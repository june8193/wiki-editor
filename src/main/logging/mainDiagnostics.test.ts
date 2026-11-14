import { EventEmitter } from 'node:events'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LogService } from './LogService'
import { createHelpMenuActions, registerProcessLifecycleLogging } from './mainDiagnostics'

class FakeAppEmitter extends EventEmitter {
  quit = vi.fn(() => {
    this.emit('will-quit', { preventDefault: vi.fn() })
  })
}

class FakeWebContents extends EventEmitter {
  id = 7
}

describe('mainDiagnostics', () => {
  let tempDir: string
  let logDir: string
  let logService: LogService

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'wiki-editor-diag-'))
    logDir = join(tempDir, 'logs')
    logService = new LogService(logDir)
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('logs ready, will-quit, uncaughtException, unhandledRejection, and render-process-gone without gaps', async () => {
    const processTarget = new EventEmitter()
    const appTarget = new FakeAppEmitter()
    const onWillQuit = vi.fn()

    const dispose = registerProcessLifecycleLogging({
      logService,
      processTarget,
      appTarget,
      getReadyData: () => ({ version: '1.0.0' }),
      onWillQuit
    })

    appTarget.emit('ready')

    const webContents = new FakeWebContents()
    appTarget.emit('web-contents-created', {}, webContents)
    webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 139 })

    processTarget.emit('uncaughtException', new Error('boom uncaught'), 'uncaughtException')
    processTarget.emit('unhandledRejection', new Error('boom rejected'))

    const preventDefault = vi.fn()
    appTarget.emit('will-quit', { preventDefault })

    await vi.waitFor(() => {
      expect(appTarget.quit).toHaveBeenCalledTimes(1)
    })
    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(onWillQuit).toHaveBeenCalledTimes(1)

    const entries = await logService.readEntries()
    expect(entries.map((entry) => entry.message)).toEqual([
      'Application ready',
      'Renderer process gone',
      'Uncaught exception in main process',
      'Unhandled promise rejection in main process',
      'Application will quit'
    ])

    expect(entries[0]).toMatchObject({
      level: 'info',
      category: 'app',
      data: { version: '1.0.0' }
    })
    expect(entries[1]).toMatchObject({
      level: 'error',
      category: 'app',
      data: { reason: 'crashed', exitCode: 139, webContentsId: 7 }
    })
    expect(entries[2]).toMatchObject({
      level: 'error',
      category: 'error',
      error: { message: 'boom uncaught' }
    })
    expect(entries[3]).toMatchObject({
      level: 'error',
      category: 'error',
      error: { message: 'boom rejected' }
    })
    expect(entries[4]).toMatchObject({
      level: 'info',
      category: 'app'
    })

    dispose()
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
      appVersion: '1.0.0',
      versions: { electron: '45.3.2', chrome: '136.0.0.0', node: '24.0.0' },
      os: { platform: 'win32', release: '10.0', arch: 'x64' },
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
    expect(entries.some((entry) => entry.level === 'error' && entry.message === 'Failed to open log folder')).toBe(
      true
    )
  })
})
