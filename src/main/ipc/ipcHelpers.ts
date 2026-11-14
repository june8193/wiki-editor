export interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void
  removeHandler(channel: string): void
}

export interface WebContentsLike {
  isDestroyed(): boolean
  send(channel: string, ...args: unknown[]): void
}

export type IpcHandlerTuple = readonly [
  string,
  (event: unknown, ...args: unknown[]) => unknown
]

export function registerIpcHandlers(
  ipcMain: IpcMainLike,
  handlers: readonly IpcHandlerTuple[]
): () => void {
  for (const [channel, handler] of handlers) {
    ipcMain.handle(channel, handler)
  }

  return () => {
    for (const [channel] of handlers) {
      ipcMain.removeHandler(channel)
    }
  }
}

export function broadcastIpcEvent(
  getTargets: () => WebContentsLike[],
  channel: string,
  payload: unknown
): void {
  for (const target of getTargets()) {
    if (!target.isDestroyed()) {
      target.send(channel, payload)
    }
  }
}
