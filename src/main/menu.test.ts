import { describe, expect, it, vi } from 'vitest'
import {
  createApplicationMenuTemplate,
  createBugReportCopiedMessageBoxOptions,
  createVersionMessageBoxOptions
} from './menu'

describe('createVersionMessageBoxOptions', () => {
  it('builds message box options with app version and runtime versions', () => {
    const options = createVersionMessageBoxOptions({
      appVersion: '1.0.0',
      versions: {
        electron: '35.0.0',
        chrome: '134.0.0.0',
        node: '22.14.0'
      }
    })

    expect(options).toEqual({
      type: 'info',
      title: 'Wiki Editor',
      message: 'Wiki Editor v1.0.0',
      detail: 'Electron: 35.0.0\nChromium: 134.0.0.0\nNode.js: 22.14.0',
      buttons: ['OK']
    })
  })

  it('falls back to unknown when runtime versions are undefined', () => {
    const options = createVersionMessageBoxOptions({
      appVersion: '1.0.0',
      versions: {}
    })

    expect(options.detail).toBe('Electron: unknown\nChromium: unknown\nNode.js: unknown')
  })
})

describe('createBugReportCopiedMessageBoxOptions', () => {
  it('builds confirmation message box options containing the active log file path', () => {
    const logFilePath = 'C:\\Users\\tester\\AppData\\Roaming\\wiki-editor\\logs\\app.jsonl'
    const options = createBugReportCopiedMessageBoxOptions({ logFilePath })

    expect(options).toEqual({
      type: 'info',
      title: 'Wiki Editor',
      message: 'Bug report copied to clipboard.',
      detail: expect.stringContaining(logFilePath),
      buttons: ['OK']
    })
  })
})

describe('createApplicationMenuTemplate', () => {
  it('creates Help menu with Copy Bug Report, Open Log Folder, and Version items invoking their callbacks', () => {
    const onCopyBugReport = vi.fn()
    const onOpenLogFolder = vi.fn()
    const onShowVersion = vi.fn()
    const template = createApplicationMenuTemplate({
      onCopyBugReport,
      onOpenLogFolder,
      onShowVersion
    })

    expect(template).toHaveLength(1)
    expect(template[0].label).toBe('Help')

    const submenu = template[0].submenu
    expect(Array.isArray(submenu)).toBe(true)
    if (!Array.isArray(submenu)) {
      throw new Error('Expected submenu to be an array')
    }

    expect(submenu.map((item) => item.label)).toEqual([
      'Copy Bug Report',
      'Open Log Folder',
      'Version'
    ])

    submenu[0].click?.(undefined as never, undefined as never, undefined as never)
    submenu[1].click?.(undefined as never, undefined as never, undefined as never)
    submenu[2].click?.(undefined as never, undefined as never, undefined as never)

    expect(onCopyBugReport).toHaveBeenCalledTimes(1)
    expect(onOpenLogFolder).toHaveBeenCalledTimes(1)
    expect(onShowVersion).toHaveBeenCalledTimes(1)
  })
})
