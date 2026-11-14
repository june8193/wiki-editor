import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerLogIpc } from '../ipc/registerLogIpc'
import { createWikiApi } from '../../preload/wikiApi'
import { serializeError } from '@shared/logging'
import { LogService } from './LogService'
import { createHelpMenuActions } from './helpMenuActions'

describe('Renderer log bridge to Help Bug Report integration', () => {
  const tempDirs: string[] = []

  afterEach(async () => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()
      if (dir) {
        await fs.rm(dir, { recursive: true, force: true })
      }
    }
  })

  it('forwards preload renderer breadcrumbs and errors into LogService and Bug Report without leaking sensitive content or creating IPC audit loops', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-editor-renderer-log-e2e-'))
    tempDirs.push(tempDir)

    const logService = new LogService(tempDir)
    const ipcHandlers = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown> | unknown>()
    const fakeIpcMain = {
      handle: vi.fn((channel: string, handler: (event: unknown, ...args: unknown[]) => Promise<unknown> | unknown) => {
        ipcHandlers.set(channel, handler)
      }),
      removeHandler: vi.fn((channel: string) => {
        ipcHandlers.delete(channel)
      })
    }

    const disposeLogIpc = registerLogIpc(fakeIpcMain, logService)

    const wikiApi = createWikiApi({
      invoke: async (channel, ...args) => {
        const handler = ipcHandlers.get(channel)
        if (!handler) {
          throw new Error(`No handler registered for channel: ${channel}`)
        }
        return handler({}, ...args)
      },
      on: vi.fn(),
      removeListener: vi.fn()
    })

    await wikiApi.log.write({
      level: 'info',
      category: 'ui',
      message: 'Workspace opened',
      data: {
        workspacePath: '/vault',
        content: 'SECRET_NOTE_BODY'
      }
    })
    await wikiApi.log.write({
      level: 'info',
      category: 'ui',
      message: 'Tab opened',
      data: {
        paneId: 'left',
        tabType: 'doc',
        raw: 'SECRET_RAW_CONFIG'
      }
    })
    await wikiApi.log.write({
      level: 'info',
      category: 'ui',
      message: 'Editor mode changed',
      data: { from: 'wysiwyg', to: 'raw' }
    })
    await wikiApi.log.write({
      level: 'info',
      category: 'ui',
      message: 'Split mode changed',
      data: { from: 'single', to: 'vertical' }
    })
    await wikiApi.log.write({
      level: 'info',
      category: 'ui',
      message: 'Tab closed',
      data: { paneId: 'left' }
    })
    await wikiApi.log.write({
      level: 'error',
      category: 'git',
      message: 'Git pull failed',
      data: {
        filePath: 'notes/a.md',
        content: 'SECRET_GIT_FILE'
      },
      error: serializeError(new Error('merge conflict in notes/a.md'))
    })

    const entries = await logService.readEntries()
    expect(entries).toHaveLength(6)
    expect(entries.every((entry) => entry.process === 'renderer')).toBe(true)
    expect(entries.some((entry) => entry.category === 'ipc')).toBe(false)
    expect(entries[0]?.data?.contentLength).toBe('SECRET_NOTE_BODY'.length)

    let copiedReport = ''
    const showMessageBox = vi.fn().mockResolvedValue({ response: 0 })
    const actions = createHelpMenuActions({
      logService,
      environment: {
        appVersion: '1.0.0',
        versions: { electron: '31.0.0', node: '20.11.0', chrome: '126.0.0' },
        os: { platform: 'win32', release: '10.0.22631', arch: 'x64' }
      },
      writeClipboardText: (text) => {
        copiedReport = text
      },
      showMessageBox,
      openPath: vi.fn().mockResolvedValue('')
    })

    await actions.onCopyBugReport()

    expect(copiedReport).toContain('## Recent Errors & Warnings')
    expect(copiedReport).toContain('[renderer/git] Git pull failed')
    expect(copiedReport).toContain('## Recent Activity (Breadcrumbs)')

    const expectedBreadcrumbOrder = [
      '[renderer/ui] Workspace opened',
      '[renderer/ui] Tab opened',
      '[renderer/ui] Editor mode changed',
      '[renderer/ui] Split mode changed',
      '[renderer/ui] Tab closed'
    ]
    let lastIndex = -1
    for (const marker of expectedBreadcrumbOrder) {
      const nextIndex = copiedReport.indexOf(marker)
      expect(nextIndex).toBeGreaterThan(lastIndex)
      lastIndex = nextIndex
    }

    expect(copiedReport).not.toContain('SECRET_NOTE_BODY')
    expect(copiedReport).not.toContain('SECRET_RAW_CONFIG')
    expect(copiedReport).not.toContain('SECRET_GIT_FILE')

    disposeLogIpc()
    expect(ipcHandlers.size).toBe(0)
  })
})
