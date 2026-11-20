import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceFrontmatterSchema } from '@shared/frontmatter'
import type { SharedDocumentBufferHub } from '@shared/sharedDocumentBufferHub'
import { ConfigService } from '../config/ConfigService'
import { createSharedDocumentBufferHub } from '../ipc/registerBufferIpc'
import { FrontmatterFieldValuesService } from './FrontmatterFieldValuesService'
import { FrontmatterSchemaService } from './FrontmatterSchemaService'
import { WorkspaceFsService } from './WorkspaceFsService'

const BASE_SCHEMA: WorkspaceFrontmatterSchema = {
  version: 1,
  fields: [
    {
      key: 'labels',
      label: '라벨',
      type: 'multi-select',
      allowCustom: true,
      options: [{ value: 'backend' }, { value: 'security' }]
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

describe('FrontmatterFieldValuesService', () => {
  let tempRoot: string
  let workspaceDir: string
  let outsideDir: string
  let configPath: string
  let workspaceService: WorkspaceFsService
  let schemaService: FrontmatterSchemaService
  let configService: ConfigService
  let bufferHub: SharedDocumentBufferHub
  let fieldValuesService: FrontmatterFieldValuesService

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'wiki-editor-fm-values-'))
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
    fieldValuesService = new FrontmatterFieldValuesService({
      workspaceService,
      frontmatterSchemaService: schemaService,
      getOpenBuffers: () => Object.values(bufferHub.getSnapshot().buffers)
    })
  })

  afterEach(async () => {
    fieldValuesService.dispose()
    schemaService.dispose()
    bufferHub.dispose()
    workspaceService.dispose()
    await rm(tempRoot, { recursive: true, force: true })
  })

  it('collects deduplicated sorted schema options and custom document values for allowCustom multi-select fields, prefers aux buffers, and excludes unsafe/non-markdown files', async () => {
    await expect(fieldValuesService.collectFieldValues()).rejects.toThrow(/워크스페이스/)

    const info = await workspaceService.openWorkspace(workspaceDir)
    expect(await fieldValuesService.collectFieldValues()).toEqual({ valuesByField: {} })

    await schemaService.saveSchema(BASE_SCHEMA)

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
    await mkdir(join(info.rootPath, '.wiki-editor'), { recursive: true })
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

    const allCustom = await fieldValuesService.collectFieldValues()
    expect(allCustom).toEqual({
      valuesByField: {
        labels: ['alpha', 'aux-unsaved-tag', 'backend', 'docs-extra', 'security', 'zebra'],
        areas: ['cli', 'platform']
      }
    })

    const labelsOnly = await fieldValuesService.collectFieldValues(['labels', 'strictTags'])
    expect(labelsOnly).toEqual({
      valuesByField: {
        labels: ['alpha', 'aux-unsaved-tag', 'backend', 'docs-extra', 'security', 'zebra']
      }
    })
  })

  it('cancels prior in-flight collectFieldValues scan on subsequent call', async () => {
    const info = await workspaceService.openWorkspace(workspaceDir)
    await schemaService.saveSchema(BASE_SCHEMA)
    for (let i = 0; i < 4; i += 1) {
      await writeFile(join(info.rootPath, `doc-${i}.md`), `---\nlabels: [tag-${i}]\n---\n`, 'utf8')
    }

    const sequential = new FrontmatterFieldValuesService({
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

    const p1 = sequential.collectFieldValues(['labels'])
    await vi.waitFor(() => {
      expect(pausedOnce).toBe(true)
    })

    const p2 = sequential.collectFieldValues(['labels'])
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
