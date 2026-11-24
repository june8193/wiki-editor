import type { DocumentBuffer } from '@shared/documentBuffer'
import { toErrorMessage } from '@shared/errors'
import type { WikiWindowApi } from '@shared/ipc'
import {
  isDiffTabTransferPayload,
  toTabTransferPayload,
  type ActiveTabDragSession,
  type PaneId,
  type ScreenPoint,
  type TabDragEndInput,
  type TabDragEndResult,
  type TabDragResolution,
  type TabTransferPayload
} from '@shared/window'
import {
  EMPTY_TAB_DRAG_STATE,
  type DraggingTabPayload,
  type TabDragUiState
} from './tabDragDrop'
import type { DocumentTabItem, PaneTabStore, TabItem, TransferredTabDropTarget } from './PaneTabStore'

export interface TabDragBufferBridge {
  getWindowId(): number | null
  isBufferReadyForImmediateDrag(bufferKey: string): boolean
  syncTabBufferForTransfer(paneId: PaneId, tabId: string): Promise<DocumentTabItem | null>
  forceCloseTab(paneId: PaneId, tabId: string): void
  completeTransferredOutTab(paneId: PaneId, tabId: string): Promise<void>
  acceptTransferredTab(
    buffer: DocumentBuffer | undefined,
    payload: TabTransferPayload,
    target?: TransferredTabDropTarget
  ): TabItem | null
}

export interface RendererTabDragControllerOptions {
  tabStore: PaneTabStore
  bufferSync: TabDragBufferBridge
  windowApi?: WikiWindowApi
  onError: (message: string | null, error?: unknown) => void
}

interface ActiveLocalDragState {
  paneId: PaneId
  tabId: string
  startPromise: Promise<ActiveTabDragSession | null>
  resolvedSessionId: string | null
  outcomeOverride: TabDragResolution | null
  pendingOutcomeSync: Promise<unknown> | null
  mainSessionEnded: boolean
  closed: boolean
  superseded: boolean
}

function getDragPayloadKey(payload: TabTransferPayload): string {
  return isDiffTabTransferPayload(payload)
    ? `diff:${payload.diff.request.kind}:${payload.diff.request.path}`
    : `doc:${payload.bufferKey}`
}

function isSameDragSession(
  left: ActiveTabDragSession | null,
  right: ActiveTabDragSession | null
): boolean {
  if (left === right) return true
  if (!left || !right) return false
  return (
    left.dragSessionId === right.dragSessionId &&
    left.outcome === right.outcome &&
    left.targetWindowId === right.targetWindowId &&
    getDragPayloadKey(left.payload) === getDragPayloadKey(right.payload)
  )
}

/**
 * Owns renderer tab-drag UI state (`draggingTab`, `externalDragSession`) and coordinates
 * the main-process drag session lifecycle, Escape cancellation, in-window/cross-window
 * completion, and dirty-buffer flush on detach/transfer.
 */
export class RendererTabDragController {
  private readonly tabStore: PaneTabStore
  private readonly bufferSync: TabDragBufferBridge
  private readonly windowApi?: WikiWindowApi
  private readonly onError: (message: string | null, error?: unknown) => void

  private readonly listeners = new Set<() => void>()
  private uiState: TabDragUiState = EMPTY_TAB_DRAG_STATE
  private activeDrag: ActiveLocalDragState | null = null
  private lastReclaimableDrag: { dragSessionId: string; drag: ActiveLocalDragState } | null = null
  private mounted = false

