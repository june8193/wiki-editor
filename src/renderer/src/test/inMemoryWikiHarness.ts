import { act } from '@testing-library/react'
import { EditorView } from '@codemirror/view'
import {
  type AppConfig,
  cloneAppConfig,
  DEFAULT_APP_CONFIG,
  validateConfigRaw
} from '@shared/config'
import type { SharedBufferHubEvent } from '@shared/documentBuffer'
import { createEmptyGitStatus } from '@shared/git'
import type { AppMenuCommand, WikiApi, WikiBufferApi, WikiGitApi, WikiLogApi } from '@shared/ipc'
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
  type ActiveTabDragSession,
  type ScreenLike,
  type TabTransferPayload,
  type WindowBounds,
  type WindowInitContext,
  type WindowRole
} from '@shared/window'
import {
  getWorkspaceDisplayName,
  recordRecentWorkspace,
  removeFavoriteWorkspace,
  toggleFavoriteWorkspace,
  type WorkspaceChangeEvent,
  type WorkspaceEntry,
  type WorkspaceEntryKind
} from '@shared/workspace'

export interface VirtualFsOptions {
  workspaces?: Record<string, Record<string, string | null>>
  selectedFolder?: string | null
  git?: Partial<WikiGitApi>
  log?: WikiLogApi
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

export interface InMemoryWindowHandle {
  windowId: number
  role: WindowRole
  api: WikiApi
  emitMenuCommand: (command: AppMenuCommand) => void
  emitBeforeInput: (input: BeforeInputKeyEventLike) => void
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
    async reconcileWorkspaceBuffersWithDisk() {
      return hub.reconcileWorkspaceBuffersWithDisk()
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
  getAuxiliaryWindows: () => InMemoryWindowHandle[]
  getWatchState: () => {
    active: boolean
    watchCalls: number
    unwatchCalls: number
    auxWatchCalls: number
    auxUnwatchCalls: number
  }
  emitExternalChange: (patch: Partial<AppConfig>) => void
  emitWorkspaceChange: (event: WorkspaceChangeEvent) => void
  getListenerCount: () => number
  getFilesSnapshot: () => Map<string, string>
  readDirCalls: string[]
  hub: SharedDocumentBufferHub
  dispose: () => void
}

/**
 * Creates a multi-window in-memory WikiApi test harness backed by a single SharedDocumentBufferHub
 * and shared virtual filesystem/config state.
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
  const workspaceListeners = new Set<(event: WorkspaceChangeEvent) => void>()
  const configPath = 'C:\\Users\\test\\AppData\\Roaming\\wiki-editor\\config.json'

  const dirs = new Set<string>()
  const files = new Map<string, string>()
  const readDirCalls: string[] = []
  let activeRoot: string | null = null
  const selectedFolder: string | null = fsOptions.selectedFolder ?? null
  let nextWindowId = 1
  let watchActive = false
  let watchCalls = 0
  let unwatchCalls = 0
  let auxWatchCalls = 0
  let auxUnwatchCalls = 0
  const auxiliaryHandles: InMemoryWindowHandle[] = []
  const screen: ScreenLike = fsOptions.screen ?? {
    getDisplayNearestPoint: () => ({
      workArea: { x: 0, y: 0, width: 1920, height: 1080 }
    })
  }
  const openWindows = new Map<number, { isDestroyed: () => boolean; getBounds: () => WindowBounds }>()
  const dragListenersByWindow = new Map<number, Set<(session: ActiveTabDragSession | null) => void>>()
  const dragCoordinator = new TabDragCoordinator()
  dragCoordinator.onStateChanged((session) => {
    for (const listeners of dragListenersByWindow.values()) {
      for (const listener of listeners) {
        listener(session)
      }
    }
  })

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

  let primaryApi: WikiApi | null = null

  const hub = new SharedDocumentBufferHub({
    initialAutoSaveConfig: {
      autoSave: state.autoSave,
      autoSaveDelayMs: state.autoSaveDelayMs
    },
    storage: {
      readWorkspaceFile: (filePath) => primaryApi!.workspace.readFile(filePath),
      writeWorkspaceFile: (filePath, content) => primaryApi!.workspace.writeFile(filePath, content),
      getConfigPath: () => primaryApi!.config.getConfigPath(),
      readConfigRaw: () => primaryApi!.config.readRaw(),
      saveConfigRaw: (raw) => primaryApi!.config.saveRaw(raw)
    }
  })

  const unsubscribeCoordinatorHub = hub.subscribe((event) => {
    if (event.type === 'paths-remapped') {
      dragCoordinator.remapPayloadKeys(event.remappings)
    }
  })

  const listDir = (dirPath: string): WorkspaceEntry[] => {
    const target = normalizePosix(dirPath === '.' && activeRoot ? activeRoot : dirPath)
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
          relativePath: activeRoot ? dir.slice(activeRoot.length + 1) : name,
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
          relativePath: activeRoot ? file.slice(activeRoot.length + 1) : name,
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
    hub.setAutoSaveConfig({
      autoSave: state.autoSave,
      autoSaveDelayMs: state.autoSaveDelayMs
    })
    const snapshot = cloneAppConfig(state)
    for (const listener of configListeners) {
      listener(snapshot)
    }
    return cloneAppConfig(snapshot)
  }

  const createWindow = (options: CreateInMemoryWindowOptions = {}): InMemoryWindowHandle => {
    const windowId = nextWindowId++
    const role: WindowRole = options.role ?? 'main'
    const initialTabs: TabTransferPayload[] = cloneTabTransferPayloads(options.initialTabs ?? [])
    const defaultBounds: WindowBounds =
      role === 'main'
        ? (fsOptions.mainBounds ?? { x: 0, y: 0, width: 1280, height: 820 })
        : {
            x: 40,
            y: 40,
            width: AUXILIARY_WINDOW_DEFAULT_WIDTH,
            height: AUXILIARY_WINDOW_DEFAULT_HEIGHT
          }
    const windowBounds: WindowBounds = { ...(options.bounds ?? defaultBounds) }
    let destroyed = false
    let hasSyncedNonEmptyTabs = false
    const menuListeners = new Set<(command: AppMenuCommand) => void>()
    const bufferListeners = new Set<(event: SharedBufferHubEvent) => void>()
    const dragListeners = new Set<(session: ActiveTabDragSession | null) => void>()
    const windowConfigListeners = new Set<(config: AppConfig) => void>()
    const windowWorkspaceListeners = new Set<(event: WorkspaceChangeEvent) => void>()
    dragListenersByWindow.set(windowId, dragListeners)
    openWindows.set(windowId, {
      isDestroyed: () => destroyed,
      getBounds: () => ({ ...windowBounds })
    })

    if (role === 'auxiliary') {
      for (const tab of initialTabs) {
        hub.registerPendingTransfer(windowId, tab.bufferKey)
      }
    }

    const destroyWindow = (): void => {
      if (destroyed) return
      destroyed = true
      dragCoordinator.clearForWindow(windowId)
      openWindows.delete(windowId)
      dragListeners.clear()
      dragListenersByWindow.delete(windowId)
      unsubscribeHub()
      hub.unregisterWindow(windowId)
      menuListeners.clear()
      bufferListeners.clear()
      for (const listener of windowConfigListeners) {
        configListeners.delete(listener)
      }
      windowConfigListeners.clear()
      for (const listener of windowWorkspaceListeners) {
        workspaceListeners.delete(listener)
      }
      windowWorkspaceListeners.clear()
    }

    const unsubscribeHub = hub.subscribe((event) => {
      if (destroyed) return
      if (role === 'auxiliary' && (event.type === 'state-changed' || event.type === 'buffers-closed')) {
        const currentTabCount = hub.getWindowTabCount(windowId)
        if (currentTabCount > 0) {
          hasSyncedNonEmptyTabs = true
        } else if (hasSyncedNonEmptyTabs) {
          destroyWindow()
          return
        }
      }
      for (const listener of bufferListeners) {
        listener(event)
      }
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
          activeRoot = normalized
          applyAndBroadcast({
            ...state,
            recentWorkspaces: recordRecentWorkspace(state.recentWorkspaces, rootPath)
          })
          return {
            rootPath: normalized,
            name: getWorkspaceDisplayName(normalized),
            entries: listDir(normalized)
          }
        },
        async readDir(dirPath) {
          if (!activeRoot) throw new Error('열린 워크스페이스가 없습니다.')
          return listDir(dirPath ?? activeRoot)
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
          if (!activeRoot) throw new Error('열린 워크스페이스가 없습니다.')
          const parent = normalizePosix(parentDirPath === '.' ? activeRoot : parentDirPath)
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
            relativePath: target.slice(activeRoot.length + 1),
            kind
          }
        },
        async renameEntry(targetPath, newName) {
          if (!activeRoot) throw new Error('열린 워크스페이스가 없습니다.')
          const target = normalizePosix(targetPath)
          const next = `${parentDirOf(target)}/${newName}`
          if (dirs.has(next) || files.has(next)) {
            throw new Error(`이미 존재하는 이름입니다: ${newName}`)
          }
          if (files.has(target)) {
            const content = files.get(target)!
            files.delete(target)
            files.set(next, content)
            return {
              name: newName,
              path: next,
              relativePath: next.slice(activeRoot.length + 1),
              kind: 'file'
            }
          }
          if (dirs.has(target)) {
            const movedDirs = [...dirs].filter((d) => d === target || d.startsWith(`${target}/`))
            const movedFiles = [...files.entries()].filter(([f]) => f.startsWith(`${target}/`))
            for (const d of movedDirs) {
              dirs.delete(d)
              dirs.add(next + d.slice(target.length))
            }
            for (const [f, c] of movedFiles) {
              files.delete(f)
              files.set(next + f.slice(target.length), c)
            }
            return {
              name: newName,
              path: next,
              relativePath: next.slice(activeRoot.length + 1),
              kind: 'directory'
            }
          }
          throw new Error(`경로를 찾을 수 없습니다: ${targetPath}`)
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
        async watch() {
          watchCalls += 1
          if (role === 'main') {
            watchActive = true
          } else {
            auxWatchCalls += 1
          }
        },
        async unwatch() {
          unwatchCalls += 1
          if (role === 'main') {
            watchActive = false
          } else {
            auxUnwatchCalls += 1
          }
        },
        onChanged(listener) {
          workspaceListeners.add(listener)
          windowWorkspaceListeners.add(listener)
          return () => {
            workspaceListeners.delete(listener)
            windowWorkspaceListeners.delete(listener)
          }
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
      buffer: createHubBufferApi(hub, windowId, bufferListeners, () => destroyed),
      window: {
        role,
        async getInitContext() {
          return {
            role,
            initialTabs: cloneTabTransferPayloads(initialTabs)
          }
        },
        async detachTabToNewWindow(payload) {
          if (destroyed) {
            throw new Error('Cannot detach tab from a closed window')
          }
          if (!hub.hasBuffer(payload.bufferKey)) {
            throw new Error('Cannot detach unknown document buffer')
          }
          if (!canDetachTabFromWindow(role, hub.getWindowTabCount(windowId))) {
            throw new Error('Cannot detach the last tab from an auxiliary window')
          }
          const aux = createWindow({
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
          if (!hub.hasBuffer(input.payload.bufferKey)) {
            throw new Error('Cannot drag unknown document buffer')
          }
          return dragCoordinator.start(windowId, input)
        },
        async updateTabDragOutcome(dragSessionId, outcome) {
          if (destroyed) return null
          return dragCoordinator.updateOutcome(windowId, dragSessionId, outcome)
        },
        async acceptTabDragDrop(input) {
          if (destroyed) {
            return { accepted: false, reason: 'no-active-drag' }
          }
          return dragCoordinator.acceptCrossWindowDrop({
            targetWindowId: windowId,
            dragSessionId: input?.dragSessionId,
            getBuffer: (key) => hub.getBuffer(key),
            onReserveTransfer: (targetId, bufferKey) => {
              hub.registerPendingTransfer(targetId, bufferKey)
            }
          })
        },
        async endTabDrag(input) {
          if (destroyed) {
            return { detached: false, outcome: 'cancelled' }
          }
          const openWindowBounds = Array.from(openWindows.values())
            .filter((win) => !win.isDestroyed())
            .map((win) => win.getBounds())
          const canDetach = canDetachTabFromWindow(role, hub.getWindowTabCount(windowId))
          const plan = dragCoordinator.finish({
            sourceWindowId: windowId,
            input,
            openWindowBounds,
            canDetach,
            hasBuffer: (key) => hub.hasBuffer(key),
            screen
          })
          if (!plan.detach) {
            return plan.result
          }
          const aux = createWindow({
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
            destroyWindow()
          }
        }
      },
      ...(fsOptions.log ? { log: fsOptions.log } : {})
    }

    if (!primaryApi) {
      primaryApi = api
    }

    const handle: InMemoryWindowHandle = {
      windowId,
      role,
      api,
      emitMenuCommand(command) {
        if (destroyed || role !== 'main') return
        for (const listener of menuListeners) {
          listener(command)
        }
      },
      emitBeforeInput(input) {
        if (destroyed) return
        dragCoordinator.handleBeforeInput(input)
      },
      getBounds: () => ({ ...windowBounds }),
      getMenuListenerCount: () => menuListeners.size,
      isClosed: () => destroyed,
      getInitContext: () => ({
        role,
        initialTabs: cloneTabTransferPayloads(initialTabs)
      }),
      destroy: destroyWindow
    }

    if (role === 'auxiliary') {
      auxiliaryHandles.push(handle)
    }

    return handle
  }

  return {
    createWindow,
    getAuxiliaryWindows: () => [...auxiliaryHandles],
    getWatchState: () => ({
      active: watchActive,
      watchCalls,
      unwatchCalls,
      auxWatchCalls,
      auxUnwatchCalls
    }),
    emitExternalChange(patch) {
      applyAndBroadcast({ ...state, ...patch, version: 1 })
    },
    emitWorkspaceChange(event) {
      for (const listener of workspaceListeners) {
        listener(event)
      }
    },
    getListenerCount: () => configListeners.size,
    getFilesSnapshot: () => new Map(files),
    readDirCalls,
    hub,
    dispose() {
      unsubscribeCoordinatorHub()
      dragCoordinator.dispose()
      openWindows.clear()
      dragListenersByWindow.clear()
      hub.dispose()
      configListeners.clear()
      workspaceListeners.clear()
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
    dispose: harness.dispose
  }
}
