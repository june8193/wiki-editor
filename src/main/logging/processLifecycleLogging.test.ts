import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LogService } from './LogService'
import { registerProcessLifecycleLogging } from './processLifecycleLogging'

class FakeAppEmitter extends EventEmitter {
  quit = vi.fn(() => {
    this.emit('will-quit', { preventDefault: vi.fn() })
  })
}

class FakeWebContents extends EventEmitter {
  id = 7
}

describe('registerProcessLifecycleLogging', () => {
  let tempDir: string
  let logService: LogService

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'wiki-editor-lifecycle-'))
    logService = new LogService(join(tempDir, 'logs'))
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
})
