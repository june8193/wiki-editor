import type { BufferKeyRemap, DocumentBuffer } from '@shared/documentBuffer'
import {
  computeCursorAuxiliaryBounds,
  isVirtualTabTransferPayload,
  isPointOutsideAllWindows,
  toTabTransferPayload,
  type AcceptTabDragDropResult,
  type ActiveTabDragSession,
  type ScreenLike,
  type TabDragEndInput,
  type TabDragEndResult,
  type TabDragResolution,
  type TabDragStartInput,
  type TabTransferPayload,
  type WindowBounds
} from '@shared/window'

export interface TabDragBufferHubPort {
  getBuffer(bufferKey: string): DocumentBuffer | undefined
  registerPendingTransfer(windowId: number, bufferKey: string): void
}

export interface AcceptCrossWindowDropParams {
  targetWindowId: number
  dragSessionId?: string
  bufferHub: TabDragBufferHubPort
}

export interface BeforeInputKeyEventLike {
  type?: string
  key?: string
}

export interface FinishTabDragParams {
  sourceWindowId: number
  input: TabDragEndInput
  openWindowBounds: readonly WindowBounds[]
  canDetach: boolean
  hasBuffer: (bufferKey: string) => boolean
  screen?: ScreenLike
}

export type FinishTabDragPlan =
  | {
      detach: true
      payload: TabTransferPayload
      targetBounds: WindowBounds
    }
  | {
      detach: false
      result: Extract<TabDragEndResult, { detached: false }>
    }

/**
 * Returns true when an Electron `before-input-event` payload represents an Escape press
 * (ignoring key-up releases so an Escape keyDown cancels cleanly on press).
 */
export function isEscapeBeforeInput(input: BeforeInputKeyEventLike): boolean {
  return input.key === 'Escape' && input.type !== 'keyUp'
}

export interface TabDragCoordinatorOptions {
  now?: () => number
  crossWindowReclaimGraceMs?: number
  nextDragSessionId?: () => string
}

const DEFAULT_CROSS_WINDOW_RECLAIM_GRACE_MS = 500

/**
 * Coordinates the single active tab drag session across windows and evaluates
 * drop/cancel outcomes identically in both main-process WindowManager and test harnesses.
 */
export class TabDragCoordinator {
  private readonly now: () => number
  private readonly crossWindowReclaimGraceMs: number
  private readonly nextDragSessionId: () => string
  private activeSession: ActiveTabDragSession | null = null
  private reclaimableEndedSession: {
    session: ActiveTabDragSession
    expiresAt: number
  } | null = null
  private sessionCounter = 0
  private readonly listeners = new Set<(session: ActiveTabDragSession | null) => void>()

  constructor(options: TabDragCoordinatorOptions = {}) {
    this.now = options.now ?? (() => Date.now())
    this.crossWindowReclaimGraceMs =
      options.crossWindowReclaimGraceMs ?? DEFAULT_CROSS_WINDOW_RECLAIM_GRACE_MS
    this.nextDragSessionId = options.nextDragSessionId ?? (() => `drag-${++this.sessionCounter}`)
  }

