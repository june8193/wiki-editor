import { act } from '@testing-library/react'
import { vi } from 'vitest'
import { EditorView } from '@codemirror/view'
import {
  getImageExtensionForMimeType,
  isSupportedImageFile,
  toMarkdownRelativeImagePath,
  type WorkspaceImageIngestInput,
  type WorkspaceImageIngestResult
} from '@shared/assets'
import {
  type AppConfig,
  cloneAppConfig,
  DEFAULT_APP_CONFIG,
  validateConfigRaw
} from '@shared/config'
import type { SharedBufferHubEvent } from '@shared/documentBuffer'
import { createEmptyGitStatus } from '@shared/git'
import type {
  AppMenuCommand,
  WikiApi,
  WikiBufferApi,
  WikiClipboardApi,
  WikiDiagramApi,
  WikiGitApi,
  WikiLogApi,
  WikiWorkspaceApi
} from '@shared/ipc'
import {
  applyWorkspaceStateUpdate,
  clonePersistedWorkspaceState,
  createDefaultWorkspaceStateDocument,
  createEmptyPersistedWorkspaceLayout,
  findWorkspaceStateInDocument,
  normalizeWorkspaceStateDocument,
  type PersistedWorkspaceState,
  type WorkspaceStateDocument
} from '@shared/workspaceState'
import { SharedDocumentBufferHub } from '@shared/sharedDocumentBufferHub'
import {
  TabDragCoordinator,
  type BeforeInputKeyEventLike
} from '@shared/tabDragSession'
import {
  AUXILIARY_WINDOW_DEFAULT_HEIGHT,
  AUXILIARY_WINDOW_DEFAULT_WIDTH,
  canDetachTabFromWindow,
  cloneTabTransferPayloads,
  computeOffsetAuxiliaryBounds,
  computeOffsetMainBounds,
  MAIN_WINDOW_DEFAULT_HEIGHT,
  MAIN_WINDOW_DEFAULT_WIDTH,
  type ActiveTabDragSession,
  type ScreenLike,
  type TabTransferPayload,
  type WindowBounds,
  type WindowInitContext,
  type WindowRole
} from '@shared/window'
import {
  compareWorkspaceEntriesByRelativePath,
  filterTopLevelWorkspaceItems,
  getWorkspaceDisplayName,
  getWorkspacePathKey,
  isMarkdownFileName,
  isNestedOrSameWorkspacePath,
  isSameWorkspacePath,
  recordRecentWorkspace,
  removeFavoriteWorkspace,
  toggleFavoriteWorkspace,
  type WorkspaceChangeEvent,
  type WorkspaceEntry,
  type WorkspaceEntryKind,
  type WorkspaceMovedEntry
} from '@shared/workspace'

export interface VirtualFsOptions {
  workspaces?: Record<string, Record<string, string | null>>
  workspaceStates?: Record<string, Partial<PersistedWorkspaceState>>
  selectedFolder?: string | null
  git?: Partial<WikiGitApi>
  diagram?: Partial<WikiDiagramApi>
  log?: WikiLogApi
  clipboard?: Partial<WikiClipboardApi>
  ingestImage?: WikiWorkspaceApi['ingestImage']
  getPathForFile?: WikiWorkspaceApi['getPathForFile']
  screen?: ScreenLike
  mainBounds?: WindowBounds
}

export function normalizePosix(pathValue: string): string {
  return pathValue.replace(/\\/g, '/').replace(/\/+$/, '') || '/'
}

export function parentDirOf(pathValue: string): string {
  const norm = normalizePosix(pathValue)
  const idx = norm.lastIndexOf('/')
  return idx <= 0 ? '/' : norm.slice(0, idx)
}

export function baseNameOf(pathValue: string): string {
  const norm = normalizePosix(pathValue)
  const idx = norm.lastIndexOf('/')
  return idx === -1 ? norm : norm.slice(idx + 1)
}

export function getRawEditorView(editorEl: HTMLElement): EditorView {
  const view = EditorView.findFromDOM(editorEl)
  if (!view) {
    throw new Error('Could not resolve CodeMirror EditorView for element')
  }
  return view
}

export function getRawEditorText(editorEl: HTMLElement): string {
  return getRawEditorView(editorEl).state.doc.toString()
}

export function setRawEditorText(editorEl: HTMLElement, nextText: string): void {
  const view = getRawEditorView(editorEl)
  act(() => {
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: nextText }
    })
  })
}

export function appendRawEditorText(editorEl: HTMLElement, suffix: string): void {
  const view = getRawEditorView(editorEl)
  const end = view.state.doc.length
  act(() => {
    view.dispatch({
      changes: { from: end, to: end, insert: suffix },
      selection: { anchor: end + suffix.length }
    })
  })
}

export function setRawEditorSelection(editorEl: HTMLElement, start: number, end: number): void {
  const view = getRawEditorView(editorEl)
  act(() => {
    view.dispatch({
      selection: { anchor: start, head: end }
    })
  })
}

export function getRawEditorSelection(editorEl: HTMLElement): { start: number; end: number } {
  return {
    start: Number(editorEl.getAttribute('data-selection-start') ?? 0),
    end: Number(editorEl.getAttribute('data-selection-end') ?? 0)
  }
}

export function getRawEditorScroller(editorEl: HTMLElement): HTMLElement {
  return getRawEditorView(editorEl).scrollDOM
}

export async function triggerMenuCommand(
  emitMenuCommand: (command: AppMenuCommand) => void,
  command: AppMenuCommand
): Promise<void> {
  await act(async () => {
    emitMenuCommand(command)
  })
}

export interface CreateInMemoryWindowOptions {
  role?: WindowRole
  initialTabs?: TabTransferPayload[]
  bounds?: WindowBounds
}

interface CreateSessionWindowOptions extends CreateInMemoryWindowOptions {
  initialWorkspacePath?: string | null
}

export interface InMemoryWindowWatchState {
  active: boolean
  watchCalls: number
  unwatchCalls: number
  auxWatchCalls: number
  auxUnwatchCalls: number
}

