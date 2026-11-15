import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ReconcileBuffersResult,
  SharedBufferHubEvent,
  SharedBufferStateSnapshot
} from '@shared/documentBuffer'
import { BUFFER_IPC_CHANNELS } from '@shared/ipc'
import { getWorkspacePathKey } from '@shared/workspace'
import { ConfigService } from '../config/ConfigService'
import { LogService } from '../logging/LogService'
import { createFakeIpcMain } from './ipcTestHelpers'
import {
  createSharedDocumentBufferHub,
  registerBufferIpc,
  type BufferWebContentsLike
} from './registerBufferIpc'
import { WorkspaceFsService } from '../workspace/WorkspaceFsService'

interface FakeWindowWebContents extends BufferWebContentsLike {
  events: SharedBufferHubEvent[]
  destroy: () => void
}

function createFakeWindowWebContents(id: number): FakeWindowWebContents {
  let destroyed = false
  const destroyedListeners: Array<() => void> = []
  const events: SharedBufferHubEvent[] = []

  return {
    id,
    events,
    isDestroyed: () => destroyed,
    send: (channel: string, payload: unknown) => {
      if (destroyed) return
      if (channel === BUFFER_IPC_CHANNELS.event) {
        events.push(payload as SharedBufferHubEvent)
      }
    },
    once: (eventName: 'destroyed', listener: () => void) => {
      if (eventName === 'destroyed') {
        destroyedListeners.push(listener)
      }
    },
    destroy: () => {
      if (destroyed) return
      destroyed = true
      for (const listener of destroyedListeners.splice(0)) {
        listener()
      }
    }
  }
}

