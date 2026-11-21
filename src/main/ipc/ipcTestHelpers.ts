import type { IpcMainLike, IpcSessionSource, WebContentsLike } from './ipcHelpers'

export function createSingleIpcSessionSource<
  TSession,
  TWebContents extends WebContentsLike = WebContentsLike
>(session: TSession): IpcSessionSource<TSession, TWebContents> {
  return {
    resolveSession: () => session,
    forEachSession: (visitor) => visitor(session)
  }
}

type IpcTestHandler = (event: unknown, ...args: unknown[]) => unknown

export interface FakeIpcMain extends IpcMainLike {
  invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T>
  invokeFrom<T = unknown>(sender: unknown, channel: string, ...args: unknown[]): Promise<T>
  hasHandler(channel: string): boolean
}

export function createFakeIpcMain(): FakeIpcMain {
  const handlers = new Map<string, IpcTestHandler>()

  const callHandler = async <T>(
    event: unknown,
    channel: string,
    args: unknown[]
  ): Promise<T> => {
    const handler = handlers.get(channel)
    if (!handler) {
      throw new Error(`No handler registered for ${channel}`)
    }
    return (await handler(event, ...args)) as T
  }

  return {
    handle(channel, listener) {
      handlers.set(channel, listener)
    },
    removeHandler(channel) {
      handlers.delete(channel)
    },
    invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
      return callHandler<T>({}, channel, args)
    },
    invokeFrom<T = unknown>(sender: unknown, channel: string, ...args: unknown[]): Promise<T> {
      return callHandler<T>({ sender }, channel, args)
    },
    hasHandler(channel: string): boolean {
      return handlers.has(channel)
    }
  }
}