export interface InMemoryWindowHandle {
  windowId: number
  sessionId: number
  role: WindowRole
  api: WikiApi
  hub: SharedDocumentBufferHub
  emitMenuCommand: (command: AppMenuCommand) => void
  emitBeforeInput: (input: BeforeInputKeyEventLike) => void
  requestClose: () => void
  getBounds: () => WindowBounds
  getMenuListenerCount: () => number
  isClosed: () => boolean
  getInitContext: () => WindowInitContext
  destroy: () => void
}

/** Creates a WikiBufferApi facade backed directly by a SharedDocumentBufferHub instance. */
export function createHubBufferApi(
  hub: SharedDocumentBufferHub,
  windowId: number,
  bufferListeners: Set<(event: SharedBufferHubEvent) => void>,
  isWindowDestroyed: () => boolean = () => false
): WikiBufferApi {
  return {
    async getSnapshot() {
      return hub.getSnapshot(windowId)
    },
    async openWorkspaceFile(filePath, name, initialContent) {
      return hub.openWorkspaceFile(filePath, name, initialContent, windowId)
    },
    async openConfigDocument() {
      return hub.openConfigDocument(windowId)
    },
    async refreshCleanConfig() {
      return hub.refreshCleanConfig()
    },
    async updateContent(key, nextContent) {
      return hub.updateContent(key, nextContent)
    },
    async saveBuffer(key) {
      return hub.saveBuffer(key)
    },
    async syncWindowTabs(bufferKeys, options) {
      return hub.syncWindowTabs(windowId, bufferKeys, options)
    },
    async setAutoSavePaused(paused) {
      hub.setAutoSavePaused(windowId, paused)
    },
    async syncRenamedPath(oldPath, newPath) {
      return hub.syncRenamedPath(oldPath, newPath)
    },
    async syncDeletedPath(targetPath) {
      return hub.syncDeletedPath(targetPath)
    },
    async reconcileWorkspaceBuffersWithDisk(changeEvent) {
      return hub.reconcileWorkspaceBuffersWithDisk(changeEvent)
    },
    async prepareDiscardPaths(targetPaths) {
      return hub.prepareWorkspacePathsForDiscard(targetPaths)
    },
    async finishDiscardPaths(targetPaths, forceSync) {
      return hub.finishWorkspacePathsDiscard(targetPaths, forceSync)
    },
    async clearWorkspaceBuffers() {
      return hub.clearWorkspaceBuffers()
    },
    onEvent(listener) {
      if (isWindowDestroyed()) {
        return () => undefined
      }
      bufferListeners.add(listener)
      return () => {
        bufferListeners.delete(listener)
      }
    }
  }
}

export interface MultiWindowWikiHarness {
  createWindow: (options?: CreateInMemoryWindowOptions) => InMemoryWindowHandle
  getMainWindows: () => InMemoryWindowHandle[]
  getAuxiliaryWindows: (mainWindowId?: number) => InMemoryWindowHandle[]
  getWatchState: (mainWindowId?: number) => InMemoryWindowWatchState
  emitExternalChange: (patch: Partial<AppConfig>) => void
  emitWorkspaceChange: (event: WorkspaceChangeEvent) => void
  getListenerCount: () => number
  getFilesSnapshot: () => Map<string, string>
  readDirCalls: string[]
  copiedTexts: string[]
  hub: SharedDocumentBufferHub
  dispose: () => void
}

interface SessionWindowRecord {
  role: WindowRole
  isDestroyed: () => boolean
  getBounds: () => WindowBounds
  forceClose: () => void
}

interface HarnessSession {
  sessionId: number
  hub: SharedDocumentBufferHub
  dragCoordinator: TabDragCoordinator
  unsubscribeCoordinatorHub: () => void
  primaryApi: WikiApi | null
  activeRoot: string | null
  pendingInitialWorkspacePath: string | null
  workspaceListeners: Set<(event: WorkspaceChangeEvent) => void>
  dragListenersByWindow: Map<number, Set<(session: ActiveTabDragSession | null) => void>>
  openWindows: Map<number, SessionWindowRecord>
  auxiliaryHandles: InMemoryWindowHandle[]
  watchActive: boolean
  watchCalls: number
  unwatchCalls: number
  auxWatchCalls: number
  auxUnwatchCalls: number
}

/**
 * Creates a multi-window in-memory WikiApi test harness supporting isolated per-main-window
 * workspace sessions, shared buffer hubs per session, and global config broadcasts.
 */
