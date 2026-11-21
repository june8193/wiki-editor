import type { AppConfig } from '@shared/config'
import { toErrorMessage } from '@shared/errors'
import type {
  WikiWindowApi,
  WikiWorkspaceApi,
  WikiWorkspaceStateApi
} from '@shared/ipc'
import { createWindowInitContextLoader, type WindowInitContext } from '@shared/window'
import {
  getWorkspacePathKey,
  isSameWorkspacePath,
  reanchorPathInWorkspace,
  readDirectoriesSettled,
  type WorkspaceEntry,
  type WorkspaceInfo,
  type WorkspaceSummary
} from '@shared/workspace'
import {
  filterExpandedDirsForWorkspace,
  type PersistedWorkspacePaneLayout,
  type PersistedWorkspaceState,
  type WorkspaceStateUpdate
} from '@shared/workspaceState'
import { logRendererInfo } from '../logging/rendererLogger'
import { promptUnsavedWorkspaceChanges, type ConfirmUnsavedChangesFn } from '../utils/confirmPrompts'
import {
  type RestoreWorkspaceLayoutOptions,
  type RestoreWorkspaceLayoutResult,
  serializePaneLayoutForWorkspace,
  type WorkspaceLayoutSnapshot
} from './workspaceLayoutPersistence'

export const DEFAULT_WORKSPACE_STATE_SAVE_DEBOUNCE_MS = 250

export interface OpenedWorkspaceTreeData {
  workspace: WorkspaceSummary
  rootEntries: readonly WorkspaceEntry[]
  childrenByDir: Readonly<Record<string, readonly WorkspaceEntry[]>>
  expandedDirs: ReadonlySet<string>
  markdownFiles: readonly WorkspaceEntry[]
}

export interface WorkspaceTreeCollaborator {
  getExpandedDirs(): ReadonlySet<string>
  applyOpenedWorkspace(opened: OpenedWorkspaceTreeData): void
}

export interface WorkspaceEditorCollaborator {
  getDirtyWorkspaceSummary(): string | null
  ensureAllWorkspaceBuffersSaved(): Promise<boolean>
  clearWorkspaceBuffers(): void
  restoreWorkspaceLayout(options: RestoreWorkspaceLayoutOptions): Promise<RestoreWorkspaceLayoutResult>
  getLatestLayoutSnapshot(): WorkspaceLayoutSnapshot
}

export interface WorkspaceConfirmCollaborator {
  confirmUnsavedChanges: ConfirmUnsavedChangesFn
  isDialogOpen(): boolean
}

export interface WorkspaceLifecycleUiCollaborator {
  reportError(message: string | null, error?: unknown): void
  removeRecentWorkspace(workspacePath: string): void
  onEnterExplorerView(reason: 'startup' | 'switch'): void
}

export interface BeforeUnloadEventTarget {
  addEventListener(type: 'beforeunload', listener: () => void): void
  removeEventListener(type: 'beforeunload', listener: () => void): void
}

export type LifecycleWorkspaceApi = Pick<
  WikiWorkspaceApi,
  | 'selectFolder'
  | 'open'
  | 'openInNewWindow'
  | 'focusIfOpen'
  | 'readDir'
  | 'listMarkdownFiles'
  | 'watch'
  | 'unwatch'
>

export interface MainWindowWorkspaceLifecycleOptions {
  workspaceApi: LifecycleWorkspaceApi
  workspaceStateApi?: WikiWorkspaceStateApi
  windowApi?: Pick<WikiWindowApi, 'getInitContext'>
  tree: WorkspaceTreeCollaborator
  editor: WorkspaceEditorCollaborator
  confirm: WorkspaceConfirmCollaborator
  ui: WorkspaceLifecycleUiCollaborator
  debounceMs?: number
  beforeUnloadTarget?: BeforeUnloadEventTarget
}

type OpenWorkspaceResult = 'opened' | 'superseded' | 'failed'

function resolveExpandedCandidatePaths(
  info: WorkspaceInfo,
  persistedState: PersistedWorkspaceState | null
): { candidates: string[]; hadInvalidEntries: boolean } {
  if (!persistedState || persistedState.expandedDirs.length === 0) {
    return { candidates: [], hadInvalidEntries: false }
  }
  const validDirs = filterExpandedDirsForWorkspace(info.rootPath, persistedState.expandedDirs)
  const candidates = validDirs.map((validDir) => reanchorPathInWorkspace(info.rootPath, validDir))
  return {
    candidates,
    hadInvalidEntries: validDirs.length < persistedState.expandedDirs.length
  }
}

