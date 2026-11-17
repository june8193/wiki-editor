import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WORKSPACE_STATE_IPC_CHANNELS } from '@shared/ipc'
import { LogService } from '../logging/LogService'
import { WorkspaceStateService } from '../workspace/WorkspaceStateService'
import type { WebContentsLike } from './ipcHelpers'
import { createFakeIpcMain } from './ipcTestHelpers'
import { registerWorkspaceStateIpc } from './registerWorkspaceStateIpc'

describe('registerWorkspaceStateIpc', () => {
  let tempDir: string
  let workspaceDir: string
  let statePath: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'wiki-editor-ws-state-ipc-'))
    workspaceDir = join(tempDir, 'wiki')
    statePath = join(tempDir, 'workspace-state.json')
    await mkdir(workspaceDir, { recursive: true })
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('handles workspace-state get/save, restricts access to main window, logs compact metadata, and disposes cleanly', async () => {
    const logService = new LogService(join(tempDir, 'logs'))
    const workspaceStateService = new WorkspaceStateService(statePath, { logService })
    const ipcMain = createFakeIpcMain()

    const mainTarget: WebContentsLike = {
      isDestroyed: () => false,
      send: () => undefined
    }
    const auxTarget: WebContentsLike = {
      isDestroyed: () => false,
      send: () => undefined
    }

    const dispose = registerWorkspaceStateIpc({
      ipcMain,
      workspaceStateService,
      isMainWindowSender: (sender) => sender === mainTarget,
      logService
    })

    expect(await ipcMain.invokeFrom(mainTarget, WORKSPACE_STATE_IPC_CHANNELS.get, workspaceDir)).toBeNull()

    await expect(
      ipcMain.invokeFrom(auxTarget, WORKSPACE_STATE_IPC_CHANNELS.get, workspaceDir)
    ).rejects.toThrow(/main window/i)
    await expect(
      ipcMain.invokeFrom(auxTarget, WORKSPACE_STATE_IPC_CHANNELS.save, workspaceDir, {
        expandedDirs: [join(workspaceDir, 'docs')]
      })
    ).rejects.toThrow(/main window/i)

    const saved = await ipcMain.invokeFrom(mainTarget, WORKSPACE_STATE_IPC_CHANNELS.save, workspaceDir, {
      expandedDirs: [join(workspaceDir, 'docs')],
      layout: {
        splitMode: 'horizontal',
        splitRatio: 0.6,
        activePaneId: 'primary',
        panes: {
          primary: {
            tabs: [
              {
                path: join(workspaceDir, 'a.md'),
                mode: 'raw',
                cursor: { selectionStart: 0, selectionEnd: 0 },
                scrollTop: 0,
                splitPreviewRatio: 0.5
              }
            ],
            activeTabPath: join(workspaceDir, 'a.md')
          },
          secondary: {
            tabs: [
              {
                path: join(workspaceDir, 'b.md'),
                mode: 'preview',
                cursor: { selectionStart: 0, selectionEnd: 0 },
                scrollTop: 20,
                splitPreviewRatio: 0.5
              }
            ],
            activeTabPath: join(workspaceDir, 'b.md')
          }
        }
      }
    })
    expect(saved).toMatchObject({
      rootPath: workspaceDir,
      expandedDirs: [join(workspaceDir, 'docs')]
    })

    const loaded = await ipcMain.invokeFrom(mainTarget, WORKSPACE_STATE_IPC_CHANNELS.get, workspaceDir)
    expect(loaded).toEqual(saved)

    const logEntries = await logService.readEntries()
    const saveLog = logEntries.find(
      (entry) =>
        entry.category === 'ipc' &&
        entry.data?.channel === WORKSPACE_STATE_IPC_CHANNELS.save &&
        entry.data?.success === true
    )
    expect(saveLog?.data).toMatchObject({
      rootPath: workspaceDir,
      expandedDirCount: 1,
      hasLayout: true,
      tabCount: 2
    })
    expect(JSON.stringify(saveLog)).not.toContain('splitPreviewRatio')

    dispose()
    expect(ipcMain.hasHandler(WORKSPACE_STATE_IPC_CHANNELS.get)).toBe(false)
    expect(ipcMain.hasHandler(WORKSPACE_STATE_IPC_CHANNELS.save)).toBe(false)
  })
})