describe('registerBufferIpc', () => {
  let tempDir: string
  let workspaceDir: string
  let configPath: string
  let workspaceService: WorkspaceFsService

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'wiki-editor-buffer-ipc-'))
    workspaceDir = join(tempDir, 'docs')
    configPath = join(tempDir, 'config.json')
    await mkdir(workspaceDir, { recursive: true })
    workspaceService = new WorkspaceFsService({ watchDebounceMs: 30 })
  })

  afterEach(async () => {
    workspaceService.dispose()
    await rm(tempDir, { recursive: true, force: true })
  })

  it('shares workspace and config document buffers in real time across multiple windows', async () => {
    const workspaceInfo = await workspaceService.openWorkspace(workspaceDir)
    const notePath = join(workspaceInfo.rootPath, 'note.md')
    await writeFile(notePath, '# Initial note', 'utf8')

    const configService = new ConfigService(configPath)
    await configService.get()

    const ipcMain = createFakeIpcMain()
    const win1 = createFakeWindowWebContents(101)
    const win2 = createFakeWindowWebContents(102)
    const liveWindows = [win1, win2]

    const dispose = registerBufferIpc({
      ipcMain,
      configService,
      hub: createSharedDocumentBufferHub({ workspaceService, configService }),
      getTargets: () => liveWindows
    })

    // Window 1 opens workspace file and edits it dirty before Window 2 opens it
    const openedInWin1 = await ipcMain.invokeFrom<{ key: string; content: string; isDirty: boolean }>(
      win1,
      BUFFER_IPC_CHANNELS.openWorkspaceFile,
      notePath,
      'note.md'
    )
    expect(openedInWin1.content).toBe('# Initial note')
    expect(openedInWin1.isDirty).toBe(false)

    await ipcMain.invokeFrom(win1, BUFFER_IPC_CHANNELS.syncWindowTabs, [openedInWin1.key])
    await ipcMain.invokeFrom(win1, BUFFER_IPC_CHANNELS.updateContent, openedInWin1.key, '# Unsaved draft')

    // Window 2 opens the same note and immediately receives Window 1's unsaved buffer
    const openedInWin2 = await ipcMain.invokeFrom<{
      key: string
      content: string
      savedContent: string
      isDirty: boolean
      version: number
    }>(win2, BUFFER_IPC_CHANNELS.openWorkspaceFile, notePath, 'note.md')
    expect(openedInWin2.key).toBe(openedInWin1.key)
    expect(openedInWin2.content).toBe('# Unsaved draft')
    expect(openedInWin2.savedContent).toBe('# Initial note')
    expect(openedInWin2.isDirty).toBe(true)

    await ipcMain.invokeFrom(win2, BUFFER_IPC_CHANNELS.syncWindowTabs, [openedInWin2.key])

    // Editing in Window 2 broadcasts updated state to both Window 1 and Window 2
    win1.events.length = 0
    win2.events.length = 0
    await ipcMain.invokeFrom(win2, BUFFER_IPC_CHANNELS.updateContent, openedInWin1.key, '# Edited in win2')

    const latestWin1State = win1.events.filter((e) => e.type === 'state-changed').at(-1)
    const latestWin2State = win2.events.filter((e) => e.type === 'state-changed').at(-1)
    expect(latestWin1State?.snapshot.buffers[openedInWin1.key]?.content).toBe('# Edited in win2')
    expect(latestWin2State?.snapshot.buffers[openedInWin1.key]?.content).toBe('# Edited in win2')
    expect(latestWin1State?.snapshot.buffers[openedInWin1.key]?.isDirty).toBe(true)

    // Saving from Window 1 writes disk, clears isDirty in both windows, and emits workspace-saved
    win1.events.length = 0
    win2.events.length = 0
    const saveResult = await ipcMain.invokeFrom<{ ok: boolean }>(
      win1,
      BUFFER_IPC_CHANNELS.saveBuffer,
      openedInWin1.key
    )
    expect(saveResult.ok).toBe(true)
    expect(await readFile(notePath, 'utf8')).toBe('# Edited in win2')
    expect(win1.events.some((e) => e.type === 'workspace-saved')).toBe(true)
    expect(win2.events.filter((e) => e.type === 'state-changed').at(-1)?.snapshot.buffers[openedInWin1.key]?.isDirty).toBe(
      false
    )

    // Config document is also shared and saved cleanly across windows
    const configWin1 = await ipcMain.invokeFrom<{ key: string; kind: string; content: string }>(
      win1,
      BUFFER_IPC_CHANNELS.openConfigDocument
    )
    expect(configWin1.kind).toBe('config')
    await ipcMain.invokeFrom(win1, BUFFER_IPC_CHANNELS.syncWindowTabs, [openedInWin1.key, configWin1.key])

    const parsedConfig = JSON.parse(configWin1.content)
    const updatedConfigRaw = JSON.stringify({ ...parsedConfig, theme: 'dark' }, null, 2)
    await ipcMain.invokeFrom(win1, BUFFER_IPC_CHANNELS.updateContent, configWin1.key, updatedConfigRaw)

    const configWin2 = await ipcMain.invokeFrom<{ key: string; content: string; isDirty: boolean }>(
      win2,
      BUFFER_IPC_CHANNELS.openConfigDocument
    )
    expect(configWin2.key).toBe(configWin1.key)
    expect(configWin2.isDirty).toBe(true)
    expect(configWin2.content).toContain('"theme": "dark"')

    await ipcMain.invokeFrom(win2, BUFFER_IPC_CHANNELS.saveBuffer, configWin1.key)
    expect((await configService.get()).theme).toBe('dark')

    dispose()
    expect(ipcMain.hasHandler(BUFFER_IPC_CHANNELS.getSnapshot)).toBe(false)
  })

  it('tracks per-window tab references and cleans up buffers when last tab closes or windows destroy', async () => {
    const workspaceInfo = await workspaceService.openWorkspace(workspaceDir)
    const filePath = join(workspaceInfo.rootPath, 'shared.md')
    await writeFile(filePath, 'Original', 'utf8')

    const configService = new ConfigService(configPath)
    await configService.get()

    const ipcMain = createFakeIpcMain()
    const win1 = createFakeWindowWebContents(201)
    const win2 = createFakeWindowWebContents(202)
    const liveWindows = [win1, win2]

    const dispose = registerBufferIpc({
      ipcMain,
      configService,
      hub: createSharedDocumentBufferHub({ workspaceService, configService }),
      getTargets: () => liveWindows
    })

    const key = getWorkspacePathKey(filePath)
    await ipcMain.invokeFrom(win1, BUFFER_IPC_CHANNELS.openWorkspaceFile, filePath, 'shared.md')
    await ipcMain.invokeFrom(win1, BUFFER_IPC_CHANNELS.syncWindowTabs, [key])
    await ipcMain.invokeFrom(win1, BUFFER_IPC_CHANNELS.updateContent, key, 'Modified in win1')

    await ipcMain.invokeFrom(win2, BUFFER_IPC_CHANNELS.openWorkspaceFile, filePath, 'shared.md')
    await ipcMain.invokeFrom(win2, BUFFER_IPC_CHANNELS.syncWindowTabs, [key])

    let snapshot = await ipcMain.invokeFrom<SharedBufferStateSnapshot>(win1, BUFFER_IPC_CHANNELS.getSnapshot)
    expect(snapshot.tabCounts[key]).toBe(2)

    // Closing tab in win2 drops count to 1 and keeps dirty buffer alive
    snapshot = await ipcMain.invokeFrom<SharedBufferStateSnapshot>(win2, BUFFER_IPC_CHANNELS.syncWindowTabs, [])
    expect(snapshot.tabCounts[key]).toBe(1)
    expect(snapshot.buffers[key]?.content).toBe('Modified in win1')

    // Re-open in win2, then destroy win2 unexpectedly -> count drops back to 1, buffer stays alive
    await ipcMain.invokeFrom(win2, BUFFER_IPC_CHANNELS.syncWindowTabs, [key])
    snapshot = await ipcMain.invokeFrom<SharedBufferStateSnapshot>(win1, BUFFER_IPC_CHANNELS.getSnapshot)
    expect(snapshot.tabCounts[key]).toBe(2)

    win2.destroy()
    snapshot = await ipcMain.invokeFrom<SharedBufferStateSnapshot>(win1, BUFFER_IPC_CHANNELS.getSnapshot)
    expect(snapshot.tabCounts[key]).toBe(1)
    expect(snapshot.buffers[key]?.content).toBe('Modified in win1')

    // Closing remaining tab in win1 prunes buffer cleanly
    snapshot = await ipcMain.invokeFrom<SharedBufferStateSnapshot>(win1, BUFFER_IPC_CHANNELS.syncWindowTabs, [])
    expect(snapshot.tabCounts[key]).toBeUndefined()
    expect(snapshot.buffers[key]).toBeUndefined()

    dispose()
  })

  it('unifies debounced autoSave across windows without duplicate writes, pauses for dialogs, and stops retries on failure until next edit', async () => {
    const workspaceInfo = await workspaceService.openWorkspace(workspaceDir)
    const notePath = join(workspaceInfo.rootPath, 'autosave.md')
    await writeFile(notePath, 'v0', 'utf8')

    const configService = new ConfigService(configPath)
    await configService.get()
    const initialConfig = await configService.update({ autoSave: true, autoSaveDelayMs: 40 })

    const ipcMain = createFakeIpcMain()
    const win1 = createFakeWindowWebContents(301)
    const win2 = createFakeWindowWebContents(302)
    const dispose = registerBufferIpc({
      ipcMain,
      configService,
      hub: createSharedDocumentBufferHub({
        workspaceService,
        configService,
        initialAutoSaveConfig: {
          autoSave: initialConfig.autoSave,
          autoSaveDelayMs: initialConfig.autoSaveDelayMs
        }
      }),
      getTargets: () => [win1, win2]
    })

    const writeSpy = vi.spyOn(workspaceService, 'writeFile')

    const key = getWorkspacePathKey(notePath)
    await ipcMain.invokeFrom(win1, BUFFER_IPC_CHANNELS.openWorkspaceFile, notePath, 'autosave.md')
    await ipcMain.invokeFrom(win1, BUFFER_IPC_CHANNELS.syncWindowTabs, [key])
    await ipcMain.invokeFrom(win2, BUFFER_IPC_CHANNELS.openWorkspaceFile, notePath, 'autosave.md')
    await ipcMain.invokeFrom(win2, BUFFER_IPC_CHANNELS.syncWindowTabs, [key])

    // Config buffer stays dirty without triggering auto-save
    const configBuf = await ipcMain.invokeFrom<{ key: string; content: string }>(
      win1,
      BUFFER_IPC_CHANNELS.openConfigDocument
    )
    await ipcMain.invokeFrom(win1, BUFFER_IPC_CHANNELS.syncWindowTabs, [key, configBuf.key])
    await ipcMain.invokeFrom(win1, BUFFER_IPC_CHANNELS.updateContent, configBuf.key, '{"invalid":')

    // Pause while win2 has a dialog open, then edit in win1 -> should NOT save while paused
    await ipcMain.invokeFrom(win2, BUFFER_IPC_CHANNELS.setAutoSavePaused, true)
    await ipcMain.invokeFrom(win1, BUFFER_IPC_CHANNELS.updateContent, key, 'v1 from win1')
    await new Promise((resolve) => setTimeout(resolve, 90))
    expect(writeSpy).not.toHaveBeenCalled()

    // Unpause -> single unified write saves v1 across both windows
    await ipcMain.invokeFrom(win2, BUFFER_IPC_CHANNELS.setAutoSavePaused, false)
    await vi.waitFor(async () => {
      expect(await readFile(notePath, 'utf8')).toBe('v1 from win1')
    })
    expect(writeSpy).toHaveBeenCalledTimes(1)

    // Write failure emits save-error and pauses retries until the user edits again
    writeSpy.mockRejectedValueOnce(new Error('Disk full'))
    win1.events.length = 0
    await ipcMain.invokeFrom(win2, BUFFER_IPC_CHANNELS.updateContent, key, 'v2 fails')

    await vi.waitFor(() => {
      expect(win1.events.some((e) => e.type === 'save-error' && e.message.includes('Disk full'))).toBe(
        true
      )
    })
    await new Promise((resolve) => setTimeout(resolve, 90))
    expect(writeSpy).toHaveBeenCalledTimes(2)

    await ipcMain.invokeFrom(win2, BUFFER_IPC_CHANNELS.updateContent, key, 'v3 succeeds')
    await vi.waitFor(async () => {
      expect(await readFile(notePath, 'utf8')).toBe('v3 succeeds')
    })
    expect(writeSpy).toHaveBeenCalledTimes(3)

    dispose()
  })

  it('preserves concurrent edits during in-flight save, broadcasts rename/delete/reconcile updates, and redacts content from IPC logs', async () => {
    const workspaceInfo = await workspaceService.openWorkspace(workspaceDir)
    const notePath = join(workspaceInfo.rootPath, 'doc.md')
    const cleanChangedPath = join(workspaceInfo.rootPath, 'clean.md')
    const cleanDeletedPath = join(workspaceInfo.rootPath, 'deleted.md')
    await writeFile(notePath, 'initial', 'utf8')
    await writeFile(cleanChangedPath, 'before', 'utf8')
    await writeFile(cleanDeletedPath, 'bye', 'utf8')

    const configService = new ConfigService(configPath)
    await configService.get()
    const logService = new LogService(join(tempDir, 'logs'))
    const infoSpy = vi.spyOn(logService, 'info')

    const ipcMain = createFakeIpcMain()
    const win1 = createFakeWindowWebContents(401)
    const win2 = createFakeWindowWebContents(402)
    const dispose = registerBufferIpc({
      ipcMain,
      configService,
      hub: createSharedDocumentBufferHub({ workspaceService, configService, logService }),
      getTargets: () => [win1, win2],
      logService
    })

    const noteKey = getWorkspacePathKey(notePath)
    const cleanKey = getWorkspacePathKey(cleanChangedPath)
    const deletedKey = getWorkspacePathKey(cleanDeletedPath)

    await ipcMain.invokeFrom(win1, BUFFER_IPC_CHANNELS.openWorkspaceFile, notePath, 'doc.md')
    await ipcMain.invokeFrom(win1, BUFFER_IPC_CHANNELS.openWorkspaceFile, cleanChangedPath, 'clean.md')
    await ipcMain.invokeFrom(win1, BUFFER_IPC_CHANNELS.openWorkspaceFile, cleanDeletedPath, 'deleted.md')
    await ipcMain.invokeFrom(win1, BUFFER_IPC_CHANNELS.syncWindowTabs, [
      noteKey,
      cleanKey,
      deletedKey
    ])
    await ipcMain.invokeFrom(win2, BUFFER_IPC_CHANNELS.syncWindowTabs, [noteKey])

    const secretText = 'SECRET_CONFIDENTIAL_LINE_v1'
    await ipcMain.invokeFrom(win1, BUFFER_IPC_CHANNELS.updateContent, noteKey, secretText)

    // Verify IPC log metadata redacted note content
    expect(JSON.stringify(infoSpy.mock.calls)).not.toContain(secretText)

    // Hold save v1 in flight while user types v2
    let releaseWrite!: () => void
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve
    })
    const realWriteFile = workspaceService.writeFile.bind(workspaceService)
    vi.spyOn(workspaceService, 'writeFile').mockImplementationOnce(async (p, c) => {
      await writeGate
      return realWriteFile(p, c)
    })

    const savePromise = ipcMain.invokeFrom<{ ok: boolean }>(
      win1,
      BUFFER_IPC_CHANNELS.saveBuffer,
      noteKey
    )
    await new Promise((resolve) => setTimeout(resolve, 10))
    await ipcMain.invokeFrom(win2, BUFFER_IPC_CHANNELS.updateContent, noteKey, 'v2 while saving')

    releaseWrite()
    await savePromise

    let snap = await ipcMain.invokeFrom<SharedBufferStateSnapshot>(win2, BUFFER_IPC_CHANNELS.getSnapshot)
    expect(snap.buffers[noteKey]?.savedContent).toBe(secretText)
    expect(snap.buffers[noteKey]?.content).toBe('v2 while saving')
    expect(snap.buffers[noteKey]?.isDirty).toBe(true)

    // Disk reconciliation refreshes clean changed files, removes clean missing files, warns on dirty conflict
    await writeFile(cleanChangedPath, 'after disk edit', 'utf8')
    await unlink(cleanDeletedPath)
    await writeFile(notePath, 'external edit on disk', 'utf8')

    win2.events.length = 0
    const reconcile = await ipcMain.invokeFrom<ReconcileBuffersResult>(
      win1,
      BUFFER_IPC_CHANNELS.reconcileWorkspaceBuffersWithDisk
    )
    expect(reconcile.closedKeys).toEqual([deletedKey])
    expect(reconcile.warnings.join(' ')).toContain('doc.md')

    snap = await ipcMain.invokeFrom<SharedBufferStateSnapshot>(win2, BUFFER_IPC_CHANNELS.getSnapshot)
    expect(snap.buffers[cleanKey]?.content).toBe('after disk edit')
    expect(snap.buffers[deletedKey]).toBeUndefined()
    expect(snap.buffers[noteKey]?.content).toBe('v2 while saving')

    // Rename & delete broadcast paths-remapped and buffers-closed
    const renamedNotePath = join(workspaceInfo.rootPath, 'renamed.md')
    const remappings = await ipcMain.invokeFrom<Array<{ oldKey: string; newKey: string }>>(
      win1,
      BUFFER_IPC_CHANNELS.syncRenamedPath,
      notePath,
      renamedNotePath
    )
    expect(remappings).toEqual([
      { oldKey: noteKey, newKey: getWorkspacePathKey(renamedNotePath) }
    ])
    expect(win2.events.some((e) => e.type === 'paths-remapped')).toBe(true)

    const closed = await ipcMain.invokeFrom<string[]>(
      win1,
      BUFFER_IPC_CHANNELS.syncDeletedPath,
      cleanChangedPath
    )
    expect(closed).toEqual([cleanKey])
    expect(win2.events.some((e) => e.type === 'buffers-closed')).toBe(true)

    await logService.flush()
    dispose()
  })

  it('keeps buffer alive when a second window opens it before syncWindowTabs and the first window is destroyed', async () => {
    const workspaceInfo = await workspaceService.openWorkspace(workspaceDir)
    const configService = new ConfigService(configPath)
    await configService.get()

    const notePath = join(workspaceInfo.rootPath, 'multi-open.md')
    const noteKey = getWorkspacePathKey(notePath)
    await writeFile(notePath, '# Shared Open', 'utf8')

    const ipcMain = createFakeIpcMain()
    const win1 = createFakeWindowWebContents(101)
    const win2 = createFakeWindowWebContents(102)
    const targets = [win1, win2]

    const dispose = registerBufferIpc({
      ipcMain,
      configService,
      hub: createSharedDocumentBufferHub({ workspaceService, configService }),
      getTargets: () => targets.filter((t) => !t.isDestroyed())
    })

    await ipcMain.invokeFrom(win1, BUFFER_IPC_CHANNELS.openWorkspaceFile, notePath, 'multi-open.md')
    await ipcMain.invokeFrom(win2, BUFFER_IPC_CHANNELS.openWorkspaceFile, notePath, 'multi-open.md')

    win1.destroy()
    let snap = await ipcMain.invokeFrom<SharedBufferStateSnapshot>(win2, BUFFER_IPC_CHANNELS.getSnapshot)
    expect(snap.buffers[noteKey]?.content).toBe('# Shared Open')

    win2.destroy()
    const win3 = createFakeWindowWebContents(103)
    targets.push(win3)
    snap = await ipcMain.invokeFrom<SharedBufferStateSnapshot>(win3, BUFFER_IPC_CHANNELS.getSnapshot)
    expect(snap.buffers[noteKey]).toBeUndefined()

    dispose()
  })
})
