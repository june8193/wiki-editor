import { describe, expect, it, vi } from 'vitest'
import { SharedDocumentBufferHub } from './sharedDocumentBufferHub'
import type { BeforeInputKeyEventLike } from './tabDragSession'
import type {
  ActiveTabDragSession,
  ScreenLike,
  TabTransferPayload,
  WindowBounds,
  WindowRole
} from './window'
import { isSameWorkspacePath, normalizeWorkspacePath, type WorkspaceInfo } from './workspace'
import {
  type CreateHostedWindowParams,
  type HostedWindow,
  type HostedWindowCallbacks,
  WindowSessionCoordinator,
  type WindowSessionHost,
  type WindowSessionServices
} from './windowSessionCoordinator'

interface FakeHostedWindow extends HostedWindow {
  role: WindowRole
  sessionId: number
  closedCount: number
  closeRequestCount: number
  focusCount: number
  restoreCount: number
  setMinimized: (minimized: boolean) => void
  setFocused: (focused: boolean) => void
  simulateUserClose: () => void
  emitFocus: () => void
  emitBeforeInput: (input: BeforeInputKeyEventLike) => void
  destroy: () => void
}

interface FakeSessionServices extends WindowSessionServices {
  readonly files: Map<string, string>
  disposed: boolean
  scanCancelCount: number
}

function createInMemorySessionHost(options?: {
  directories?: string[]
  files?: Record<string, string>
  screen?: ScreenLike
  cleanCloseFlushTimeoutMs?: number
}) {
  const dirs = new Set<string>((options?.directories ?? []).map(normalizeWorkspacePath))
  const files = new Map<string, string>(Object.entries(options?.files ?? {}))
  const createdWindows: FakeHostedWindow[] = []
  let nextWindowId = 1
  let focusedWindowId: number | undefined

  const host: WindowSessionHost<FakeSessionServices> = {
    screen: options?.screen ?? {
      getDisplayNearestPoint: () => ({
        workArea: { x: 0, y: 0, width: 1920, height: 1080 }
      })
    },
    cleanCloseFlushTimeoutMs: options?.cleanCloseFlushTimeoutMs,
    getFocusedWindowId: () => focusedWindowId,
    createSessionServices(): FakeSessionServices {
      let activeRoot: string | null = null
      const bufferHub = new SharedDocumentBufferHub({
        initialAutoSaveConfig: { autoSave: false },
        storage: {
          readWorkspaceFile: async (filePath) => {
            const content = files.get(filePath)
            if (content === undefined) throw new Error(`ENOENT: ${filePath}`)
            return content
          },
          writeWorkspaceFile: async (filePath, content) => {
            files.set(filePath, content)
          },
          getConfigPath: async () => 'C:/Users/test/config.json',
          readConfigRaw: async () => '{}',
          saveConfigRaw: async () => ({})
        }
      })

      const services: FakeSessionServices = {
        bufferHub,
        files,
        disposed: false,
        scanCancelCount: 0,
        getWorkspaceRoot: () => activeRoot,
        openWorkspace: async (resolvedRootPath: string): Promise<WorkspaceInfo> => {
          activeRoot = resolvedRootPath
          return {
            rootPath: resolvedRootPath,
            name: resolvedRootPath.split(/[\\/]/).filter(Boolean).at(-1) ?? resolvedRootPath,
            entries: []
          }
        },
        cancelActiveWorkspaceScans: () => {
          services.scanCancelCount += 1
        },
        dispose: () => {
          services.disposed = true
          bufferHub.dispose()
        }
      }
      return services
    },
    createWindow(params: CreateHostedWindowParams<FakeSessionServices>): FakeHostedWindow {
      const windowId = nextWindowId++
      const callbacks: HostedWindowCallbacks = params.callbacks
      let destroyed = false
      let minimized = false
      let focused = false
      let closedCount = 0
      let closeRequestCount = 0
      let focusCount = 0
      let restoreCount = 0
      const bounds: WindowBounds = {
        x: 100,
        y: 120,
        width: params.role === 'main' ? 1280 : 960,
        height: params.role === 'main' ? 820 : 760,
        ...params.bounds
      }

      const destroy = (): void => {
        if (destroyed) return
        destroyed = true
        if (focusedWindowId === windowId) {
          focusedWindowId = undefined
        }
        callbacks.onClosed()
      }

      const fakeWindow: FakeHostedWindow = {
        windowId,
        role: params.role,
        sessionId: params.sessionId,
        get closedCount() {
          return closedCount
        },
        get closeRequestCount() {
          return closeRequestCount
        },
        get focusCount() {
          return focusCount
        },
        get restoreCount() {
          return restoreCount
        },
        getBounds: () => ({ ...bounds }),
        isDestroyed: () => destroyed,
        isMinimized: () => minimized,
        isFocused: () => focused,
        restore: () => {
          minimized = false
          restoreCount += 1
        },
        focus: () => {
          focused = true
          focusedWindowId = windowId
          focusCount += 1
          callbacks.onFocus()
        },
        close: () => {
          closedCount += 1
          if (callbacks.onCloseAttempt()) {
            destroy()
          }
        },
        sendCloseRequested: () => {
          closeRequestCount += 1
        },
        setMinimized: (next) => {
          minimized = next
        },
        setFocused: (next) => {
          focused = next
          focusedWindowId = next ? windowId : focusedWindowId === windowId ? undefined : focusedWindowId
        },
        simulateUserClose: () => {
          if (destroyed) return
          if (callbacks.onCloseAttempt()) {
            destroy()
          }
        },
        emitFocus: () => {
          focused = true
          focusedWindowId = windowId
          callbacks.onFocus()
        },
        emitBeforeInput: (input) => {
          if (!destroyed) {
            callbacks.onBeforeInput(input)
          }
        },
        destroy
      }

      createdWindows.push(fakeWindow)
      return fakeWindow
    },
    async resolveValidWorkspacePath(rawPath: string): Promise<string> {
      const normalized = normalizeWorkspacePath(rawPath)
      if (!normalized) {
        throw new Error('워크스페이스 경로가 비어 있습니다.')
      }
      for (const dir of dirs) {
        if (isSameWorkspacePath(dir, normalized)) {
          return dir
        }
      }
      throw new Error(`워크스페이스 폴더를 찾을 수 없습니다: ${rawPath}`)
    },
    async tryResolveWorkspacePath(rawPath: string): Promise<string | null> {
      const normalized = normalizeWorkspacePath(rawPath)
      if (!normalized) return null
      for (const dir of dirs) {
        if (isSameWorkspacePath(dir, normalized)) {
          return dir
        }
      }
      return null
    }
  }

  return { host, dirs, files, createdWindows }
}