function reconcileRestoredDirectories(
  rootEntries: readonly WorkspaceEntry[],
  loadedDirs: ReadonlyArray<{ dirPath: string; entries: WorkspaceEntry[] }>,
  candidateCount: number
): {
  restoredExpandedDirs: Set<string>
  restoredChildrenByDir: Record<string, WorkspaceEntry[]>
  hadMissingDirs: boolean
} {
  const entryPathByKey = new Map<string, string>()
  const indexDirEntries = (entries: readonly WorkspaceEntry[]): void => {
    for (const entry of entries) {
      if (entry.kind === 'directory') {
        entryPathByKey.set(getWorkspacePathKey(entry.path), entry.path)
      }
    }
  }
  indexDirEntries(rootEntries)
  for (const loaded of loadedDirs) {
    indexDirEntries(loaded.entries)
  }

  const restoredExpandedDirs = new Set<string>()
  const restoredChildrenByDir: Record<string, WorkspaceEntry[]> = {}
  for (const loaded of loadedDirs) {
    const canonicalDirPath =
      entryPathByKey.get(getWorkspacePathKey(loaded.dirPath)) ?? loaded.dirPath
    restoredExpandedDirs.add(canonicalDirPath)
    restoredChildrenByDir[canonicalDirPath] = loaded.entries
  }
  return {
    restoredExpandedDirs,
    restoredChildrenByDir,
    hadMissingDirs: loadedDirs.length < candidateCount
  }
}

function serializeWorkspaceStateSignature(
  dirs: readonly string[],
  layout: PersistedWorkspacePaneLayout
): string {
  return JSON.stringify({ expandedDirs: dirs, layout })
}

function serializeWorkspaceStatePayload(
  rootPath: string,
  expandedDirs: readonly string[],
  layoutSnapshot: WorkspaceLayoutSnapshot
): { update: WorkspaceStateUpdate; signature: string } {
  const dirs = [...expandedDirs]
  const layout = serializePaneLayoutForWorkspace(rootPath, layoutSnapshot)
  return {
    update: { expandedDirs: dirs, layout },
    signature: serializeWorkspaceStateSignature(dirs, layout)
  }
}

/**
 * Deep module owning the main window's workspace startup, focus check, unsaved switch guard,
 * buffer reset, folder tree/pane layout restoration, and encapsulated workspace-state persistence.
 */
export class MainWindowWorkspaceLifecycle {
  private readonly workspaceApi: LifecycleWorkspaceApi
  private readonly workspaceStateApi?: WikiWorkspaceStateApi
  private readonly windowApi?: Pick<WikiWindowApi, 'getInitContext'>
  private readonly tree: WorkspaceTreeCollaborator
  private readonly editor: WorkspaceEditorCollaborator
  private readonly confirm: WorkspaceConfirmCollaborator
  private readonly ui: WorkspaceLifecycleUiCollaborator
  private readonly debounceMs: number
  private readonly beforeUnloadTarget?: BeforeUnloadEventTarget

  private disposed = false
  readonly loadInitContext: () => Promise<WindowInitContext | null>
  private initResolved = false
  private initialWorkspacePath: string | null = null
  private loadedConfig: AppConfig | null = null

  private activeWorkspaceRoot: string | null = null
  private hasWorkspaceInteraction = false
  private isSelectingFolder = false
  private hasUserSelectedSidebarView = false
  private openRequestSeq = 0
  private workspaceRestoreSeq = 0
  private switchWorkspaceSeq = 0

  private trackedRootPath: string | null = null
  private trackedRootKey: string | null = null
  private lastSavedSignature: string | null = null
  private hasPendingSave = false
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private removeBeforeUnload: (() => void) | null = null

  constructor(options: MainWindowWorkspaceLifecycleOptions) {
    this.workspaceApi = options.workspaceApi
    this.workspaceStateApi = options.workspaceStateApi
    this.windowApi = options.windowApi
    this.tree = options.tree
    this.editor = options.editor
    this.confirm = options.confirm
    this.ui = options.ui
    this.debounceMs = options.debounceMs ?? DEFAULT_WORKSPACE_STATE_SAVE_DEBOUNCE_MS
    this.beforeUnloadTarget =
      options.beforeUnloadTarget ?? (typeof window !== 'undefined' ? window : undefined)
    this.loadInitContext = createWindowInitContextLoader(options.windowApi)
    this.initResolved = !this.windowApi?.getInitContext
  }