export function createMultiWindowWikiHarness(
  initialOverrides: Partial<AppConfig> = {},
  fsOptions: VirtualFsOptions = {}
): MultiWindowWikiHarness {
  let state: AppConfig = {
    ...cloneAppConfig(DEFAULT_APP_CONFIG),
    ...initialOverrides
  }
  const configListeners = new Set<(config: AppConfig) => void>()
  const configPath = 'C:\\Users\\test\\AppData\\Roaming\\wiki-editor\\config.json'

  const dirs = new Set<string>()
  const files = new Map<string, string>()
  const readDirCalls: string[] = []
  const copiedTexts: string[] = []
  const seededWorkspaces: Record<string, PersistedWorkspaceState> = {}
  for (const [rawKey, partial] of Object.entries(fsOptions.workspaceStates ?? {})) {
    const rootPath = partial.rootPath ?? rawKey
    seededWorkspaces[rawKey] = {
      rootPath,
      updatedAt: partial.updatedAt ?? new Date().toISOString(),
      expandedDirs: partial.expandedDirs ?? [],
      layout: partial.layout ?? createEmptyPersistedWorkspaceLayout()
    }
  }
  let workspaceStateDoc: WorkspaceStateDocument = fsOptions.workspaceStates
    ? normalizeWorkspaceStateDocument({ version: 1, workspaces: seededWorkspaces })
    : createDefaultWorkspaceStateDocument()
  const selectedFolder: string | null = fsOptions.selectedFolder ?? null
  let nextWindowId = 1
  let nextSessionId = 1
  const mainHandles: InMemoryWindowHandle[] = []
  const auxiliaryHandles: InMemoryWindowHandle[] = []
  const sessions = new Map<number, HarnessSession>()
  const screen: ScreenLike = fsOptions.screen ?? {
    getDisplayNearestPoint: () => ({
      workArea: { x: 0, y: 0, width: 1920, height: 1080 }
    })
  }

  for (const [rootRaw, entries] of Object.entries(fsOptions.workspaces ?? {})) {
    const root = normalizePosix(rootRaw)
    dirs.add(root)
    for (const [relRaw, content] of Object.entries(entries)) {
      const rel = relRaw.replace(/\\/g, '/').replace(/^\/+/, '')
      const parts = rel.split('/').filter(Boolean)
      let cursor = root
      for (let i = 0; i < parts.length; i += 1) {
        cursor = `${cursor}/${parts[i]}`
        const isLast = i === parts.length - 1
        if (isLast && content !== null) {
          files.set(cursor, content)
        } else {
          dirs.add(cursor)
        }
      }
    }
  }

  const createSession = (): HarnessSession => {
    const sessionId = nextSessionId++
    const dragListenersByWindow = new Map<
      number,
      Set<(session: ActiveTabDragSession | null) => void>
    >()
    const dragCoordinator = new TabDragCoordinator()
    dragCoordinator.onStateChanged((dragSession) => {
      for (const listeners of dragListenersByWindow.values()) {
        for (const listener of listeners) {
          listener(dragSession)
        }
      }
    })

    const session: HarnessSession = {
      sessionId,
      hub: null as unknown as SharedDocumentBufferHub,
      dragCoordinator,
      unsubscribeCoordinatorHub: () => undefined,
      primaryApi: null,
      activeRoot: null,
      pendingInitialWorkspacePath: null,
      workspaceListeners: new Set(),
      dragListenersByWindow,
      openWindows: new Map(),
      auxiliaryHandles: [],
      watchActive: false,
      watchCalls: 0,
      unwatchCalls: 0,
      auxWatchCalls: 0,
      auxUnwatchCalls: 0
    }

    const hub = new SharedDocumentBufferHub({
      initialAutoSaveConfig: {
        autoSave: state.autoSave,
        autoSaveDelayMs: state.autoSaveDelayMs
      },
      storage: {
        readWorkspaceFile: (filePath) => session.primaryApi!.workspace.readFile(filePath),
        writeWorkspaceFile: (filePath, content) =>
          session.primaryApi!.workspace.writeFile(filePath, content),
        readWorkspaceDirectory: (dirPath) => session.primaryApi!.workspace.readDir(dirPath),
        getConfigPath: () => session.primaryApi!.config.getConfigPath(),
        readConfigRaw: () => session.primaryApi!.config.readRaw(),
        saveConfigRaw: (raw) => session.primaryApi!.config.saveRaw(raw)
      }
    })

    session.hub = hub
    session.unsubscribeCoordinatorHub = hub.subscribe((event) => {
      if (event.type === 'paths-remapped') {
        dragCoordinator.remapPayloadKeys(event.remappings)
      }
    })

    sessions.set(sessionId, session)
    return session
  }

  const defaultSession = createSession()

  const listDir = (session: HarnessSession, dirPath: string): WorkspaceEntry[] => {
    const target = normalizePosix(dirPath === '.' && session.activeRoot ? session.activeRoot : dirPath)
    readDirCalls.push(target)
    if (!dirs.has(target)) {
      throw new Error(`폴더를 찾을 수 없습니다: ${dirPath}`)
    }
    const entries: WorkspaceEntry[] = []
    for (const dir of dirs) {
      if (dir !== target && parentDirOf(dir) === target) {
        const name = baseNameOf(dir)
        entries.push({
          name,
          path: dir,
          relativePath: session.activeRoot ? dir.slice(session.activeRoot.length + 1) : name,
          kind: 'directory'
        })
      }
    }
    for (const file of files.keys()) {
      if (parentDirOf(file) === target) {
        const name = baseNameOf(file)
        entries.push({
          name,
          path: file,
          relativePath: session.activeRoot ? file.slice(session.activeRoot.length + 1) : name,
          kind: 'file'
        })
      }
    }
    return entries.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    })
  }

  const applyAndBroadcast = (nextState: AppConfig): AppConfig => {
    state = cloneAppConfig(nextState)
    for (const session of sessions.values()) {
      session.hub.setAutoSaveConfig({
        autoSave: state.autoSave,
        autoSaveDelayMs: state.autoSaveDelayMs
      })
    }
    const snapshot = cloneAppConfig(state)
    for (const listener of configListeners) {
      listener(snapshot)
    }
    return cloneAppConfig(snapshot)
  }

  const findOpenSessionByWorkspacePath = (
    targetPath: string
  ): { session: HarnessSession; mainWindowId: number } | undefined => {
    for (const session of sessions.values()) {
      const candidatePath = session.activeRoot ?? session.pendingInitialWorkspacePath
      if (!candidatePath || !isSameWorkspacePath(candidatePath, targetPath)) {
        continue
      }
      for (const [winId, winRecord] of session.openWindows.entries()) {
        if (winRecord.role === 'main' && !winRecord.isDestroyed()) {
          return { session, mainWindowId: winId }
        }
      }
    }
    return undefined
  }

  const hasOtherSessionPendingDrag = (excludeSessionId: number): boolean => {
    for (const session of sessions.values()) {
      if (session.sessionId !== excludeSessionId && session.dragCoordinator.hasPendingDrag()) {
        return true
      }
    }
    return false
  }

  const getAllOpenWindowBounds = (): WindowBounds[] => {
    const bounds: WindowBounds[] = []
    for (const session of sessions.values()) {
      for (const win of session.openWindows.values()) {
        if (!win.isDestroyed()) {
          bounds.push(win.getBounds())
        }
      }
    }
    return bounds
  }

  const createWindowInSession = (
    session: HarnessSession,
    options: CreateSessionWindowOptions = {}
  ): InMemoryWindowHandle => {
    const windowId = nextWindowId++
    const role: WindowRole = options.role ?? 'main'
    const initialTabs: TabTransferPayload[] = cloneTabTransferPayloads(options.initialTabs ?? [])
    const initialWorkspacePath =
      options.initialWorkspacePath !== undefined ? options.initialWorkspacePath : undefined
    if (role === 'main' && initialWorkspacePath) {
      session.pendingInitialWorkspacePath = normalizePosix(initialWorkspacePath)
    }
    const defaultBounds: WindowBounds =
      role === 'main'
        ? (fsOptions.mainBounds ?? {
            x: 0,
            y: 0,
            width: MAIN_WINDOW_DEFAULT_WIDTH,
            height: MAIN_WINDOW_DEFAULT_HEIGHT
          })
        : {
            x: 40,
            y: 40,
            width: AUXILIARY_WINDOW_DEFAULT_WIDTH,
            height: AUXILIARY_WINDOW_DEFAULT_HEIGHT
          }
    const windowBounds: WindowBounds = { ...(options.bounds ?? defaultBounds) }
    let destroyed = false
    let closing = false
    let closePromptPending = false
    let closeFlushEnabled = false
    let hasSyncedNonEmptyTabs = false
    const menuListeners = new Set<(command: AppMenuCommand) => void>()
    const bufferListeners = new Set<(event: SharedBufferHubEvent) => void>()
    const dragListeners = new Set<(session: ActiveTabDragSession | null) => void>()
    const closeRequestedListeners = new Set<() => void>()
    const windowConfigListeners = new Set<(config: AppConfig) => void>()
    const windowWorkspaceListeners = new Set<(event: WorkspaceChangeEvent) => void>()
    session.dragListenersByWindow.set(windowId, dragListeners)

    const closeAllOpenAuxiliaryWindows = (): void => {
      for (const candidate of [...session.openWindows.values()]) {
        if (candidate.role === 'auxiliary') {
          candidate.forceClose()
        }
      }
    }

    const destroyWindow = (): void => {
      if (destroyed) return
      destroyed = true
      closePromptPending = false
      if (role === 'main') {
        closeAllOpenAuxiliaryWindows()
      }
      session.dragCoordinator.clearForWindow(windowId)
      session.openWindows.delete(windowId)
      dragListeners.clear()
      session.dragListenersByWindow.delete(windowId)
      closeRequestedListeners.clear()
      unsubscribeHub()
      session.hub.unregisterWindow(windowId)
      menuListeners.clear()
      bufferListeners.clear()
      for (const listener of windowConfigListeners) {
        configListeners.delete(listener)
      }
      windowConfigListeners.clear()
      for (const listener of windowWorkspaceListeners) {
        session.workspaceListeners.delete(listener)
      }
      windowWorkspaceListeners.clear()
    }

    const forceCloseWindow = (): void => {
      if (destroyed || closing) return
      closing = true
      closePromptPending = false
      destroyWindow()
    }

    session.openWindows.set(windowId, {
      role,
      isDestroyed: () => destroyed,
      getBounds: () => ({ ...windowBounds }),
      forceClose: forceCloseWindow
    })

    if (role === 'auxiliary') {
      for (const tab of initialTabs) {
        session.hub.registerPendingTransfer(windowId, tab.bufferKey)
      }
    }

    const requestCloseWindow = (): void => {
      if (destroyed || closing || closePromptPending) return
      const shouldPromptOrFlush =
        session.hub.hasDirtyBuffersForWindowClose(role, windowId) ||
        (role === 'main' && closeFlushEnabled)
      if (!shouldPromptOrFlush) {
        forceCloseWindow()
        return
      }
      closePromptPending = true
      for (const listener of closeRequestedListeners) {
        listener()
      }
    }

    const unsubscribeHub = session.hub.subscribe((event) => {
      if (destroyed) return
      if (role === 'auxiliary' && (event.type === 'state-changed' || event.type === 'buffers-closed')) {
        const currentTabCount = session.hub.getWindowTabCount(windowId)
        if (currentTabCount > 0) {
          hasSyncedNonEmptyTabs = true
        } else if (hasSyncedNonEmptyTabs) {
          forceCloseWindow()
          return
        }
      }
      for (const listener of bufferListeners) {
        listener(event)
      }
    })

    const relocateVirtualEntry = (
      oldPath: string,
      nextPath: string,
      kind: WorkspaceEntryKind
    ): WorkspaceEntry => {
      if (kind === 'file') {
        const content = files.get(oldPath)!
        files.delete(oldPath)
        files.set(nextPath, content)
      } else {
        const movedDirs = [...dirs].filter(
          (d) => d === oldPath || d.startsWith(`${oldPath}/`)
        )
        const movedFiles = [...files.entries()].filter(([f]) => f.startsWith(`${oldPath}/`))
        for (const d of movedDirs) {
          dirs.delete(d)
          dirs.add(nextPath + d.slice(oldPath.length))
        }
        for (const [f, c] of movedFiles) {
          files.delete(f)
          files.set(nextPath + f.slice(oldPath.length), c)
        }
      }
      return {
        name: baseNameOf(nextPath),
        path: nextPath,
        relativePath: session.activeRoot
          ? nextPath.slice(session.activeRoot.length + 1)
          : baseNameOf(nextPath),
        kind
      }
    }

    const buildInitContext = (): WindowInitContext => ({
      role,
      initialTabs: cloneTabTransferPayloads(initialTabs),
      ...(initialWorkspacePath !== undefined ? { initialWorkspacePath } : {})
    })

    const api: WikiApi = {
      config: {
        async get() {
          return cloneAppConfig(state)
        },
        async update(patch) {
          return applyAndBroadcast({ ...state, ...patch, version: 1 })
        },
        async getConfigPath() {
          return configPath
        },
        async readRaw() {
          return JSON.stringify(state, null, 2)
        },
        async saveRaw(raw) {
          const validated = validateConfigRaw(raw)
          return applyAndBroadcast(validated)
        },
        async toggleFavoriteWorkspace(workspacePath, name) {
          return applyAndBroadcast({
            ...state,
            favoriteWorkspaces: toggleFavoriteWorkspace(
              state.favoriteWorkspaces,
              workspacePath,
              name
            )
          })
        },
        async removeFavoriteWorkspace(workspacePath) {
          return applyAndBroadcast({
            ...state,
            favoriteWorkspaces: removeFavoriteWorkspace(state.favoriteWorkspaces, workspacePath)
          })
        },
        onChanged(listener) {
          configListeners.add(listener)
          windowConfigListeners.add(listener)
          return () => {
            configListeners.delete(listener)
            windowConfigListeners.delete(listener)
          }
        }
      },
      workspace: {
        async selectFolder() {
          return selectedFolder
        },
        async open(rootPath) {
          if (role !== 'main') {
            throw new Error('Only the main window can open a workspace')
          }
          const normalized = normalizePosix(rootPath)
          if (!dirs.has(normalized)) {
            throw new Error(`워크스페이스 폴더를 찾을 수 없습니다: ${rootPath}`)
          }
          session.activeRoot = normalized
          session.pendingInitialWorkspacePath = null
          applyAndBroadcast({
            ...state,
            recentWorkspaces: recordRecentWorkspace(state.recentWorkspaces, rootPath)
          })
          return {
            rootPath: normalized,
            name: getWorkspaceDisplayName(normalized),
            entries: listDir(session, normalized)
          }
        },
        async openInNewWindow(rootPath) {
          if (role !== 'main') {
            throw new Error('Only the main window can open a workspace')
          }
          const trimmed = rootPath.trim()
          if (!trimmed) {
            throw new Error('워크스페이스 경로가 비어 있습니다.')
          }
          const normalized = normalizePosix(trimmed)
          if (files.has(normalized)) {
            throw new Error('선택한 경로는 폴더가 아닙니다.')
          }
          if (!dirs.has(normalized)) {
            throw new Error(`워크스페이스 폴더를 찾을 수 없습니다: ${rootPath}`)
          }

          const existing = findOpenSessionByWorkspacePath(normalized)
          if (existing) {
            return {
              status: 'focused-existing',
              windowId: existing.mainWindowId,
              rootPath: existing.session.activeRoot ?? normalized
            }
          }

          const newSession = createSession()
          const newMainWin = createWindowInSession(newSession, {
            role: 'main',
            initialWorkspacePath: normalized,
            bounds: computeOffsetMainBounds(windowBounds, screen)
          })
          return {
            status: 'opened',
            windowId: newMainWin.windowId,
            rootPath: normalized
          }
        },
        async readDir(dirPath) {
          if (!session.activeRoot) throw new Error('열린 워크스페이스가 없습니다.')
          return listDir(session, dirPath ?? session.activeRoot)
        },
        async listMarkdownFiles() {
          if (!session.activeRoot) throw new Error('열린 워크스페이스가 없습니다.')
          const prefix = `${session.activeRoot}/`
          const ignoredSegments = new Set([
            '.git',
            'node_modules',
            '.hg',
            '.svn',
            '.DS_Store',
            'Thumbs.db'
          ])
          const markdownEntries: WorkspaceEntry[] = []
          for (const file of files.keys()) {
            if (!file.startsWith(prefix)) continue
            const relativePath = file.slice(prefix.length)
            if (relativePath.split('/').some((seg) => ignoredSegments.has(seg))) continue
            const name = baseNameOf(file)
            if (!isMarkdownFileName(name)) continue
            markdownEntries.push({
              name,
              path: file,
              relativePath,
              kind: 'file'
            })
          }
          return markdownEntries.sort(compareWorkspaceEntriesByRelativePath)
        },
        async readFile(filePath) {
          const normalized = normalizePosix(filePath)
          const content = files.get(normalized)
          if (content === undefined) {
            throw new Error(`파일을 찾을 수 없습니다: ${filePath}`)
          }
          return content
        },
        async writeFile(filePath, content) {
          const normalized = normalizePosix(filePath)
          if (!files.has(normalized) && !dirs.has(parentDirOf(normalized))) {
            throw new Error(`경로를 찾을 수 없습니다: ${filePath}`)
          }
          files.set(normalized, content)
        },
        async createEntry(parentDirPath, name, kind: WorkspaceEntryKind, initialContent = '') {
          if (!session.activeRoot) throw new Error('열린 워크스페이스가 없습니다.')
          const parent = normalizePosix(
            parentDirPath === '.' ? session.activeRoot : parentDirPath
          )
          const target = `${parent}/${name}`
          if (dirs.has(target) || files.has(target)) {
            throw new Error(`이미 존재하는 파일 또는 폴더입니다: ${name}`)
          }
          if (kind === 'directory') {
            dirs.add(target)
          } else {
            files.set(target, initialContent)
          }
          return {
            name,
            path: target,
            relativePath: target.slice(session.activeRoot.length + 1),
            kind
          }
        },
        async renameEntry(targetPath, newName) {
          if (!session.activeRoot) throw new Error('열린 워크스페이스가 없습니다.')
          const target = normalizePosix(targetPath)
          const next = `${parentDirOf(target)}/${newName}`
          if (dirs.has(next) || files.has(next)) {
            throw new Error(`이미 존재하는 이름입니다: ${newName}`)
          }
          if (files.has(target)) {
            return relocateVirtualEntry(target, next, 'file')
          }
          if (dirs.has(target)) {
            return relocateVirtualEntry(target, next, 'directory')
          }
          throw new Error(`경로를 찾을 수 없습니다: ${targetPath}`)
        },
        async moveEntries(sourcePaths, targetDirPath): Promise<WorkspaceMovedEntry[]> {
          if (!session.activeRoot) throw new Error('열린 워크스페이스가 없습니다.')
          const targetDir = normalizePosix(
            targetDirPath === '.' ? session.activeRoot : targetDirPath
          )
          if (!dirs.has(targetDir)) {
            throw new Error(`폴더를 찾을 수 없습니다: ${targetDirPath}`)
          }
          if (sourcePaths.length === 0) return []

          const resolved: Array<{ path: string; kind: WorkspaceEntryKind }> = []
          for (const rawSource of sourcePaths) {
            const source = normalizePosix(rawSource === '.' ? session.activeRoot : rawSource)
            if (source === session.activeRoot) {
              throw new Error('워크스페이스 루트 폴더는 이동할 수 없습니다.')
            }
            if (dirs.has(source)) {
              resolved.push({ path: source, kind: 'directory' })
            } else if (files.has(source)) {
              resolved.push({ path: source, kind: 'file' })
            } else {
              throw new Error(`경로를 찾을 수 없습니다: ${rawSource}`)
            }
          }

          const topLevel = filterTopLevelWorkspaceItems(
            resolved,
            (item) => item.path,
            (item) => item.kind === 'directory'
          )

          const plannedKeys = new Set<string>()
          const existingKeys = new Set(
            [...dirs, ...files.keys()].map((item) => getWorkspacePathKey(item))
          )
          const plans: Array<{ oldPath: string; nextPath: string; kind: WorkspaceEntryKind }> = []

          for (const item of topLevel) {
            if (
              item.kind === 'directory' &&
              isNestedOrSameWorkspacePath(targetDir, item.path)
            ) {
              throw new Error('폴더를 자기 자신이나 하위 폴더로 이동할 수 없습니다.')
            }
            if (parentDirOf(item.path) === targetDir) {
              continue
            }
            const name = baseNameOf(item.path)
            const nextPath = `${targetDir}/${name}`
            const nextKey = getWorkspacePathKey(nextPath)
            if (plannedKeys.has(nextKey) || existingKeys.has(nextKey)) {
              throw new Error(`이미 존재하는 이름입니다: ${name}`)
            }
            plannedKeys.add(nextKey)
            plans.push({ oldPath: item.path, nextPath, kind: item.kind })
          }

          const moved: WorkspaceMovedEntry[] = []
          for (const plan of plans) {
            moved.push({
              oldPath: plan.oldPath,
              entry: relocateVirtualEntry(plan.oldPath, plan.nextPath, plan.kind)
            })
          }
          return moved
        },
        async deleteEntry(targetPath) {
          const target = normalizePosix(targetPath)
          if (files.has(target)) {
            files.delete(target)
            return
          }
          if (dirs.has(target)) {
            for (const d of [...dirs]) {
              if (d === target || d.startsWith(`${target}/`)) dirs.delete(d)
            }
            for (const f of [...files.keys()]) {
              if (f.startsWith(`${target}/`)) files.delete(f)
            }
            return
          }
          throw new Error(`경로를 찾을 수 없습니다: ${targetPath}`)
        },
        async ingestImage(input: WorkspaceImageIngestInput): Promise<WorkspaceImageIngestResult> {
          if (fsOptions.ingestImage) {
            return fsOptions.ingestImage(input)
          }
          if (!session.activeRoot) {
            throw new Error('열린 워크스페이스가 없습니다.')
          }
          const docPosix = normalizePosix(input.documentPath)
          const docDir = parentDirOf(docPosix)

          const saveAsset = (stem: string, ext: string): WorkspaceImageIngestResult => {
            const assetsDir = `${docDir}/assets`
            dirs.add(assetsDir)
            for (let index = 0; index < 100; index += 1) {
              const nextStem = index === 0 ? stem : `${stem}-${index}`
              const fileName = `${nextStem}${ext}`
              const savedPath = `${assetsDir}/${fileName}`
              if (!files.has(savedPath)) {
                files.set(savedPath, `<binary:${fileName}>`)
                return {
                  markdownPath: toMarkdownRelativeImagePath(`assets/${fileName}`),
                  altText: nextStem,
                  savedPath
                }
              }
            }
            throw new Error('collision limit')
          }

          if (input.source.kind === 'clipboard') {
            const ext = getImageExtensionForMimeType(input.source.mimeType)
            if (!ext) {
              throw new Error(`지원하지 않는 이미지 형식입니다: ${input.source.mimeType}`)
            }
            const docName = baseNameOf(docPosix)
            const docStem = docName.replace(/\.[^.]+$/, '') || 'image'
            return saveAsset(`${docStem}-20260402-090507`, ext)
          }

          if (input.source.kind === 'fileBytes') {
            const base = baseNameOf(input.source.fileName)
            if (!isSupportedImageFile(base)) {
              throw new Error(`지원하지 않는 이미지 파일입니다: ${base}`)
            }
            const dot = base.lastIndexOf('.')
            return saveAsset(base.slice(0, dot), base.slice(dot).toLowerCase())
          }

          const candidate = normalizePosix(input.source.filePath)
          if (!isSupportedImageFile(candidate)) {
            throw new Error(`지원하지 않는 이미지 파일입니다: ${candidate}`)
          }
          if (candidate === session.activeRoot || candidate.startsWith(`${session.activeRoot}/`)) {
            const docParts = docDir.split('/').filter(Boolean)
            const targetParts = candidate.split('/').filter(Boolean)
            let common = 0
            while (
              common < docParts.length &&
              common < targetParts.length &&
              docParts[common].toLowerCase() === targetParts[common].toLowerCase()
            ) {
              common += 1
            }
            const relParts = [
              ...Array(docParts.length - common).fill('..'),
              ...targetParts.slice(common)
            ]
            const base = baseNameOf(candidate)
            const dot = base.lastIndexOf('.')
            return {
              markdownPath: toMarkdownRelativeImagePath(relParts.join('/')),
              altText: dot > 0 ? base.slice(0, dot) : base,
              savedPath: candidate
            }
          }
          const base = baseNameOf(candidate)
          const dot = base.lastIndexOf('.')
          return saveAsset(base.slice(0, dot), base.slice(dot).toLowerCase())
        },
        getPathForFile(file: File): string {
          return fsOptions.getPathForFile?.(file) ?? ''
        },
        async watch() {
          session.watchCalls += 1
          if (role === 'main') {
            session.watchActive = true
          } else {
            session.auxWatchCalls += 1
          }
        },
        async unwatch() {
          session.unwatchCalls += 1
          if (role === 'main') {
            session.watchActive = false
          } else {
            session.auxUnwatchCalls += 1
          }
        },
        onChanged(listener) {
          session.workspaceListeners.add(listener)
          windowWorkspaceListeners.add(listener)
          return () => {
            session.workspaceListeners.delete(listener)
            windowWorkspaceListeners.delete(listener)
          }
        }
      },
      workspaceState: {
        async get(rootPath) {
          if (role !== 'main') {
            throw new Error('Only the main window can access workspace state')
          }
          return findWorkspaceStateInDocument(workspaceStateDoc, rootPath)
        },
        async save(rootPath, update) {
          if (role !== 'main') {
            throw new Error('Only the main window can access workspace state')
          }
          const { document: nextDoc, workspaceState } = applyWorkspaceStateUpdate(
            workspaceStateDoc,
            rootPath,
            update
          )
          workspaceStateDoc = nextDoc
          return clonePersistedWorkspaceState(workspaceState)
        }
      },
      git: {
        status: async (workspacePath) => createEmptyGitStatus(false, workspacePath),
        init: async (workspacePath) => ({
          ...createEmptyGitStatus(true, workspacePath),
          branch: 'main',
          isUnborn: true
        }),
        stage: async (workspacePath) => createEmptyGitStatus(true, workspacePath),
        stageAll: async (workspacePath) => createEmptyGitStatus(true, workspacePath),
        unstage: async (workspacePath) => createEmptyGitStatus(true, workspacePath),
        unstageAll: async (workspacePath) => createEmptyGitStatus(true, workspacePath),
        discard: async (workspacePath) => createEmptyGitStatus(true, workspacePath),
        discardAll: async (workspacePath) => createEmptyGitStatus(true, workspacePath),
        commit: async (workspacePath) => createEmptyGitStatus(true, workspacePath),
        branches: async () => ({ current: null, isDetached: false, branches: [] }),
        checkout: async (workspacePath) => createEmptyGitStatus(true, workspacePath),
        pull: async (workspacePath) => createEmptyGitStatus(true, workspacePath),
        push: async (workspacePath) => createEmptyGitStatus(true, workspacePath),
        sync: async (workspacePath) => ({
          status: createEmptyGitStatus(true, workspacePath),
          pulled: true,
          pushed: true,
          summary: '동기화 완료'
        }),
        log: async () => ({ commits: [], hasMore: false }),
        commitDetail: async (_workspacePath, commitHash) => ({
          hash: commitHash,
          shortHash: commitHash.slice(0, 7),
          parents: [],
          subject: '',
          body: '',
          authorName: '',
          authorEmail: '',
          committedAt: '',
          files: []
        }),
        diff: async (_workspacePath, request) => ({
          path: request.path,
          ...(request.origPath ? { origPath: request.origPath } : {}),
          status: request.status,
          isBinary: false,
          isTruncated: false,
          existsInWorkspace: true,
          rawPatch: ''
        }),
        ...fsOptions.git
      },
      menu: {
        onCommand(listener) {
          menuListeners.add(listener)
          return () => {
            menuListeners.delete(listener)
          }
        }
      },
      buffer: createHubBufferApi(session.hub, windowId, bufferListeners, () => destroyed),
      diagram: {
        copyText: vi.fn(async () => {}),
        copyImage: vi.fn(async () => {}),
        saveFile: vi.fn(async () => ({ canceled: true })),
        ...fsOptions.diagram
      },
      clipboard: {
        async writeText(text: string) {
          copiedTexts.push(text)
        },
        ...fsOptions.clipboard
      },
      window: {
        role,
        async getInitContext() {
          return buildInitContext()
        },
        async detachTabToNewWindow(payload) {
          if (destroyed) {
            throw new Error('Cannot detach tab from a closed window')
          }
          if (!session.hub.hasBuffer(payload.bufferKey)) {
            throw new Error('Cannot detach unknown document buffer')
          }
          if (!canDetachTabFromWindow(role, session.hub.getWindowTabCount(windowId))) {
            throw new Error('Cannot detach the last tab from an auxiliary window')
          }
          const aux = createWindowInSession(session, {
            role: 'auxiliary',
            initialTabs: [payload],
            bounds: computeOffsetAuxiliaryBounds(windowBounds, screen)
          })
          return { windowId: aux.windowId }
        },
        async startTabDrag(input) {
          if (destroyed) {
            throw new Error('Cannot start tab drag from a closed window')
          }
          if (!session.hub.hasBuffer(input.payload.bufferKey)) {
            throw new Error('Cannot drag unknown document buffer')
          }
          return session.dragCoordinator.start(windowId, input)
        },
        async updateTabDragOutcome(dragSessionId, outcome) {
          if (destroyed) return null
          return session.dragCoordinator.updateOutcome(windowId, dragSessionId, outcome)
        },
        async acceptTabDragDrop(input) {
          if (destroyed) {
            return { accepted: false, reason: 'invalid-target-window' }
          }
          const result = session.dragCoordinator.acceptCrossWindowDrop({
            targetWindowId: windowId,
            dragSessionId: input?.dragSessionId,
            bufferHub: session.hub
          })
          if (
            !result.accepted &&
            (result.reason === 'no-active-drag' || result.reason === 'session-mismatch') &&
            hasOtherSessionPendingDrag(session.sessionId)
          ) {
            return { accepted: false, reason: 'different-workspace-session' }
          }
          return result
        },
        async endTabDrag(input) {
          if (destroyed) {
            return { detached: false, outcome: 'cancelled' }
          }
          const canDetach = canDetachTabFromWindow(role, session.hub.getWindowTabCount(windowId))
          const plan = session.dragCoordinator.finish({
            sourceWindowId: windowId,
            input,
            openWindowBounds: getAllOpenWindowBounds(),
            canDetach,
            hasBuffer: (key) => session.hub.hasBuffer(key),
            screen
          })
          if (!plan.detach) {
            return plan.result
          }
          const aux = createWindowInSession(session, {
            role: 'auxiliary',
            initialTabs: [plan.payload],
            bounds: plan.targetBounds
          })
          return { detached: true, windowId: aux.windowId }
        },
        onTabDragStateChanged(listener) {
          dragListeners.add(listener)
          return () => {
            dragListeners.delete(listener)
          }
        },
        async closeCurrent() {
          if (role === 'auxiliary') {
            forceCloseWindow()
          }
        },
        onCloseRequested(listener) {
          closeRequestedListeners.add(listener)
          return () => {
            closeRequestedListeners.delete(listener)
          }
        },
        async resolveCloseRequest(approved) {
          if (destroyed || !closePromptPending) return
          closePromptPending = false
          if (approved) {
            forceCloseWindow()
          }
        },
        async setCloseFlushEnabled(enabled) {
          if (!destroyed && role === 'main') {
            closeFlushEnabled = Boolean(enabled)
          }
        }
      },
      ...(fsOptions.log ? { log: fsOptions.log } : {})
    }

    if (!session.primaryApi) {
      session.primaryApi = api
    }

    const handle: InMemoryWindowHandle = {
      windowId,
      sessionId: session.sessionId,
      role,
      api,
      hub: session.hub,
      emitMenuCommand(command) {
        if (destroyed || role !== 'main') return
        for (const listener of menuListeners) {
          listener(command)
        }
      },
      emitBeforeInput(input) {
        if (destroyed) return
        session.dragCoordinator.handleBeforeInput(input)
      },
      requestClose: requestCloseWindow,
      getBounds: () => ({ ...windowBounds }),
      getMenuListenerCount: () => menuListeners.size,
      isClosed: () => destroyed,
      getInitContext: buildInitContext,
      destroy: destroyWindow
    }

    if (role === 'main') {
      mainHandles.push(handle)
    } else {
      auxiliaryHandles.push(handle)
      session.auxiliaryHandles.push(handle)
    }

    return handle
  }

  const createWindow = (options: CreateInMemoryWindowOptions = {}): InMemoryWindowHandle => {
    return createWindowInSession(defaultSession, options)
  }

  const findSessionByMainWindowId = (mainWindowId?: number): HarnessSession | undefined => {
    if (mainWindowId === undefined) return defaultSession
    const matched = mainHandles.find((win) => win.windowId === mainWindowId)
    return matched ? sessions.get(matched.sessionId) : undefined
  }

  const toWatchState = (target: HarnessSession): InMemoryWindowWatchState => ({
    active: target.watchActive,
    watchCalls: target.watchCalls,
    unwatchCalls: target.unwatchCalls,
    auxWatchCalls: target.auxWatchCalls,
    auxUnwatchCalls: target.auxUnwatchCalls
  })

  return {
    createWindow,
    getMainWindows: () => [...mainHandles],
    getAuxiliaryWindows: (mainWindowId?: number) => {
      if (mainWindowId === undefined) {
        return [...auxiliaryHandles]
      }
      const session = findSessionByMainWindowId(mainWindowId)
      return session ? [...session.auxiliaryHandles] : []
    },
    getWatchState: (mainWindowId?: number) =>
      toWatchState(findSessionByMainWindowId(mainWindowId) ?? defaultSession),
    emitExternalChange(patch) {
      applyAndBroadcast({ ...state, ...patch, version: 1 })
    },
    emitWorkspaceChange(event) {
      if (sessions.size === 1) {
        for (const listener of defaultSession.workspaceListeners) {
          listener(event)
        }
        return
      }
      for (const session of sessions.values()) {
        if (session.activeRoot && isSameWorkspacePath(session.activeRoot, event.rootPath)) {
          for (const listener of session.workspaceListeners) {
            listener(event)
          }
        }
      }
    },
    getListenerCount: () => configListeners.size,
    getFilesSnapshot: () => new Map(files),
    readDirCalls,
    copiedTexts,
    hub: defaultSession.hub,
    dispose() {
      for (const session of sessions.values()) {
        session.unsubscribeCoordinatorHub()
        session.dragCoordinator.dispose()
        session.openWindows.clear()
        session.dragListenersByWindow.clear()
        session.hub.dispose()
        session.workspaceListeners.clear()
      }
      sessions.clear()
      configListeners.clear()
    }
  }
}

export function createInMemoryWikiApi(
  initialOverrides: Partial<AppConfig> = {},
  fsOptions: VirtualFsOptions = {}
): {
  api: WikiApi
  emitExternalChange: (patch: Partial<AppConfig>) => void
  emitWorkspaceChange: (event: WorkspaceChangeEvent) => void
  emitMenuCommand: (command: AppMenuCommand) => void
  getListenerCount: () => number
  getMenuListenerCount: () => number
  getFilesSnapshot: () => Map<string, string>
  readDirCalls: string[]
  copiedTexts: string[]
  dispose: () => void
} {
  const harness = createMultiWindowWikiHarness(initialOverrides, fsOptions)
  const primaryWindow = harness.createWindow()

  return {
    api: primaryWindow.api,
    emitExternalChange: harness.emitExternalChange,
    emitWorkspaceChange: harness.emitWorkspaceChange,
    emitMenuCommand: primaryWindow.emitMenuCommand,
    getListenerCount: harness.getListenerCount,
    getMenuListenerCount: primaryWindow.getMenuListenerCount,
    getFilesSnapshot: harness.getFilesSnapshot,
    readDirCalls: harness.readDirCalls,
    copiedTexts: harness.copiedTexts,
    dispose: harness.dispose
  }
}
