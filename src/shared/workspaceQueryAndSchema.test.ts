import { describe, expect, it, vi } from 'vitest'
import {
  FRONTMATTER_SCHEMA_RELATIVE_PATH,
  type FrontmatterSchemaLoadResult,
  serializeFrontmatterSchema,
  type WorkspaceFrontmatterSchema
} from './frontmatter'
import { DEFAULT_SEARCH_MATCH_OPTIONS } from './search'
import { SharedDocumentBufferHub } from './sharedDocumentBufferHub'
import {
  filterSearchableTextContent,
  SCHEMA_TARGET_NOT_FILE_ERROR,
  type SchemaRawReadResult,
  WorkspaceQueryAndSchemaHub,
  type WorkspaceQueryAndSchemaStorage
} from './workspaceQueryAndSchema'
import {
  compareWorkspaceEntriesByRelativePath,
  getWorkspacePathKey,
  IGNORED_WORKSPACE_ENTRY_NAMES,
  joinWorkspacePath,
  type WorkspaceEntry
} from './workspace'

interface InMemoryTestStorageOptions {
  initialRoot?: string | null
  files?: Record<string, string>
  invalidTargets?: ReadonlySet<string>
  realPaths?: Record<string, string>
  onBeforeReadText?: (filePath: string, signal?: AbortSignal) => Promise<void> | void
}

function normalizeTestPosix(pathValue: string): string {
  return pathValue.replace(/\\/g, '/').replace(/\/+$/, '') || '/'
}

function createInMemoryQueryStorage(options: InMemoryTestStorageOptions = {}) {
  let activeRoot: string | null = options.initialRoot
    ? normalizeTestPosix(options.initialRoot)
    : null
  const files = new Map<string, string>()
  for (const [rawPath, content] of Object.entries(options.files ?? {})) {
    files.set(normalizeTestPosix(rawPath), content)
  }
  const invalidTargets = new Set(
    [...(options.invalidTargets ?? [])].map((item) => normalizeTestPosix(item))
  )
  const realPaths = new Map<string, string>()
  for (const [alias, real] of Object.entries(options.realPaths ?? {})) {
    realPaths.set(normalizeTestPosix(alias), normalizeTestPosix(real))
  }
  const rootListeners = new Set<(rootPath: string | null) => Promise<void> | void>()
  const schemaWatchers = new Map<string, Set<() => void>>()

  const storage: WorkspaceQueryAndSchemaStorage = {
    getWorkspaceRoot: () => activeRoot,
    onWorkspaceRootChanged: (listener) => {
      rootListeners.add(listener)
      return () => {
        rootListeners.delete(listener)
      }
    },
    async listWorkspaceFiles(listOpts = {}) {
      if (!activeRoot) {
        throw new Error('열린 워크스페이스가 없습니다.')
      }
      const prefix = `${activeRoot}/`
      const entries: WorkspaceEntry[] = []
      for (const filePath of files.keys()) {
        if (listOpts.signal?.aborted) {
          return []
        }
        if (!filePath.startsWith(prefix)) continue
        const relativePath = filePath.slice(prefix.length)
        if (
          relativePath
            .split('/')
            .filter(Boolean)
            .some((seg) => IGNORED_WORKSPACE_ENTRY_NAMES.has(seg))
        ) {
          continue
        }
        const name = relativePath.split('/').pop() ?? relativePath
        if (listOpts.filterFileName && !listOpts.filterFileName(name)) {
          continue
        }
        entries.push({
          name,
          path: filePath,
          relativePath,
          kind: 'file'
        })
      }
      return entries.sort(compareWorkspaceEntriesByRelativePath)
    },
    async readTextFileForSearch(filePath, readOpts = {}) {
      if (options.onBeforeReadText) {
        await options.onBeforeReadText(filePath, readOpts.signal)
      }
      if (readOpts.signal?.aborted) {
        return null
      }
      const text = files.get(normalizeTestPosix(filePath))
      return text === undefined ? null : filterSearchableTextContent(text)
    },
    ...(Object.keys(options.realPaths ?? {}).length > 0
      ? {
          resolveRealPath: async (targetPath: string) => {
            const norm = normalizeTestPosix(targetPath)
            return realPaths.get(norm) ?? norm
          }
        }
      : {}),
    async readSchemaRaw(rootPath): Promise<SchemaRawReadResult> {
      const schemaPath = joinWorkspacePath(rootPath, FRONTMATTER_SCHEMA_RELATIVE_PATH)
      const normalizedSchema = normalizeTestPosix(schemaPath)
      if (invalidTargets.has(normalizedSchema)) {
        return { kind: 'invalid-target', schemaPath, error: SCHEMA_TARGET_NOT_FILE_ERROR }
      }
      const rawText = files.get(normalizedSchema)
      if (rawText === undefined) {
        return { kind: 'missing', schemaPath }
      }
      return { kind: 'present', schemaPath, rawText }
    },
    async writeSchemaRaw(rootPath, serializedSchema) {
      const schemaPath = joinWorkspacePath(rootPath, FRONTMATTER_SCHEMA_RELATIVE_PATH)
      const normalizedSchema = normalizeTestPosix(schemaPath)
      if (invalidTargets.has(normalizedSchema)) {
        throw new Error(SCHEMA_TARGET_NOT_FILE_ERROR)
      }
      files.set(normalizedSchema, serializedSchema)
      return { schemaPath }
    },
    watchSchema(rootPath, onPossibleChange) {
      const key = getWorkspacePathKey(rootPath)
      let listeners = schemaWatchers.get(key)
      if (!listeners) {
        listeners = new Set()
        schemaWatchers.set(key, listeners)
      }
      listeners.add(onPossibleChange)
      return () => {
        listeners?.delete(onPossibleChange)
        if (listeners && listeners.size === 0) {
          schemaWatchers.delete(key)
        }
      }
    }
  }

  return {
    storage,
    files,
    async setWorkspaceRoot(nextRoot: string | null): Promise<void> {
      activeRoot = nextRoot ? normalizeTestPosix(nextRoot) : null
      for (const listener of [...rootListeners]) {
        await listener(activeRoot)
      }
    },
    emitSchemaChange(rootPath: string): void {
      const listeners = schemaWatchers.get(getWorkspacePathKey(rootPath))
      if (!listeners) return
      for (const listener of [...listeners]) {
        listener()
      }
    }
  }
}

