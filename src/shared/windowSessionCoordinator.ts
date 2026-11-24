import {
  EMPTY_SHARED_BUFFER_SNAPSHOT,
  type SharedBufferHubEvent,
  type SharedBufferStateSnapshot,
  type SyncWindowTabsOptions
} from './documentBuffer'
import type { SharedDocumentBufferHub } from './sharedDocumentBufferHub'
import { type BeforeInputKeyEventLike, TabDragCoordinator } from './tabDragSession'
import {
  canDetachTabFromWindow,
  cloneTabTransferDiffState,
  cloneTabTransferPayloads,
  computeOffsetAuxiliaryBounds,
  computeOffsetMainBounds,
  formatWindowTitle,
  isDiffTabTransferPayload,
  type AcceptTabDragDropInput,
  type AcceptTabDragDropResult,
  type ActiveTabDragSession,
  type DetachTabToNewWindowResult,
  type ScreenLike,
  type TabDragEndInput,
  type TabDragEndResult,
  type TabDragResolution,
  type TabDragStartInput,
  type TabTransferPayload,
  type WindowBounds,
  type WindowInitContext,
  type WindowRole
} from './window'
import {
  type FocusOpenWorkspaceResult,
  isSameWorkspacePath,
  type OpenWorkspaceInNewWindowResult,
  type WorkspaceInfo
} from './workspace'

export interface WindowSessionServices {
  readonly bufferHub: SharedDocumentBufferHub
  getWorkspaceRoot(): string | null
  openWorkspace(resolvedRootPath: string): Promise<WorkspaceInfo>
  cancelActiveWorkspaceScans?(): void
  dispose?(): void
}

export interface HostedWindowCallbacks {
  /**
   * Returns `true` when the close may proceed immediately, or `false` when the host
   * should intercept the close and await `resolveCloseRequest` (or flush timeout).
   */
  onCloseAttempt(): boolean
  onFocus(): void
  onBeforeInput(input: BeforeInputKeyEventLike): void
  onClosed(): void
}

export interface HostedWindow {
  readonly windowId: number
  getBounds(): WindowBounds
  isDestroyed(): boolean
  isMinimized(): boolean
  isFocused(): boolean
  restore(): void
  focus(): void
  close(): void
  sendCloseRequested(): void
  dispose?(): void
}

export interface CreateHostedWindowParams<TSessionServices extends WindowSessionServices> {
  sessionId: number
  role: WindowRole
  bounds?: Partial<WindowBounds>
  title?: string
  services: TSessionServices
  callbacks: HostedWindowCallbacks
}

export interface WindowSessionHost<
  TSessionServices extends WindowSessionServices = WindowSessionServices
> {
  readonly screen?: ScreenLike
  createSessionServices(sessionId: number): TSessionServices
  createWindow(params: CreateHostedWindowParams<TSessionServices>): HostedWindow
  mountWindow?(window: HostedWindow, role: WindowRole): void
  resolveValidWorkspacePath(rawPath: string): Promise<string>
  tryResolveWorkspacePath(rawPath: string): Promise<string | null>
  getFocusedWindowId?(): number | undefined
  cleanCloseFlushTimeoutMs?: number
}

export interface WindowSessionSnapshot<TSessionServices extends WindowSessionServices> {
  readonly sessionId: number
  readonly services: TSessionServices
  isMainWindow(windowId: number | undefined): boolean
}

export interface CreateMainWindowCoordinatorOptions {
  bounds?: Partial<WindowBounds>
  initialWorkspacePath?: string | null
}

export interface JoinSessionWindowOptions {
  role: WindowRole
  initialTabs?: readonly TabTransferPayload[]
  bounds?: Partial<WindowBounds>
}

interface ManagedWindowRecord {
  sessionId: number
  windowId: number
  role: WindowRole
  hosted: HostedWindow
  initialTabs: TabTransferPayload[]
  hadInitialTabs: boolean
  initialWorkspacePath?: string | null
  hasSyncedNonEmptyTabs: boolean
  closing: boolean
  closePromptPending: boolean
  closeFlushEnabled: boolean
  cleanCloseFlushTimer?: ReturnType<typeof setTimeout>
}

interface ManagedSession<TSessionServices extends WindowSessionServices> {
  sessionId: number
  mainWindowId: number
  services: TSessionServices
  dragCoordinator: TabDragCoordinator
  pendingInitialWorkspacePath: string | null
  pendingOpenWorkspacePath: string | null
  pendingOpenToken: number
  openWorkspaceQueue: Promise<unknown>
  windowIds: Set<number>
  disposed: boolean
  unsubscribeHub: () => void
  unsubscribeDrag: () => void
  disposeCleanups: Array<() => void>
  snapshot: WindowSessionSnapshot<TSessionServices>
}

const DEFAULT_CLEAN_CLOSE_FLUSH_TIMEOUT_MS = 1000

/**
 * Shared deep coordinator for multi-main-window workspace sessions, auxiliary window lifecycle,
 * duplicate workspace focus/open serialization, close gates, and session-scoped tab drag isolation.
 */
