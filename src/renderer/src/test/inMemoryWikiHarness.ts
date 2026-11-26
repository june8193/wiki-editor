import { act } from '@testing-library/react'
import { vi } from 'vitest'
import iconv from 'iconv-lite'
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
import type { SharedBufferHubEvent, SharedBufferStateSnapshot, SyncWindowTabsOptions } from '@shared/documentBuffer'
import {
  DEFAULT_TEXT_ENCODING,
  type TextEncoding,
  UnencodableCharactersError,
  type WriteFileWithEncodingOptions
} from '@shared/encoding'
import {
  FRONTMATTER_SCHEMA_DIR,
  FRONTMATTER_SCHEMA_RELATIVE_PATH,
  type FrontmatterSchemaLoadResult
} from '@shared/frontmatter'
import { createEmptyGitStatus } from '@shared/git'
import type { WorkspaceSearchRequest, WorkspaceSearchResponse } from '@shared/search'
import type {
  TerminalDataEvent,
  TerminalExitEvent,
  TerminalSessionInfo,
  TerminalShellProfile
} from '@shared/terminal'
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
import type { BeforeInputKeyEventLike } from '@shared/tabDragSession'
import {
  AUXILIARY_WINDOW_DEFAULT_HEIGHT,
  AUXILIARY_WINDOW_DEFAULT_WIDTH,
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
  WindowSessionCoordinator,
  type WindowSessionServices
} from '@shared/windowSessionCoordinator'
import {
  compareWorkspaceEntriesByRelativePath,
  filterTopLevelWorkspaceItems,
  getWorkspaceDisplayName,
  getWorkspacePathKey,
  IGNORED_WORKSPACE_ENTRY_NAMES,
  isMarkdownFileName,
  isNestedOrSameWorkspacePath,
  isSameWorkspacePath,
  joinWorkspacePath,
  recordRecentWorkspace,
  removeFavoriteWorkspace,
  toggleFavoriteWorkspace,
  type WorkspaceChangeEvent,
  type WorkspaceEntry,
  type WorkspaceEntryKind,
  type WorkspaceMovedEntry
} from '@shared/workspace'
import {
  filterSearchableTextContent,
  SCHEMA_DIR_NOT_DIRECTORY_ERROR,
  SCHEMA_TARGET_NOT_FILE_ERROR,
  type SchemaRawReadResult,
  WorkspaceQueryAndSchemaHub,
  type WorkspaceQueryStorageListOptions
} from '@shared/workspaceQueryAndSchema'

export interface VirtualFsOptions {
  workspaces?: Record<string, Record<string, string | null>>
  workspacesEncoding?: Record<string, Record<string, TextEncoding>>
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
  getFocusCount: () => number
  getRestoreCount: () => number
  isMinimized: () => boolean
  setMinimized: (minimized: boolean) => void
  isClosed: () => boolean
  getInitContext: () => WindowInitContext
  destroy: () => void
}