describe('WorkspaceQueryAndSchemaHub', () => {
  it('manages frontmatter schema lifecycle: missing state, non-overwriting starter creation, strict validation, fingerprint dedup, and serialized queue', async () => {
    const env = createInMemoryQueryStorage()
    const hub = new WorkspaceQueryAndSchemaHub({ storage: env.storage })
    const events: FrontmatterSchemaLoadResult[] = []
    hub.onSchemaChanged((evt) => events.push(evt))

    try {
      await expect(hub.getSchema()).rejects.toThrow(/워크스페이스/)
      await expect(hub.createDefaultSchema()).rejects.toThrow(/워크스페이스/)
      expect(hub.getSchemaPath()).toBeNull()

      await env.setWorkspaceRoot('C:/wiki/docs')
      const expectedPath = 'C:/wiki/docs/.wiki-editor/frontmatter.json'
      expect(hub.getSchemaPath()).toBe(expectedPath)
      expect(hub.isSchemaFilePath('c:\\wiki\\docs\\.wiki-editor\\frontmatter.json')).toBe(true)

      const missing = await hub.getSchema()
      expect(missing).toEqual({
        exists: false,
        path: expectedPath,
        schema: null
      })

      const created = await hub.createDefaultSchema()
      expect(created.exists).toBe(true)
      expect(created.schema?.fields.map((f) => f.key)).toEqual([
        'status',
        'priority',
        'labels',
        'assignee',
        'dueDate'
      ])
      expect(events).toHaveLength(1)
      expect(await hub.reloadSchemaIfChanged()).toBeNull()

      await expect(
        hub.saveSchema({
          version: 1,
          fields: [
            { key: 'dup', label: 'A', type: 'text' },
            { key: 'dup', label: 'B', type: 'text' }
          ]
        })
      ).rejects.toThrow(/중복/)

      const customSchema: WorkspaceFrontmatterSchema = {
        version: 1,
        fields: [{ key: 'owner', label: '담당', type: 'text', required: true }]
      }
      const saved = await hub.saveSchema(customSchema)
      expect(saved.schema).toEqual(customSchema)
      expect(events).toHaveLength(2)

      // createDefaultSchema does not overwrite existing valid or corrupt schema
      const secondCreate = await hub.createDefaultSchema()
      expect(secondCreate.schema).toEqual(customSchema)

      env.files.set(expectedPath, '{ corrupt json')
      const reloadedError = await hub.reloadSchemaIfChanged()
      expect(reloadedError?.exists).toBe(true)
      expect(reloadedError?.schema).toBeNull()
      expect(reloadedError?.error).toBeTruthy()
      expect(events).toHaveLength(3)
      // Unchanged corrupt raw text does not re-emit
      expect(await hub.reloadSchemaIfChanged()).toBeNull()

      const createOverCorrupt = await hub.createDefaultSchema()
      expect(createOverCorrupt.schema).toBeNull()
      expect(createOverCorrupt.error).toBeTruthy()
      expect(env.files.get(expectedPath)).toBe('{ corrupt json')
    } finally {
      hub.dispose()
    }
  })

  it('syncs schema changes two-way with SharedDocumentBufferHub, handles external watch/delete and root switches, and isolates invalid targets', async () => {
    const env = createInMemoryQueryStorage({
      initialRoot: 'C:/wiki/alpha',
      invalidTargets: new Set(['C:/wiki/bad-target/.wiki-editor/frontmatter.json'])
    })
    const bufferHub = new SharedDocumentBufferHub({
      initialAutoSaveConfig: { autoSave: false },
      storage: {
        readWorkspaceFile: async (filePath) => {
          const text = env.files.get(normalizeTestPosix(filePath))
          if (text === undefined) throw new Error(`ENOENT: ${filePath}`)
          return text
        },
        writeWorkspaceFile: async (filePath, content) => {
          env.files.set(normalizeTestPosix(filePath), content)
        },
        getConfigPath: async () => 'C:/Users/test/config.json',
        readConfigRaw: async () => '{}',
        saveConfigRaw: async () => ({})
      }
    })
    const hub = new WorkspaceQueryAndSchemaHub({
      storage: env.storage,
      bufferHub
    })
    const events: FrontmatterSchemaLoadResult[] = []
    hub.onSchemaChanged((evt) => events.push(evt))

    try {
      const schemaPath = 'C:/wiki/alpha/.wiki-editor/frontmatter.json'
      await hub.createDefaultSchema()
      expect(events).toHaveLength(1)

      // Open clean frontmatter.json buffer -> saveSchema automatically refreshes clean buffer
      const schemaBuf = await bufferHub.openWorkspaceFile(schemaPath, 'frontmatter.json', undefined, 1)
      bufferHub.syncWindowTabs(1, [schemaBuf.key])
      await hub.saveSchema({
        version: 1,
        fields: [{ key: 'reviewer', label: '리뷰어', type: 'text', required: true }]
      })
      await vi.waitFor(() => {
        expect(bufferHub.getBuffer(schemaBuf.key)?.content).toContain('"reviewer"')
        expect(bufferHub.getBuffer(schemaBuf.key)?.isDirty).toBe(false)
      })

      // External file modification via watcher reloads schema AND refreshes clean buffer
      env.files.set(
        schemaPath,
        JSON.stringify({
          version: 1,
          fields: [{ key: 'stage', label: '단계', type: 'text' }]
        })
      )
      env.emitSchemaChange('C:/wiki/alpha')
      await vi.waitFor(() => {
        expect(events.at(-1)?.schema?.fields[0]?.key).toBe('stage')
        expect(bufferHub.getBuffer(schemaBuf.key)?.content).toContain('"stage"')
      })

      // Concurrent getSchema() or collectFieldValues() before reloadSchemaIfChanged() must not swallow pending onSchemaChanged broadcast
      env.files.set(
        schemaPath,
        JSON.stringify({
          version: 1,
          fields: [{ key: 'owner', label: '소유자', type: 'text', required: true }]
        })
      )
      const peeked = await hub.getSchema()
      expect(peeked.schema?.fields[0]?.key).toBe('owner')
      await hub.collectFieldValues(['owner'])
      const reloadedAfterPeek = await hub.reloadSchemaIfChanged()
      expect(reloadedAfterPeek?.schema?.fields[0]?.key).toBe('owner')
      await vi.waitFor(() => {
        expect(events.at(-1)?.schema?.fields[0]?.key).toBe('owner')
        expect(bufferHub.getBuffer(schemaBuf.key)?.content).toContain('"owner"')
      })

      // Saving invalid JSON through SharedDocumentBufferHub emits workspace-saved -> reloads error state
      bufferHub.updateContent(schemaBuf.key, '{ invalid json')
      await bufferHub.saveBuffer(schemaBuf.key)
      await vi.waitFor(() => {
        const latest = events.at(-1)
        expect(latest?.exists).toBe(true)
        expect(latest?.schema).toBeNull()
        expect(latest?.error).toContain('frontmatter.json 구문 오류')
      })

      // External deletion via watcher broadcasts missing state
      env.files.delete(schemaPath)
      env.emitSchemaChange('C:/wiki/alpha')
      await vi.waitFor(() => {
        expect(events.at(-1)).toEqual({
          exists: false,
          path: schemaPath,
          schema: null
        })
      })

      // Switching workspace stops watching old workspace and reports invalid target cleanly
      const eventsBeforeSwitch = events.length
      await env.setWorkspaceRoot('C:/wiki/bad-target')
      env.files.set(
        schemaPath,
        JSON.stringify({ version: 1, fields: [{ key: 'stale', label: 'Stale', type: 'text' }] })
      )
      env.emitSchemaChange('C:/wiki/alpha')
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(events).toHaveLength(eventsBeforeSwitch)

      const invalidState = await hub.getSchema()
      expect(invalidState).toEqual({
        exists: true,
        path: 'C:/wiki/bad-target/.wiki-editor/frontmatter.json',
        schema: null,
        error: SCHEMA_TARGET_NOT_FILE_ERROR
      })
      await expect(hub.createDefaultSchema()).rejects.toThrow(/파일이 아닙니다/)
    } finally {
      hub.dispose()
      bufferHub.dispose()
    }
  })

  it('searches text, filename ranking, snippets, limits, frontmatter filters/sort/summaries, and buffer overlays with TextEncoder 2MB & config.json exclusions', async () => {
    const schema: WorkspaceFrontmatterSchema = {
      version: 1,
      fields: [
        {
          key: 'status',
          label: '상태',
          type: 'select',
          showInSearchBadge: true,
          options: [{ value: 'todo' }, { value: 'in-progress' }, { value: 'done' }]
        },
        {
          key: 'priority',
          label: '우선순위',
          type: 'select',
          showInSearchBadge: true,
          options: [{ value: 'high' }, { value: 'medium' }, { value: 'low' }]
        },
        {
          key: 'labels',
          label: '라벨',
          type: 'multi-select',
          allowCustom: true,
          showInSearchBadge: true,
          options: [{ value: 'backend' }, { value: 'security' }]
        }
      ]
    }
    const env = createInMemoryQueryStorage({
      files: {
        [`C:/wiki/docs/${FRONTMATTER_SCHEMA_RELATIVE_PATH}`]: serializeFrontmatterSchema(schema),
        'C:/wiki/docs/docs/alpha-topic.md': 'no body hit',
        'C:/wiki/docs/zeta-topic.md': '---\nstatus: todo\n---\ntopic in body',
        'C:/wiki/docs/a-body-only.md':
          `${'p'.repeat(200)}topic${'q'.repeat(200)}\n` +
          Array.from({ length: 12 }, (_, idx) => `row ${idx} topic`).join('\n'),
        'C:/wiki/docs/b-body-only.md': 'extra topic beyond total limit',
        'C:/wiki/docs/a-low.md': '---\nstatus: in-progress\npriority: low\n---\ntoken\ntoken\ntoken',
        'C:/wiki/docs/d-high.md': '---\nstatus: in-progress\npriority: high\nlabels: [security]\n---\ntoken\ntoken',
        'C:/wiki/docs/c-medium.md': '---\nstatus: in-progress\npriority: medium\n---\ntoken',
        'C:/wiki/docs/b-empty.md': '# No priority\ntoken',
        'C:/wiki/docs/symlink-target.md': 'disk old text',
        'C:/wiki/docs/assets/topic.png': 'topic inside image',
        'C:/wiki/docs/assets/topic.zip': 'topic inside zip',
        'C:/wiki/docs/.wiki-editor/internal.md': '---\nstatus: in-progress\n---\ntoken',
        'C:/wiki/docs/ignored.txt': '---\nstatus: in-progress\n---\ntoken'
      },
      realPaths: {
        'C:/wiki/docs/linked-note.md': 'C:/wiki/docs/symlink-target.md'
      }
    })
    const bufferHub = new SharedDocumentBufferHub({
      initialAutoSaveConfig: { autoSave: false },
      storage: {
        readWorkspaceFile: async (filePath) => {
          const norm = normalizeTestPosix(filePath)
          const resolved =
            norm === 'C:/wiki/docs/linked-note.md' ? 'C:/wiki/docs/symlink-target.md' : norm
          const text = env.files.get(resolved)
          if (text === undefined) throw new Error(`ENOENT: ${filePath}`)
          return text
        },
        writeWorkspaceFile: async () => undefined,
        getConfigPath: async () => 'C:/Users/test/config.json',
        readConfigRaw: async () => '{}',
        saveConfigRaw: async () => ({})
      }
    })
    const hub = new WorkspaceQueryAndSchemaHub({
      storage: env.storage,
      bufferHub
    })

    try {
      await expect(
        hub.search({ query: 'topic', options: DEFAULT_SEARCH_MATCH_OPTIONS })
      ).rejects.toThrow(/워크스페이스/)

      await env.setWorkspaceRoot('C:/wiki/docs')

      expect(await hub.search({ query: '', options: DEFAULT_SEARCH_MATCH_OPTIONS })).toEqual({
        query: '',
        files: [],
        totalFileCount: 0,
        totalMatchCount: 0,
        truncated: false
      })

      const invalidRegex = await hub.search({
        query: '[unclosed',
        options: { caseSensitive: false, wholeWord: false, useRegex: true }
      })
      expect(invalidRegex.error).toBeTruthy()
      expect(invalidRegex.files).toEqual([])

      // Filename match ranking, snippet lineOffset, per-file & total limits, and summary omission
      const ranked = await hub.search({
        query: 'topic',
        options: DEFAULT_SEARCH_MATCH_OPTIONS,
        maxMatchesPerFile: 5,
        maxTotalMatches: 6
      })
      expect(ranked.files.map((f) => f.relativePath)).toEqual([
        'docs/alpha-topic.md',
        'zeta-topic.md',
        'a-body-only.md'
      ])
      expect('frontmatterSummary' in ranked.files[0]).toBe(false)
      expect(ranked.files[1].frontmatterSummary).toEqual({ status: 'todo' })
      expect(ranked.files[2].lineMatches[0].lineOffset + ranked.files[2].lineMatches[0].matches[0].start).toBe(200)
      expect(ranked.files[2].totalMatchCount).toBe(13)
      expect(ranked.files[2].truncatedInFile).toBe(true)
      expect(ranked.totalMatchCount).toBe(6)
      expect(ranked.truncated).toBe(true)

      // Unsaved buffer overlay via resolveRealPath, config.json exclusion, and UTF-8 >2MB buffer exclusion
      const linkedBuf = await bufferHub.openWorkspaceFile(
        'C:/wiki/docs/linked-note.md',
        'linked-note.md',
        undefined,
        1
      )
      const hugeBuf = await bufferHub.openWorkspaceFile(
        'C:/wiki/docs/b-body-only.md',
        'b-body-only.md',
        undefined,
        1
      )
      const configBuf = await bufferHub.openConfigDocument(1)
      bufferHub.syncWindowTabs(1, [linkedBuf.key, hugeBuf.key, configBuf.key])
      bufferHub.updateContent(linkedBuf.key, 'unsavedSymlinkToken')
      // Multi-byte UTF-8 string (< 2M chars, > 2MB bytes) must be excluded via TextEncoder byteLength
      bufferHub.updateContent(hugeBuf.key, `unsavedSymlinkToken ${'한'.repeat(700_000)}`)
      bufferHub.updateContent(configBuf.key, '{"token":"unsavedSymlinkToken"}')

      const overlayResp = await hub.search({
        query: 'unsavedSymlinkToken',
        options: DEFAULT_SEARCH_MATCH_OPTIONS
      })
      expect(overlayResp.files.map((f) => f.relativePath)).toEqual(['symlink-target.md'])
      expect(overlayResp.totalMatchCount).toBe(1)

      // Attribute-only search + frontmatter sort + post-sort truncation
      const attrOnly = await hub.search({
        query: '',
        options: DEFAULT_SEARCH_MATCH_OPTIONS,
        frontmatter: {
          conditions: [{ fieldKey: 'status', operator: 'in', values: ['in-progress'] }],
          sort: { by: 'frontmatter', fieldKey: 'priority', direction: 'asc' }
        }
      })
      expect(attrOnly.files.map((f) => f.relativePath)).toEqual([
        'd-high.md',
        'c-medium.md',
        'a-low.md'
      ])
      expect(attrOnly.files[0].frontmatterSummary).toEqual({
        status: 'in-progress',
        priority: 'high',
        labels: ['security']
      })

      const sortedTruncated = await hub.search({
        query: 'token',
        options: DEFAULT_SEARCH_MATCH_OPTIONS,
        maxTotalMatches: 3,
        frontmatter: {
          conditions: [],
          sort: { by: 'frontmatter', fieldKey: 'priority', direction: 'asc' }
        }
      })
      expect(sortedTruncated.files.map((f) => f.relativePath)).toEqual(['d-high.md', 'c-medium.md'])
      expect(sortedTruncated.totalMatchCount).toBe(3)
      expect(sortedTruncated.truncated).toBe(true)
    } finally {
      hub.dispose()
      bufferHub.dispose()
    }
  })

  it('collects allowCustom multi-select field values with buffer overlay and keeps search/field-values lanes independent until root switch or dispose', async () => {
    const schema: WorkspaceFrontmatterSchema = {
      version: 1,
      fields: [
        {
          key: 'labels',
          label: '라벨',
          type: 'multi-select',
          allowCustom: true,
          options: [{ value: 'security' }, { value: 'backend' }]
        },
        {
          key: 'strictTags',
          label: '고정 태그',
          type: 'multi-select',
          allowCustom: false,
          options: [{ value: 'core' }]
        },
        {
          key: 'areas',
          label: '영역',
          type: 'multi-select',
          allowCustom: true
        }
      ]
    }
    let releaseSearchRead: () => void = () => undefined
    let releaseValuesRead: () => void = () => undefined
    let searchReadEntered = false
    let valuesReadEntered = false
    let searchSignal: AbortSignal | undefined
    let valuesSignal: AbortSignal | undefined
    let readInterceptor: ((filePath: string, signal?: AbortSignal) => Promise<void> | void) | null =
      null

    const env = createInMemoryQueryStorage({
      files: {
        'C:/wiki/alpha/doc1.md':
          '---\nlabels: [zebra, backend, alpha]\nstrictTags: [ignored]\nareas: [platform]\n---\nsearchHit',
        'C:/wiki/alpha/README': '---\nlabels: [alpha, docs-extra]\nareas: [cli]\n---\n',
        'C:/wiki/alpha/stale.md': '---\nlabels: [stale-disk-tag]\n---\n',
        'C:/wiki/alpha/.wiki-editor/leak.md': '---\nlabels: [internal-leak]\n---\n',
        'C:/wiki/alpha/note.txt': '---\nlabels: [txt-leak]\n---\n',
        'C:/wiki/alpha/null.md': '---\nlabels: [null-leak]\n---\n\0',
        'C:/wiki/alpha/huge.md': `---\nlabels: [huge-leak]\n---\n${'한'.repeat(700_000)}`,
        'C:/wiki/beta/other.md': '---\nlabels: [beta-tag]\n---\nsearchHit'
      },
      onBeforeReadText: async (filePath, signal) => {
        await readInterceptor?.(filePath, signal)
      }
    })
    const bufferHub = new SharedDocumentBufferHub({
      initialAutoSaveConfig: { autoSave: false },
      storage: {
        readWorkspaceFile: async (filePath) => {
          const text = env.files.get(normalizeTestPosix(filePath))
          if (text === undefined) throw new Error(`ENOENT: ${filePath}`)
          return text
        },
        writeWorkspaceFile: async () => undefined,
        getConfigPath: async () => 'C:/Users/test/config.json',
        readConfigRaw: async () => '{}',
        saveConfigRaw: async () => ({})
      }
    })
    const hub = new WorkspaceQueryAndSchemaHub({
      storage: env.storage,
      bufferHub,
      concurrency: 1
    })

    try {
      await expect(hub.collectFieldValues()).rejects.toThrow(/워크스페이스/)
      await env.setWorkspaceRoot('C:/wiki/alpha')
      expect(await hub.collectFieldValues()).toEqual({ valuesByField: {} })

      await hub.saveSchema(schema)

      const staleBuf = await bufferHub.openWorkspaceFile(
        'C:/wiki/alpha/stale.md',
        'stale.md',
        undefined,
        1
      )
      const configBuf = await bufferHub.openConfigDocument(1)
      bufferHub.syncWindowTabs(1, [staleBuf.key, configBuf.key])
      bufferHub.updateContent(staleBuf.key, '---\nlabels: [unsaved-custom]\n---\n')
      bufferHub.updateContent(configBuf.key, '---\nlabels: [config-leak]\n---\n')

      expect(await hub.collectFieldValues()).toEqual({
        valuesByField: {
          labels: ['alpha', 'backend', 'docs-extra', 'security', 'unsaved-custom', 'zebra'],
          areas: ['cli', 'platform']
        }
      })
      expect(await hub.collectFieldValues(['labels', 'strictTags'])).toEqual({
        valuesByField: {
          labels: ['alpha', 'backend', 'docs-extra', 'security', 'unsaved-custom', 'zebra']
        }
      })

      // Independent lanes: search & collectFieldValues do NOT abort each other
      readInterceptor = async (filePath, signal) => {
        if (filePath.endsWith('/doc1.md') && !searchReadEntered) {
          searchReadEntered = true
          searchSignal = signal
          await new Promise<void>((resolve) => {
            releaseSearchRead = resolve
          })
        } else if (filePath.endsWith('/README') && !valuesReadEntered) {
          valuesReadEntered = true
          valuesSignal = signal
          await new Promise<void>((resolve) => {
            releaseValuesRead = resolve
          })
        }
      }
      const searchPromise = hub.search({
        query: 'searchHit',
        options: DEFAULT_SEARCH_MATCH_OPTIONS
      })
      await vi.waitFor(() => {
        expect(searchReadEntered).toBe(true)
      })

      const valuesPromise = hub.collectFieldValues(['labels'])
      await vi.waitFor(() => {
        expect(valuesReadEntered).toBe(true)
      })

      expect(searchSignal?.aborted).toBe(false)
      expect(valuesSignal?.aborted).toBe(false)

      releaseSearchRead()
      releaseValuesRead()
      const [searchResult, valuesResult] = await Promise.all([searchPromise, valuesPromise])
      expect(searchResult.files.map((f) => f.relativePath)).toEqual(['doc1.md'])
      expect(valuesResult.valuesByField.labels).toContain('unsaved-custom')

      // Same-lane preemption: second collectFieldValues aborts first, second search aborts first
      valuesReadEntered = false
      readInterceptor = async (filePath, signal) => {
        if (filePath.endsWith('/doc1.md') && !valuesReadEntered) {
          valuesReadEntered = true
          valuesSignal = signal
          await new Promise<void>((resolve) => {
            releaseValuesRead = resolve
          })
        }
      }
      const firstValues = hub.collectFieldValues(['labels'])
      await vi.waitFor(() => {
        expect(valuesReadEntered).toBe(true)
      })
      const secondValues = hub.collectFieldValues(['labels'])
      expect(valuesSignal?.aborted).toBe(true)
      releaseValuesRead()
      const [abortedValues, completedValues] = await Promise.all([firstValues, secondValues])
      expect(abortedValues).toEqual({ valuesByField: {} })
      expect(completedValues.valuesByField.labels).toContain('unsaved-custom')

      // Workspace root switch aborts BOTH lanes at once
      searchReadEntered = false
      valuesReadEntered = false
      readInterceptor = async (filePath, signal) => {
        if (filePath.endsWith('/doc1.md') && !searchReadEntered) {
          searchReadEntered = true
          searchSignal = signal
          await new Promise<void>((resolve) => {
            releaseSearchRead = resolve
          })
        } else if (filePath.endsWith('/README') && !valuesReadEntered) {
          valuesReadEntered = true
          valuesSignal = signal
          await new Promise<void>((resolve) => {
            releaseValuesRead = resolve
          })
        }
      }
      const switchingSearch = hub.search({
        query: 'searchHit',
        options: DEFAULT_SEARCH_MATCH_OPTIONS
      })
      await vi.waitFor(() => {
        expect(searchReadEntered).toBe(true)
      })
      const switchingValues = hub.collectFieldValues(['labels'])
      await vi.waitFor(() => {
        expect(valuesReadEntered).toBe(true)
      })

      await env.setWorkspaceRoot('C:/wiki/beta')
      expect(searchSignal?.aborted).toBe(true)
      expect(valuesSignal?.aborted).toBe(true)
      releaseSearchRead()
      releaseValuesRead()
      expect(await switchingSearch).toMatchObject({ files: [], totalFileCount: 0 })
      expect(await switchingValues).toEqual({ valuesByField: {} })

      // dispose() aborts both lanes
      readInterceptor = null
      const betaSchema = {
        ...schema,
        fields: [schema.fields[0]]
      }
      await hub.saveSchema(betaSchema)
      let releaseDisposeGate!: () => void
      const disposeGate = new Promise<void>((resolve) => {
        releaseDisposeGate = resolve
      })
      let disposeEntered = false
      let disposeSignal: AbortSignal | undefined
      const disposeEnv = createInMemoryQueryStorage({
        initialRoot: 'C:/wiki/dispose',
        files: {
          [`C:/wiki/dispose/${FRONTMATTER_SCHEMA_RELATIVE_PATH}`]: serializeFrontmatterSchema(schema),
          'C:/wiki/dispose/a.md': '---\nlabels: [x]\n---\nhit'
        },
        onBeforeReadText: async (_p, sig) => {
          disposeEntered = true
          disposeSignal = sig
          await disposeGate
        }
      })
      const disposeHub = new WorkspaceQueryAndSchemaHub({ storage: disposeEnv.storage })
      const pendingSearch = disposeHub.search({
        query: 'hit',
        options: DEFAULT_SEARCH_MATCH_OPTIONS
      })
      await vi.waitFor(() => {
        expect(disposeEntered).toBe(true)
      })
      disposeHub.dispose()
      expect(disposeSignal?.aborted).toBe(true)
      releaseDisposeGate()
      expect(await pendingSearch).toMatchObject({ files: [], totalFileCount: 0 })
    } finally {
      hub.dispose()
      bufferHub.dispose()
    }
  })

  it('handles single-line snippet overflow, post-budget nameMatches preservation, and schema read error propagation by query mode', async () => {
    const longLine = [
      'hit',
      'a'.repeat(20),
      'hit',
      'b'.repeat(350),
      'hit',
      'c'.repeat(40),
      'hit',
      'd'.repeat(40),
      'hit',
      'e'.repeat(40),
      'hit'
    ].join('')
    const env = createInMemoryQueryStorage({
      initialRoot: 'C:/wiki/edge',
      files: {
        'C:/wiki/edge/01-hit.md': 'hit hit hit',
        'C:/wiki/edge/02-hit.md': 'hit\nhit\nhit\nhit',
        'C:/wiki/edge/03-hit-clean.md': 'nothing in body',
        'C:/wiki/edge/04-body-only.md': 'hit in body',
        'C:/wiki/edge/05-single-long.md': longLine
      }
    })
    const hub = new WorkspaceQueryAndSchemaHub({ storage: env.storage, concurrency: 1 })

    try {
      const capped = await hub.search({
        query: 'hit',
        options: DEFAULT_SEARCH_MATCH_OPTIONS,
        maxMatchesPerFile: 10,
        maxTotalMatches: 2
      })
      expect(capped.truncated).toBe(true)
      expect(capped.totalMatchCount).toBe(2)
      expect(capped.files.map((f) => f.relativePath)).toEqual([
        '01-hit.md',
        '02-hit.md',
        '03-hit-clean.md'
      ])
      expect(capped.files[1].lineMatches).toEqual([])
      expect(capped.files[1].totalMatchCount).toBe(4)
      expect(capped.files[1].truncatedInFile).toBe(true)
      expect(capped.files[2].totalMatchCount).toBe(0)
      expect(capped.files[2].truncatedInFile).toBe(false)

      const singleLong = await hub.search({
        query: 'hit',
        options: DEFAULT_SEARCH_MATCH_OPTIONS,
        maxMatchesPerFile: 4,
        maxTotalMatches: 100
      })
      const longFile = singleLong.files.find((f) => f.relativePath === '05-single-long.md')!
      expect(longFile.totalMatchCount).toBe(6)
      expect(longFile.lineMatches[0].matches.length).toBeLessThanOrEqual(4)
      expect(longFile.truncatedInFile).toBe(true)

      // When readSchemaRaw throws (e.g. symlink error), plain text search succeeds while frontmatter search/values throw
      const throwingStorage: WorkspaceQueryAndSchemaStorage = {
        ...env.storage,
        readSchemaRaw: async () => {
          throw new Error('심볼릭 링크 접근 차단')
        }
      }
      const guardedHub = new WorkspaceQueryAndSchemaHub({ storage: throwingStorage })
      try {
        const plainResp = await guardedHub.search({
          query: 'nothing',
          options: DEFAULT_SEARCH_MATCH_OPTIONS
        })
        expect(plainResp.files.map((f) => f.relativePath)).toEqual(['03-hit-clean.md'])

        await expect(
          guardedHub.search({
            query: '',
            options: DEFAULT_SEARCH_MATCH_OPTIONS,
            frontmatter: { conditions: [{ fieldKey: 'status', operator: 'is-empty' }] }
          })
        ).rejects.toThrow(/심볼릭/)
        await expect(guardedHub.collectFieldValues()).rejects.toThrow(/심볼릭/)
      } finally {
        guardedHub.dispose()
      }
    } finally {
      hub.dispose()
    }
  })
})
