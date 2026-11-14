import type { MessageBoxOptions } from 'electron'
import { createBugReportCopiedMessageBoxOptions } from '../menu'
import { type AppEnvironmentInfo, formatBugReport } from './formatBugReport'
import type { LogService } from './LogService'

export interface HelpMenuActionsOptions {
  logService: LogService
  environment: AppEnvironmentInfo
  writeClipboardText: (text: string) => void
  showMessageBox: (options: MessageBoxOptions) => Promise<unknown>
  openPath: (targetPath: string) => Promise<string>
}

export interface HelpMenuActions {
  onCopyBugReport: () => Promise<void>
  onOpenLogFolder: () => Promise<void>
}

/**
 * Builds Help menu handlers for copying formatted AI bug reports and opening the logs directory.
 */
export function createHelpMenuActions({
  logService,
  environment,
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
          environment
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