  start = (): (() => void) => {
    this.disposed = false
    if (this.beforeUnloadTarget && !this.removeBeforeUnload) {
      const handleBeforeUnload = (): void => {
        void this.flushWorkspaceState()
      }
      this.beforeUnloadTarget.addEventListener('beforeunload', handleBeforeUnload)
      this.removeBeforeUnload = () => {
        this.beforeUnloadTarget?.removeEventListener('beforeunload', handleBeforeUnload)
        this.removeBeforeUnload = null
      }
    }

    if (!this.windowApi?.getInitContext) {
      this.initResolved = true
      this.initialWorkspacePath = null
      this.tryStartupWorkspaceOpen()
    } else {
      void this.loadInitContext().then((context) => {
        if (this.disposed) return
        this.initResolved = true
        this.initialWorkspacePath = context?.initialWorkspacePath?.trim() || null
        this.tryStartupWorkspaceOpen()
      })
    }

    return () => {
      this.dispose()
    }
  }

  dispose = (): void => {
    this.disposed = true
    this.removeBeforeUnload?.()
    this.clearDebounceTimer()
    void this.flushWorkspaceState()
    void this.workspaceApi.unwatch().catch(() => undefined)
  }

  handleInitialConfigLoaded = (config: AppConfig): void => {
    if (this.disposed) return
    this.loadedConfig = config
    this.tryStartupWorkspaceOpen()
  }

  markUserSelectedSidebarView = (): void => {
    this.hasUserSelectedSidebarView = true
  }

  getSwitchSequence = (): number => this.switchWorkspaceSeq

  syncPersistenceState = (): void => {
    if (this.disposed || !this.activeWorkspaceRoot) return
    if (this.trackedRootKey !== getWorkspacePathKey(this.activeWorkspaceRoot)) {
      return
    }
    const expandedDirs = [...this.tree.getExpandedDirs()]
    const { signature } = serializeWorkspaceStatePayload(
      this.activeWorkspaceRoot,
      expandedDirs,
      this.editor.getLatestLayoutSnapshot()
    )
    if (signature === this.lastSavedSignature) {
      if (this.hasPendingSave) {
        this.hasPendingSave = false
        this.clearDebounceTimer()
      }
      return
    }
    this.hasPendingSave = true
    this.scheduleSave()
  }

  flushWorkspaceState = async (): Promise<void> => {
    this.clearDebounceTimer()
    const targetRoot = this.trackedRootPath
    if (!targetRoot) {
      return
    }
    const { update, signature } = serializeWorkspaceStatePayload(
      targetRoot,
      [...this.tree.getExpandedDirs()],
      this.editor.getLatestLayoutSnapshot()
    )
    if (!this.hasPendingSave && signature === this.lastSavedSignature) {
      return
    }
    this.hasPendingSave = false
    this.lastSavedSignature = signature

    const saveApi = this.workspaceStateApi?.save
    if (!saveApi) {
      return
    }
    await saveApi(targetRoot, update).catch(() => undefined)
  }

  switchWorkspace = async (targetPath: string): Promise<void> => {
    if (this.disposed) return
    this.hasWorkspaceInteraction = true

    if (this.activeWorkspaceRoot && isSameWorkspacePath(this.activeWorkspaceRoot, targetPath)) {
      this.switchWorkspaceSeq += 1
      this.ui.onEnterExplorerView('switch')
      return
    }

    const switchSeq = ++this.switchWorkspaceSeq
    if (this.workspaceApi.focusIfOpen) {
      const canProceed = await this.focusExistingAndCheckProceed(targetPath, switchSeq)
      if (!canProceed || this.disposed || switchSeq !== this.switchWorkspaceSeq) {
        return
      }
    }

    if (this.confirm.isDialogOpen()) {
      return
    }

    if (this.activeWorkspaceRoot === null) {
      await this.openAndRestoreWorkspace(targetPath, { isStartupRestore: false })
      return
    }

    const accepted = await promptUnsavedWorkspaceChanges(
      {
        getDirtySummary: () => this.editor.getDirtyWorkspaceSummary(),
        saveDirtyBuffers: () => this.editor.ensureAllWorkspaceBuffersSaved()
      },
      this.confirm.confirmUnsavedChanges,
      {
        message: (dirtySummary) =>
          `"${dirtySummary}"에 저장하지 않은 변경 사항이 있습니다. 어떻게 할까요?`,
        confirmLabel: '저장 후 이동',
        secondaryLabel: '버리고 이동'
      }
    )
    if (!accepted || this.disposed || switchSeq !== this.switchWorkspaceSeq) {
      return
    }

    if (!(await this.focusExistingAndCheckProceed(targetPath, switchSeq))) {
      return
    }

    const prevRoot = this.activeWorkspaceRoot
    const openSeqBeforeSuspend = this.openRequestSeq
    await this.#suspendAndFlush()
    if (this.disposed || switchSeq !== this.switchWorkspaceSeq) {
      if (this.openRequestSeq === openSeqBeforeSuspend) {
        this.resumePersistenceIfStillOn(prevRoot)
      }
      return
    }

    const openResult = await this.openAndRestoreWorkspace(targetPath, { isStartupRestore: false })
    if (openResult === 'failed') {
      this.resumePersistenceIfStillOn(prevRoot)
    }
  }