  constructor(options: RendererTabDragControllerOptions) {
    this.tabStore = options.tabStore
    this.bufferSync = options.bufferSync
    this.windowApi = options.windowApi
    this.onError = options.onError
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getSnapshot = (): TabDragUiState => this.uiState

  start(): () => void {
    this.mounted = true
    const unsubscribeDragState = this.windowApi?.onTabDragStateChanged((session) =>
      this.handleMainDragStateChanged(session)
    )

    return () => {
      this.mounted = false
      unsubscribeDragState?.()
      this.clearCurrentDrag()
    }
  }

  startDrag = (paneId: PaneId, tabId: string): void => {
    const initialTab = this.tabStore.getTab(paneId, tabId)
    if (!initialTab) return

    this.lastReclaimableDrag = null
    this.setDraggingTab({ paneId, tabId })
    if (!this.windowApi || !this.mounted) return

    if (this.activeDrag) {
      this.activeDrag.superseded = true
    }

    const dragState: ActiveLocalDragState = {
      paneId,
      tabId,
      startPromise: Promise.resolve(null),
      resolvedSessionId: null,
      outcomeOverride: null,
      pendingOutcomeSync: null,
      mainSessionEnded: false,
      closed: false,
      superseded: false
    }
    this.activeDrag = dragState

    dragState.startPromise = (async () => {
      try {
        const latestTab =
          initialTab.kind === 'diff'
            ? this.tabStore.getTab(paneId, tabId)
            : this.bufferSync.isBufferReadyForImmediateDrag(initialTab.bufferKey)
              ? this.tabStore.getTab(paneId, tabId)
              : await this.bufferSync.syncTabBufferForTransfer(paneId, tabId)
        if (!latestTab || !this.mounted || dragState.superseded) {
          return null
        }

        const session = await this.windowApi!.startTabDrag({
          paneId,
          tabId,
          payload: toTabTransferPayload(latestTab)
        })
        dragState.resolvedSessionId = session.dragSessionId

        if (dragState.outcomeOverride && dragState.outcomeOverride !== session.outcome) {
          await this.windowApi!
            .updateTabDragOutcome(session.dragSessionId, dragState.outcomeOverride)
            .catch(() => null)
        }
        return session
      } catch {
        return null
      }
    })()
  }

  completeInWindowDrop = (): void => {
    this.setDraggingTab(null)
    this.lastReclaimableDrag = null
    const drag = this.activeDrag
    if (!drag || !this.windowApi || drag.outcomeOverride === 'cancelled') return

    this.activeDrag = null
    this.applyOutcomeOverride(drag, 'dropped-in-window')

    // Complete main session proactively because split/cross-pane drops unmount the source tab before dragend fires
    void (async () => {
      try {
        const session = await this.awaitSettledSession(drag)
        if (!session) return
        await this.endMainDragSession(drag, { dragSessionId: session.dragSessionId })
      } catch {
        // In-window layout transition already succeeded; ignore late IPC cleanup failure
      }
    })()
  }

  cancelDrag = (): void => {
    this.setDraggingTab(null)
    this.lastReclaimableDrag = null
    const drag = this.activeDrag
    if (!drag || !this.windowApi || drag.outcomeOverride === 'cancelled') return

    this.applyOutcomeOverride(drag, 'cancelled')
  }

  endDrag = async (screenPoint?: ScreenPoint): Promise<void> => {
    this.setDraggingTab(null)
    const drag = this.activeDrag
    this.activeDrag = null
    if (!drag || !this.windowApi) return

    let activeSessionId: string | null = null
    try {
      const session = await this.awaitSettledSession(drag)
      if (!session) return
      activeSessionId = session.dragSessionId

      if (drag.outcomeOverride !== null) {
        await this.endMainDragSession(drag, {
          dragSessionId: session.dragSessionId,
          screenPoint
        })
        return
      }

      this.lastReclaimableDrag = { dragSessionId: session.dragSessionId, drag }
      const currentTab = this.tabStore.getTab(drag.paneId, drag.tabId)
      const latestTab =
        currentTab?.kind === 'diff'
          ? currentTab
          : await this.bufferSync.syncTabBufferForTransfer(drag.paneId, drag.tabId)
      if (!this.mounted) return

      const result = await this.endMainDragSession(drag, {
        dragSessionId: session.dragSessionId,
        screenPoint,
        ...(latestTab ? { payload: toTabTransferPayload(latestTab) } : {})
      })
      if (!this.mounted || !result) return
      if (result.detached || result.outcome === 'dropped-in-window') {
        this.clearReclaimableDrag(session.dragSessionId)
        if (this.claimDragClose(drag)) {
          this.bufferSync.forceCloseTab(drag.paneId, drag.tabId)
        }
      }
    } catch (error: unknown) {
      if (activeSessionId) {
        this.clearReclaimableDrag(activeSessionId)
        await this.windowApi
          .updateTabDragOutcome(activeSessionId, 'cancelled')
          .then(() => this.endMainDragSession(drag, { dragSessionId: activeSessionId! }))
          .catch(() => null)
      }
      if (this.mounted) {
        this.onError(toErrorMessage(error, '새 창으로 이동하지 못했습니다.'), error)
      }
    }
  }

  /**
   * Accepts an incoming external tab drop onto a target pane tab bar or split direction,
   * fetching the authoritative buffer via IPC before mutating local layout state.
   */
  acceptExternalDrop = async (
    target: TransferredTabDropTarget,
    dragSessionId?: string
  ): Promise<boolean> => {
    if (!this.windowApi || !this.mounted) {
      return false
    }

    try {
      const result = await this.windowApi.acceptTabDragDrop(
        dragSessionId ? { dragSessionId } : undefined
      )
      if (!this.mounted) {
        return false
      }
      this.setExternalDragSession(null)
      if (!result.accepted) {
        return false
      }
      this.bufferSync.acceptTransferredTab(result.buffer, result.payload, target)
      return true
    } catch (error: unknown) {
      this.setExternalDragSession(null)
      if (this.mounted) {
        this.onError(toErrorMessage(error, '탭을 옮기지 못했습니다.'), error)
      }
      return false
    }
  }

  private async awaitSettledSession(
    drag: ActiveLocalDragState
  ): Promise<ActiveTabDragSession | null> {
    const session = await drag.startPromise
    if (!session || !this.mounted) return null
    if (drag.pendingOutcomeSync) {
      await drag.pendingOutcomeSync.catch(() => undefined)
      if (!this.mounted) return null
    }
    return session
  }

  private applyOutcomeOverride(
    drag: ActiveLocalDragState,
    outcome: TabDragResolution
  ): void {
    drag.outcomeOverride = outcome
    if (drag.resolvedSessionId && this.windowApi) {
      drag.pendingOutcomeSync = this.windowApi
        .updateTabDragOutcome(drag.resolvedSessionId, outcome)
        .catch(() => null)
    }
  }

  private clearCurrentDrag(): void {
    this.setDraggingTab(null)
    this.setExternalDragSession(null)
    this.lastReclaimableDrag = null
    if (this.activeDrag) {
      this.activeDrag.superseded = true
      this.activeDrag = null
    }
  }

  private matchesActiveLocalDrag(session: ActiveTabDragSession): boolean {
    const drag = this.activeDrag
    if (!drag) return false
    const localWindowId = this.bufferSync.getWindowId()
    return (
      drag.resolvedSessionId === session.dragSessionId ||
      (drag.resolvedSessionId === null &&
        (localWindowId === null || localWindowId === session.sourceWindowId) &&
        drag.paneId === session.paneId &&
        drag.tabId === session.tabId)
    )
  }

  private async finalizeCrossWindowSourceTransfer(
    drag: ActiveLocalDragState,
    dragSessionId: string
  ): Promise<void> {
    if (this.claimDragClose(drag)) {
      await this.bufferSync.completeTransferredOutTab(drag.paneId, drag.tabId)
    }
    if (this.mounted && !drag.mainSessionEnded) {
      await this.endMainDragSession(drag, { dragSessionId }).catch(() => undefined)
    }
  }

  private handleMainDragStateChanged(session: ActiveTabDragSession | null): void {
    if (!this.mounted) return

    if (!session || session.outcome !== 'pending') {
      this.setExternalDragSession(null)
    } else {
      const localWindowId = this.bufferSync.getWindowId()
      const isOwnWindow =
        (localWindowId !== null && localWindowId === session.sourceWindowId) ||
        this.matchesActiveLocalDrag(session)
      this.setExternalDragSession(isOwnWindow ? null : session)
    }

    if (!session) {
      return
    }
    const matchedActiveDrag =
      this.activeDrag && this.matchesActiveLocalDrag(session) ? this.activeDrag : null
    const matchedReclaimableDrag =
      !matchedActiveDrag && this.lastReclaimableDrag?.dragSessionId === session.dragSessionId
        ? this.lastReclaimableDrag.drag
        : null
    const drag = matchedActiveDrag ?? matchedReclaimableDrag
    if (!drag) {
      return
    }

    if (session.outcome === 'cancelled') {
      drag.outcomeOverride = 'cancelled'
      this.clearReclaimableDrag(session.dragSessionId)
      this.setDraggingTab(null)
      return
    }

    if (
      session.outcome === 'dropped-in-window' &&
      session.targetWindowId !== undefined &&
      session.targetWindowId !== session.sourceWindowId
    ) {
      drag.outcomeOverride = 'dropped-in-window'
      if (matchedActiveDrag) {
        this.activeDrag = null
      }
      this.clearReclaimableDrag(session.dragSessionId)
      this.setDraggingTab(null)
      void this.finalizeCrossWindowSourceTransfer(drag, session.dragSessionId)
    }
  }

  private clearReclaimableDrag(dragSessionId: string): void {
    if (this.lastReclaimableDrag?.dragSessionId === dragSessionId) {
      this.lastReclaimableDrag = null
    }
  }

  private endMainDragSession(
    drag: ActiveLocalDragState,
    input: TabDragEndInput
  ): Promise<TabDragEndResult | undefined> {
    drag.mainSessionEnded = true
    return this.windowApi ? this.windowApi.endTabDrag(input) : Promise.resolve(undefined)
  }

  private claimDragClose(drag: ActiveLocalDragState): boolean {
    if (drag.closed) {
      return false
    }
    drag.closed = true
    return true
  }

  private setDraggingTab(next: DraggingTabPayload | null): void {
    const prev = this.uiState.draggingTab
    if (
      (prev === null && next === null) ||
      (prev !== null && next !== null && prev.paneId === next.paneId && prev.tabId === next.tabId)
    ) {
      return
    }
    this.uiState = { ...this.uiState, draggingTab: next }
    this.notifyListeners()
  }

  private setExternalDragSession(next: ActiveTabDragSession | null): void {
    if (isSameDragSession(this.uiState.externalDragSession, next)) {
      return
    }
    this.uiState = { ...this.uiState, externalDragSession: next }
    this.notifyListeners()
  }

  private notifyListeners(): void {
    for (const listener of this.listeners) {
      listener()
    }
  }
}
