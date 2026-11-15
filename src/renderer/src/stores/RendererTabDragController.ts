import { toErrorMessage } from '@shared/errors'
import type { WikiWindowApi } from '@shared/ipc'
import {
  toTabTransferPayload,
  type ActiveTabDragSession,
  type PaneId,
  type ScreenPoint,
  type TabDragResolution
} from '@shared/window'
import type { DraggingTabPayload } from '../components/PaneTabBar'
import type { PaneTabStore, TabItem } from './PaneTabStore'

export interface RendererTabDragControllerOptions {
  tabStore: PaneTabStore
  windowApi?: WikiWindowApi
  getWindowId: () => number | null
  isBufferReadyForImmediateDrag: (bufferKey: string) => boolean
  syncTabBufferForTransfer: (paneId: PaneId, tabId: string) => Promise<TabItem | null>
  closeDetachedTab: (paneId: PaneId, tabId: string) => void
  onError: (message: string | null, error?: unknown) => void
}

interface ActiveLocalDragState {
  paneId: PaneId
  tabId: string
  startPromise: Promise<ActiveTabDragSession | null>
  resolvedSessionId: string | null
  outcomeOverride: TabDragResolution | null
  pendingOutcomeSync: Promise<unknown> | null
  superseded: boolean
}

/**
 * Owns renderer tab-drag UI state (`draggingTab`) and coordinates the main-process
 * drag session lifecycle, Escape cancellation, in-window completion, and dirty-buffer flush on detach.
 */
export class RendererTabDragController {
  private readonly tabStore: PaneTabStore
  private readonly windowApi?: WikiWindowApi
  private readonly getWindowId: () => number | null
  private readonly isBufferReadyForImmediateDrag: (bufferKey: string) => boolean
  private readonly syncTabBufferForTransfer: (paneId: PaneId, tabId: string) => Promise<TabItem | null>
  private readonly closeDetachedTab: (paneId: PaneId, tabId: string) => void
  private readonly onError: (message: string | null, error?: unknown) => void

  private readonly listeners = new Set<() => void>()
  private draggingTab: DraggingTabPayload | null = null
  private activeDrag: ActiveLocalDragState | null = null
  private mounted = false

  constructor(options: RendererTabDragControllerOptions) {
    this.tabStore = options.tabStore
    this.windowApi = options.windowApi
    this.getWindowId = options.getWindowId
    this.isBufferReadyForImmediateDrag = options.isBufferReadyForImmediateDrag
    this.syncTabBufferForTransfer = options.syncTabBufferForTransfer
    this.closeDetachedTab = options.closeDetachedTab
    this.onError = options.onError
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getSnapshot = (): DraggingTabPayload | null => this.draggingTab

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
      superseded: false
    }
    this.activeDrag = dragState

    dragState.startPromise = (async () => {
      try {
        const latestTab = this.isBufferReadyForImmediateDrag(initialTab.bufferKey)
          ? this.tabStore.getTab(paneId, tabId)
          : await this.syncTabBufferForTransfer(paneId, tabId)
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
    const drag = this.activeDrag
    if (!drag || !this.windowApi || drag.outcomeOverride === 'cancelled') return

    this.activeDrag = null
    this.applyOutcomeOverride(drag, 'dropped-in-window')

    // Complete main session proactively because split/cross-pane drops unmount the source tab before dragend fires
    void (async () => {
      try {
        const session = await this.awaitSettledSession(drag)
        if (!session) return
        await this.windowApi!.endTabDrag({ dragSessionId: session.dragSessionId })
      } catch {
        // In-window layout transition already succeeded; ignore late IPC cleanup failure
      }
    })()
  }

  cancelDrag = (): void => {
    this.setDraggingTab(null)
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
        await this.windowApi.endTabDrag({
          dragSessionId: session.dragSessionId,
          screenPoint
        })
        return
      }

      const latestTab = await this.syncTabBufferForTransfer(drag.paneId, drag.tabId)
      if (!this.mounted) return

      const result = await this.windowApi.endTabDrag({
        dragSessionId: session.dragSessionId,
        screenPoint,
        ...(latestTab ? { payload: toTabTransferPayload(latestTab) } : {})
      })
      if (result.detached && this.mounted) {
        this.closeDetachedTab(drag.paneId, drag.tabId)
      }
    } catch (error: unknown) {
      if (activeSessionId) {
        await this.windowApi
          .updateTabDragOutcome(activeSessionId, 'cancelled')
          .then(() => this.windowApi!.endTabDrag({ dragSessionId: activeSessionId! }))
          .catch(() => null)
      }
      if (this.mounted) {
        this.onError(toErrorMessage(error, '새 창으로 이동하지 못했습니다.'), error)
      }
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
    if (this.activeDrag) {
      this.activeDrag.superseded = true
      this.activeDrag = null
    }
  }

  private handleMainDragStateChanged(session: ActiveTabDragSession | null): void {
    const drag = this.activeDrag
    if (!this.mounted || !drag || !session || session.outcome !== 'cancelled') {
      return
    }
    const localWindowId = this.getWindowId()
    const matchesSession =
      drag.resolvedSessionId === session.dragSessionId ||
      (drag.resolvedSessionId === null &&
        (localWindowId === null || localWindowId === session.sourceWindowId) &&
        drag.paneId === session.paneId &&
        drag.tabId === session.tabId)
    if (!matchesSession) return

    drag.outcomeOverride = 'cancelled'
    this.setDraggingTab(null)
  }

  private setDraggingTab(next: DraggingTabPayload | null): void {
    const prev = this.draggingTab
    if (
      (prev === null && next === null) ||
      (prev !== null && next !== null && prev.paneId === next.paneId && prev.tabId === next.tabId)
    ) {
      return
    }
    this.draggingTab = next
    for (const listener of this.listeners) {
      listener()
    }
  }
}