  selectFolder = async (): Promise<void> => {
    if (this.disposed || this.confirm.isDialogOpen() || this.isSelectingFolder) {
      return
    }
    this.isSelectingFolder = true
    this.hasWorkspaceInteraction = true
    this.ui.reportError(null)
    try {
      const selectedPath = await this.workspaceApi.selectFolder()
      this.isSelectingFolder = false
      if (!this.disposed && selectedPath && !this.confirm.isDialogOpen()) {
        await this.switchWorkspace(selectedPath)
      }
    } catch (error: unknown) {
      this.isSelectingFolder = false
      if (!this.disposed) {
        this.ui.reportError(toErrorMessage(error, '폴더 선택에 실패했습니다.'), error)
      }
    }
  }

  openInNewWindow = async (targetPath: string): Promise<void> => {
    const openInNewWindow = this.workspaceApi.openInNewWindow
    if (!openInNewWindow) {
      this.ui.reportError('새 창에서 워크스페이스를 열 수 없습니다.')
      return
    }
    this.ui.reportError(null)
    try {
      await openInNewWindow(targetPath)
    } catch (error: unknown) {
      if (!this.disposed) {
        this.ui.reportError(toErrorMessage(error, '새 창에서 워크스페이스를 열지 못했습니다.'), error)
      }
    }
  }

  private tryStartupWorkspaceOpen(): void {
    if (
      this.disposed ||
      this.hasWorkspaceInteraction ||
      this.isSelectingFolder ||
      this.activeWorkspaceRoot !== null ||
      !this.initResolved
    ) {
      return
    }

    if (this.initialWorkspacePath) {
      this.hasWorkspaceInteraction = true
      void this.openAndRestoreWorkspace(this.initialWorkspacePath, { isStartupRestore: true })
      return
    }

    const lastWorkspacePath = this.loadedConfig?.recentWorkspaces[0]
    if (!lastWorkspacePath) {
      return
    }
    this.hasWorkspaceInteraction = true
    void this.openAndRestoreWorkspace(lastWorkspacePath, {
      isStartupRestore: true,
      silentError: true,
      onSilentError: () => this.ui.removeRecentWorkspace(lastWorkspacePath)
    })
  }

  private async focusExistingAndCheckProceed(targetPath: string, switchSeq: number): Promise<boolean> {
    const focusIfOpen = this.workspaceApi.focusIfOpen
    if (!focusIfOpen) {
      return true
    }
    let focused = false
    try {
      focused = (await focusIfOpen(targetPath)).focused
    } catch {
      focused = false
    }
    if (this.disposed || switchSeq !== this.switchWorkspaceSeq) {
      return false
    }
    if (focused) {
      this.ui.reportError(null)
      return false
    }
    return true
  }

