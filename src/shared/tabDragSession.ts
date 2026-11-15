import {
  computeCursorAuxiliaryBounds,
  isPointOutsideAllWindows,
  toTabTransferPayload,
  type ActiveTabDragSession,
  type ScreenLike,
  type ScreenPoint,
  type TabDragEndInput,
  type TabDragEndResult,
  type TabDragOutcome,
  type TabDragStartInput,
  type TabTransferPayload,
  type WindowBounds
} from '@shared/window'

export interface BeforeInputKeyEventLike {
  type?: string
  key?: string
}

export interface FinishTabDragParams {
  sourceWindowId: number
  input: TabDragEndInput
  openWindowBounds: readonly WindowBounds[]
  canDetach: boolean
  screen?: ScreenLike
}

export interface FinishTabDragPlan {
  result: TabDragEndResult
  detachPayload?: TabTransferPayload
  targetBounds?: WindowBounds
}

/**
 * Returns true when an Electron `before-input-event` payload represents an Escape press
 * (ignoring key-up releases so an Escape keyDown cancels cleanly on press).
 */
export function isEscapeBeforeInput(input: BeforeInputKeyEventLike): boolean {
  return input.key === 'Escape' && input.type !== 'keyUp'
}

/**
 * Coordinates the single active tab drag session across windows and evaluates
 * drop/cancel outcomes identically in both main-process WindowManager and test harnesses.
 */
export class TabDragCoordinator {
  private activeSession: ActiveTabDragSession | null = null
  private sessionCounter = 0
  private readonly listeners = new Set<(session: ActiveTabDragSession | null) => void>()

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
   * Returns a cloned snapshot of the currently active drag session, if any.
   */
  getActiveSession(): ActiveTabDragSession | null {
    return this.activeSession ? cloneSession(this.activeSession) : null
  }

  /**
   * Begins a new drag session owned by `sourceWindowId`, replacing any stale prior session.
   */
  start(sourceWindowId: number, input: TabDragStartInput): ActiveTabDragSession {
    this.sessionCounter += 1
    this.activeSession = {
      dragSessionId: `drag-${this.sessionCounter}`,
      sourceWindowId,
      paneId: input.paneId,
      tabId: input.tabId,
      payload: toTabTransferPayload(input.payload),
      outcome: 'pending'
    }
    const snapshot = cloneSession(this.activeSession)
    this.emit(snapshot)
    return snapshot
  }

  /**
   * Updates the active session outcome when owned by `sourceWindowId` and matching `dragSessionId`.
   * Cancellation is sticky so an Escape cancel is never overwritten by a late in-window drop signal.
   */
  updateOutcome(
    sourceWindowId: number,
    dragSessionId: string,
    outcome: TabDragOutcome
  ): ActiveTabDragSession | null {
    const session = this.activeSession
    if (!session || session.sourceWindowId !== sourceWindowId || session.dragSessionId !== dragSessionId) {
      return null
    }
    if (session.outcome === 'cancelled' || session.outcome === outcome) {
      return cloneSession(session)
    }
    session.outcome = outcome
    const snapshot = cloneSession(session)
    this.emit(snapshot)
    return snapshot
  }

  /**
   * Cancels the active drag session when Escape is observed on any focused app window.
   */
  handleBeforeInput(input: BeforeInputKeyEventLike): ActiveTabDragSession | null {
    if (!isEscapeBeforeInput(input) || !this.activeSession) {
      return null
    }
    if (this.activeSession.outcome === 'cancelled') {
      return cloneSession(this.activeSession)
    }
    this.activeSession.outcome = 'cancelled'
    const snapshot = cloneSession(this.activeSession)
    this.emit(snapshot)
    return snapshot
  }

  /**
   * Clears the active session if its owning window closed before `endTabDrag` ran.
   */
  clearForWindow(windowId: number): void {
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
    const { sourceWindowId, input, openWindowBounds, canDetach, screen } = params
    const session = this.activeSession
    if (!session || session.sourceWindowId !== sourceWindowId || session.dragSessionId !== input.dragSessionId) {
      return { result: { detached: false, outcome: 'cancelled' } }
    }

    this.activeSession = null
    this.emit(null)

    if (session.outcome !== 'pending') {
      return { result: { detached: false, outcome: session.outcome } }
    }
    if (!canDetach) {
      return { result: { detached: false, outcome: 'cancelled' } }
    }

    const cursorPoint: ScreenPoint = screen?.getCursorScreenPoint?.() ?? input.screenPoint
    if (!isPointOutsideAllWindows(cursorPoint, openWindowBounds)) {
      return { result: { detached: false, outcome: 'cancelled' } }
    }

    const detachPayload = toTabTransferPayload(input.payload ?? session.payload)
    const targetBounds = computeCursorAuxiliaryBounds(cursorPoint, screen)
    return {
      result: { detached: true, outcome: 'pending' },
      detachPayload,
      targetBounds
    }
  }

  /**
   * Drops active state and all registered listeners on shutdown.
   */
  dispose(): void {
    this.activeSession = null
    this.listeners.clear()
  }

  private emit(session: ActiveTabDragSession | null): void {
    const payload = session ? cloneSession(session) : null
    for (const listener of this.listeners) {
      listener(payload)
    }
  }
}

function cloneSession(session: ActiveTabDragSession): ActiveTabDragSession {
  return {
    ...session,
    payload: toTabTransferPayload(session.payload)
  }
}
