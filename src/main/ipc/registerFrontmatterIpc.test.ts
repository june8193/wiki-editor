import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  FrontmatterSchemaLoadResult,
  WorkspaceFrontmatterFieldValuesResponse,
  WorkspaceFrontmatterSchema
} from '@shared/frontmatter'
import { FRONTMATTER_IPC_CHANNELS } from '@shared/ipc'
import type { WorkspaceQueryAndSchemaHub } from '@shared/workspaceQueryAndSchema'
import { LogService } from '../logging/LogService'
import { createDiskWorkspaceQueryAndSchemaHub } from '../workspace/diskWorkspaceQueryAndSchema'
import { WorkspaceFsService } from '../workspace/WorkspaceFsService'
import type { WebContentsLike } from './ipcHelpers'
import { createFakeIpcMain, createSingleIpcSessionSource } from './ipcTestHelpers'
import { registerFrontmatterIpc } from './registerFrontmatterIpc'

describe('registerFrontmatterIpc', () => {
  let tempDir: string
  let workspaceDir: string
  let workspaceService: WorkspaceFsService
  let queryAndSchemaHub: WorkspaceQueryAndSchemaHub

  beforeEach(async () => {
    tempDir = await realpath(await mkdtemp(join(tmpdir(), 'wiki-editor-fm-ipc-')))
    workspaceDir = join(tempDir, 'docs')
    await mkdir(workspaceDir, { recursive: true })
    workspaceService = new WorkspaceFsService({ watchDebounceMs: 25 })
    queryAndSchemaHub = createDiskWorkspaceQueryAndSchemaHub({
      workspaceService,
      watchDebounceMs: 25
    })
  })

  afterEach(async () => {
    queryAndSchemaHub.dispose()
    workspaceService.dispose()
    await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 })
  })

  it('handles schema get, starter creation, strict save, external reload broadcast, and safe error logging', async () => {
    const logService = new LogService(join(tempDir, 'logs'))
    const ipcMain = createFakeIpcMain()
    const messages: Array<{ channel: string; payload: unknown }> = []
    const liveTarget: WebContentsLike = {
      isDestroyed: () => false,
      send: (channel, payload) => messages.push({ channel, payload })
    }
    const destroyedTarget: WebContentsLike = {
      isDestroyed: () => true,
      send: (channel, payload) => messages.push({ channel, payload })
    }

    const dispose = registerFrontmatterIpc({
      ipcMain,
      sessionSource: createSingleIpcSessionSource({
        queryAndSchemaHub,
        getTargets: () => [liveTarget, destroyedTarget]
      }),
      logService
    })

    await expect(ipcMain.invoke(FRONTMATTER_IPC_CHANNELS.getSchema)).rejects.toThrow(/워크스페이스/)

    await workspaceService.openWorkspace(workspaceDir)
    const initial = await ipcMain.invoke<FrontmatterSchemaLoadResult>(
      FRONTMATTER_IPC_CHANNELS.getSchema
    )
    expect(initial).toEqual({
      exists: false,
      path: join(workspaceDir, '.wiki-editor', 'frontmatter.json'),
      schema: null
    })

    const created = await ipcMain.invoke<FrontmatterSchemaLoadResult>(
      FRONTMATTER_IPC_CHANNELS.createDefaultSchema
    )
    expect(created.exists).toBe(true)
    expect(created.schema?.fields.map((f) => f.key)).toEqual([
      'status',
      'priority',
      'labels',
      'assignee',
      'dueDate'
    ])
    expect(messages).toHaveLength(1)
    expect(messages[0]).toEqual({
      channel: FRONTMATTER_IPC_CHANNELS.schemaChanged,
      payload: created
    })

    const updatedSchema: WorkspaceFrontmatterSchema = {
      version: 1,
      fields: [{ key: 'topic', label: 'SECRET_LABEL', type: 'text', required: true }]
    }
    const saved = await ipcMain.invoke<FrontmatterSchemaLoadResult>(
      FRONTMATTER_IPC_CHANNELS.saveSchema,
      updatedSchema
    )
    expect(saved.schema).toEqual(updatedSchema)
    expect(messages).toHaveLength(2)

    await expect(
      ipcMain.invoke(FRONTMATTER_IPC_CHANNELS.saveSchema, {
        version: 1,
        fields: [{ key: 'status', label: 'Bad', type: 'select', options: [] }]
      })
    ).rejects.toThrow(/options/)

    // External invalid JSON edit reloads and broadcasts error state without crashing
    await writeFile(join(workspaceDir, '.wiki-editor', 'frontmatter.json'), '{ bad json', 'utf8')
    await vi.waitFor(() => {
      expect(messages.length).toBeGreaterThanOrEqual(3)
    })
    const lastPayload = messages.at(-1)?.payload as FrontmatterSchemaLoadResult
    expect(lastPayload.exists).toBe(true)
    expect(lastPayload.schema).toBeNull()
    expect(lastPayload.error).toBeTruthy()

    const logEntries = await logService.readEntries()
    const serializedLogs = JSON.stringify(logEntries)
    expect(serializedLogs).not.toContain('SECRET_LABEL')
    expect(logEntries.some((entry) => entry.data?.channel === FRONTMATTER_IPC_CHANNELS.saveSchema)).toBe(
      true
    )

    dispose()
    expect(ipcMain.hasHandler(FRONTMATTER_IPC_CHANNELS.getSchema)).toBe(false)
    expect(ipcMain.hasHandler(FRONTMATTER_IPC_CHANNELS.createDefaultSchema)).toBe(false)
    expect(ipcMain.hasHandler(FRONTMATTER_IPC_CHANNELS.saveSchema)).toBe(false)
    expect(ipcMain.hasHandler(FRONTMATTER_IPC_CHANNELS.getFieldValues)).toBe(false)
  })

  it('handles frontmatter:get-field-values and redacts field values from audit logs', async () => {
    const logService = new LogService(join(tempDir, 'logs'))
    const ipcMain = createFakeIpcMain()

    const dispose = registerFrontmatterIpc({
      ipcMain,
      sessionSource: createSingleIpcSessionSource({
        queryAndSchemaHub,
        getTargets: () => []
      }),
      logService
    })

    await expect(ipcMain.invoke(FRONTMATTER_IPC_CHANNELS.getFieldValues)).rejects.toThrow(
      /워크스페이스/
    )

    await workspaceService.openWorkspace(workspaceDir)
    await queryAndSchemaHub.saveSchema({
      version: 1,
      fields: [
        {
          key: 'labels',
          label: '라벨',
          type: 'multi-select',
          allowCustom: true,
          options: [{ value: 'backend' }]
        }
      ]
    })
    await writeFile(
      join(workspaceDir, 'note.md'),
      '---\nlabels: [SECRET_TAG, backend]\n---\n# Note',
      'utf8'
    )

    const result = await ipcMain.invoke<WorkspaceFrontmatterFieldValuesResponse>(
      FRONTMATTER_IPC_CHANNELS.getFieldValues,
      ['labels']
    )
    expect(result).toEqual({
      valuesByField: {
        labels: ['backend', 'SECRET_TAG']
      }
    })

    const serializedLogs = JSON.stringify(await logService.readEntries())
    expect(serializedLogs).not.toContain('SECRET_TAG')
    expect(serializedLogs).toContain(FRONTMATTER_IPC_CHANNELS.getFieldValues)

    dispose()
  })
})