  private async openAndRestoreWorkspace(
    targetPath: string,
    options: {
      isStartupRestore: boolean
      silentError?: boolean
      onSilentError?: () => void
    }
  ): Promise<OpenWorkspaceResult> {
    const seq = ++this.openRequestSeq
    if (!options.silentError) {
      this.ui.reportError(null)
    }

    try {
      const info = await this.workspaceApi.open(targetPath)
      if (this.disposed || seq !== this.openRequestSeq) return 'superseded'

      const [initialMarkdownFiles, persistedState] = await Promise.all([
        this.workspaceApi.listMarkdownFiles().catch(() => [] as WorkspaceEntry[]),
        this.workspaceStateApi?.get(info.rootPath).catch(() => null) ?? Promise.resolve(null)
      ])
      if (this.disposed || seq !== this.openRequestSeq) {
        return 'superseded'
      }

      const { candidates, hadInvalidEntries } = resolveExpandedCandidatePaths(info, persistedState)
      const loadedDirs = await readDirectoriesSettled(this.workspaceApi.readDir, candidates)
      if (this.disposed || seq !== this.openRequestSeq) {
        return 'superseded'
      }

      const { restoredExpandedDirs, restoredChildrenByDir, hadMissingDirs } =
        reconcileRestoredDirectories(info.entries, loadedDirs, candidates.length)
      const hadPrunedExpandedDirs = hadInvalidEntries || hadMissingDirs

      const hadOpenWorkspace = this.activeWorkspaceRoot !== null
      this.activeWorkspaceRoot = info.rootPath

      this.tree.applyOpenedWorkspace({
        workspace: { rootPath: info.rootPath, name: info.name },
        rootEntries: info.entries,
        childrenByDir: restoredChildrenByDir,
        expandedDirs: restoredExpandedDirs,
        markdownFiles: initialMarkdownFiles
      })
      logRendererInfo('ui', 'Workspace opened', { rootPath: info.rootPath, name: info.name })

      if (hadOpenWorkspace) {
        this.editor.clearWorkspaceBuffers()
      }
      if (options.isStartupRestore) {
        if (!this.hasUserSelectedSidebarView) {
          this.ui.onEnterExplorerView('startup')
        }
      } else {
        this.ui.onEnterExplorerView('switch')
      }

      const restoreSeq = ++this.workspaceRestoreSeq
      const restoreTask = this.editor.restoreWorkspaceLayout({
        rootPath: info.rootPath,
        persistedLayout: persistedState?.layout ?? null,
        rootEntries: info.entries,
        restoredChildrenByDir,
        readDir: (dirPath) => this.workspaceApi.readDir(dirPath),
        isCancelled: () => this.disposed || restoreSeq !== this.workspaceRestoreSeq
      })

      await this.workspaceApi.watch().catch(() => undefined)
      const { restored, hadPrunedTabs, reconciledLayout } = await restoreTask
      if (!restored || this.disposed || restoreSeq !== this.workspaceRestoreSeq) {
        return 'superseded'
      }

      this.#markRestored({
        rootPath: info.rootPath,
        persistedState,
        restoredExpandedDirs: [...restoredExpandedDirs],
        restoredLayout: reconciledLayout,
        hadPrunedState: hadPrunedExpandedDirs || hadPrunedTabs
      })
      return 'opened'
    } catch (error: unknown) {
      if (this.disposed || seq !== this.openRequestSeq) return 'superseded'
      if (options.silentError) {
        options.onSilentError?.()
      } else {
        this.ui.reportError(toErrorMessage(error, '워크스페이스를 열지 못했습니다.'), error)
      }
      return 'failed'
    }
  }

  private clearDebounceTimer(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
  }

  private scheduleSave(): void {
    this.clearDebounceTimer()
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      void this.flushWorkspaceState()
    }, this.debounceMs)
  }

  #markRestored(context: {
    rootPath: string
    persistedState: PersistedWorkspaceState | null
    restoredExpandedDirs: readonly string[]
    restoredLayout: PersistedWorkspacePaneLayout
    hadPrunedState: boolean
  }): void {
    this.clearDebounceTimer()
    const dirs = [...context.restoredExpandedDirs]
    this.trackedRootPath = context.rootPath
    this.trackedRootKey = getWorkspacePathKey(context.rootPath)

    if (context.hadPrunedState && context.persistedState !== null) {
      this.lastSavedSignature = null
      this.hasPendingSave = true
      this.scheduleSave()
    } else {
      this.lastSavedSignature = serializeWorkspaceStateSignature(dirs, context.restoredLayout)
      this.hasPendingSave = false
    }
  }

  async #suspendAndFlush(): Promise<void> {
    const pendingFlush = this.flushWorkspaceState()
    this.trackedRootPath = null
    this.trackedRootKey = null
    this.hasPendingSave = false
    this.clearDebounceTimer()
    await pendingFlush
  }

  private resumePersistenceIfStillOn(prevRoot: string | null): void {
    if (
      !this.disposed &&
      prevRoot &&
      this.activeWorkspaceRoot &&
      isSameWorkspacePath(this.activeWorkspaceRoot, prevRoot) &&
      this.trackedRootPath === null
    ) {
      this.trackedRootPath = prevRoot
      this.trackedRootKey = getWorkspacePathKey(prevRoot)
    }
  }
}
