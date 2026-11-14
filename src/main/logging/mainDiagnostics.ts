import type { MessageBoxOptions } from 'electron'
import { createBugReportCopiedMessageBoxOptions, type RuntimeVersions } from '../menu'
import { type BugReportOsInfo, formatBugReport } from './formatBugReport'
import type { LogService } from './LogService'

const QUIT_FLUSH_TIMEOUT_MS = 500

export interface ProcessEventTargetLike {
  on(event: 'uncaughtException', listener: (error: Error, origin?: string) => void): unknown
  on(event: 'unhandledRejection', listener: (reason: unknown) => void): unknown
  removeListener(
    event: 'uncaughtException',
    listener: (error: Error, origin?: string) => void
  ): unknown
  removeListener(event: 'unhandledRejection', listener: (reason: unknown) => void): unknown
}

export interface RenderProcessGoneDetailsLike {
  reason: string
  exitCode: number
}

export interface WebContentsDiagnosticsLike {
  id?: number
  on(
    event: 'render-process-gone',
    listener: (event: unknown, details: RenderProcessGoneDetailsLike) => void
  ): unknown
}

export interface QuitEventLike {
  preventDefault?: () => void
}

export interface AppEventTargetLike {
  on(event: 'ready', listener: () => void): unknown
  on(
    event: 'web-contents-created',
    listener: (event: unknown, webContents: WebContentsDiagnosticsLike) => void
  ): unknown
  on(event: 'will-quit', listener: (event: QuitEventLike) => void): unknown
  removeListener(event: 'ready', listener: () => void): unknown
  removeListener(
    event: 'web-contents-created',
    listener: (event: unknown, webContents: WebContentsDiagnosticsLike) => void
  ): unknown
  removeListener(event: 'will-quit', listener: (event: QuitEventLike) => void): unknown
  quit?: () => void
}

export interface RegisterProcessLifecycleLoggingOptions {
  logService: LogService
  processTarget: ProcessEventTargetLike
  appTarget: AppEventTargetLike
  getReadyData?: () => Record<string, unknown>
  onWillQuit?: () => void
}

export interface HelpMenuActionsOptions {
  logService: LogService
  appVersion: string
  versions: RuntimeVersions
  os: BugReportOsInfo
  writeClipboardText: (text: string) => void
  showMessageBox: (options: MessageBoxOptions) => Promise<unknown>
  openPath: (targetPath: string) => Promise<string>
}

export interface HelpMenuActions {
  onCopyBugReport: () => Promise<void>
  onOpenLogFolder: () => Promise<void>
}

/**
 * Registers app lifecycle, process crash, and renderer termination logging listeners.
 */
export function registerProcessLifecycleLogging({
  logService,
  processTarget,
  appTarget,
  getReadyData,
  onWillQuit
}: RegisterProcessLifecycleLoggingOptions): () => void {
  let quitFlushed = false

  const handleUncaughtException = (error: Error, origin?: string): void => {
    void logService.error('error', 'Uncaught exception in main process', {
      ...(origin ? { data: { origin } } : {}),
      error
    })
  }

  const handleUnhandledRejection = (reason: unknown): void => {
    void logService.error('error', 'Unhandled promise rejection in main process', {
      error: reason
    })
  }

  const handleReady = (): void => {
    void logService.info('app', 'Application ready', {
      data: getReadyData?.()
    })
  }

  const handleWebContentsCreated = (
    _event: unknown,
    webContents: WebContentsDiagnosticsLike
  ): void => {
    webContents.on('render-process-gone', (_goneEvent, details) => {
      void logService.error('app', 'Renderer process gone', {
        data: {
          reason: details.reason,
          exitCode: details.exitCode,
          ...(webContents.id !== undefined ? { webContentsId: webContents.id } : {})
        }
      })
    })
  }

  const handleWillQuit = (event: QuitEventLike | undefined): void => {
    if (quitFlushed) {
      return
    }
    quitFlushed = true
    onWillQuit?.()

    if (event && typeof event.preventDefault === 'function' && typeof appTarget.quit === 'function') {
      event.preventDefault()
      const logPromise = logService.info('app', 'Application will quit')
      const timeoutPromise = new Promise<void>((resolve) => {
        setTimeout(resolve, QUIT_FLUSH_TIMEOUT_MS)
      })
      void Promise.race([logPromise, timeoutPromise]).finally(() => {
        appTarget.quit?.()
      })
      return
    }

    void logService.info('app', 'Application will quit')
  }

  processTarget.on('uncaughtException', handleUncaughtException)
  processTarget.on('unhandledRejection', handleUnhandledRejection)
  appTarget.on('ready', handleReady)
  appTarget.on('web-contents-created', handleWebContentsCreated)
  appTarget.on('will-quit', handleWillQuit)

  return () => {
    processTarget.removeListener('uncaughtException', handleUncaughtException)
    processTarget.removeListener('unhandledRejection', handleUnhandledRejection)
    appTarget.removeListener('ready', handleReady)
    appTarget.removeListener('web-contents-created', handleWebContentsCreated)
    appTarget.removeListener('will-quit', handleWillQuit)
  }
}

/**
 * Builds Help menu handlers for copying formatted AI bug reports and opening the logs directory.
 */
export function createHelpMenuActions({
  logService,
  appVersion,
  versions,
  os,
  writeClipboardText,
  showMessageBox,
  openPath
}: HelpMenuActionsOptions): HelpMenuActions {
  return {
    onCopyBugReport: async () => {
      try {
        const entries = await logService.readEntries()
        const report = formatBugReport({
          entries,
          logFilePath: logService.getLogFilePath(),
          appVersion,
          versions,
          os
        })
        writeClipboardText(report)
        await showMessageBox(
          createBugReportCopiedMessageBoxOptions({
            logFilePath: logService.getLogFilePath()
          })
        )
        await logService.info('app', 'Bug report copied to clipboard')
      } catch (error) {
        await logService.error('app', 'Failed to copy bug report', { error })
      }
    },
    onOpenLogFolder: async () => {
      const logDir = logService.getLogDir()
      try {
        await logService.ensureLogDir()
        const openError = await openPath(logDir)
        if (openError) {
          await logService.error('app', 'Failed to open log folder', {
            data: { logDir, reason: openError }
          })
          return
        }
        await logService.info('app', 'Opened log folder', {
          data: { logDir }
        })
      } catch (error) {
        await logService.error('app', 'Failed to open log folder', {
          data: { logDir },
          error
        })
      }
    }
  }
}
