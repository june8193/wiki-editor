import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type FrontmatterSchemaLoadResult,
  type WorkspaceFrontmatterSchema
} from '@shared/frontmatter'
import { FrontmatterSchemaService } from './FrontmatterSchemaService'
import { WorkspaceFsService } from './WorkspaceFsService'

describe('FrontmatterSchemaService', () => {
  let tempRoot: string
  let workspaceDir: string
  let secondWorkspaceDir: string
  let outsideDir: string
  let workspaceService: WorkspaceFsService
  let schemaService: FrontmatterSchemaService

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'wiki-editor-fm-schema-'))
    workspaceDir = join(tempRoot, 'workspace')
    secondWorkspaceDir = join(tempRoot, 'workspace-two')
    outsideDir = join(tempRoot, 'outside')
    await mkdir(workspaceDir, { recursive: true })
    await mkdir(secondWorkspaceDir, { recursive: true })
    await mkdir(outsideDir, { recursive: true })
    await writeFile(
      join(outsideDir, 'frontmatter.json'),
      JSON.stringify({ version: 1, fields: [{ key: 'leak', label: 'Leak', type: 'text' }] }),
      'utf8'
    )

    workspaceService = new WorkspaceFsService({ watchDebounceMs: 25 })
    schemaService = new FrontmatterSchemaService({
      workspaceService,
      watchDebounceMs: 25
    })
  })

  afterEach(async () => {
    schemaService.dispose()
    workspaceService.dispose()
    await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 })
  })

  it('requires an open workspace and returns { exists: false, schema: null } when schema file is absent', async () => {
    await expect(schemaService.getSchema()).rejects.toThrow(/워크스페이스/)
    await expect(schemaService.createDefaultSchema()).rejects.toThrow(/워크스페이스/)

    await workspaceService.openWorkspace(workspaceDir)
    const missing = await schemaService.getSchema()
    expect(missing).toEqual({
      exists: false,
      path: join(workspaceDir, '.wiki-editor', 'frontmatter.json'),
      schema: null
    })
  })

  it('atomically initializes Jira starter template only when absent and does not overwrite existing files', async () => {
    await workspaceService.openWorkspace(workspaceDir)
    const events: FrontmatterSchemaLoadResult[] = []
    schemaService.onSchemaChanged((evt) => events.push(evt))

    const created = await schemaService.createDefaultSchema()
    expect(created.exists).toBe(true)
    expect(created.error).toBeUndefined()
    expect(created.schema?.version).toBe(1)
    expect(created.schema?.fields.map((f) => f.key)).toEqual([
      'status',
      'priority',
      'labels',
      'assignee',
      'dueDate'
    ])
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual(created)

    // Subsequent watcher ticks from the atomic write itself must not emit duplicate events
    await new Promise((resolve) => setTimeout(resolve, 90))
    expect(events).toHaveLength(1)

    // Subsequent createDefaultSchema does NOT overwrite custom edits
    const customSchema: WorkspaceFrontmatterSchema = {
      version: 1,
      fields: [{ key: 'owner', label: '담당', type: 'text', required: true }]
    }
    const saved = await schemaService.saveSchema(customSchema)
    expect(saved.schema).toEqual(customSchema)

    const secondCreate = await schemaService.createDefaultSchema()
    expect(secondCreate.schema).toEqual(customSchema)

    // Corrupt file on disk is NOT overwritten by createDefaultSchema either
    await writeFile(join(workspaceDir, '.wiki-editor', 'frontmatter.json'), '{ corrupt json', 'utf8')
    const createOverCorrupt = await schemaService.createDefaultSchema()
    expect(createOverCorrupt.exists).toBe(true)
    expect(createOverCorrupt.schema).toBeNull()
    expect(createOverCorrupt.error).toBeTruthy()
    expect(await readFile(join(workspaceDir, '.wiki-editor', 'frontmatter.json'), 'utf8')).toBe(
      '{ corrupt json'
    )
  })

  it('strictly validates schemas on save and returns non-crashing error state on invalid disk JSON/schema', async () => {
    await workspaceService.openWorkspace(workspaceDir)

    await expect(
      schemaService.saveSchema({
        version: 1,
        fields: [
          { key: 'dup', label: 'One', type: 'text' },
          { key: 'dup', label: 'Two', type: 'text' }
        ]
      })
    ).rejects.toThrow(/중복/)

    await expect(
      schemaService.saveSchema({
        version: 1,
        fields: [{ key: 'status', label: '상태', type: 'select', options: [] }]
      })
    ).rejects.toThrow(/options/)

    // Invalid disk file loads cleanly with error without crashing
    await mkdir(join(workspaceDir, '.wiki-editor'), { recursive: true })
    await writeFile(
      join(workspaceDir, '.wiki-editor', 'frontmatter.json'),
      JSON.stringify({ version: 2, fields: [] }),
      'utf8'
    )
    const loadedInvalid = await schemaService.getSchema()
    expect(loadedInvalid.exists).toBe(true)
    expect(loadedInvalid.schema).toBeNull()
    expect(loadedInvalid.error).toMatch(/version/)
  })

  it('blocks symlink escapes and dangling symlinks for .wiki-editor and frontmatter.json', async () => {
    await workspaceService.openWorkspace(workspaceDir)
    const dotWikiDir = join(workspaceDir, '.wiki-editor')

    let junctionCreated = false
    try {
      await symlink(outsideDir, dotWikiDir, 'junction')
      junctionCreated = true
    } catch {
      junctionCreated = false
    }

    if (junctionCreated) {
      await expect(schemaService.getSchema()).rejects.toThrow(/루트 밖|심볼릭/)
      await expect(
        schemaService.saveSchema({
          version: 1,
          fields: [{ key: 'title', label: '제목', type: 'text' }]
        })
      ).rejects.toThrow(/루트 밖|심볼릭/)
      await rm(dotWikiDir, { recursive: true, force: true })
    }

    await mkdir(dotWikiDir, { recursive: true })
    const danglingLink = join(dotWikiDir, 'frontmatter.json')
    const missingOutside = join(outsideDir, 'missing-schema.json')
    let fileLinkCreated = false
    try {
      await symlink(missingOutside, danglingLink, 'file')
      fileLinkCreated = true
    } catch {
      fileLinkCreated = false
    }

    if (fileLinkCreated) {
      await expect(schemaService.getSchema()).rejects.toThrow(/심볼릭|루트 밖/)
      await expect(schemaService.createDefaultSchema()).rejects.toThrow(/심볼릭|루트 밖/)
      await expect(lstat(missingOutside)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  })

  it('detects external creation, modification, corruption, and deletion of frontmatter.json and stops watching old workspace on switch', async () => {
    await workspaceService.openWorkspace(workspaceDir)
    const events: FrontmatterSchemaLoadResult[] = []
    schemaService.onSchemaChanged((evt) => events.push(evt))

    const schemaDir = join(workspaceDir, '.wiki-editor')
    const schemaFile = join(schemaDir, 'frontmatter.json')
    await mkdir(schemaDir, { recursive: true })
    await writeFile(
      schemaFile,
      JSON.stringify({
        version: 1,
        fields: [{ key: 'stage', label: '단계', type: 'text' }]
      }),
      'utf8'
    )

    await vi.waitFor(() => {
      expect(events.some((e) => e.exists && e.schema?.fields[0]?.key === 'stage')).toBe(true)
    })

    // External corruption
    await writeFile(schemaFile, '{ broken', 'utf8')
    await vi.waitFor(() => {
      expect(events.some((e) => e.exists && e.schema === null && Boolean(e.error))).toBe(true)
    })

    // External deletion
    await rm(schemaFile, { force: true })
    await vi.waitFor(() => {
      expect(events.at(-1)).toEqual({
        exists: false,
        path: schemaFile,
        schema: null
      })
    })

    // Switch to second workspace -> old workspace mutations must no longer fire events
    const countBeforeSwitch = events.length
    await workspaceService.openWorkspace(secondWorkspaceDir)
    await writeFile(
      schemaFile,
      JSON.stringify({
        version: 1,
        fields: [{ key: 'stale', label: 'Stale', type: 'text' }]
      }),
      'utf8'
    )
    await new Promise((resolve) => setTimeout(resolve, 90))
    expect(events.length).toBe(countBeforeSwitch)
  })
})
