import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHelpMenuActions } from './helpMenuActions'
import { LogService } from './LogService'

describe('createHelpMenuActions', () => {
  let tempDir: string
  let logDir: string
  let logService: LogService

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'wiki-editor-help-actions-'))
    logDir = join(tempDir, 'logs')
    logService = new LogService(logDir)
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('copies formatted bug report with confirmation dialog and ensures log dir before opening folder', async () => {
    await logService.info('app', 'Startup complete')
    await logService.error('git', 'Push failed', {
      error: Object.assign(new Error('remote rejected'), { code: 1, stderr: 'rejected' })
    })

    let copiedText = ''
    const showMessageBox = vi.fn(async () => ({ response: 0, checkboxChecked: false }))
    const openPath = vi.fn(async () => '')

    const actions = createHelpMenuActions({
      logService,
      environment: {
        appVersion: '1.0.0',
        versions: { electron: '45.3.2', chrome: '136.0.0.0', node: '24.0.0' },
        os: { platform: 'win32', release: '10.0', arch: 'x64' }
      },
      writeClipboardText: (text) => {
        copiedText = text
      },
      showMessageBox,
      openPath
    })

    await actions.onCopyBugReport()

    expect(copiedText).toContain('# Wiki Editor Bug Report')
    expect(copiedText).toContain('Wiki Editor: v1.0.0')
    expect(copiedText).toContain(logService.getLogFilePath())
    expect(copiedText).toContain('Push failed')
    expect(copiedText).toContain('Startup complete')
    expect(showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'info',
        message: 'Bug report copied to clipboard.',
        detail: expect.stringContaining(logService.getLogFilePath())
      })
    )

    // Remove logDir first to confirm onOpenLogFolder creates it before calling openPath
    await rm(logDir, { recursive: true, force: true })
    await actions.onOpenLogFolder()

    expect((await stat(logDir)).isDirectory()).toBe(true)
    expect(openPath).toHaveBeenCalledWith(logDir)

    // Failure return from openPath is recorded without throwing
    openPath.mockResolvedValueOnce('Access denied')
    await expect(actions.onOpenLogFolder()).resolves.toBeUndefined()
    const entries = await logService.readEntries()
    expect(
      entries.some((entry) => entry.level === 'error' && entry.message === 'Failed to open log folder')
    ).toBe(true)
  })
})
