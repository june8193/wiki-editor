import {
  computeCursorAuxiliaryBounds,
  isPointOutsideAllWindows,
  toTabTransferPayload,
  type ActiveTabDragSession,
  type ScreenLike,
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
    return cloneSession(snapshot)
  }

  /**
   * Transitions a pending active session to a terminal outcome and broadcasts the change.
   */
  private transitionPendingOutcome(
    targetOutcome: Exclude<TabDragOutcome, 'pending'>
  ): ActiveTabDragSession | null {
    const session = this.activeSession
    if (!session) return null
    if (session.outcome !== 'pending') {
      return cloneSession(session)
    }
    session.outcome = targetOutcome
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
    outcome: TabDragOutcome
  ): ActiveTabDragSession | null {
    const session = this.activeSession
    if (!session || session.sourceWindowId !== sourceWindowId || session.dragSessionId !== dragSessionId) {
      return null
    }
    if (outcome === 'pending') {
      return cloneSession(session)
    }
    return this.transitionPendingOutcome(outcome)
  }

  /**
   * Cancels the active pending drag session when Escape is observed on any focused app window.
   */
  handleBeforeInput(input: BeforeInputKeyEventLike): ActiveTabDragSession | null {
    if (!isEscapeBeforeInput(input)) {
      return null
    }
    return this.transitionPendingOutcome('cancelled')
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
      return { detach: false, result: { detached: false, outcome: 'cancelled' } }
    }

    this.activeSession = null
    this.emit(null)

    if (session.outcome !== 'pending') {
      return { detach: false, result: { detached: false, outcome: session.outcome } }
    }
    if (!canDetach) {
      return { detach: false, result: { detached: false, outcome: 'cancelled' } }
    }

    const cursorPoint = screen?.getCursorScreenPoint?.() ?? input.screenPoint
    if (!cursorPoint || !isPointOutsideAllWindows(cursorPoint, openWindowBounds)) {
      return { detach: false, result: { detached: false, outcome: 'cancelled' } }
    }

    return {
      detach: true,
      payload: toTabTransferPayload(input.payload ?? session.payload),
      targetBounds: computeCursorAuxiliaryBounds(cursorPoint, screen)
    }
  }

  /**
   * Drops active state and all registered listeners on shutdown.
   */
  dispose(): void {
    this.activeSession = null
    this.listeners.clear()
  }

  private emit(snapshot: ActiveTabDragSession | null): void {
    for (const listener of this.listeners) {
      listener(snapshot ? cloneSession(snapshot) : null)
    }
  }
}

function cloneSession(session: ActiveTabDragSession): ActiveTabDragSession {
  return {
    ...session,
    payload: toTabTransferPayload(session.payload)
  }
}