/** Creates a WikiBufferApi facade backed directly by a SharedDocumentBufferHub instance. */
export function createHubBufferApi(
  hub: SharedDocumentBufferHub,
  windowId: number,
  bufferListeners: Set<(event: SharedBufferHubEvent) => void>,
  isWindowDestroyed: () => boolean = () => false,
  onSyncWindowTabs: (
    bufferKeys: readonly string[],
    options?: SyncWindowTabsOptions
  ) => SharedBufferStateSnapshot = (bufferKeys, options) =>
    hub.syncWindowTabs(windowId, bufferKeys, options)
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
    async setEncoding(key, encoding) {
      return hub.setEncoding(key, encoding)
    },
    async reopenWithEncoding(key, encoding) {
      return hub.reopenWithEncoding(key, encoding)
    },
    async saveBuffer(key, options) {
      return hub.saveBuffer(key, options)
    },
    async syncWindowTabs(bufferKeys, options) {
      return onSyncWindowTabs(bufferKeys, options)
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
  getFileEncoding: (filePath: string) => TextEncoding
  readDirCalls: string[]
  copiedTexts: string[]
  emitTerminalData: (sessionId: string, data: string) => void
  emitTerminalExit: (sessionId: string, exitCode: number | null, signal?: number) => void
  getTerminalSessions: () => TerminalSessionInfo[]
  getTerminalClosedIds: () => string[]
  getTerminalWrites: () => Array<{ sessionId: string; data: string }>
  getTerminalResizes: () => Array<{ sessionId: string; cols: number; rows: number }>
  hub: SharedDocumentBufferHub
  dispose: () => void
}

interface InMemorySessionServices extends WindowSessionServices {
  readonly sessionId: number
  readonly hub: SharedDocumentBufferHub
  readonly queryAndSchemaHub: WorkspaceQueryAndSchemaHub
  primaryApi: WikiApi | null
  activeRoot: string | null
  workspaceListeners: Set<(event: WorkspaceChangeEvent) => void>
  rootChangedListeners: Set<(rootPath: string | null) => Promise<void> | void>
  schemaWatchers: Set<() => void>
  bufferListenerSets: Set<Set<(event: SharedBufferHubEvent) => void>>
  dragListenersByWindow: Map<number, Set<(session: ActiveTabDragSession | null) => void>>
  auxiliaryHandles: InMemoryWindowHandle[]
  watchActive: boolean
  watchCalls: number
  unwatchCalls: number
  auxWatchCalls: number
  auxUnwatchCalls: number
}

/**
 * Creates a multi-window in-memory WikiApi test harness backed by `WindowSessionCoordinator`
 * for isolated per-main-window workspace sessions, shared buffer hubs, and global config broadcasts.
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
  const fileEncodings = new Map<string, TextEncoding>()
  const readDirCalls: string[] = []
  const copiedTexts: string[] = []
  const terminalSessions = new Map<string, TerminalSessionInfo>()
  const terminalClosedIds: string[] = []
  const terminalWrites: Array<{ sessionId: string; data: string }> = []
  const terminalResizes: Array<{ sessionId: string; cols: number; rows: number }> = []
  const terminalDataListeners = new Set<(event: TerminalDataEvent) => void>()
  const terminalExitListeners = new Set<(event: TerminalExitEvent) => void>()
  let nextTerminalSessionSeq = 1
  const defaultProfiles: TerminalShellProfile[] = [
    { id: 'pwsh', label: 'PowerShell', executable: 'pwsh.exe', args: ['-NoLogo'], isDefault: true },
    { id: 'cmd', label: 'Command Prompt', executable: 'cmd.exe', args: [], isDefault: false }
  ]
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
  const mainHandles: InMemoryWindowHandle[] = []
  const auxiliaryHandles: InMemoryWindowHandle[] = []
  const handlesByWindowId = new Map<number, InMemoryWindowHandle>()
  const allServicesById = new Map<number, InMemorySessionServices>()
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
          const seededEncoding = fsOptions.workspacesEncoding?.[rootRaw]?.[relRaw]
          if (seededEncoding) {
            fileEncodings.set(cursor, seededEncoding)
          }
        } else {
          dirs.add(cursor)
        }
      }
    }
  }

  const listSessionWorkspaceFiles = (
    session: InMemorySessionServices,
    options: WorkspaceQueryStorageListOptions = {}
  ): WorkspaceEntry[] => {
    if (!session.activeRoot) {
      throw new Error('열린 워크스페이스가 없습니다.')
    }
    const prefix = `${session.activeRoot}/`
    const entries: WorkspaceEntry[] = []
    for (const filePath of files.keys()) {
      if (options.signal?.aborted) {
        return []
      }
      if (!filePath.startsWith(prefix)) continue
      const relativePath = filePath.slice(prefix.length)
      if (relativePath.split('/').some((seg) => IGNORED_WORKSPACE_ENTRY_NAMES.has(seg))) {
        continue
      }
      const name = baseNameOf(filePath)
      if (options.filterFileName && !options.filterFileName(name)) {
        continue
      }
      entries.push({
        name,
        path: filePath,
        relativePath,
        kind: 'file'
      })
    }
    return entries.sort(compareWorkspaceEntriesByRelativePath)
  }

  const notifySessionSchemaWatchers = (session: InMemorySessionServices): void => {
    for (const watcher of [...session.schemaWatchers]) {
      watcher()
    }
  }

  const listDir = (session: InMemorySessionServices, dirPath: string): WorkspaceEntry[] => {
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

  const inspectVirtualSchemaTarget = (
    rootPath: string
  ): { schemaDir: string; schemaPath: string; invalidError?: string } => {
    const schemaDir = joinWorkspacePath(rootPath, FRONTMATTER_SCHEMA_DIR)
    const schemaPath = joinWorkspacePath(rootPath, FRONTMATTER_SCHEMA_RELATIVE_PATH)
    if (files.has(schemaDir)) {
      return {
        schemaDir,
        schemaPath,
        invalidError: SCHEMA_DIR_NOT_DIRECTORY_ERROR
      }
    }
    if (dirs.has(schemaPath)) {
      return {
        schemaDir,
        schemaPath,
        invalidError: SCHEMA_TARGET_NOT_FILE_ERROR
      }
    }
    return { schemaDir, schemaPath }
  }

  const relocateVirtualEntry = (
    session: InMemorySessionServices,
    oldPath: string,
    nextPath: string,
    kind: WorkspaceEntryKind
  ): WorkspaceEntry => {
    if (kind === 'file') {
      const content = files.get(oldPath)!
      files.delete(oldPath)
      files.set(nextPath, content)
    } else {
      const movedDirs = [...dirs].filter((d) => d === oldPath || d.startsWith(`${oldPath}/`))
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

  let coordinator!: WindowSessionCoordinator<InMemorySessionServices>

  const applyAndBroadcast = (nextState: AppConfig): AppConfig => {
    state = cloneAppConfig(nextState)
    coordinator.forEachSession((session) => {
      session.services.hub.setAutoSaveConfig({
        autoSave: state.autoSave,
        autoSaveDelayMs: state.autoSaveDelayMs
      })
      void session.services.hub.refreshCleanConfig().catch(() => undefined)
    })
    const snapshot = cloneAppConfig(state)
    for (const listener of configListeners) {
      listener(snapshot)
    }
    return cloneAppConfig(snapshot)
  }

  const findVirtualDir = (rawPath: string): string | null => {
    const normalized = normalizePosix(rawPath)
    if (dirs.has(normalized)) {
      return normalized
    }
    for (const dir of dirs) {
      if (isSameWorkspacePath(dir, normalized)) {
        return dir
      }
    }
    return null
  }

  const resolveVirtualWorkspacePath = async (rawPath: string): Promise<string> => {
    const trimmed = rawPath.trim()
    if (!trimmed) {
      throw new Error('워크스페이스 경로가 비어 있습니다.')
    }
    const normalized = normalizePosix(trimmed)
    if (files.has(normalized)) {
      throw new Error('선택한 경로는 폴더가 아닙니다.')
    }
    const resolvedDir = findVirtualDir(trimmed)
    if (!resolvedDir) {
      throw new Error(`워크스페이스 폴더를 찾을 수 없습니다: ${rawPath}`)
    }
    return resolvedDir
  }

  coordinator = new WindowSessionCoordinator<InMemorySessionServices>({
    screen,
    resolveValidWorkspacePath: resolveVirtualWorkspacePath,
    tryResolveWorkspacePath: async (rawPath) => {
      const trimmed = rawPath.trim()
      return trimmed ? findVirtualDir(trimmed) : null
    },
    createSessionServices: (sessionId) => {
      let activeRoot: string | null = null
      let primaryApi: WikiApi | null = null
      const workspaceListeners = new Set<(event: WorkspaceChangeEvent) => void>()
      const rootChangedListeners = new Set<(rootPath: string | null) => Promise<void> | void>()
      const schemaWatchers = new Set<() => void>()
      const bufferListenerSets = new Set<Set<(event: SharedBufferHubEvent) => void>>()
      const dragListenersByWindow = new Map<
        number,
        Set<(session: ActiveTabDragSession | null) => void>
      >()

      const hub = new SharedDocumentBufferHub({
        initialAutoSaveConfig: {
          autoSave: state.autoSave,
          autoSaveDelayMs: state.autoSaveDelayMs
        },
        storage: {
          readWorkspaceFile: (filePath) => primaryApi!.workspace.readFile(filePath),
          readWorkspaceFileWithEncoding: async (filePath, forcedEncoding) => {
            const content = await primaryApi!.workspace.readFile(filePath)
            const normalized = normalizePosix(filePath)
            const storedEncoding = fileEncodings.get(normalized) ?? DEFAULT_TEXT_ENCODING
            if (!forcedEncoding || forcedEncoding === storedEncoding) {
              return { content, encoding: storedEncoding }
            }
            const rawBytes =
              storedEncoding === 'euc-kr'
                ? iconv.encode(content, 'cp949')
                : new TextEncoder().encode(content)
            const redecoded =
              forcedEncoding === 'euc-kr'
                ? iconv.decode(rawBytes, 'cp949')
                : new TextDecoder('utf-8', { fatal: false }).decode(rawBytes)
            return { content: redecoded, encoding: forcedEncoding }
          },
          writeWorkspaceFile: async (
            filePath,
            content,
            options?: WriteFileWithEncodingOptions
          ) => {
            const normalized = normalizePosix(filePath)
            if (!files.has(normalized) && !dirs.has(parentDirOf(normalized))) {
              throw new Error(`경로를 찾을 수 없습니다: ${filePath}`)
            }
            const encoding = options?.encoding ?? DEFAULT_TEXT_ENCODING
            if (encoding === 'euc-kr') {
              const encoded = iconv.encode(content, 'cp949')
              const roundtripped = iconv.decode(encoded, 'cp949')
              if (roundtripped !== content) {
                const samples: string[] = []
                let count = 0
                const origChars = Array.from(content)
                const roundChars = Array.from(roundtripped)
                for (let i = 0; i < origChars.length; i += 1) {
                  if (origChars[i] !== roundChars[i]) {
                    count += 1
                    if (!samples.includes(origChars[i]) && samples.length < 5) {
                      samples.push(origChars[i])
                    }
                  }
                }
                if (!options?.allowLossy) {
                  throw new UnencodableCharactersError('euc-kr', {
                    count: Math.max(1, count),
                    samples
                  })
                }
                files.set(normalized, roundtripped)
                fileEncodings.set(normalized, 'euc-kr')
                return
              }
            }
            fileEncodings.set(normalized, encoding)
            await primaryApi!.workspace.writeFile(filePath, content)
          },
          readWorkspaceDirectory: (dirPath) => primaryApi!.workspace.readDir(dirPath),
          getConfigPath: () => primaryApi!.config.getConfigPath(),
          readConfigRaw: () => primaryApi!.config.readRaw(),
          saveConfigRaw: (raw) => primaryApi!.config.saveRaw(raw)
        }
      })

      const unsubscribeHubForward = hub.subscribe((event) => {
        for (const listenerSet of bufferListenerSets) {
          for (const listener of listenerSet) {
            listener(event)
          }
        }
      })

      const queryAndSchemaHub = new WorkspaceQueryAndSchemaHub({
        bufferHub: hub,
        storage: {
          getWorkspaceRoot: () => activeRoot,
          onWorkspaceRootChanged: (listener) => {
            rootChangedListeners.add(listener)
            return () => {
              rootChangedListeners.delete(listener)
            }
          },
          async listWorkspaceFiles(options = {}) {
            return listSessionWorkspaceFiles(session, options)
          },
          async readTextFileForSearch(filePath, options = {}) {
            if (options.signal?.aborted) {
              return null
            }
            const text = files.get(normalizePosix(filePath))
            return text === undefined ? null : filterSearchableTextContent(text)
          },
          async readSchemaRaw(rootPath): Promise<SchemaRawReadResult> {
            const { schemaPath, invalidError } = inspectVirtualSchemaTarget(rootPath)
            if (invalidError) {
              return { kind: 'invalid-target', schemaPath, error: invalidError }
            }
            const rawText = files.get(schemaPath)
            if (rawText === undefined) {
              return { kind: 'missing', schemaPath }
            }
            return { kind: 'present', schemaPath, rawText }
          },
          async writeSchemaRaw(rootPath, serializedSchema) {
            const { schemaDir, schemaPath, invalidError } = inspectVirtualSchemaTarget(rootPath)
            if (invalidError) {
              throw new Error(invalidError)
            }
            dirs.add(schemaDir)
            files.set(schemaPath, serializedSchema)
            return { schemaPath }
          },
          watchSchema(_rootPath, onPossibleChange) {
            schemaWatchers.add(onPossibleChange)
            return () => {
              schemaWatchers.delete(onPossibleChange)
            }
          }
        }
      })

      const session: InMemorySessionServices = {
        sessionId,
        bufferHub: hub,
        hub,
        queryAndSchemaHub,
        get primaryApi() {
          return primaryApi
        },
        set primaryApi(api: WikiApi | null) {
          primaryApi = api
        },
        get activeRoot() {
          return activeRoot
        },
        set activeRoot(nextRoot: string | null) {
          activeRoot = nextRoot
        },
        workspaceListeners,
        rootChangedListeners,
        schemaWatchers,
        bufferListenerSets,
        dragListenersByWindow,
        auxiliaryHandles: [],
        watchActive: false,
        watchCalls: 0,
        unwatchCalls: 0,
        auxWatchCalls: 0,
        auxUnwatchCalls: 0,
        getWorkspaceRoot: () => activeRoot,
        openWorkspace: async (resolvedRootPath) => {
          activeRoot = resolvedRootPath
          for (const listener of [...rootChangedListeners]) {
            await listener(resolvedRootPath)
          }
          return {
            rootPath: resolvedRootPath,
            name: getWorkspaceDisplayName(resolvedRootPath),
            entries: listDir(session, resolvedRootPath)
          }
        },
        cancelActiveWorkspaceScans: () => queryAndSchemaHub.cancelActiveScans(),
        dispose: () => {
          unsubscribeHubForward()
          queryAndSchemaHub.dispose()
          hub.dispose()
          workspaceListeners.clear()
          rootChangedListeners.clear()
          schemaWatchers.clear()
          bufferListenerSets.clear()
          dragListenersByWindow.clear()
        }
      }

      allServicesById.set(sessionId, session)
      return session
    },
    createWindow: ({ sessionId, role, bounds, services: session, callbacks }) => {
      const windowId = nextWindowId++
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
      const windowBounds: WindowBounds = { ...defaultBounds, ...bounds }
      let destroyed = false
      let minimized = false
      let focusCount = 0
      let restoreCount = 0

      const menuListeners = new Set<(command: AppMenuCommand) => void>()
      const bufferListeners = new Set<(event: SharedBufferHubEvent) => void>()
      const dragListeners = new Set<(dragSession: ActiveTabDragSession | null) => void>()
      const closeRequestedListeners = new Set<() => void>()
      const windowConfigListeners = new Set<(config: AppConfig) => void>()
      const windowWorkspaceListeners = new Set<(event: WorkspaceChangeEvent) => void>()
      const windowSchemaUnsubscribers = new Set<() => void>()

      session.bufferListenerSets.add(bufferListeners)
      session.dragListenersByWindow.set(windowId, dragListeners)

      const cleanupWindowResources = (): void => {
        menuListeners.clear()
        bufferListeners.clear()
        session.bufferListenerSets.delete(bufferListeners)
        dragListeners.clear()
        session.dragListenersByWindow.delete(windowId)
        closeRequestedListeners.clear()
        for (const listener of windowConfigListeners) {
          configListeners.delete(listener)
        }
        windowConfigListeners.clear()
        for (const listener of windowWorkspaceListeners) {
          session.workspaceListeners.delete(listener)
        }
        windowWorkspaceListeners.clear()
        for (const unsubscribe of [...windowSchemaUnsubscribers]) {
          unsubscribe()
        }
        windowSchemaUnsubscribers.clear()
      }

      const closeWindow = (): void => {
        if (destroyed) return
        destroyed = true
        cleanupWindowResources()
        callbacks.onClosed()
      }

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
            const info = await coordinator.openWorkspaceInSession(windowId, rootPath)
            applyAndBroadcast({
              ...state,
              recentWorkspaces: recordRecentWorkspace(state.recentWorkspaces, rootPath)
            })
            return info
          },
          async openInNewWindow(rootPath) {
            return coordinator.openWorkspaceInNewWindow(windowId, rootPath)
          },
          async focusIfOpen(rootPath) {
            return coordinator.focusWorkspaceIfOpen(windowId, rootPath)
          },
          async readDir(dirPath) {
            if (!session.activeRoot) throw new Error('열린 워크스페이스가 없습니다.')
            return listDir(session, dirPath ?? session.activeRoot)
          },
          async listMarkdownFiles() {
            return listSessionWorkspaceFiles(session, { filterFileName: isMarkdownFileName })
          },
          search(request: WorkspaceSearchRequest): Promise<WorkspaceSearchResponse> {
            return session.queryAndSchemaHub.search(request)
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
            if (
              session.activeRoot &&
              normalized === `${session.activeRoot}/${FRONTMATTER_SCHEMA_RELATIVE_PATH}`
            ) {
              notifySessionSchemaWatchers(session)
            }
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
              return relocateVirtualEntry(session, target, next, 'file')
            }
            if (dirs.has(target)) {
              return relocateVirtualEntry(session, target, next, 'directory')
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
                entry: relocateVirtualEntry(session, plan.oldPath, plan.nextPath, plan.kind)
              })
            }
            return moved
          },
          async deleteEntry(targetPath) {
            const target = normalizePosix(targetPath)
            if (files.has(target)) {
              files.delete(target)
              notifySessionSchemaWatchers(session)
              return
            }
            if (dirs.has(target)) {
              for (const d of [...dirs]) {
                if (d === target || d.startsWith(`${target}/`)) dirs.delete(d)
              }
              for (const f of [...files.keys()]) {
                if (f.startsWith(`${target}/`)) files.delete(f)
              }
              notifySessionSchemaWatchers(session)
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
        frontmatter: {
          getSchema: () => session.queryAndSchemaHub.getSchema(),
          createDefaultSchema: () => session.queryAndSchemaHub.createDefaultSchema(),
          saveSchema: (rawSchema) => session.queryAndSchemaHub.saveSchema(rawSchema),
          getFieldValues: (fieldKeys?: string[]) =>
            session.queryAndSchemaHub.collectFieldValues(fieldKeys),
          onSchemaChanged(listener) {
            if (destroyed) {
              return () => undefined
            }
            const unsubscribe = session.queryAndSchemaHub.onSchemaChanged(listener)
            const cleanup = (): void => {
              windowSchemaUnsubscribers.delete(cleanup)
              unsubscribe()
            }
            windowSchemaUnsubscribers.add(cleanup)
            return cleanup
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
          fetch: async (workspacePath) => createEmptyGitStatus(true, workspacePath),
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
          compareRefs: async () => ({
            defaultBaseRef: null,
            currentRef: null,
            worktrees: [],
            localBranches: [],
            remoteBranches: []
          }),
          compareSummary: async (_workspacePath, request) => ({
            baseRef: request.baseRef,
            compareRef: request.compareRef,
            mode: request.mode,
            mergeBaseHash: null,
            totalAdditions: 0,
            totalDeletions: 0,
            files: [],
            commits: []
          }),
          stashList: async () => [],
          stashDetail: async (_workspacePath, stashRef) => ({
            ref: stashRef,
            hash: '0000000000000000000000000000000000000000',
            branch: null,
            message: '',
            createdAt: '',
            files: []
          }),
          stashCreate: async (workspacePath) => createEmptyGitStatus(true, workspacePath),
          stashApply: async (workspacePath) => createEmptyGitStatus(true, workspacePath),
          stashPop: async (workspacePath) => createEmptyGitStatus(true, workspacePath),
          stashDrop: async () => [],
          stashClear: async () => [],
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
        buffer: createHubBufferApi(
          session.hub,
          windowId,
          bufferListeners,
          () => destroyed,
          (bufferKeys, options) => coordinator.syncWindowTabs(windowId, bufferKeys, options)
        ),
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
            return coordinator.getWindowInitContext(windowId)
          },
          async detachTabToNewWindow(payload) {
            return coordinator.detachTabToNewWindow(windowId, payload)
          },
          async startTabDrag(input) {
            return coordinator.startTabDrag(windowId, input)
          },
          async updateTabDragOutcome(dragSessionId, outcome) {
            return coordinator.updateTabDragOutcome(windowId, dragSessionId, outcome)
          },
          async acceptTabDragDrop(input) {
            return coordinator.acceptTabDragDrop(windowId, input)
          },
          async endTabDrag(input) {
            return coordinator.endTabDrag(windowId, input)
          },
          onTabDragStateChanged(listener) {
            dragListeners.add(listener)
            return () => {
              dragListeners.delete(listener)
            }
          },
          async closeCurrent() {
            coordinator.closeCurrentWindow(windowId)
          },
          onCloseRequested(listener) {
            closeRequestedListeners.add(listener)
            return () => {
              closeRequestedListeners.delete(listener)
            }
          },
          async resolveCloseRequest(approved) {
            coordinator.resolveCloseRequest(windowId, approved)
          },
          async setCloseFlushEnabled(enabled) {
            coordinator.setCloseFlushEnabled(windowId, enabled)
          }
        },
        ...(fsOptions.log ? { log: fsOptions.log } : {}),
        terminal: {
          async listProfiles() {
            return defaultProfiles.map((profile) => ({ ...profile, args: [...profile.args] }))
          },
          async createSession(request) {
            if (role !== 'main') {
              throw new Error('보조 창에서는 터미널을 사용할 수 없습니다.')
            }
            if (!session.activeRoot) {
              throw new Error('열린 워크스페이스가 없습니다.')
            }
            const profile =
              defaultProfiles.find((candidate) => candidate.id === request.profileId) ??
              defaultProfiles[0]
            const id = `term-${nextTerminalSessionSeq++}`
            const info: TerminalSessionInfo = {
              id,
              profileId: profile.id,
              title: profile.label,
              cwd: session.activeRoot,
              pid: 1000 + nextTerminalSessionSeq,
              isRunning: true
            }
            terminalSessions.set(id, info)
            return { ...info }
          },
          async write(sessionId, data) {
            terminalWrites.push({ sessionId, data })
          },
          async resize(sessionId, cols, rows) {
            terminalResizes.push({ sessionId, cols, rows })
          },
          async closeSession(sessionId) {
            terminalClosedIds.push(sessionId)
            const existing = terminalSessions.get(sessionId)
            if (existing) {
              terminalSessions.set(sessionId, { ...existing, isRunning: false })
            }
          },
          async openExternalUrl() {
            return true
          },
          onData(listener) {
            terminalDataListeners.add(listener)
            return () => {
              terminalDataListeners.delete(listener)
            }
          },
          onExit(listener) {
            terminalExitListeners.add(listener)
            return () => {
              terminalExitListeners.delete(listener)
            }
          }
        }
      }

      if (!session.primaryApi) {
        session.primaryApi = api
      }

      const handle: InMemoryWindowHandle = {
        windowId,
        sessionId,
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
          coordinator.handleBeforeInput(input)
        },
        requestClose: () => {
          if (destroyed) return
          if (callbacks.onCloseAttempt()) {
            closeWindow()
          }
        },
        getBounds: () => ({ ...windowBounds }),
        getMenuListenerCount: () => menuListeners.size,
        getFocusCount: () => focusCount,
        getRestoreCount: () => restoreCount,
        isMinimized: () => minimized,
        setMinimized: (nextMinimized) => {
          minimized = nextMinimized
        },
        isClosed: () => destroyed,
        getInitContext: () => coordinator.getWindowInitContext(windowId),
        destroy: closeWindow
      }

      handlesByWindowId.set(windowId, handle)
      if (role === 'main') {
        mainHandles.push(handle)
      } else {
        auxiliaryHandles.push(handle)
        session.auxiliaryHandles.push(handle)
      }

      return {
        windowId,
        getBounds: () => ({ ...windowBounds }),
        isDestroyed: () => destroyed,
        isMinimized: () => minimized,
        isFocused: () => false,
        restore: () => {
          if (minimized) {
            minimized = false
            restoreCount += 1
          }
        },
        focus: () => {
          if (!destroyed) {
            focusCount += 1
          }
        },
        close: closeWindow,
        sendCloseRequested: () => {
          for (const listener of closeRequestedListeners) {
            listener()
          }
        },
        dispose: cleanupWindowResources
      }
    }
  })

  const unsubscribeDragBroadcast = coordinator.onTabDragStateChanged(
    (dragSession, targetWindowIds) => {
      for (const windowId of targetWindowIds) {
        const win = handlesByWindowId.get(windowId)
        if (!win) continue
        const listeners = allServicesById.get(win.sessionId)?.dragListenersByWindow.get(windowId)
        if (!listeners) continue
        for (const listener of listeners) {
          listener(dragSession)
        }
      }
    }
  )

  const initialSession = coordinator.createSession()
  let defaultSessionId = initialSession.sessionId
  let latestDefaultServices = initialSession.services

  const ensureDefaultSessionId = (): number => {
    if (!coordinator.hasLiveSession(defaultSessionId)) {
      const nextSession = coordinator.createSession()
      defaultSessionId = nextSession.sessionId
      latestDefaultServices = nextSession.services
    }
    return defaultSessionId
  }

  const createWindow = (options: CreateInMemoryWindowOptions = {}): InMemoryWindowHandle => {
    const hosted = coordinator.joinSessionWindow(ensureDefaultSessionId(), {
      role: options.role ?? 'main',
      initialTabs: options.initialTabs,
      bounds: options.bounds
    })
    return handlesByWindowId.get(hosted.windowId)!
  }

  return {
    createWindow,
    getMainWindows: () => [...mainHandles],
    getAuxiliaryWindows: (mainWindowId?: number) => {
      if (mainWindowId === undefined) {
        return [...auxiliaryHandles]
      }
      const matched = mainHandles.find((win) => win.windowId === mainWindowId)
      const session = matched ? allServicesById.get(matched.sessionId) : undefined
      return session ? [...session.auxiliaryHandles] : []
    },
    getWatchState: () => ({
      active: latestDefaultServices.watchActive,
      watchCalls: latestDefaultServices.watchCalls,
      unwatchCalls: latestDefaultServices.unwatchCalls,
      auxWatchCalls: latestDefaultServices.auxWatchCalls,
      auxUnwatchCalls: latestDefaultServices.auxUnwatchCalls
    }),
    emitExternalChange(patch) {
      applyAndBroadcast({ ...state, ...patch, version: 1 })
    },
    emitWorkspaceChange(event) {
      const liveServices: InMemorySessionServices[] = []
      coordinator.forEachSession((session) => {
        liveServices.push(session.services)
      })
      if (liveServices.length === 1) {
        for (const listener of liveServices[0].workspaceListeners) {
          listener(event)
        }
        notifySessionSchemaWatchers(liveServices[0])
        return
      }
      for (const session of liveServices) {
        if (session.activeRoot && isSameWorkspacePath(session.activeRoot, event.rootPath)) {
          for (const listener of session.workspaceListeners) {
            listener(event)
          }
          notifySessionSchemaWatchers(session)
        }
      }
    },
    getListenerCount: () => configListeners.size,
    getFilesSnapshot: () => new Map(files),
    getFileEncoding: (filePath) => fileEncodings.get(normalizePosix(filePath)) ?? DEFAULT_TEXT_ENCODING,
    readDirCalls,
    copiedTexts,
    emitTerminalData(sessionId, data) {
      for (const listener of terminalDataListeners) {
        listener({ sessionId, data })
      }
    },
    emitTerminalExit(sessionId, exitCode, signal) {
      const existing = terminalSessions.get(sessionId)
      if (existing) {
        terminalSessions.set(sessionId, { ...existing, isRunning: false })
      }
      for (const listener of terminalExitListeners) {
        listener({ sessionId, exitCode, signal })
      }
    },
    getTerminalSessions: () => [...terminalSessions.values()],
    getTerminalClosedIds: () => [...terminalClosedIds],
    getTerminalWrites: () => [...terminalWrites],
    getTerminalResizes: () => [...terminalResizes],
    get hub() {
      return latestDefaultServices.hub
    },
    dispose() {
      unsubscribeDragBroadcast()
      coordinator.dispose()
      handlesByWindowId.clear()
      allServicesById.clear()
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
  getFileEncoding: (filePath: string) => TextEncoding
  readDirCalls: string[]
  copiedTexts: string[]
  emitTerminalData: (sessionId: string, data: string) => void
  emitTerminalExit: (sessionId: string, exitCode: number | null, signal?: number) => void
  getTerminalSessions: () => TerminalSessionInfo[]
  getTerminalClosedIds: () => string[]
  getTerminalWrites: () => Array<{ sessionId: string; data: string }>
  getTerminalResizes: () => Array<{ sessionId: string; cols: number; rows: number }>
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
    getFileEncoding: harness.getFileEncoding,
    readDirCalls: harness.readDirCalls,
    copiedTexts: harness.copiedTexts,
    emitTerminalData: harness.emitTerminalData,
    emitTerminalExit: harness.emitTerminalExit,
    getTerminalSessions: harness.getTerminalSessions,
    getTerminalClosedIds: harness.getTerminalClosedIds,
    getTerminalWrites: harness.getTerminalWrites,
    getTerminalResizes: harness.getTerminalResizes,
    dispose: harness.dispose
  }
}