  /**
   * Subscribes to active drag session state transitions (`session` or `null`).
   */
  onStateChanged(listener: (session: ActiveTabDragSession | null) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * Returns true when a pending active or reclaimable cross-window drag is currently held.
   */
  hasPendingDrag(): boolean {
    const session = this.activeSession ?? this.getValidReclaimableSession()
    return session !== null && session.outcome === 'pending'
  }

  /**
   * Begins a new drag session owned by `sourceWindowId`, replacing any stale prior session.
   */
  start(sourceWindowId: number, input: TabDragStartInput): ActiveTabDragSession {
    this.reclaimableEndedSession = null
    this.activeSession = {
      dragSessionId: this.nextDragSessionId(),
      sourceWindowId,
      paneId: input.paneId,
      tabId: input.tabId,
      payload: toTabTransferPayload(input.payload),
      outcome: 'pending'
    }
    const snapshot = cloneSession(this.activeSession)
    this.emit(snapshot)
    return cloneSession(snapshot)
  }

  private getValidReclaimableSession(): ActiveTabDragSession | null {
    const entry = this.reclaimableEndedSession
    if (!entry) return null
    if (this.now() > entry.expiresAt) {
      this.reclaimableEndedSession = null
      return null
    }
    return entry.session
  }

  /**
   * Transitions a pending drag session to a terminal outcome and broadcasts the change.
   */
  private transitionPendingOutcome(
    session: ActiveTabDragSession | null,
    targetOutcome: TabDragResolution,
    targetWindowId?: number
  ): ActiveTabDragSession | null {
    if (!session) return null
    if (session.outcome !== 'pending') {
      return cloneSession(session)
    }
    session.outcome = targetOutcome
    if (targetWindowId !== undefined) {
      session.targetWindowId = targetWindowId
    }
    const snapshot = cloneSession(session)
    this.emit(snapshot)
    return cloneSession(snapshot)
  }

  /**
   * Updates the active session outcome when owned by `sourceWindowId` and matching `dragSessionId`.
   * Only `'pending'` sessions can transition, preventing late events from overwriting prior outcomes.
   */
  updateOutcome(
    sourceWindowId: number,
    dragSessionId: string,
    outcome: TabDragResolution
  ): ActiveTabDragSession | null {
    const session = this.activeSession
    if (!session || session.sourceWindowId !== sourceWindowId || session.dragSessionId !== dragSessionId) {
      return null
    }
    return this.transitionPendingOutcome(session, outcome)
  }

  /**
   * Atomically validates a cross-window drop target, reserves buffer ownership on the target
   * window before broadcasting, marks the active drag session `'dropped-in-window'`, and returns
   * the authoritative shared `DocumentBuffer` and transferred tab state.
   */
  acceptCrossWindowDrop(params: AcceptCrossWindowDropParams): AcceptTabDragDropResult {
    const session = this.activeSession ?? this.getValidReclaimableSession()
    if (!session) {
      return { accepted: false, reason: 'no-active-drag' }
    }
    if (session.outcome !== 'pending') {
      return { accepted: false, reason: 'drag-not-pending' }
    }
    if (params.dragSessionId && params.dragSessionId !== session.dragSessionId) {
      return { accepted: false, reason: 'session-mismatch' }
    }
    if (session.sourceWindowId === params.targetWindowId) {
      return { accepted: false, reason: 'same-window' }
    }

    if (isVirtualTabTransferPayload(session.payload)) {
      const payload = toTabTransferPayload(session.payload)
      session.payload = payload
      this.reclaimableEndedSession = null
      this.transitionPendingOutcome(session, 'dropped-in-window', params.targetWindowId)

      return {
        accepted: true,
        dragSessionId: session.dragSessionId,
        sourceWindowId: session.sourceWindowId,
        targetWindowId: params.targetWindowId,
        payload
      }
    }

    const buffer = params.bufferHub.getBuffer(session.payload.bufferKey)
    if (!buffer) {
      return { accepted: false, reason: 'unknown-buffer' }
    }

    // Reserve pending transfer ownership BEFORE broadcasting 'dropped-in-window' so an
    // eager source window tab close cannot prune the last buffer reference in flight.
    params.bufferHub.registerPendingTransfer(params.targetWindowId, buffer.key)
    const payload = toTabTransferPayload({ ...session.payload, bufferKey: buffer.key })
    session.payload = payload
    this.reclaimableEndedSession = null
    this.transitionPendingOutcome(session, 'dropped-in-window', params.targetWindowId)

    return {
      accepted: true,
      dragSessionId: session.dragSessionId,
      sourceWindowId: session.sourceWindowId,
      targetWindowId: params.targetWindowId,
      payload,
      buffer: { ...buffer }
    }
  }

  /**
   * Remaps the active drag session's bufferKey when a shared document path is renamed mid-drag.
   */
  remapPayloadKeys(remappings: readonly BufferKeyRemap[]): void {
    if (remappings.length === 0) return
    const keyMap = new Map(remappings.map((item) => [item.oldKey, item.newKey]))
    if (this.activeSession && remapSessionBufferKey(this.activeSession, keyMap)) {
      this.emit(cloneSession(this.activeSession))
    }
    if (this.reclaimableEndedSession) {
      remapSessionBufferKey(this.reclaimableEndedSession.session, keyMap)
    }
  }

  /**
   * Cancels the active pending drag session when Escape is observed on any focused app window.
   */
  handleBeforeInput(input: BeforeInputKeyEventLike): ActiveTabDragSession | null {
    if (!isEscapeBeforeInput(input)) {
      return null
    }
    this.reclaimableEndedSession = null
    return this.transitionPendingOutcome(this.activeSession, 'cancelled')
  }

  /**
   * Clears the active session if its owning window closed before `endTabDrag` ran.
   */
  clearForWindow(windowId: number): void {
    if (this.reclaimableEndedSession?.session.sourceWindowId === windowId) {
      this.reclaimableEndedSession = null
    }
    if (this.activeSession?.sourceWindowId !== windowId) {
      return
    }
    this.activeSession = null
    this.emit(null)
  }

  /**
   * Completes a drag session and computes whether a new auxiliary window should be opened.
   */
  finish(params: FinishTabDragParams): FinishTabDragPlan {
    const { sourceWindowId, input, openWindowBounds, canDetach, hasBuffer, screen } = params
    const session = this.activeSession
    if (!session || session.sourceWindowId !== sourceWindowId || session.dragSessionId !== input.dragSessionId) {
      return { detach: false, result: { detached: false, outcome: 'cancelled' } }
    }

    this.activeSession = null
    this.emit(null)

    if (session.outcome !== 'pending') {
      this.reclaimableEndedSession = null
      return { detach: false, result: { detached: false, outcome: session.outcome } }
    }

    const payload = toTabTransferPayload(input.payload ?? session.payload)
    const bufferExists = isVirtualTabTransferPayload(payload) || hasBuffer(payload.bufferKey)
    const cursorPoint = screen?.getCursorScreenPoint?.() ?? input.screenPoint
    const shouldDetach =
      canDetach &&
      bufferExists &&
      cursorPoint !== undefined &&
      isPointOutsideAllWindows(cursorPoint, openWindowBounds)

    if (!shouldDetach || !cursorPoint) {
      // Cross-process Chromium can deliver source dragend before target drop's acceptTabDragDrop IPC;
      // keep unescaped, non-detached pending drags reclaimable within a short grace window.
      this.reclaimableEndedSession = bufferExists
        ? {
            session: cloneSession({ ...session, payload }),
            expiresAt: this.now() + this.crossWindowReclaimGraceMs
          }
        : null
      return { detach: false, result: { detached: false, outcome: 'cancelled' } }
    }

    this.reclaimableEndedSession = null
    return {
      detach: true,
      payload,
      targetBounds: computeCursorAuxiliaryBounds(cursorPoint, screen)
    }
  }

  /**
   * Drops active state and all registered listeners on shutdown.
   */
  dispose(): void {
    this.activeSession = null
    this.reclaimableEndedSession = null
    this.listeners.clear()
  }

  private emit(snapshot: ActiveTabDragSession | null): void {
    for (const listener of this.listeners) {
      listener(snapshot ? cloneSession(snapshot) : null)
    }
  }
}

function remapSessionBufferKey(
  session: ActiveTabDragSession,
  keyMap: ReadonlyMap<string, string>
): boolean {
  if (isVirtualTabTransferPayload(session.payload)) return false
  const nextKey = keyMap.get(session.payload.bufferKey)
  if (!nextKey || nextKey === session.payload.bufferKey) return false
  session.payload.bufferKey = nextKey
  return true
}

function cloneSession(session: ActiveTabDragSession): ActiveTabDragSession {
  return {
    ...session,
    payload: toTabTransferPayload(session.payload)
  }
}