describe('WindowSessionCoordinator', () => {
  it('manages main/auxiliary window init contexts, pending transfer preservation, syncWindowTabs 0-tab auxiliary auto-close, and cascading main-window close', async () => {
    const { host, createdWindows } = createInMemorySessionHost({
      directories: ['C:/wiki/alpha'],
      files: {
        'C:/wiki/alpha/one.md': '# One',
        'C:/wiki/alpha/two.md': '# Two'
      }
    })
    const coordinator = new WindowSessionCoordinator(host)

    try {
      const mainWin = coordinator.createMainWindow({ initialWorkspacePath: 'C:/wiki/alpha' }) as FakeHostedWindow
      const mainSession = coordinator.resolveSessionForWindow(mainWin.windowId)!
      expect(mainSession.isMainWindow(mainWin.windowId)).toBe(true)
      expect(coordinator.getWindowInitContext(mainWin.windowId)).toEqual({
        role: 'main',
        initialTabs: [],
        initialWorkspacePath: 'C:/wiki/alpha'
      })

      await coordinator.openWorkspaceInSession(mainWin.windowId, 'C:/wiki/alpha')
      const oneBuf = await mainSession.services.bufferHub.openWorkspaceFile(
        'C:/wiki/alpha/one.md',
        'one.md',
        undefined,
        mainWin.windowId
      )
      const twoBuf = await mainSession.services.bufferHub.openWorkspaceFile(
        'C:/wiki/alpha/two.md',
        'two.md',
        undefined,
        mainWin.windowId
      )
      coordinator.syncWindowTabs(mainWin.windowId, [oneBuf.key, twoBuf.key])
      mainSession.services.bufferHub.updateContent(oneBuf.key, '# One unsaved')

      const onePayload: TabTransferPayload = {
        bufferKey: oneBuf.key,
        mode: 'wysiwyg',
        cursor: { selectionStart: 2, selectionEnd: 5 },
        scrollTop: 90
      }
      const { windowId: aux1Id } = coordinator.detachTabToNewWindow(mainWin.windowId, onePayload)
      const aux1 = createdWindows[1]
      expect(aux1.windowId).toBe(aux1Id)
      expect(coordinator.getWindowInitContext(aux1Id)).toEqual({
        role: 'auxiliary',
        initialTabs: [onePayload],
        initialWorkspacePath: 'C:\\wiki\\alpha'
      })
      await expect(
        coordinator.openWorkspaceInNewWindow(aux1Id, 'C:/wiki/alpha')
      ).rejects.toThrow(/Only the main window can open a workspace/)

      // Main clears one.md before aux1 hydrates -> pending transfer keeps dirty buffer alive
      coordinator.syncWindowTabs(mainWin.windowId, [twoBuf.key], { releasePending: true })
      expect(mainSession.services.bufferHub.getBuffer(oneBuf.key)?.content).toBe('# One unsaved')

      // Pre-hydration syncWindowTabs([]) keeps aux1 open
      coordinator.syncWindowTabs(aux1Id, [])
      expect(aux1.isDestroyed()).toBe(false)

      // Hydrating [one] and dropping back to [] auto-closes aux1 cleanly
      coordinator.syncWindowTabs(aux1Id, [oneBuf.key])
      expect(aux1.isDestroyed()).toBe(false)
      coordinator.syncWindowTabs(aux1Id, [])
      expect(aux1.closedCount).toBe(1)
      expect(aux1.isDestroyed()).toBe(true)
      expect(mainWin.isDestroyed()).toBe(false)

      // Closing main window cascades to all remaining auxiliary windows and disposes session
      const twoPayload: TabTransferPayload = {
        bufferKey: twoBuf.key,
        mode: 'raw',
        cursor: { selectionStart: 0, selectionEnd: 0 },
        scrollTop: 0
      }
      const { windowId: aux2Id } = coordinator.detachTabToNewWindow(mainWin.windowId, twoPayload)
      const aux2 = createdWindows[2]
      coordinator.syncWindowTabs(aux2Id, [twoBuf.key])
      coordinator.syncWindowTabs(mainWin.windowId, [])

      mainWin.simulateUserClose()
      expect(aux2.isDestroyed()).toBe(true)
      expect(mainWin.isDestroyed()).toBe(true)
      expect(mainSession.services.disposed).toBe(true)
      expect(coordinator.resolveSessionForWindow(mainWin.windowId)).toBeUndefined()
    } finally {
      coordinator.dispose()
    }
  })

  it('prevents duplicate workspace sessions across pendingInitialWorkspacePath, pendingOpenWorkspacePath, and activeRoot while clamping offset main bounds', async () => {
    const { host, dirs, createdWindows } = createInMemorySessionHost({
      directories: ['C:/wiki/alpha', 'C:/wiki/beta', 'C:/wiki/gamma', 'C:/wiki/delta'],
      screen: {
        getDisplayNearestPoint: () => ({
          workArea: { x: 0, y: 0, width: 1920, height: 1080 }
        })
      }
    })
    const coordinator = new WindowSessionCoordinator(host)

    try {
      const main1 = coordinator.createMainWindow({
        bounds: { x: 620, y: 240, width: 1280, height: 820 }
      }) as FakeHostedWindow
      await coordinator.openWorkspaceInSession(main1.windowId, 'C:/wiki/alpha')

      // Invalid path rejects before creating a second window
      await expect(
        coordinator.openWorkspaceInNewWindow(main1.windowId, 'C:/wiki/missing')
      ).rejects.toThrow(/찾을 수 없습니다/)
      expect(createdWindows).toHaveLength(1)

      // Open Beta in new offset window (clamped from 660,280 -> maxX=640, maxY=260 inside 1920x1080)
      const openBeta = await coordinator.openWorkspaceInNewWindow(main1.windowId, 'C:/wiki/beta')
      const main2 = createdWindows[1]
      expect(openBeta).toEqual({
        status: 'opened',
        windowId: main2.windowId,
        rootPath: 'C:\\wiki\\beta'
      })
      expect(main2.getBounds()).toEqual({ x: 640, y: 260, width: 1280, height: 820 })

      // Before main2 finishes opening Beta, duplicate check matches pendingInitialWorkspacePath and restores/focuses main2
      main2.setMinimized(true)
      const dupPending = await coordinator.openWorkspaceInNewWindow(main1.windowId, 'C:/wiki/beta/')
      expect(dupPending).toEqual({
        status: 'focused-existing',
        windowId: main2.windowId,
        rootPath: 'C:\\wiki\\beta'
      })
      expect(main2.restoreCount).toBe(1)
      expect(main2.focusCount).toBe(1)
      expect(createdWindows).toHaveLength(2)

      // focusWorkspaceIfOpen finds main1 from main2 and skips unopened gamma
      expect(await coordinator.focusWorkspaceIfOpen(main2.windowId, 'C:/wiki/gamma')).toEqual({
        focused: false
      })
      main1.setMinimized(true)
      expect(await coordinator.focusWorkspaceIfOpen(main2.windowId, 'c:/wiki/alpha/')).toEqual({
        focused: true,
        windowId: main1.windowId,
        rootPath: 'C:\\wiki\\alpha'
      })
      expect(main1.restoreCount).toBe(1)
      expect(main1.focusCount).toBe(1)

      // Raw openWorkspaceInSession targeting another session's workspace focuses it and rejects
      main1.setMinimized(true)
      await expect(
        coordinator.openWorkspaceInSession(main2.windowId, 'C:/wiki/alpha')
      ).rejects.toThrow(/이미 다른 창/)
      expect(main1.restoreCount).toBe(2)
      expect(main1.focusCount).toBe(2)

      // In-flight switch Alpha -> Gamma reserves BOTH outgoing Alpha and incoming Gamma
      const main1Services = coordinator.resolveSessionForWindow(main1.windowId)!.services
      const origOpen = main1Services.openWorkspace
      let releaseGamma!: () => void
      const gammaBarrier = new Promise<void>((resolve) => {
        releaseGamma = resolve
      })
      let gammaStarted!: () => void
      const gammaStartedPromise = new Promise<void>((resolve) => {
        gammaStarted = resolve
      })
      main1Services.openWorkspace = async (rootPath) => {
        if (isSameWorkspacePath(rootPath, 'C:/wiki/gamma')) {
          gammaStarted()
          await gammaBarrier
        }
        return origOpen(rootPath)
      }

      const switchPromise = coordinator.openWorkspaceInSession(main1.windowId, 'C:/wiki/gamma')
      await gammaStartedPromise

      expect(await coordinator.openWorkspaceInNewWindow(main2.windowId, 'C:/wiki/gamma')).toMatchObject({
        status: 'focused-existing',
        windowId: main1.windowId
      })
      expect(await coordinator.openWorkspaceInNewWindow(main2.windowId, 'C:/wiki/alpha')).toMatchObject({
        status: 'focused-existing',
        windowId: main1.windowId
      })
      expect(createdWindows).toHaveLength(2)

      releaseGamma()
      await switchPromise
      main1Services.openWorkspace = origOpen

      // Validation failure clears stale pendingInitialWorkspacePath so removed/recreated folder can open again
      const deltaWinRes = await coordinator.openWorkspaceInNewWindow(main1.windowId, 'C:/wiki/delta')
      expect(deltaWinRes.status).toBe('opened')
      const main3 = createdWindows[2]
      dirs.delete('C:\\wiki\\delta')
      await expect(
        coordinator.openWorkspaceInSession(main3.windowId, deltaWinRes.rootPath)
      ).rejects.toThrow()
      dirs.add('C:\\wiki\\delta')
      const reopenDelta = await coordinator.openWorkspaceInNewWindow(main1.windowId, 'C:/wiki/delta')
      expect(reopenDelta.status).toBe('opened')
      expect(createdWindows).toHaveLength(4)
    } finally {
      coordinator.dispose()
    }
  })

  it('handles pre-hydration buffers-closed/paths-remapped on auxiliary windows and keeps shared sessions alive when another main window remains', async () => {
    const { host, createdWindows } = createInMemorySessionHost({
      directories: ['C:/wiki/alpha'],
      files: {
        'C:/wiki/alpha/one.md': '# One',
        'C:/wiki/alpha/two.md': '# Two'
      }
    })
    const coordinator = new WindowSessionCoordinator(host)

    try {
      const main1 = coordinator.createMainWindow() as FakeHostedWindow
      const session = coordinator.resolveSessionForWindow(main1.windowId)!
      await coordinator.openWorkspaceInSession(main1.windowId, 'C:/wiki/alpha')
      const oneBuf = await session.services.bufferHub.openWorkspaceFile(
        'C:/wiki/alpha/one.md',
        'one.md',
        undefined,
        main1.windowId
      )
      const twoBuf = await session.services.bufferHub.openWorkspaceFile(
        'C:/wiki/alpha/two.md',
        'two.md',
        undefined,
        main1.windowId
      )
      coordinator.syncWindowTabs(main1.windowId, [oneBuf.key, twoBuf.key])

      // Pre-hydration rename remaps auxiliary initialTabs before getInitContext is read
      const { windowId: auxRenameId } = coordinator.detachTabToNewWindow(main1.windowId, {
        bufferKey: oneBuf.key,
        mode: 'raw',
        cursor: { selectionStart: 0, selectionEnd: 0 },
        scrollTop: 0
      })
      session.services.bufferHub.syncRenamedPath('C:/wiki/alpha/one.md', 'C:/wiki/alpha/one-renamed.md')
      expect(coordinator.getWindowInitContext(auxRenameId).initialTabs[0]).toMatchObject({
        bufferKey: 'c:/wiki/alpha/one-renamed.md'
      })

      // Deleting the sole pre-hydration initialTab closes that auxiliary window automatically
      session.services.bufferHub.syncDeletedPath('C:/wiki/alpha/one-renamed.md')
      expect(createdWindows[1].isDestroyed()).toBe(true)

      // Empty-initialTabs auxiliary window joined explicitly stays open on syncWindowTabs([]) until it actually hydrates non-empty tabs
      const emptyAux = coordinator.joinSessionWindow(session.sessionId, {
        role: 'auxiliary',
        initialTabs: []
      }) as FakeHostedWindow
      coordinator.syncWindowTabs(emptyAux.windowId, [])
      expect(emptyAux.isDestroyed()).toBe(false)

      // Second main window in same session prevents session disposal when first main window closes
      const main2 = coordinator.joinSessionWindow(session.sessionId, {
        role: 'main'
      }) as FakeHostedWindow
      main1.simulateUserClose()
      expect(main1.isDestroyed()).toBe(true)
      expect(main2.isDestroyed()).toBe(false)
      expect(emptyAux.isDestroyed()).toBe(false)
      expect(coordinator.hasLiveSession(session.sessionId)).toBe(true)

      main2.simulateUserClose()
      expect(emptyAux.isDestroyed()).toBe(true)
      expect(coordinator.hasLiveSession(session.sessionId)).toBe(false)
    } finally {
      coordinator.dispose()
    }
  })

  it('enforces close guards (exclusive auxiliary vs session-wide main), clean close-flush timeout, menu target resolution, and session lifecycle hooks', async () => {
    vi.useFakeTimers()
    const { host, createdWindows } = createInMemorySessionHost({
      directories: ['C:/wiki/alpha', 'C:/wiki/beta'],
      files: {
        'C:/wiki/alpha/shared.md': '# Shared',
        'C:/wiki/alpha/sole.md': '# Sole',
        'C:/wiki/beta/b.md': '# Beta'
      },
      cleanCloseFlushTimeoutMs: 500
    })
    const coordinator = new WindowSessionCoordinator(host)
    const createdEvents: number[] = []
    const disposedEvents: number[] = []
    const cleanupRuns: number[] = []

    const unsubCreated = coordinator.onSessionCreated((session) => {
      createdEvents.push(session.sessionId)
      return () => {
        cleanupRuns.push(session.sessionId)
      }
    })
    const unsubDisposed = coordinator.onSessionDisposed((session) => {
      disposedEvents.push(session.sessionId)
    })

    try {
      const main1 = coordinator.createMainWindow() as FakeHostedWindow
      await coordinator.openWorkspaceInSession(main1.windowId, 'C:/wiki/alpha')
      const session1 = coordinator.resolveSessionForWindow(main1.windowId)!

      const sharedBuf = await session1.services.bufferHub.openWorkspaceFile(
        'C:/wiki/alpha/shared.md',
        'shared.md',
        undefined,
        main1.windowId
      )
      const soleBuf = await session1.services.bufferHub.openWorkspaceFile(
        'C:/wiki/alpha/sole.md',
        'sole.md',
        undefined,
        main1.windowId
      )
      coordinator.syncWindowTabs(main1.windowId, [sharedBuf.key, soleBuf.key])
      session1.services.bufferHub.updateContent(sharedBuf.key, '# Dirty Shared')
      session1.services.bufferHub.updateContent(soleBuf.key, '# Dirty Sole')

      const { windowId: auxSharedId } = coordinator.detachTabToNewWindow(main1.windowId, {
        bufferKey: sharedBuf.key,
        mode: 'raw',
        cursor: { selectionStart: 0, selectionEnd: 0 },
        scrollTop: 0
      })
      const auxShared = createdWindows[1]
      coordinator.syncWindowTabs(auxSharedId, [sharedBuf.key])

      // auxShared shares dirty buffer with main1 -> user close closes immediately without prompt
      auxShared.simulateUserClose()
      expect(auxShared.isDestroyed()).toBe(true)
      expect(auxShared.closeRequestCount).toBe(0)

      // Detach soleBuf to auxSole and drop from main1 -> sole dirty owner triggers close prompt
      const { windowId: auxSoleId } = coordinator.detachTabToNewWindow(main1.windowId, {
        bufferKey: soleBuf.key,
        mode: 'raw',
        cursor: { selectionStart: 0, selectionEnd: 0 },
        scrollTop: 0
      })
      const auxSole = createdWindows[2]
      coordinator.syncWindowTabs(auxSoleId, [soleBuf.key])
      coordinator.syncWindowTabs(main1.windowId, [sharedBuf.key])

      auxSole.simulateUserClose()
      expect(auxSole.isDestroyed()).toBe(false)
      expect(auxSole.closeRequestCount).toBe(1)

      // Duplicate X click is suppressed while closePromptPending is true
      auxSole.simulateUserClose()
      expect(auxSole.closeRequestCount).toBe(1)

      // Rejecting keeps auxSole alive; closeCurrentWindow bypasses dirty close guard
      coordinator.resolveCloseRequest(auxSoleId, false)
      expect(auxSole.isDestroyed()).toBe(false)
      coordinator.closeCurrentWindow(main1.windowId)
      expect(main1.isDestroyed()).toBe(false) // no-op on main

      // Second main window session for menu target routing + clean close flush timeout
      const openBeta = await coordinator.openWorkspaceInNewWindow(main1.windowId, 'C:/wiki/beta')
      const main2 = createdWindows[3]
      expect(openBeta.windowId).toBe(main2.windowId)
      expect(coordinator.getLiveSessionServices()).toHaveLength(2)

      // Menu target resolution maps auxiliary window back to owning main window and tracks focused/active window
      expect(coordinator.resolveMenuTargetMainWindowId(auxSoleId)).toBe(main1.windowId)
      main2.setFocused(true)
      expect(coordinator.resolveMenuTargetMainWindowId()).toBe(main2.windowId)

      // Clean close-flush timeout auto-closes main2 after 500ms if renderer does not respond
      coordinator.setCloseFlushEnabled(main2.windowId, true)
      main2.simulateUserClose()
      expect(main2.isDestroyed()).toBe(false)
      expect(main2.closeRequestCount).toBe(1)

      vi.advanceTimersByTime(499)
      expect(main2.isDestroyed()).toBe(false)
      vi.advanceTimersByTime(1)
      expect(main2.isDestroyed()).toBe(true)
      expect(disposedEvents).toEqual([2])
      expect(cleanupRuns).toEqual([2])

      // Main1 dirty close prompts only Main1 (never auxSole), and approval cascades to auxSole
      main1.simulateUserClose()
      expect(main1.closeRequestCount).toBe(1)
      expect(auxSole.closeRequestCount).toBe(1)
      coordinator.resolveCloseRequest(main1.windowId, true)
      expect(auxSole.isDestroyed()).toBe(true)
      expect(main1.isDestroyed()).toBe(true)
      expect(createdEvents).toEqual([1, 2])
      expect(disposedEvents).toEqual([2, 1])
      expect(cleanupRuns).toEqual([2, 1])
    } finally {
      vi.useRealTimers()
      unsubCreated()
      unsubDisposed()
      coordinator.dispose()
    }
  })

  it('scopes tab drag broadcasts per session, rejects cross-session drops with different-workspace-session, cancels on Escape, and detaches outside bounds', async () => {
    const { host, createdWindows } = createInMemorySessionHost({
      directories: ['C:/wiki/alpha', 'C:/wiki/beta'],
      files: {
        'C:/wiki/alpha/a.md': '# Alpha',
        'C:/wiki/beta/b.md': '# Beta'
      },
      screen: {
        getDisplayNearestPoint: () => ({
          workArea: { x: 0, y: 0, width: 2560, height: 1440 }
        })
      }
    })
    const coordinator = new WindowSessionCoordinator(host)
    const dragEvents: Array<{ session: ActiveTabDragSession | null; targetWindowIds: number[] }> =
      []
    const unsubDrag = coordinator.onTabDragStateChanged((dragSession, targetWindowIds) => {
      dragEvents.push({ session: dragSession, targetWindowIds })
    })

    try {
      const main1 = coordinator.createMainWindow({
        bounds: { x: 0, y: 0, width: 1000, height: 800 }
      }) as FakeHostedWindow
      await coordinator.openWorkspaceInSession(main1.windowId, 'C:/wiki/alpha')
      const session1 = coordinator.resolveSessionForWindow(main1.windowId)!

      const openBeta = await coordinator.openWorkspaceInNewWindow(main1.windowId, 'C:/wiki/beta')
      const main2 = createdWindows.find((w) => w.windowId === openBeta.windowId)!
      await coordinator.openWorkspaceInSession(main2.windowId, 'C:/wiki/beta')
      const session2 = coordinator.resolveSessionForWindow(main2.windowId)!

      const bufA = await session1.services.bufferHub.openWorkspaceFile(
        'C:/wiki/alpha/a.md',
        'a.md',
        undefined,
        main1.windowId
      )
      coordinator.syncWindowTabs(main1.windowId, [bufA.key])
      await session2.services.bufferHub.openWorkspaceFile(
        'C:/wiki/beta/b.md',
        'b.md',
        undefined,
        main2.windowId
      )

      const payloadA: TabTransferPayload = {
        bufferKey: bufA.key,
        mode: 'raw',
        cursor: { selectionStart: 0, selectionEnd: 0 },
        scrollTop: 0
      }

      // Start drag in Session 1 -> broadcasts only to Session 1 windows
      const drag1 = coordinator.startTabDrag(main1.windowId, {
        paneId: 'primary',
        tabId: 'tab-a',
        payload: payloadA
      })
      expect(dragEvents.at(-1)).toEqual({
        session: drag1,
        targetWindowIds: [main1.windowId]
      })

      // Cross-session drop onto main2 rejects without mutating Session 1 drag
      expect(
        coordinator.acceptTabDragDrop(main2.windowId, { dragSessionId: drag1.dragSessionId })
      ).toEqual({
        accepted: false,
        reason: 'different-workspace-session'
      })

      // Dropping inside Session 2's window bounds does not spawn a detached window
      expect(
        coordinator.endTabDrag(main1.windowId, {
          dragSessionId: drag1.dragSessionId,
          screenPoint: { x: main2.getBounds().x + 50, y: main2.getBounds().y + 50 }
        })
      ).toEqual({ detached: false, outcome: 'cancelled' })
      expect(createdWindows).toHaveLength(2)

      // Escape before-input cancels pending drag and prevents outside detach
      const escDrag = coordinator.startTabDrag(main1.windowId, {
        paneId: 'primary',
        tabId: 'tab-a',
        payload: payloadA
      })
      main1.emitBeforeInput({ type: 'keyDown', key: 'Escape' })
      expect(dragEvents.at(-1)?.session?.outcome).toBe('cancelled')
      expect(
        coordinator.endTabDrag(main1.windowId, {
          dragSessionId: escDrag.dragSessionId,
          screenPoint: { x: 2000, y: 200 }
        })
      ).toEqual({ detached: false, outcome: 'cancelled' })

      // Outside-all-windows dragend detaches into auxiliary window in Session 1, then cross-window drop back to main1 auto-closes aux1
      const outsideDrag = coordinator.startTabDrag(main1.windowId, {
        paneId: 'primary',
        tabId: 'tab-a',
        payload: payloadA
      })
      const detached = coordinator.endTabDrag(main1.windowId, {
        dragSessionId: outsideDrag.dragSessionId,
        screenPoint: { x: 1500, y: 200 },
        payload: payloadA
      })
      expect(detached.detached).toBe(true)
      const aux1 = createdWindows[2]
      expect(aux1.getBounds()).toEqual({ x: 1500, y: 200, width: 960, height: 760 })
      coordinator.syncWindowTabs(main1.windowId, [])
      coordinator.syncWindowTabs(aux1.windowId, [bufA.key])

      // Single-tab aux outside drop is suppressed; same-session drop onto main1 succeeds and auto-closes aux1 on syncWindowTabs([])
      const auxDrag = coordinator.startTabDrag(aux1.windowId, {
        paneId: 'primary',
        tabId: 'tab-a',
        payload: payloadA
      })
      expect(dragEvents.at(-1)?.targetWindowIds.sort()).toEqual(
        [main1.windowId, aux1.windowId].sort()
      )
      expect(
        coordinator.acceptTabDragDrop(main1.windowId, { dragSessionId: auxDrag.dragSessionId })
      ).toMatchObject({
        accepted: true,
        sourceWindowId: aux1.windowId,
        targetWindowId: main1.windowId
      })
      coordinator.syncWindowTabs(aux1.windowId, [])
      expect(aux1.isDestroyed()).toBe(true)
    } finally {
      unsubDrag()
      coordinator.dispose()
    }
  })

  it('detaches and drags branch-compare Diff tabs into auxiliary windows, injects initialWorkspacePath, and tracks nonBufferTabCount for auto-close', async () => {
    const { host, createdWindows } = createInMemorySessionHost({
      directories: ['C:/wiki/alpha'],
      files: {
        'C:/wiki/alpha/a.md': '# A'
      }
    })
    const coordinator = new WindowSessionCoordinator(host)
    try {
      const mainWin = coordinator.createMainWindow({ initialWorkspacePath: 'C:/wiki/alpha' }) as FakeHostedWindow
      await coordinator.openWorkspaceInSession(mainWin.windowId, 'C:/wiki/alpha')
      const mainSession = coordinator.resolveSessionForWindow(mainWin.windowId)!
      const buf = await mainSession.services.bufferHub.openWorkspaceFile('C:/wiki/alpha/a.md', 'a.md')
      coordinator.syncWindowTabs(mainWin.windowId, [buf.key], { nonBufferTabCount: 1 })

      const diffPayload = {
        kind: 'diff' as const,
        diff: {
          request: {
            kind: 'branch-compare' as const,
            baseRef: 'main',
            compareRef: 'feat/x',
            mode: 'three-dot' as const,
            path: 'docs/guide.md',
            status: 'M' as const
          },
          viewMode: 'side-by-side' as const
        }
      }

      const { windowId: auxId } = coordinator.detachTabToNewWindow(mainWin.windowId, diffPayload)
      const auxWin = createdWindows.find((w) => w.windowId === auxId)!
      expect(auxWin).toBeDefined()
      const initCtx = coordinator.getWindowInitContext(auxId)
      expect(initCtx.role).toBe('auxiliary')
      expect(initCtx.initialTabs).toHaveLength(1)
      expect(initCtx.initialTabs[0]).toMatchObject({
        kind: 'diff',
        diff: {
          request: diffPayload.diff.request,
          viewMode: 'side-by-side'
        }
      })
      const firstInitialTab = initCtx.initialTabs[0]
      if (firstInitialTab.kind !== 'diff') throw new Error('expected diff tab')
      expect(firstInitialTab.diff.workspaceRootPath).toBeTruthy()

      coordinator.syncWindowTabs(auxId, [], { nonBufferTabCount: 1 })
      expect(auxWin.isDestroyed()).toBe(false)

      // Dragging the diff tab from mainWin into auxWin succeeds without a document buffer
      const dragSession = coordinator.startTabDrag(mainWin.windowId, {
        paneId: 'primary',
        tabId: 'diff-1',
        payload: diffPayload
      })
      const dropResult = coordinator.acceptTabDragDrop(auxId, {
        dragSessionId: dragSession.dragSessionId
      })
      expect(dropResult).toMatchObject({
        accepted: true,
        sourceWindowId: mainWin.windowId,
        targetWindowId: auxId,
        payload: diffPayload
      })

      // Closing all diff tabs in auxWin auto-closes the auxiliary window
      coordinator.syncWindowTabs(auxId, [], { nonBufferTabCount: 0 })
      expect(auxWin.isDestroyed()).toBe(true)
    } finally {
      coordinator.dispose()
    }
  })
})