export class WindowSessionCoordinator<
  TSessionServices extends WindowSessionServices = WindowSessionServices
> {
  private readonly host: WindowSessionHost<TSessionServices>
  private readonly cleanCloseFlushTimeoutMs: number
  private readonly sessions = new Map<number, ManagedSession<TSessionServices>>()
  private readonly windowsById = new Map<number, ManagedWindowRecord>()
  private readonly sessionCreatedListeners = new Set<
    (session: WindowSessionSnapshot<TSessionServices>) => (() => void) | void
  >()
  private readonly sessionDisposedListeners = new Set<
    (session: WindowSessionSnapshot<TSessionServices>) => void
  >()
  private readonly dragStateListeners = new Set<
    (session: ActiveTabDragSession | null, targetWindowIds: number[]) => void
  >()

  private nextSessionId = 1
  private dragSessionCounter = 0
  private lastActiveSessionId: number | null = null
  private disposed = false

  constructor(host: WindowSessionHost<TSessionServices>) {
    this.host = host
    this.cleanCloseFlushTimeoutMs =
      host.cleanCloseFlushTimeoutMs ?? DEFAULT_CLEAN_CLOSE_FLUSH_TIMEOUT_MS
  }

  private createManagedSession(
    initialWorkspacePath: string | null = null
  ): ManagedSession<TSessionServices> {
    const sessionId = this.nextSessionId++
    const services = this.host.createSessionServices(sessionId)
    const dragCoordinator = new TabDragCoordinator({
      nextDragSessionId: () => `drag-${++this.dragSessionCounter}`
    })

    const session: ManagedSession<TSessionServices> = {
      sessionId,
      mainWindowId: 0,
      services,
      dragCoordinator,
      pendingInitialWorkspacePath: initialWorkspacePath,
      pendingOpenWorkspacePath: null,
      pendingOpenToken: 0,
      openWorkspaceQueue: Promise.resolve(),
      windowIds: new Set<number>(),
      disposed: false,
      unsubscribeHub: () => undefined,
      unsubscribeDrag: () => undefined,
      disposeCleanups: [],
      snapshot: {
        sessionId,
        services,
        isMainWindow: (windowId) => {
          const live = this.resolveLiveWindow(windowId)
          return (
            live !== undefined &&
            live.session.sessionId === sessionId &&
            live.record.role === 'main'
          )
        }
      }
    }

    session.unsubscribeHub = services.bufferHub.subscribe((event) => {
      this.handleHubEvent(session, event)
    })
    session.unsubscribeDrag = dragCoordinator.onStateChanged((dragSession) => {
      if (this.disposed || session.disposed) return
      const targetWindowIds = this.getLiveWindowIds(session.sessionId)
      for (const listener of this.dragStateListeners) {
        listener(dragSession, targetWindowIds)
      }
    })

    this.sessions.set(sessionId, session)
    return session
  }

  createSession(): WindowSessionSnapshot<TSessionServices> {
    if (this.disposed) {
      throw new Error('WindowSessionCoordinator is disposed')
    }
    const session = this.createManagedSession()
    this.notifySessionCreated(session)
    return session.snapshot
  }

  hasLiveSession(sessionId: number): boolean {
    const session = this.sessions.get(sessionId)
    return session !== undefined && !this.disposed && !session.disposed
  }

  private notifySessionCreated(session: ManagedSession<TSessionServices>): void {
    for (const listener of this.sessionCreatedListeners) {
      const cleanup = listener(session.snapshot)
      if (typeof cleanup === 'function') {
        session.disposeCleanups.push(cleanup)
      }
    }
  }

  private registerHostedWindow(
    session: ManagedSession<TSessionServices>,
    options: {
      role: WindowRole
      initialTabs: readonly TabTransferPayload[]
      bounds?: Partial<WindowBounds>
      title?: string
      initialWorkspacePath?: string | null
    }
  ): ManagedWindowRecord {
    const clonedTabs = cloneTabTransferPayloads(options.initialTabs)
    let record!: ManagedWindowRecord

    const hosted = this.host.createWindow({
      sessionId: session.sessionId,
      role: options.role,
      bounds: options.bounds,
      title: options.title,
      services: session.services,
      callbacks: {
        onCloseAttempt: () => this.handleWindowCloseAttempt(record),
        onFocus: () => {
          if (!this.disposed && !session.disposed) {
            this.lastActiveSessionId = session.sessionId
          }
        },
        onBeforeInput: (input) => {
          this.handleBeforeInput(input)
        },
        onClosed: () => {
          this.handleWindowClosed(session, record)
        }
      }
    })

    record = {
      sessionId: session.sessionId,
      windowId: hosted.windowId,
      role: options.role,
      hosted,
      initialTabs: clonedTabs,
      hadInitialTabs: clonedTabs.length > 0,
      ...(options.initialWorkspacePath !== undefined
        ? { initialWorkspacePath: options.initialWorkspacePath }
        : {}),
      hasSyncedNonEmptyTabs: false,
      closing: false,
      closePromptPending: false,
      closeFlushEnabled: false
    }

    this.windowsById.set(hosted.windowId, record)
    session.windowIds.add(hosted.windowId)

    if (options.role === 'main') {
      if (session.mainWindowId === 0) {
        session.mainWindowId = hosted.windowId
      }
      this.lastActiveSessionId = session.sessionId
    } else {
      for (const tab of clonedTabs) {
        if (!isDiffTabTransferPayload(tab)) {
          session.services.bufferHub.registerPendingTransfer(hosted.windowId, tab.bufferKey)
        }
      }
    }

    return record
  }

  private handleWindowClosed(
    session: ManagedSession<TSessionServices>,
    record: ManagedWindowRecord
  ): void {
    this.clearCleanCloseFlushTimer(record)
    if (!session.disposed) {
      session.dragCoordinator.clearForWindow(record.windowId)
      session.services.bufferHub.unregisterWindow(record.windowId)
    }
    this.windowsById.delete(record.windowId)
    session.windowIds.delete(record.windowId)
    if (session.mainWindowId === record.windowId) {
      session.mainWindowId = this.findLiveMainWindow(session)?.windowId ?? 0
    }

    if (record.role === 'main' && !this.hasLiveMainWindow(session)) {
      this.closeSessionAuxiliaryWindows(session)
      this.disposeSession(session)
    }
  }

  private disposeSession(session: ManagedSession<TSessionServices>): void {
    if (session.disposed) return
    session.disposed = true

    for (const listener of this.sessionDisposedListeners) {
      listener(session.snapshot)
    }
    for (const cleanup of session.disposeCleanups.splice(0)) {
      cleanup()
    }

    session.unsubscribeHub()
    session.unsubscribeDrag()
    session.dragCoordinator.dispose()
    session.services.dispose?.()

    this.sessions.delete(session.sessionId)
    if (this.lastActiveSessionId === session.sessionId) {
      this.lastActiveSessionId = this.findFallbackActiveSessionId()
    }
  }

  private findLiveMainWindow(
    session: ManagedSession<TSessionServices> | undefined,
    excludeWindowId?: number
  ): ManagedWindowRecord | undefined {
    if (this.disposed || !session || session.disposed) return undefined
    const preferred = this.windowsById.get(session.mainWindowId)
    if (
      preferred &&
      preferred.windowId !== excludeWindowId &&
      preferred.role === 'main' &&
      !preferred.hosted.isDestroyed()
    ) {
      return preferred
    }
    for (const windowId of session.windowIds) {
      if (windowId === excludeWindowId) continue
      const candidate = this.windowsById.get(windowId)
      if (candidate && candidate.role === 'main' && !candidate.hosted.isDestroyed()) {
        return candidate
      }
    }
    return undefined
  }

  private hasLiveMainWindow(
    session: ManagedSession<TSessionServices>,
    excludeWindowId?: number
  ): boolean {
    return this.findLiveMainWindow(session, excludeWindowId) !== undefined
  }

  private findFallbackActiveSessionId(): number | null {
    for (const session of this.sessions.values()) {
      if (this.findLiveMainWindow(session)) {
        return session.sessionId
      }
    }
    return null
  }

  private resolveLiveWindow(
    windowId: number | undefined
  ): { record: ManagedWindowRecord; session: ManagedSession<TSessionServices> } | undefined {
    if (this.disposed || windowId === undefined) return undefined
    const record = this.windowsById.get(windowId)
    if (!record || record.hosted.isDestroyed()) return undefined
    const session = this.sessions.get(record.sessionId)
    if (!session || session.disposed) return undefined
    return { record, session }
  }

  private requireSourceWindow(
    windowId: number | undefined,
    action: string
  ): { record: ManagedWindowRecord; session: ManagedSession<TSessionServices> } {
    const live = this.resolveLiveWindow(windowId)
    if (!live) {
      throw new Error(`Cannot ${action} from an unknown source window`)
    }
    return live
  }

  private requireMainSenderSession(
    windowId: number | undefined
  ): ManagedSession<TSessionServices> {
    const live = this.resolveLiveWindow(windowId)
    if (!live || live.record.role !== 'main') {
      throw new Error('Only the main window can open a workspace')
    }
    return live.session
  }

  private assertKnownBuffer(
    session: ManagedSession<TSessionServices>,
    payload: TabTransferPayload | undefined,
    action: string
  ): void {
    if (isDiffTabTransferPayload(payload)) {
      return
    }
    if (
      !payload ||
      typeof payload.bufferKey !== 'string' ||
      !session.services.bufferHub.hasBuffer(payload.bufferKey)
    ) {
      throw new Error(`Cannot ${action} unknown document buffer`)
    }
  }

  createMainWindow(options?: CreateMainWindowCoordinatorOptions): HostedWindow {
    if (this.disposed) {
      throw new Error('WindowSessionCoordinator is disposed')
    }
    const initialWorkspacePath = options?.initialWorkspacePath ?? null
    const session = this.createManagedSession(initialWorkspacePath)
    const record = this.registerHostedWindow(session, {
      role: 'main',
      initialTabs: [],
      bounds: options?.bounds,
      initialWorkspacePath: options?.initialWorkspacePath
    })
    this.notifySessionCreated(session)
    this.host.mountWindow?.(record.hosted, 'main')
    return record.hosted
  }

  private mountSessionWindow(
    session: ManagedSession<TSessionServices>,
    options: {
      role: WindowRole
      initialTabs: readonly TabTransferPayload[]
      bounds?: Partial<WindowBounds>
    }
  ): ManagedWindowRecord {
    const firstTab = options.role === 'auxiliary' ? options.initialTabs[0] : undefined
    const firstName = firstTab
      ? isDiffTabTransferPayload(firstTab)
        ? (firstTab.diff.request.path.split(/[\\/]/).pop() ?? firstTab.diff.request.path)
        : session.services.bufferHub.getBufferName(firstTab.bufferKey)
      : undefined
    const record = this.registerHostedWindow(session, {
      role: options.role,
      initialTabs: options.initialTabs,
      bounds: options.bounds,
      title: options.role === 'auxiliary' ? formatWindowTitle(firstName) : undefined
    })
    this.host.mountWindow?.(record.hosted, options.role)
    return record
  }

  joinSessionWindow(sessionId: number, options: JoinSessionWindowOptions): HostedWindow {
    if (this.disposed) {
      throw new Error('WindowSessionCoordinator is disposed')
    }
    const session = this.sessions.get(sessionId)
    if (!session || session.disposed) {
      throw new Error(`Cannot join unknown or disposed session ${sessionId}`)
    }
    return this.mountSessionWindow(session, {
      role: options.role,
      initialTabs: options.initialTabs ?? [],
      bounds: options.bounds
    }).hosted
  }

  createAuxiliaryWindow(
    initialTabs: readonly TabTransferPayload[],
    sourceBounds?: WindowBounds,
    sourceWindowId?: number
  ): HostedWindow {
    if (this.disposed) {
      throw new Error('WindowSessionCoordinator is disposed')
    }
    const session = this.resolveTargetSessionForAuxCreation(sourceWindowId)
    const bounds = sourceBounds ? computeOffsetAuxiliaryBounds(sourceBounds, this.host.screen) : undefined
    return this.openAuxiliaryWindowInSession(session, initialTabs, bounds).hosted
  }

  private resolveTargetSessionForAuxCreation(
    sourceWindowId?: number
  ): ManagedSession<TSessionServices> {
    if (sourceWindowId !== undefined) {
      const live = this.resolveLiveWindow(sourceWindowId)
      if (live) {
        return live.session
      }
    }
    const activeSession = this.getActiveSession()
    if (!activeSession) {
      throw new Error('Cannot create auxiliary window without an active main window session')
    }
    return activeSession
  }

  private openAuxiliaryWindowInSession(
    session: ManagedSession<TSessionServices>,
    initialTabs: readonly TabTransferPayload[],
    bounds?: WindowBounds
  ): ManagedWindowRecord {
    if (initialTabs.length === 0) {
      throw new Error('Auxiliary window requires at least one initial tab')
    }
    return this.mountSessionWindow(session, {
      role: 'auxiliary',
      initialTabs,
      bounds
    })
  }

  private normalizeDiffTransferPayload(
    session: ManagedSession<TSessionServices>,
    payload: TabTransferPayload
  ): TabTransferPayload {
    if (!isDiffTabTransferPayload(payload)) return payload
    return {
      kind: 'diff',
      diff: cloneTabTransferDiffState(
        payload.diff,
        this.getSessionEffectiveWorkspaceRoot(session) ?? undefined
      )
    }
  }

  detachTabToNewWindow(
    senderWindowId: number | undefined,
    payload: TabTransferPayload
  ): DetachTabToNewWindowResult {
    const { record: sourceRecord, session } = this.requireSourceWindow(senderWindowId, 'detach tab')
    this.assertKnownBuffer(session, payload, 'detach')

    if (
      !canDetachTabFromWindow(
        sourceRecord.role,
        session.services.bufferHub.getWindowTabCount(sourceRecord.windowId)
      )
    ) {
      throw new Error('Cannot detach the last tab from an auxiliary window')
    }

    const auxRecord = this.openAuxiliaryWindowInSession(
      session,
      [this.normalizeDiffTransferPayload(session, payload)],
      computeOffsetAuxiliaryBounds(sourceRecord.hosted.getBounds(), this.host.screen)
    )
    return { windowId: auxRecord.windowId }
  }

  getWindowInitContext(windowId: number | undefined): WindowInitContext {
    const live = this.resolveLiveWindow(windowId)
    if (!live) {
      return { role: 'main', initialTabs: [] }
    }
    const { record } = live
    return {
      role: record.role,
      initialTabs: cloneTabTransferPayloads(record.initialTabs),
      ...(record.initialWorkspacePath !== undefined
        ? { initialWorkspacePath: record.initialWorkspacePath }
        : {})
    }
  }

  syncWindowTabs(
    windowId: number | undefined,
    bufferKeys: readonly string[],
    options?: SyncWindowTabsOptions
  ): SharedBufferStateSnapshot {
    const live = this.resolveLiveWindow(windowId)
    if (!live) {
      return EMPTY_SHARED_BUFFER_SNAPSHOT
    }
    const { record, session } = live
    const snapshot = session.services.bufferHub.syncWindowTabs(
      record.windowId,
      bufferKeys,
      options
    )
    this.reconcileAuxiliaryAutoClose(session)
    return snapshot
  }

  private getSessionEffectiveWorkspaceRoot(
    session: ManagedSession<TSessionServices>
  ): string | null {
    return this.getSessionCandidateWorkspacePaths(session)[0] ?? null
  }

  private getSessionCandidateWorkspacePaths(
    session: ManagedSession<TSessionServices>
  ): string[] {
    const candidates: string[] = []
    for (const candidate of [
      session.pendingOpenWorkspacePath,
      session.services.getWorkspaceRoot(),
      session.pendingInitialWorkspacePath
    ]) {
      if (candidate && !candidates.includes(candidate)) {
        candidates.push(candidate)
      }
    }
    return candidates
  }

  private findSessionByWorkspacePath(
    targetPath: string,
    excludeSessionId?: number
  ): ManagedSession<TSessionServices> | undefined {
    for (const session of this.sessions.values()) {
      if (session.sessionId === excludeSessionId || !this.findLiveMainWindow(session)) continue
      for (const candidate of this.getSessionCandidateWorkspacePaths(session)) {
        if (isSameWorkspacePath(candidate, targetPath)) {
          return session
        }
      }
    }
    return undefined
  }

  private focusSessionMainWindow(
    session: ManagedSession<TSessionServices>
  ): ManagedWindowRecord | undefined {
    const mainRecord = this.findLiveMainWindow(session)
    if (!mainRecord) return undefined
    if (mainRecord.hosted.isMinimized()) {
      mainRecord.hosted.restore()
    }
    mainRecord.hosted.focus()
    this.lastActiveSessionId = session.sessionId
    return mainRecord
  }

  private focusExistingSessionTarget(
    session: ManagedSession<TSessionServices>,
    fallbackRoot: string
  ): { windowId: number; rootPath: string } {
    const mainRecord = this.focusSessionMainWindow(session)
    return {
      windowId: mainRecord?.windowId ?? session.mainWindowId,
      rootPath: this.getSessionEffectiveWorkspaceRoot(session) ?? fallbackRoot
    }
  }

  private getActiveSession(): ManagedSession<TSessionServices> | undefined {
    if (this.lastActiveSessionId !== null) {
      const candidate = this.sessions.get(this.lastActiveSessionId)
      if (this.findLiveMainWindow(candidate)) {
        return candidate
      }
    }
    const fallbackId = this.findFallbackActiveSessionId()
    return fallbackId !== null ? this.sessions.get(fallbackId) : undefined
  }

  private clearMatchingPendingInitialWorkspace(
    session: ManagedSession<TSessionServices>,
    requestedPath: string
  ): void {
    if (this.disposed || session.disposed || session.services.getWorkspaceRoot()) {
      return
    }
    if (
      session.pendingInitialWorkspacePath &&
      isSameWorkspacePath(session.pendingInitialWorkspacePath, requestedPath)
    ) {
      session.pendingInitialWorkspacePath = null
    }
  }

  private openValidatedDirectoryInSession(
    session: ManagedSession<TSessionServices>,
    realRoot: string
  ): Promise<WorkspaceInfo> {
    const openToken = ++session.pendingOpenToken
    session.pendingOpenWorkspacePath = realRoot

    const run = session.openWorkspaceQueue.then(async () => {
      if (!this.hasLiveMainWindow(session)) {
        throw new Error('Only the main window can open a workspace')
      }
      try {
        session.services.cancelActiveWorkspaceScans?.()
        const info = await session.services.openWorkspace(realRoot)
        session.pendingInitialWorkspacePath = null
        if (!this.hasLiveMainWindow(session)) {
          throw new Error('Only the main window can open a workspace')
        }
        return info
      } catch (error) {
        if (!session.services.getWorkspaceRoot() && session.pendingOpenToken === openToken) {
          session.pendingInitialWorkspacePath = null
        }
        throw error
      } finally {
        if (session.pendingOpenToken === openToken) {
          session.pendingOpenWorkspacePath = null
        }
      }
    })

    session.openWorkspaceQueue = run.catch(() => undefined)
    return run
  }

  async openWorkspaceInNewWindow(
    senderWindowId: number | undefined,
    rootPath: string
  ): Promise<OpenWorkspaceInNewWindowResult> {
    if (this.disposed) {
      throw new Error('WindowSessionCoordinator is disposed')
    }
    if (senderWindowId !== undefined) {
      this.requireMainSenderSession(senderWindowId)
    }

    const realRoot = await this.host.resolveValidWorkspacePath(rootPath)
    if (this.disposed) {
      throw new Error('WindowSessionCoordinator is disposed')
    }

    const existingSession = this.findSessionByWorkspacePath(realRoot)
    if (existingSession) {
      return {
        status: 'focused-existing',
        ...this.focusExistingSessionTarget(existingSession, realRoot)
      }
    }

    const sourceRecord =
      this.resolveLiveWindow(senderWindowId)?.record ??
      this.findLiveMainWindow(this.getActiveSession())
    const bounds = sourceRecord
      ? computeOffsetMainBounds(sourceRecord.hosted.getBounds(), this.host.screen)
      : undefined

    const newWin = this.createMainWindow({
      bounds,
      initialWorkspacePath: realRoot
    })
    return {
      status: 'opened',
      windowId: newWin.windowId,
      rootPath: realRoot
    }
  }

  async openWorkspaceInSession(
    senderWindowId: number | undefined,
    rootPath: string
  ): Promise<WorkspaceInfo> {
    const senderSession = this.requireMainSenderSession(senderWindowId)
    let realRoot: string
    try {
      realRoot = await this.host.resolveValidWorkspacePath(rootPath)
    } catch (error) {
      this.clearMatchingPendingInitialWorkspace(senderSession, rootPath)
      throw error
    }
    if (!this.hasLiveMainWindow(senderSession)) {
      throw new Error('Only the main window can open a workspace')
    }
    const existingSession = this.findSessionByWorkspacePath(realRoot, senderSession.sessionId)
    if (existingSession) {
      this.focusSessionMainWindow(existingSession)
      throw new Error('이미 다른 창에 열려 있는 워크스페이스입니다.')
    }

    return this.openValidatedDirectoryInSession(senderSession, realRoot)
  }

  async focusWorkspaceIfOpen(
    senderWindowId: number | undefined,
    rootPath: string
  ): Promise<FocusOpenWorkspaceResult> {
    const senderSession = this.requireMainSenderSession(senderWindowId)
    const resolvedCandidate = await this.host.tryResolveWorkspacePath(rootPath)
    if (!resolvedCandidate || !this.hasLiveMainWindow(senderSession)) {
      return { focused: false }
    }

    const existingSession = this.findSessionByWorkspacePath(
      resolvedCandidate,
      senderSession.sessionId
    )
    if (!existingSession) {
      return { focused: false }
    }

    return {
      focused: true,
      ...this.focusExistingSessionTarget(existingSession, resolvedCandidate)
    }
  }

  handleBeforeInput(input: BeforeInputKeyEventLike): void {
    for (const session of this.sessions.values()) {
      if (!session.disposed) {
        session.dragCoordinator.handleBeforeInput(input)
      }
    }
  }

  onTabDragStateChanged(
    listener: (session: ActiveTabDragSession | null, targetWindowIds: number[]) => void
  ): () => void {
    this.dragStateListeners.add(listener)
    return () => {
      this.dragStateListeners.delete(listener)
    }
  }

  startTabDrag(windowId: number | undefined, input: TabDragStartInput): ActiveTabDragSession {
    const { record: sourceRecord, session } = this.requireSourceWindow(windowId, 'start tab drag')
    this.assertKnownBuffer(session, input?.payload, 'drag')
    return session.dragCoordinator.start(sourceRecord.windowId, {
      ...input,
      payload: this.normalizeDiffTransferPayload(session, input.payload)
    })
  }

  updateTabDragOutcome(
    windowId: number | undefined,
    dragSessionId: string,
    outcome: TabDragResolution
  ): ActiveTabDragSession | null {
    const live = this.resolveLiveWindow(windowId)
    if (!live) {
      return null
    }
    return live.session.dragCoordinator.updateOutcome(live.record.windowId, dragSessionId, outcome)
  }

  acceptTabDragDrop(
    windowId: number | undefined,
    input?: AcceptTabDragDropInput
  ): AcceptTabDragDropResult {
    const live = this.resolveLiveWindow(windowId)
    if (!live) {
      return { accepted: false, reason: 'invalid-target-window' }
    }
    const { record: targetRecord, session: targetSession } = live

    const result = targetSession.dragCoordinator.acceptCrossWindowDrop({
      targetWindowId: targetRecord.windowId,
      dragSessionId: input?.dragSessionId,
      bufferHub: targetSession.services.bufferHub
    })

    if (
      !result.accepted &&
      (result.reason === 'no-active-drag' || result.reason === 'session-mismatch') &&
      this.hasOtherSessionPendingDrag(targetSession.sessionId)
    ) {
      return { accepted: false, reason: 'different-workspace-session' }
    }

    return result
  }

  private hasOtherSessionPendingDrag(excludeSessionId: number): boolean {
    for (const session of this.sessions.values()) {
      if (session.sessionId !== excludeSessionId && !session.disposed) {
        if (session.dragCoordinator.hasPendingDrag()) {
          return true
        }
      }
    }
    return false
  }

  private getOpenWindowBounds(): WindowBounds[] {
    const bounds: WindowBounds[] = []
    for (const record of this.windowsById.values()) {
      if (!record.hosted.isDestroyed() && !record.hosted.isMinimized()) {
        bounds.push(record.hosted.getBounds())
      }
    }
    return bounds
  }

  endTabDrag(windowId: number | undefined, input: TabDragEndInput): TabDragEndResult {
    const live = this.resolveLiveWindow(windowId)
    if (!live) {
      return { detached: false, outcome: 'cancelled' }
    }
    const { record: sourceRecord, session } = live

    const canDetach = canDetachTabFromWindow(
      sourceRecord.role,
      session.services.bufferHub.getWindowTabCount(sourceRecord.windowId)
    )
    const plan = session.dragCoordinator.finish({
      sourceWindowId: sourceRecord.windowId,
      input,
      openWindowBounds: this.getOpenWindowBounds(),
      canDetach,
      hasBuffer: (key) => session.services.bufferHub.hasBuffer(key),
      screen: this.host.screen
    })

    if (!plan.detach) {
      return plan.result
    }

    const auxRecord = this.openAuxiliaryWindowInSession(session, [plan.payload], plan.targetBounds)
    return { detached: true, windowId: auxRecord.windowId }
  }

  private clearCleanCloseFlushTimer(record: ManagedWindowRecord): void {
    if (record.cleanCloseFlushTimer !== undefined) {
      clearTimeout(record.cleanCloseFlushTimer)
      record.cleanCloseFlushTimer = undefined
    }
  }

  setCloseFlushEnabled(windowId: number | undefined, enabled: boolean): void {
    const live = this.resolveLiveWindow(windowId)
    if (!live || live.record.role !== 'main') return
    live.record.closeFlushEnabled = Boolean(enabled)
  }

  closeCurrentWindow(windowId: number | undefined): void {
    const live = this.resolveLiveWindow(windowId)
    if (!live || live.record.role !== 'auxiliary') return
    this.closeRecord(live.record)
  }

  private cascadeAuxiliaryCloseIfLastMain(
    session: ManagedSession<TSessionServices>,
    record: ManagedWindowRecord
  ): void {
    if (record.role === 'main' && !this.hasLiveMainWindow(session, record.windowId)) {
      this.closeSessionAuxiliaryWindows(session)
    }
  }

  private finalizeApprovedClose(
    session: ManagedSession<TSessionServices>,
    record: ManagedWindowRecord
  ): void {
    record.closePromptPending = false
    this.cascadeAuxiliaryCloseIfLastMain(session, record)
    this.closeRecord(record)
  }

  resolveCloseRequest(windowId: number | undefined, approved: boolean): void {
    const live = this.resolveLiveWindow(windowId)
    if (!live || !live.record.closePromptPending) return
    const { record, session } = live
    this.clearCleanCloseFlushTimer(record)
    if (!approved) {
      record.closePromptPending = false
      return
    }
    this.finalizeApprovedClose(session, record)
  }

  private handleWindowCloseAttempt(record: ManagedWindowRecord): boolean {
    if (this.disposed || record.closing) return true
    if (record.closePromptPending) {
      return false
    }
    const session = this.sessions.get(record.sessionId)
    if (!session || session.disposed) return true

    const hasDirty = session.services.bufferHub.hasDirtyBuffersForWindowClose(
      record.role,
      record.windowId
    )
    const needsCloseFlush = record.role === 'main' && record.closeFlushEnabled
    if (!hasDirty && !needsCloseFlush) {
      if (record.role === 'main' && !this.hasLiveMainWindow(session, record.windowId)) {
        record.closing = true
      }
      this.cascadeAuxiliaryCloseIfLastMain(session, record)
      return true
    }

    record.closePromptPending = true
    if (!hasDirty && needsCloseFlush) {
      this.clearCleanCloseFlushTimer(record)
      record.cleanCloseFlushTimer = setTimeout(() => {
        record.cleanCloseFlushTimer = undefined
        if (record.closePromptPending && !record.hosted.isDestroyed()) {
          this.finalizeApprovedClose(session, record)
        }
      }, this.cleanCloseFlushTimeoutMs)
    }
    record.hosted.sendCloseRequested()
    return false
  }

  private closeSessionAuxiliaryWindows(session: ManagedSession<TSessionServices>): void {
    for (const windowId of [...session.windowIds]) {
      const candidate = this.windowsById.get(windowId)
      if (candidate && candidate.role === 'auxiliary') {
        this.closeRecord(candidate)
      }
    }
  }

  private closeRecord(record: ManagedWindowRecord): void {
    this.clearCleanCloseFlushTimer(record)
    if (record.closing || record.hosted.isDestroyed()) return
    record.closePromptPending = false
    record.closing = true
    record.hosted.close()
  }

  private handleHubEvent(
    session: ManagedSession<TSessionServices>,
    event: SharedBufferHubEvent
  ): void {
    if (this.disposed || session.disposed) return

    if (event.type === 'paths-remapped') {
      session.dragCoordinator.remapPayloadKeys(event.remappings)
      const remappings = new Map(event.remappings.map((item) => [item.oldKey, item.newKey]))
      for (const windowId of session.windowIds) {
        const record = this.windowsById.get(windowId)
        if (!record || record.role !== 'auxiliary') continue
        for (const tab of record.initialTabs) {
          if (isDiffTabTransferPayload(tab)) continue
          const nextKey = remappings.get(tab.bufferKey)
          if (nextKey) {
            tab.bufferKey = nextKey
          }
        }
      }
      return
    }

    if (event.type === 'buffers-closed') {
      const closedKeys = new Set(event.closedKeys)
      for (const windowId of session.windowIds) {
        const record = this.windowsById.get(windowId)
        if (!record || record.role !== 'auxiliary') continue
        record.initialTabs = record.initialTabs.filter(
          (tab) => isDiffTabTransferPayload(tab) || !closedKeys.has(tab.bufferKey)
        )
      }
      this.reconcileAuxiliaryAutoClose(session)
      return
    }

    if (event.type === 'state-changed') {
      this.reconcileAuxiliaryAutoClose(session)
    }
  }

  private reconcileAuxiliaryAutoClose(session: ManagedSession<TSessionServices>): void {
    for (const windowId of [...session.windowIds]) {
      const record = this.windowsById.get(windowId)
      if (!record || record.role !== 'auxiliary' || record.closing || record.hosted.isDestroyed()) {
        continue
      }

      const tabCount = session.services.bufferHub.getWindowTabCount(record.windowId)
      if (tabCount > 0) {
        record.hasSyncedNonEmptyTabs = true
        continue
      }

      if (record.hasSyncedNonEmptyTabs || (record.hadInitialTabs && record.initialTabs.length === 0)) {
        this.closeRecord(record)
      }
    }
  }

  resolveSessionForWindow(
    windowId: number | undefined
  ): WindowSessionSnapshot<TSessionServices> | undefined {
    return this.resolveLiveWindow(windowId)?.session.snapshot
  }

  isMainWindow(windowId: number | undefined): boolean {
    return this.resolveLiveWindow(windowId)?.record.role === 'main'
  }

  getLiveSessionServices(): TSessionServices[] {
    const result: TSessionServices[] = []
    for (const session of this.sessions.values()) {
      if (this.findLiveMainWindow(session)) {
        result.push(session.services)
      }
    }
    return result
  }

  forEachSession(visitor: (session: WindowSessionSnapshot<TSessionServices>) => void): void {
    for (const session of this.sessions.values()) {
      if (!session.disposed) {
        visitor(session.snapshot)
      }
    }
  }

  onSessionCreated(
    listener: (session: WindowSessionSnapshot<TSessionServices>) => (() => void) | void
  ): () => void {
    this.sessionCreatedListeners.add(listener)
    const attachedCleanups: Array<() => void> = []
    for (const session of this.sessions.values()) {
      if (session.disposed) continue
      const cleanup = listener(session.snapshot)
      if (typeof cleanup === 'function') {
        session.disposeCleanups.push(cleanup)
        attachedCleanups.push(cleanup)
      }
    }
    return () => {
      this.sessionCreatedListeners.delete(listener)
      for (const cleanup of attachedCleanups.splice(0)) {
        cleanup()
      }
    }
  }

  onSessionDisposed(
    listener: (session: WindowSessionSnapshot<TSessionServices>) => void
  ): () => void {
    this.sessionDisposedListeners.add(listener)
    return () => {
      this.sessionDisposedListeners.delete(listener)
    }
  }

  private findFocusedWindowRecord(): ManagedWindowRecord | undefined {
    for (const record of this.windowsById.values()) {
      if (!record.hosted.isDestroyed() && record.hosted.isFocused()) {
        return record
      }
    }
    return undefined
  }

  resolveMenuTargetMainWindowId(preferredWindowId?: number): number | undefined {
    const targetRecord =
      this.resolveLiveWindow(preferredWindowId)?.record ??
      this.resolveLiveWindow(this.host.getFocusedWindowId?.())?.record ??
      this.findFocusedWindowRecord()

    if (targetRecord) {
      return this.findLiveMainWindow(this.sessions.get(targetRecord.sessionId))?.windowId
    }

    return this.findLiveMainWindow(this.getActiveSession())?.windowId
  }

  getLiveWindowIds(sessionId?: number): number[] {
    if (this.disposed) return []
    const ids: number[] = []
    if (sessionId !== undefined) {
      const session = this.sessions.get(sessionId)
      if (!session || session.disposed) return []
      for (const windowId of session.windowIds) {
        const record = this.windowsById.get(windowId)
        if (record && !record.hosted.isDestroyed()) {
          ids.push(windowId)
        }
      }
      return ids
    }

    for (const record of this.windowsById.values()) {
      if (!record.hosted.isDestroyed()) {
        ids.push(record.windowId)
      }
    }
    return ids
  }

  dispose(): void {
    this.disposed = true
    for (const record of this.windowsById.values()) {
      this.clearCleanCloseFlushTimer(record)
      record.hosted.dispose?.()
    }
    for (const session of [...this.sessions.values()]) {
      this.disposeSession(session)
    }
    this.sessionCreatedListeners.clear()
    this.sessionDisposedListeners.clear()
    this.dragStateListeners.clear()
    this.windowsById.clear()
    this.sessions.clear()
    this.lastActiveSessionId = null
  }
}
