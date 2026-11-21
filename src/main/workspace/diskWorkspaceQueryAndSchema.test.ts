import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type FrontmatterSchemaLoadResult,
  type WorkspaceFrontmatterSchema
} from '@shared/frontmatter'
import { DEFAULT_SEARCH_MATCH_OPTIONS } from '@shared/search'
import { SharedDocumentBufferHub } from '@shared/sharedDocumentBufferHub'
import { WorkspaceQueryAndSchemaHub } from '@shared/workspaceQueryAndSchema'
import { ConfigService } from '../config/ConfigService'
import { createSharedDocumentBufferHub } from '../ipc/registerBufferIpc'
import { createDiskWorkspaceQueryAndSchemaHub } from './diskWorkspaceQueryAndSchema'
import { WorkspaceFsService } from './WorkspaceFsService'

const TEST_SCHEMA: WorkspaceFrontmatterSchema = {
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
      key: 'labels',
      label: '라벨',
      type: 'multi-select',
      allowCustom: true,
      showInSearchBadge: true,
      options: [{ value: 'backend' }, { value: 'security' }]
    }
  ]
}

describe('diskWorkspaceQueryAndSchema adapter', () => {
  let tempRoot: string
  let workspaceDir: string
  let secondWorkspaceDir: string
  let outsideDir: string
  let configPath: string
  let workspaceService: WorkspaceFsService
  let configService: ConfigService
  let bufferHub: SharedDocumentBufferHub
  let hub: WorkspaceQueryAndSchemaHub

  beforeEach(async () => {
    tempRoot = await realpath(await mkdtemp(join(tmpdir(), 'wiki-editor-disk-query-')))
    workspaceDir = join(tempRoot, 'workspace')
    secondWorkspaceDir = join(tempRoot, 'workspace-two')
    outsideDir = join(tempRoot, 'outside')
    configPath = join(tempRoot, 'config.json')
    await mkdir(workspaceDir, { recursive: true })
    await mkdir(secondWorkspaceDir, { recursive: true })
    await mkdir(outsideDir, { recursive: true })
    await writeFile(
      join(outsideDir, 'frontmatter.json'),
      JSON.stringify({ version: 1, fields: [{ key: 'leak', label: 'Leak', type: 'text' }] }),
      'utf8'
    )

    workspaceService = new WorkspaceFsService({ watchDebounceMs: 25 })
    configService = new ConfigService(configPath)
    await configService.get()
    bufferHub = createSharedDocumentBufferHub({ workspaceService, configService })
    hub = createDiskWorkspaceQueryAndSchemaHub({
      workspaceService,
      bufferHub,
      watchDebounceMs: 25
    })
  })

  afterEach(async () => {
    hub.dispose()
    bufferHub.dispose()
    workspaceService.dispose()
    await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 })
  })

  it('blocks symlink escapes and dangling symlinks for .wiki-editor and frontmatter.json and handles non-file targets', async () => {
    await workspaceService.openWorkspace(workspaceDir)

    const dotWikiDir = join(workspaceDir, '.wiki-editor')
    let dirLinkCreated = false
    try {
      await symlink(outsideDir, dotWikiDir, 'junction')
      dirLinkCreated = true
    } catch {
      dirLinkCreated = false
    }

    if (dirLinkCreated) {
      await expect(hub.getSchema()).rejects.toThrow(/루트 밖|심볼릭/)
      await expect(
        hub.saveSchema({
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
      await expect(hub.getSchema()).rejects.toThrow(/심볼릭|루트 밖/)
      await expect(hub.createDefaultSchema()).rejects.toThrow(/심볼릭|루트 밖/)
      await expect(lstat(missingOutside)).rejects.toMatchObject({ code: 'ENOENT' })
      await rm(danglingLink, { force: true })
    }

    await mkdir(danglingLink, { recursive: true })
    const dirTarget = await hub.getSchema()
    expect(dirTarget.exists).toBe(true)
    expect(dirTarget.schema).toBeNull()
    expect(dirTarget.error).toContain('파일이 아닙니다')
    await expect(hub.createDefaultSchema()).rejects.toThrow(/파일이 아닙니다/)
  })

  it('writes schema atomically without self-watch echo and watches external creation, corruption, deletion, and root switch', async () => {
    await workspaceService.openWorkspace(workspaceDir)
    const events: FrontmatterSchemaLoadResult[] = []
    hub.onSchemaChanged((evt) => events.push(evt))

    const created = await hub.createDefaultSchema()
    expect(created.exists).toBe(true)
    expect(events).toHaveLength(1)

    await new Promise((resolve) => setTimeout(resolve, 90))
    expect(events).toHaveLength(1)

    const schemaFile = join(workspaceDir, '.wiki-editor', 'frontmatter.json')
    await writeFile(
      schemaFile,
      JSON.stringify({ version: 1, fields: [{ key: 'stage', label: '단계', type: 'text' }] }),
      'utf8'
    )
    await vi.waitFor(() => {
      expect(events.some((e) => e.exists && e.schema?.fields[0]?.key === 'stage')).toBe(true)
    })

    await writeFile(schemaFile, '{ broken', 'utf8')
    await vi.waitFor(() => {
      expect(events.some((e) => e.exists && e.schema === null && Boolean(e.error))).toBe(true)
    })

    await rm(schemaFile, { force: true })
    await vi.waitFor(() => {
      expect(events.at(-1)).toEqual({
        exists: false,
        path: schemaFile,
        schema: null
      })
    })
    expect(await readFile(join(outsideDir, 'frontmatter.json'), 'utf8')).toContain('leak')

    const countBeforeSwitch = events.length
    await workspaceService.openWorkspace(secondWorkspaceDir)
    await writeFile(
      schemaFile,
      JSON.stringify({ version: 1, fields: [{ key: 'stale', label: 'Stale', type: 'text' }] }),
      'utf8'
    )
    await new Promise((resolve) => setTimeout(resolve, 90))
    expect(events.length).toBe(countBeforeSwitch)
  })

  it('enforces disk exclusions, symlinked realpath buffer overlay, and AbortSignal propagation across search and field values', async () => {
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

    await writeFile(
      join(workspaceDir, 'guides', 'intro.md'),
      '---\nstatus: in-progress\nlabels: [disk-custom, backend]\n---\nSecond needle line',
      'utf8'
    )
    await writeFile(join(workspaceDir, 'guides', 'notes.txt'), 'Plain text needle here', 'utf8')
    await writeFile(join(workspaceDir, 'package.json'), '{"key": "needle"}', 'utf8')
    await writeFile(join(workspaceDir, 'README'), 'Extensionless needle doc', 'utf8')
    await writeFile(join(workspaceDir, 'assets', 'needle.png'), 'needle inside png', 'utf8')
    await writeFile(join(workspaceDir, 'assets', 'needle.zip'), 'needle inside zip', 'utf8')
    await writeFile(
      join(workspaceDir, 'assets', 'needle-null.dat'),
      Buffer.from('needle\0binary')
    )
    await writeFile(
      join(workspaceDir, 'assets', 'needle-huge.txt'),
      Buffer.concat([Buffer.from('needle '), Buffer.alloc(2 * 1024 * 1024, 0x61)])
    )
    await writeFile(join(outsideDir, 'outside-needle.md'), 'outside needle', 'utf8')

    try {
      await symlink(outsideDir, join(workspaceDir, 'outside-link'), 'junction')
      await symlink(join(workspaceDir, 'guides'), join(workspaceDir, 'guides', 'cycle'), 'junction')
    } catch {
      // Ignore on systems disallowing symlink creation
    }

    const info = await workspaceService.openWorkspace(workspaceDir)
    await hub.saveSchema(TEST_SCHEMA)

    // Aux unsaved buffer overrides disk content for guides/intro.md
    const introPath = join(info.rootPath, 'guides', 'intro.md')
    const buf = await bufferHub.openWorkspaceFile(introPath, 'intro.md', undefined, 1)
    bufferHub.syncWindowTabs(1, [buf.key])
    bufferHub.updateContent(
      buf.key,
      '---\nstatus: in-progress\nlabels: [aux-disk-override]\n---\nAux unsaved needle'
    )

    const searchResp = await hub.search({
      query: 'needle',
      options: DEFAULT_SEARCH_MATCH_OPTIONS
    })
    expect(searchResp.files.map((f) => f.relativePath)).toEqual([
      'guides/intro.md',
      'guides/notes.txt',
      'package.json',
      'README'
    ])
    expect(searchResp.files[0].frontmatterSummary).toEqual({
      status: 'in-progress',
      labels: ['aux-disk-override']
    })

    const fieldValues = await hub.collectFieldValues(['labels'])
    expect(fieldValues).toEqual({
      valuesByField: {
        labels: ['aux-disk-override', 'backend', 'security']
      }
    })

    // AbortSignal propagation on real WorkspaceFsService reads
    const sequentialHub = createDiskWorkspaceQueryAndSchemaHub({
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
        }
        return realRead(filePath, options)
      }
    )

    try {
      const p1 = sequentialHub.search({
        query: 'needle',
        options: DEFAULT_SEARCH_MATCH_OPTIONS
      })
      await vi.waitFor(() => {
        expect(firstReadStarted).toBe(true)
      })
      const p2 = sequentialHub.search({
        query: 'Extensionless',
        options: DEFAULT_SEARCH_MATCH_OPTIONS
      })
      expect(firstReadSignal?.aborted).toBe(true)
      releaseFirstRead()
      const [r1, r2] = await Promise.all([p1, p2])
      expect(r1.files).toEqual([])
      expect(r2.files.map((f) => f.relativePath)).toEqual(['README'])
    } finally {
      spy.mockRestore()
      sequentialHub.dispose()
    }
  })
})
