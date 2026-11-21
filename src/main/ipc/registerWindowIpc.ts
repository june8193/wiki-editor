import { WINDOW_IPC_CHANNELS } from '@shared/ipc'
import type {
  AcceptTabDragDropInput,
  AcceptTabDragDropResult,
  ActiveTabDragSession,
  DetachTabToNewWindowResult,
  TabDragEndInput,
  TabDragEndResult,
  TabDragResolution,
  TabDragStartInput,
  TabTransferPayload,
  WindowInitContext
} from '@shared/window'
import type { LogService } from '../logging/LogService'
import {
  broadcastIpcEvent,
  type IpcHandlerTuple,
  type IpcMainLike,
  registerIpcHandlers,
  resolveSenderWebContents,
  type WebContentsLike
} from './ipcHelpers'

export interface WindowIpcCoordinator {
  onTabDragStateChanged(
    listener: (session: ActiveTabDragSession | null, targets?: WebContentsLike[]) => void
  ): () => void
  getWebContentsTargets(): WebContentsLike[]
  getWindowInitContext(sender: unknown): WindowInitContext
  detachTabToNewWindow(sender: unknown, payload: TabTransferPayload): DetachTabToNewWindowResult
  startTabDrag(sender: unknown, input: TabDragStartInput): ActiveTabDragSession
  updateTabDragOutcome(
    sender: unknown,
    dragSessionId: string,
    outcome: TabDragResolution
  ): ActiveTabDragSession | null
  acceptTabDragDrop(sender: unknown, input?: AcceptTabDragDropInput): AcceptTabDragDropResult
  endTabDrag(sender: unknown, input: TabDragEndInput): TabDragEndResult
  closeCurrentWindow(sender: unknown): void
  resolveCloseRequest(sender: unknown, approved: boolean): void
  setCloseFlushEnabled(sender: unknown, enabled: boolean): void
}

export interface RegisterWindowIpcOptions {
  ipcMain: IpcMainLike
  windowManager: WindowIpcCoordinator
  logService?: LogService
}

/**
 * Registers window:* IPC handlers for role discovery, auxiliary detachment, drag coordination, and closing.
 */
export function registerWindowIpc({
  ipcMain,
  windowManager,
  logService
}: RegisterWindowIpcOptions): () => void {
  const unsubscribeDragState = windowManager.onTabDragStateChanged((session, targets) => {
    broadcastIpcEvent(
      () => targets ?? windowManager.getWebContentsTargets(),
      WINDOW_IPC_CHANNELS.dragStateChanged,
      session
    )
  })

  const handlers: readonly IpcHandlerTuple[] = [
    [
      WINDOW_IPC_CHANNELS.getInitContext,
      (event) => windowManager.getWindowInitContext(resolveSenderWebContents(event))
    ],
    [
      WINDOW_IPC_CHANNELS.detachTabToNewWindow,
      (event, payload) =>
        windowManager.detachTabToNewWindow(
          resolveSenderWebContents(event),
          payload as TabTransferPayload
        )
    ],
    [
      WINDOW_IPC_CHANNELS.startTabDrag,
      (event, input) =>
        windowManager.startTabDrag(resolveSenderWebContents(event), input as TabDragStartInput)
    ],
    [
      WINDOW_IPC_CHANNELS.updateTabDragOutcome,
      (event, dragSessionId, outcome) =>
        windowManager.updateTabDragOutcome(
          resolveSenderWebContents(event),
          dragSessionId as string,
          outcome as TabDragResolution
        )
    ],
    [
      WINDOW_IPC_CHANNELS.acceptTabDragDrop,
      (event, input) =>
        windowManager.acceptTabDragDrop(
          resolveSenderWebContents(event),
          input as AcceptTabDragDropInput | undefined
        )
    ],
    [
      WINDOW_IPC_CHANNELS.endTabDrag,
      (event, input) =>
        windowManager.endTabDrag(resolveSenderWebContents(event), input as TabDragEndInput)
    ],
    [
      WINDOW_IPC_CHANNELS.closeCurrent,
      (event) => {
        windowManager.closeCurrentWindow(resolveSenderWebContents(event))
      }
    ],
    [
      WINDOW_IPC_CHANNELS.resolveCloseRequest,
      (event, approved) => {
        windowManager.resolveCloseRequest(resolveSenderWebContents(event), Boolean(approved))
      }
    ],
    [
      WINDOW_IPC_CHANNELS.setCloseFlushEnabled,
      (event, enabled) => {
        windowManager.setCloseFlushEnabled(resolveSenderWebContents(event), Boolean(enabled))
      }
    ]
  ]

  const disposeHandlers = registerIpcHandlers(ipcMain, handlers, { logService })
  return () => {
    unsubscribeDragState()
    disposeHandlers()
  }
}
