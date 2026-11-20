import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type WorkspaceFrontmatterSchema } from '@shared/frontmatter'
import { DEFAULT_SEARCH_MATCH_OPTIONS } from '@shared/search'
import { SharedDocumentBufferHub } from '@shared/sharedDocumentBufferHub'
import { ConfigService } from '../config/ConfigService'
import { createSharedDocumentBufferHub } from '../ipc/registerBufferIpc'
import { FrontmatterSchemaService } from './FrontmatterSchemaService'
import { WorkspaceFsService } from './WorkspaceFsService'
import { WorkspaceSearchService } from './WorkspaceSearchService'

const TEST_FM_SCHEMA: WorkspaceFrontmatterSchema = {
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
    },
    {
      key: 'dueDate',
      label: '마감일',
      type: 'date'
    }
  ]
}

describe('WorkspaceSearchService', () => {
  let tempRoot: string
  let workspaceDir: string
  let outsideDir: string
  let configPath: string
  let workspaceService: WorkspaceFsService
  let schemaService: FrontmatterSchemaService
  let configService: ConfigService
  let bufferHub: SharedDocumentBufferHub
  let searchService: WorkspaceSearchService

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'wiki-editor-ws-search-'))
    workspaceDir = join(tempRoot, 'workspace')
    outsideDir = join(tempRoot, 'outside')
    configPath = join(tempRoot, 'config.json')
    await mkdir(workspaceDir, { recursive: true })
    await mkdir(outsideDir, { recursive: true })

    workspaceService = new WorkspaceFsService()
    schemaService = new FrontmatterSchemaService({ workspaceService, watchDebounceMs: 25 })
    configService = new ConfigService(configPath)
    await configService.get()
    bufferHub = createSharedDocumentBufferHub({ workspaceService, configService })
    searchService = new WorkspaceSearchService({
      workspaceService,
      frontmatterSchemaService: schemaService,
      getOpenBuffers: () => Object.values(bufferHub.getSnapshot().buffers)
    })
  })

  afterEach(async () => {
    searchService.dispose()
    schemaService.dispose()
    bufferHub.dispose()
    workspaceService.dispose()
    await rm(tempRoot, { recursive: true, force: true })
  })

  it('requires an open workspace and handles empty query and invalid regex errors cleanly', async () => {
    await expect(
      searchService.search({ query: 'wiki', options: DEFAULT_SEARCH_MATCH_OPTIONS })
    ).rejects.toThrow(/워크스페이스/)

    await workspaceService.openWorkspace(workspaceDir)

    const emptyResp = await searchService.search({
      query: '',
      options: DEFAULT_SEARCH_MATCH_OPTIONS
    })
    expect(emptyResp).toEqual({
      query: '',
      files: [],
      totalFileCount: 0,
      totalMatchCount: 0,
      truncated: false
    })

    const badRegexResp = await searchService.search({
      query: '[unclosed',
      options: { caseSensitive: false, wholeWord: false, useRegex: true }
    })
    expect(badRegexResp.query).toBe('[unclosed')
    expect(badRegexResp.files).toEqual([])
    expect(badRegexResp.totalFileCount).toBe(0)
    expect(badRegexResp.totalMatchCount).toBe(0)
    expect(badRegexResp.truncated).toBe(false)
    expect(badRegexResp.error).toBeTruthy()
  })

  it('recursively searches all text files (.md, .txt, .json, extensionless) while excluding system dirs, unsafe symlinks, images, binaries, null-byte files, and >2MB files', async () => {
    await mkdir(join(workspaceDir, '.git', 'objects'), { recursive: true })
    await mkdir(join(workspaceDir, 'node_modules', 'pkg'), { recursive: true })
    await mkdir(join(workspaceDir, '.hg'), { recursive: true })
    await mkdir(join(workspaceDir, '.svn'), { recursive: true })
    await mkdir(join(workspaceDir, 'guides'), { recursive: true })
    await mkdir(join(workspaceDir, 'assets'), { recursive: true })

    await writeFile(join(workspaceDir, '.git', 'note.md'), 'needle in git', 'utf8')
    await writeFile(join(workspaceDir, 'node_modules', 'pkg', 'index.txt'), 'needle in deps', 'utf8')
    await writeFile(join(workspaceDir, '.hg', 'hgrc'), 'needle in hg', 'utf8')
    await writeFile(join(workspaceDir, '.svn', 'entries'), 'needle in svn', 'utf8')
    await writeFile(join(workspaceDir, '.DS_Store'), 'needle in ds_store', 'utf8')
    await writeFile(join(workspaceDir, 'Thumbs.db'), 'needle in thumbs', 'utf8')

    await writeFile(join(workspaceDir, 'guides', 'intro.md'), 'First line\nSecond needle line', 'utf8')
    await writeFile(join(workspaceDir, 'guides', 'notes.txt'), 'Plain text needle here', 'utf8')
    await writeFile(join(workspaceDir, 'package.json'), '{"key": "needle"}', 'utf8')
    await writeFile(join(workspaceDir, 'README'), 'Extensionless needle doc', 'utf8')

    // Excluded non-text files even if their names or contents contain "needle"
    await writeFile(join(workspaceDir, 'assets', 'needle.png'), 'needle inside png', 'utf8')
    await writeFile(join(workspaceDir, 'assets', 'needle.svg'), '<svg>needle</svg>', 'utf8')
    await writeFile(join(workspaceDir, 'assets', 'needle.zip'), 'needle inside zip', 'utf8')
    await writeFile(join(workspaceDir, 'assets', 'needle.exe'), 'needle inside exe', 'utf8')
    await writeFile(
      join(workspaceDir, 'assets', 'needle-null.dat'),
      Buffer.concat([Buffer.from('needle\0binary')])
    )
    await writeFile(
      join(workspaceDir, 'assets', 'needle-huge.txt'),
      Buffer.concat([Buffer.from('needle '), Buffer.alloc(2 * 1024 * 1024, 0x61)])
    )

    // External and cyclic symlinks must not leak or loop
    await writeFile(join(outsideDir, 'outside-needle.md'), 'outside needle', 'utf8')
    try {
      await symlink(outsideDir, join(workspaceDir, 'outside-link'), 'junction')
      await symlink(join(workspaceDir, 'guides'), join(workspaceDir, 'guides', 'cycle'), 'junction')
    } catch {
      // Ignore on systems disallowing symlink creation
    }

    await workspaceService.openWorkspace(workspaceDir)
    const response = await searchService.search({
      query: 'needle',
      options: DEFAULT_SEARCH_MATCH_OPTIONS
    })

    expect(response.error).toBeUndefined()
    expect(response.files.map((f) => f.relativePath)).toEqual([
      'guides/intro.md',
      'guides/notes.txt',
      'package.json',
      'README'
    ])
    expect(response.totalFileCount).toBe(4)
    expect(response.totalMatchCount).toBe(4)
    expect(response.truncated).toBe(false)
    expect(response.files[0].lineMatches).toEqual([
      {
        lineNumber: 2,
        lineText: 'Second needle line',
        lineOffset: 0,
        matches: [{ start: 7, end: 13 }]
      }
    ])
  })

  it('prefers unsaved SharedDocumentBufferHub workspace text buffers (including auxiliary window edits) over disk and excludes config.json', async () => {
    const info = await workspaceService.openWorkspace(workspaceDir)
    const docPath = join(info.rootPath, 'draft.md')
    await writeFile(docPath, 'line 1 oldDiskToken\nline 2 clean', 'utf8')

    // Open in main window (win 1), edit in auxiliary window (win 2) without saving
    const buf = await bufferHub.openWorkspaceFile(docPath, 'draft.md', undefined, 1)
    bufferHub.syncWindowTabs(1, [buf.key])
    await bufferHub.openWorkspaceFile(docPath, 'draft.md', undefined, 2)
    bufferHub.syncWindowTabs(2, [buf.key])
    bufferHub.updateContent(buf.key, 'line 1 clean\nline 2 auxUnsavedToken\nline 3 auxUnsavedToken')

    // Open global config.json buffer with dirty matching content -> must NOT appear in workspace search
    const configBuf = await bufferHub.openConfigDocument(1)
    bufferHub.syncWindowTabs(1, [buf.key, configBuf.key])
    bufferHub.updateContent(configBuf.key, '{"note":"auxUnsavedToken"}')

    const oldResult = await searchService.search({
      query: 'oldDiskToken',
      options: DEFAULT_SEARCH_MATCH_OPTIONS
    })
    expect(oldResult.files).toEqual([])

    const unsavedResult = await searchService.search({
      query: 'auxUnsavedToken',
      options: DEFAULT_SEARCH_MATCH_OPTIONS
    })
    expect(unsavedResult.totalFileCount).toBe(1)
    expect(unsavedResult.totalMatchCount).toBe(2)
    expect(unsavedResult.files[0].relativePath).toBe('draft.md')
    expect(unsavedResult.files[0].lineMatches.map((m) => m.lineNumber)).toEqual([2, 3])
  })

  it('ranks filename/path matches first, extracts long-line snippets with accurate lineOffset, and enforces per-file and total limits', async () => {
    const info = await workspaceService.openWorkspace(workspaceDir)
    await mkdir(join(info.rootPath, 'docs'), { recursive: true })
    await writeFile(join(info.rootPath, 'docs', 'alpha-topic.md'), 'no body hit', 'utf8')
    await writeFile(join(info.rootPath, 'zeta-topic.md'), 'topic in body', 'utf8')
    await writeFile(
      join(info.rootPath, 'a-body-only.md'),
      `${'p'.repeat(200)}topic${'q'.repeat(200)}\n` +
        Array.from({ length: 12 }, (_, idx) => `row ${idx} topic`).join('\n'),
      'utf8'
    )
    await writeFile(join(info.rootPath, 'b-body-only.md'), 'extra topic beyond total limit', 'utf8')

    const ranked = await searchService.search({
      query: 'topic',
      options: DEFAULT_SEARCH_MATCH_OPTIONS,
      maxMatchesPerFile: 5,
      maxTotalMatches: 6
    })

    // Filename/path matches sorted ascending by relativePath appear BEFORE body-only matches
    expect(ranked.files.map((f) => f.relativePath)).toEqual([
      'docs/alpha-topic.md',
      'zeta-topic.md',
      'a-body-only.md'
    ])
    expect(ranked.files[0].nameMatches).toEqual([{ start: 11, end: 16 }])
    expect(ranked.files[0].lineMatches).toEqual([])
    expect(ranked.files[0].totalMatchCount).toBe(0)

    const bodyFile = ranked.files[2]
    // Long line snippet should preserve column = lineOffset + span.start
    const firstLineMatch = bodyFile.lineMatches[0]
    expect(firstLineMatch.lineNumber).toBe(1)
    expect(firstLineMatch.lineOffset).toBeGreaterThan(0)
    expect(firstLineMatch.lineOffset + firstLineMatch.matches[0].start).toBe(200)
    expect(
      firstLineMatch.lineText.slice(
        firstLineMatch.matches[0].start,
        firstLineMatch.matches[0].end
      )
    ).toBe('topic')

    // Per-file cap (5) vs total cap (6, with 1 match in zeta-topic + 5 in a-body-only; b-body-only overflows total cap)
    expect(bodyFile.totalMatchCount).toBe(13)
    expect(bodyFile.truncatedInFile).toBe(true)
    expect(ranked.totalMatchCount).toBe(6)
    expect(ranked.truncated).toBe(true)

    // Per-file truncation alone without exceeding total cap leaves response.truncated = false
    const perFileOnly = await searchService.search({
      query: 'topic',
      options: DEFAULT_SEARCH_MATCH_OPTIONS,
      maxMatchesPerFile: 5,
      maxTotalMatches: 100
    })
    expect(perFileOnly.files[2].truncatedInFile).toBe(true)
    expect(perFileOnly.files[2].totalMatchCount).toBe(13)
    expect(perFileOnly.totalMatchCount).toBe(7)
    expect(perFileOnly.truncated).toBe(false)
  })

  it('cancels prior in-flight scan when a subsequent search request arrives on the same service', async () => {
    const info = await workspaceService.openWorkspace(workspaceDir)
    for (let i = 0; i < 6; i += 1) {
      await writeFile(join(info.rootPath, `file-${i}.md`), 'alpha beta', 'utf8')
    }

    const sequentialSearch = new WorkspaceSearchService({
      workspaceService,
      concurrency: 1
    })

    let releaseFirstRead!: () => void
    const firstReadGate = new Promise<void>((resolve) => {
      releaseFirstRead = resolve
    })
    const realRead = workspaceService.readTextFileForSearch.bind(workspaceService)
    let firstReadSignal: AbortSignal | undefined
    let firstReadStarted = false
    const spy = vi.spyOn(workspaceService, 'readTextFileForSearch').mockImplementation(
      async (filePath, options) => {
        if (!firstReadStarted) {
          firstReadStarted = true
          firstReadSignal = options?.signal
          await firstReadGate
          return realRead(filePath, options)
        }
        return realRead(filePath, options)
      }
    )

    const firstPromise = sequentialSearch.search({
      query: 'alpha',
      options: DEFAULT_SEARCH_MATCH_OPTIONS
    })

    await vi.waitFor(() => {
      expect(firstReadStarted).toBe(true)
    })

    const secondPromise = sequentialSearch.search({
      query: 'beta',
      options: DEFAULT_SEARCH_MATCH_OPTIONS
    })

    expect(firstReadSignal?.aborted).toBe(true)
    releaseFirstRead()
    const [firstResult, secondResult] = await Promise.all([firstPromise, secondPromise])

    // 1 aborted read from first scan + 6 reads from second scan (remaining 5 files of first scan skipped)
    expect(spy).toHaveBeenCalledTimes(7)
    expect(firstResult).toEqual({
      query: 'alpha',
      files: [],
      totalFileCount: 0,
      totalMatchCount: 0,
      truncated: false
    })
    expect(secondResult.query).toBe('beta')
    expect(secondResult.totalFileCount).toBe(6)
    expect(secondResult.totalMatchCount).toBe(6)

    spy.mockRestore()
    sequentialSearch.dispose()
  })

  it('terminates safely on empty-matching regexes and aborts stale scans when the workspace root switches mid-search', async () => {
    const info = await workspaceService.openWorkspace(workspaceDir)
    await writeFile(join(info.rootPath, 'doc.md'), 'alpha\nbeta', 'utf8')

    const emptyRegexResult = await searchService.search({
      query: '.*',
      options: { caseSensitive: false, wholeWord: false, useRegex: true }
    })
    expect(emptyRegexResult.error).toBeUndefined()
    expect(emptyRegexResult.totalFileCount).toBe(1)
    expect(emptyRegexResult.totalMatchCount).toBe(2)

    const otherWorkspace = join(tempRoot, 'other-workspace')
    await mkdir(otherWorkspace, { recursive: true })
    await writeFile(join(otherWorkspace, 'other.md'), 'alpha', 'utf8')

    let releaseRead!: () => void
    const gate = new Promise<void>((resolve) => {
      releaseRead = resolve
    })
    const realRead = workspaceService.readTextFileForSearch.bind(workspaceService)
    let readEntered = false
    const readSpy = vi
      .spyOn(workspaceService, 'readTextFileForSearch')
      .mockImplementationOnce(async (filePath, options) => {
        readEntered = true
        await gate
        return realRead(filePath, options)
      })

    const staleSearchPromise = searchService.search({
      query: 'alpha',
      options: DEFAULT_SEARCH_MATCH_OPTIONS
    })
    await vi.waitFor(() => {
      expect(readEntered).toBe(true)
    })

    await workspaceService.openWorkspace(otherWorkspace)
    releaseRead()

    const staleResult = await staleSearchPromise
    expect(staleResult).toEqual({
      query: 'alpha',
      files: [],
      totalFileCount: 0,
      totalMatchCount: 0,
      truncated: false
    })
    readSpy.mockRestore()
  })

  it('sets truncatedInFile when a single long line exceeds maxMatchesPerFile outside its snippet window', async () => {
    const info = await workspaceService.openWorkspace(workspaceDir)
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
    await writeFile(join(info.rootPath, 'single-long.md'), longLine, 'utf8')

    const response = await searchService.search({
      query: 'hit',
      options: DEFAULT_SEARCH_MATCH_OPTIONS,
      maxMatchesPerFile: 4,
      maxTotalMatches: 100
    })

    expect(response.files).toHaveLength(1)
    expect(response.files[0].totalMatchCount).toBe(6)
    expect(response.files[0].lineMatches[0].matches.length).toBeLessThanOrEqual(4)
    expect(response.files[0].truncatedInFile).toBe(true)
    expect(response.truncated).toBe(false)
  })

  it('preserves pre-truncation totalMatchCount and binary/size exclusions on nameMatches files after maxTotalMatches is exhausted', async () => {
    const info = await workspaceService.openWorkspace(workspaceDir)
    await writeFile(join(info.rootPath, '01-hit.md'), 'hit hit hit', 'utf8')
    await writeFile(join(info.rootPath, '02-hit.md'), 'hit\nhit\nhit\nhit', 'utf8')
    await writeFile(
      join(info.rootPath, '03-hit-null.txt'),
      Buffer.from('hit\0binary')
    )
    await writeFile(
      join(info.rootPath, '04-hit-huge.md'),
      Buffer.concat([Buffer.from('hit '), Buffer.alloc(2 * 1024 * 1024, 0x61)])
    )
    await writeFile(join(info.rootPath, '05-hit-clean.md'), 'nothing in body', 'utf8')
    await writeFile(join(info.rootPath, '06-body-only.md'), 'hit in body', 'utf8')

    // Sequential mode forces stopBodyScanning before 02-hit..05-hit are dispatched
    const sequentialSearch = new WorkspaceSearchService({
      workspaceService,
      concurrency: 1
    })

    try {
      for (const service of [sequentialSearch, searchService]) {
        const response = await service.search({
          query: 'hit',
          options: DEFAULT_SEARCH_MATCH_OPTIONS,
          maxMatchesPerFile: 10,
          maxTotalMatches: 2
        })

        expect(response.truncated).toBe(true)
        expect(response.totalMatchCount).toBe(2)
        expect(response.files.map((f) => f.relativePath)).toEqual([
          '01-hit.md',
          '02-hit.md',
          '05-hit-clean.md'
        ])

        expect(response.files[0].lineMatches).toEqual([
          {
            lineNumber: 1,
            lineText: 'hit hit hit',
            lineOffset: 0,
            matches: [
              { start: 0, end: 3 },
              { start: 4, end: 7 }
            ]
          }
        ])
        expect(response.files[0].totalMatchCount).toBe(3)
        expect(response.files[0].truncatedInFile).toBe(true)

        expect(response.files[1].lineMatches).toEqual([])
        expect(response.files[1].totalMatchCount).toBe(4)
        expect(response.files[1].truncatedInFile).toBe(true)

        expect(response.files[2].lineMatches).toEqual([])
        expect(response.files[2].totalMatchCount).toBe(0)
        expect(response.files[2].truncatedInFile).toBe(false)
      }
    } finally {
      sequentialSearch.dispose()
    }
  })

  it('supports attribute-only search, text+frontmatter intersection, unsaved aux buffer priority, and excludes .wiki-editor/non-markdown/binary/>2MB/config.json', async () => {
    const info = await workspaceService.openWorkspace(workspaceDir)
    await schemaService.saveSchema(TEST_FM_SCHEMA)

    await writeFile(
      join(info.rootPath, 'a-match.md'),
      '---\nstatus: in-progress\npriority: high\nlabels: [security, backend]\ndueDate: 2026-11-22\n---\n# Auth\nAudit Auth token',
      'utf8'
    )
    await writeFile(
      join(info.rootPath, 'b-disk-stale.md'),
      '---\nstatus: todo\npriority: low\n---\n# Draft\nOld body',
      'utf8'
    )
    await writeFile(
      join(info.rootPath, 'README'),
      '---\nstatus: in-progress\npriority: medium\nlabels: [security]\ndueDate: 2026-11-21\n---\nAuth extensionless doc',
      'utf8'
    )
    await writeFile(
      join(info.rootPath, '.wiki-editor', 'internal.md'),
      '---\nstatus: in-progress\nlabels: [security]\n---\nAuth internal',
      'utf8'
    )
    await writeFile(
      join(info.rootPath, 'ignored.txt'),
      '---\nstatus: in-progress\nlabels: [security]\n---\nAuth txt',
      'utf8'
    )
    await writeFile(
      join(info.rootPath, 'null-doc.md'),
      Buffer.from('---\nstatus: in-progress\nlabels: [security]\n---\nAuth\0binary')
    )
    await writeFile(
      join(info.rootPath, 'huge-doc.md'),
      Buffer.concat([
        Buffer.from('---\nstatus: in-progress\nlabels: [security]\n---\nAuth '),
        Buffer.alloc(2 * 1024 * 1024, 0x61)
      ])
    )

    // Unsaved auxiliary window buffer updates b-disk-stale.md to match AND config.json must stay excluded
    const stalePath = join(info.rootPath, 'b-disk-stale.md')
    const bufB = await bufferHub.openWorkspaceFile(stalePath, 'b-disk-stale.md', undefined, 1)
    bufferHub.syncWindowTabs(1, [bufB.key])
    await bufferHub.openWorkspaceFile(stalePath, 'b-disk-stale.md', undefined, 2)
    bufferHub.syncWindowTabs(2, [bufB.key])
    bufferHub.updateContent(
      bufB.key,
      '---\nstatus: in-progress\npriority: high\nlabels: [security]\ndueDate: 2026-11-20\n---\n# Draft\nauth unsaved line'
    )
    const configBuf = await bufferHub.openConfigDocument(1)
    bufferHub.syncWindowTabs(1, [bufB.key, configBuf.key])
    bufferHub.updateContent(configBuf.key, '---\nstatus: in-progress\nlabels: [security]\n---\nAuth')

    // 1. Attribute-only query (empty text query + AND conditions)
    const attrOnly = await searchService.search({
      query: '',
      options: DEFAULT_SEARCH_MATCH_OPTIONS,
      frontmatter: {
        conditions: [
          { fieldKey: 'status', operator: 'in', values: ['in-progress'] },
          { fieldKey: 'labels', operator: 'any-of', values: ['security'] },
          { fieldKey: 'dueDate', operator: 'lte', value: '2026-11-25' }
        ]
      }
    })
    expect(attrOnly.error).toBeUndefined()
    expect(attrOnly.files.map((f) => f.relativePath)).toEqual([
      'a-match.md',
      'b-disk-stale.md',
      'README'
    ])
    expect(attrOnly.totalFileCount).toBe(3)
    expect(attrOnly.totalMatchCount).toBe(0)
    expect(attrOnly.files[0].frontmatterSummary).toEqual({
      status: 'in-progress',
      priority: 'high',
      labels: ['security', 'backend']
    })

    // 2. Intersection with case-sensitive + wholeWord text query ('Auth' matches a-match (2) & README (1), NOT lowercase 'auth' in b-disk-stale)
    const combined = await searchService.search({
      query: 'Auth',
      options: { caseSensitive: true, wholeWord: true, useRegex: false },
      frontmatter: {
        conditions: [{ fieldKey: 'status', operator: 'in', values: ['in-progress'] }]
      }
    })
    expect(combined.files.map((f) => f.relativePath)).toEqual(['a-match.md', 'README'])
    expect(combined.totalMatchCount).toBe(3)

    // Regex intersection (.*)
    const regexCombined = await searchService.search({
      query: 'Audit\\s+Auth',
      options: { caseSensitive: false, wholeWord: false, useRegex: true },
      frontmatter: {
        conditions: [{ fieldKey: 'status', operator: 'in', values: ['in-progress'] }]
      }
    })
    expect(regexCombined.files.map((f) => f.relativePath)).toEqual(['a-match.md'])
    expect(regexCombined.totalMatchCount).toBe(1)

    // 3. Plain text search without conditions still attaches frontmatterSummary when schema exists
    const plainWithSummary = await searchService.search({
      query: 'unsaved',
      options: DEFAULT_SEARCH_MATCH_OPTIONS
    })
    expect(plainWithSummary.files.map((f) => f.relativePath)).toEqual(['b-disk-stale.md'])
    expect(plainWithSummary.files[0].frontmatterSummary).toEqual({
      status: 'in-progress',
      priority: 'high',
      labels: ['security']
    })
  })

  it('sorts frontmatter search results by schema option order with empty last and applies maxTotalMatches after sorting', async () => {
    const info = await workspaceService.openWorkspace(workspaceDir)
    await schemaService.saveSchema(TEST_FM_SCHEMA)

    await writeFile(
      join(info.rootPath, 'a-low-first-by-path.md'),
      '---\npriority: low\n---\ntoken\ntoken\ntoken',
      'utf8'
    )
    await writeFile(join(info.rootPath, 'b-empty.md'), '# No priority\ntoken', 'utf8')
    await writeFile(
      join(info.rootPath, 'c-medium.md'),
      '---\npriority: medium\n---\ntoken',
      'utf8'
    )
    await writeFile(
      join(info.rootPath, 'd-high-last-by-path.md'),
      '---\npriority: high\n---\ntoken\ntoken',
      'utf8'
    )

    // Attribute-only sort desc: low -> medium -> high -> empty
    const attrDesc = await searchService.search({
      query: '',
      options: DEFAULT_SEARCH_MATCH_OPTIONS,
      frontmatter: {
        conditions: [{ fieldKey: 'priority', operator: 'not-in', values: ['none'] }],
        sort: { by: 'frontmatter', fieldKey: 'priority', direction: 'desc' }
      }
    })
    expect(attrDesc.files.map((f) => f.relativePath)).toEqual([
      'a-low-first-by-path.md',
      'c-medium.md',
      'd-high-last-by-path.md',
      'b-empty.md'
    ])

    // Text + frontmatter sort asc with maxTotalMatches=3 -> high (2) + medium (1) win before a-low-first-by-path!
    const textSortedTruncated = await searchService.search({
      query: 'token',
      options: DEFAULT_SEARCH_MATCH_OPTIONS,
      maxTotalMatches: 3,
      frontmatter: {
        conditions: [],
        sort: { by: 'frontmatter', fieldKey: 'priority', direction: 'asc' }
      }
    })
    expect(textSortedTruncated.files.map((f) => f.relativePath)).toEqual([
      'd-high-last-by-path.md',
      'c-medium.md'
    ])
    expect(textSortedTruncated.totalMatchCount).toBe(3)
    expect(textSortedTruncated.truncated).toBe(true)
  })

  it('collects deduplicated sorted schema options and custom document values for allowCustom multi-select fields, prefers aux buffers, and excludes unsafe/non-markdown files', async () => {
    await expect(searchService.collectFrontmatterFieldValues()).rejects.toThrow(/워크스페이스/)

    const info = await workspaceService.openWorkspace(workspaceDir)
    expect(await searchService.collectFrontmatterFieldValues()).toEqual({ valuesByField: {} })

    const multiSchema: WorkspaceFrontmatterSchema = {
      version: 1,
      fields: [
        ...TEST_FM_SCHEMA.fields,
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
    await schemaService.saveSchema(multiSchema)

    await writeFile(
      join(info.rootPath, 'doc1.md'),
      '---\nlabels: [zebra, backend, alpha]\nstrictTags: [ignored-custom]\nareas: [platform]\n---\n',
      'utf8'
    )
    await writeFile(
      join(info.rootPath, 'README'),
      '---\nlabels: [alpha, docs-extra]\nareas: [cli]\n---\n',
      'utf8'
    )
    await writeFile(
      join(info.rootPath, 'stale.md'),
      '---\nlabels: [stale-disk-tag]\n---\n',
      'utf8'
    )
    await writeFile(
      join(info.rootPath, '.wiki-editor', 'leak.md'),
      '---\nlabels: [wiki-editor-leak]\n---\n',
      'utf8'
    )
    await writeFile(
      join(info.rootPath, 'note.txt'),
      '---\nlabels: [txt-leak]\n---\n',
      'utf8'
    )
    await writeFile(
      join(info.rootPath, 'bin.md'),
      Buffer.from('---\nlabels: [bin-leak]\n---\n\0')
    )
    await writeFile(
      join(info.rootPath, 'huge.md'),
      Buffer.concat([Buffer.from('---\nlabels: [huge-leak]\n---\n'), Buffer.alloc(2 * 1024 * 1024, 0x61)])
    )
    await writeFile(
      join(outsideDir, 'outside.md'),
      '---\nlabels: [outside-leak]\n---\n',
      'utf8'
    )
    try {
      await symlink(outsideDir, join(info.rootPath, 'outside-link'), 'junction')
    } catch {
      // Ignore on systems disallowing symlink creation
    }

    // Auxiliary window unsaved buffer overrides stale.md and config.json stays excluded
    const stalePath = join(info.rootPath, 'stale.md')
    const staleBuf = await bufferHub.openWorkspaceFile(stalePath, 'stale.md', undefined, 1)
    bufferHub.syncWindowTabs(1, [staleBuf.key])
    await bufferHub.openWorkspaceFile(stalePath, 'stale.md', undefined, 2)
    bufferHub.syncWindowTabs(2, [staleBuf.key])
    bufferHub.updateContent(staleBuf.key, '---\nlabels: [aux-unsaved-tag]\n---\n')

    const configBuf = await bufferHub.openConfigDocument(1)
    bufferHub.syncWindowTabs(1, [staleBuf.key, configBuf.key])
    bufferHub.updateContent(configBuf.key, '---\nlabels: [config-leak]\n---\n')

    const allCustom = await searchService.collectFrontmatterFieldValues()
    expect(allCustom).toEqual({
      valuesByField: {
        labels: ['alpha', 'aux-unsaved-tag', 'backend', 'docs-extra', 'security', 'zebra'],
        areas: ['cli', 'platform']
      }
    })

    const labelsOnly = await searchService.collectFrontmatterFieldValues(['labels', 'strictTags'])
    expect(labelsOnly).toEqual({
      valuesByField: {
        labels: ['alpha', 'aux-unsaved-tag', 'backend', 'docs-extra', 'security', 'zebra']
      }
    })
  })

  it('cancels prior in-flight collectFrontmatterFieldValues scan on subsequent call without cancelling concurrent search', async () => {
    const info = await workspaceService.openWorkspace(workspaceDir)
    await schemaService.saveSchema(TEST_FM_SCHEMA)
    for (let i = 0; i < 4; i += 1) {
      await writeFile(join(info.rootPath, `doc-${i}.md`), `---\nlabels: [tag-${i}]\n---\n`, 'utf8')
    }

    const sequential = new WorkspaceSearchService({
      workspaceService,
      frontmatterSchemaService: schemaService,
      concurrency: 1
    })

    let releaseFirstRead!: () => void
    const gate = new Promise<void>((resolve) => {
      releaseFirstRead = resolve
    })
    const realRead = workspaceService.readTextFileForSearch.bind(workspaceService)
    let firstSignal: AbortSignal | undefined
    let pausedOnce = false
    const spy = vi.spyOn(workspaceService, 'readTextFileForSearch').mockImplementation(
      async (filePath, options) => {
        if (!pausedOnce) {
          pausedOnce = true
          firstSignal = options?.signal
          await gate
        }
        return realRead(filePath, options)
      }
    )

    const p1 = sequential.collectFrontmatterFieldValues(['labels'])
    await vi.waitFor(() => {
      expect(pausedOnce).toBe(true)
    })

    const p2 = sequential.collectFrontmatterFieldValues(['labels'])
    expect(firstSignal?.aborted).toBe(true)
    releaseFirstRead()

    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1).toEqual({ valuesByField: {} })
    expect(r2).toEqual({
      valuesByField: {
        labels: ['backend', 'security', 'tag-0', 'tag-1', 'tag-2', 'tag-3']
      }
    })

    spy.mockRestore()
    sequential.dispose()
  })
})
