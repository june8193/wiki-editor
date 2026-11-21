import type { BaseWindow, MenuItemConstructorOptions } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { MENU_IPC_CHANNELS } from '@shared/ipc'
import type { WebContentsLike } from './ipc/ipcHelpers'
import {
  createApplicationMenuTemplate,
  createBugReportCopiedMessageBoxOptions,
  createVersionMessageBoxOptions
} from './menu'

function getSubmenu(
  template: MenuItemConstructorOptions[],
  menuLabel: string
): MenuItemConstructorOptions[] {
  const menu = template.find((item) => item.label === menuLabel)
  if (!menu || !Array.isArray(menu.submenu)) {
    throw new Error(`Expected submenu for "${menuLabel}"`)
  }
  return menu.submenu
}

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
  it('defines File, Settings, and Help menus with expected items, roles, and accelerator', () => {
    const template = createApplicationMenuTemplate({
      getTargetWebContents: () => undefined,
      onShowVersion: () => {}
    })

    expect(template.map((item) => item.label)).toEqual(['File', 'Settings', 'Help'])

    const fileMenu = getSubmenu(template, 'File')
    expect(fileMenu.map((item) => item.label ?? item.role ?? item.type)).toEqual([
      '폴더 열기...',
      'separator',
      'quit'
    ])
    expect(fileMenu[0].accelerator).toBe('CmdOrCtrl+O')

    const settingsMenu = getSubmenu(template, 'Settings')
    expect(settingsMenu.map((item) => item.label ?? item.role ?? item.type)).toEqual([
      '설정 패널',
      '테마 전환'
    ])

    const helpMenu = getSubmenu(template, 'Help')
    expect(helpMenu.map((item) => item.label ?? item.type)).toEqual([
      '사용자 매뉴얼',
      'separator',
      'Copy Bug Report',
      'Open Log Folder',
      'Version'
    ])
    expect(helpMenu[0].accelerator).toBeUndefined()
  })

  it('creates Help menu with 사용자 매뉴얼, Copy Bug Report, Open Log Folder, and Version items invoking their callbacks', () => {
    const onCopyBugReport = vi.fn()
    const onOpenLogFolder = vi.fn()
    const onShowVersion = vi.fn()
    const template = createApplicationMenuTemplate({
      onCopyBugReport,
      onOpenLogFolder,
      onShowVersion
    })

    const helpMenu = getSubmenu(template, 'Help')
    expect(helpMenu.map((item) => item.label ?? item.type)).toEqual([
      '사용자 매뉴얼',
      'separator',
      'Copy Bug Report',
      'Open Log Folder',
      'Version'
    ])
    expect(typeof helpMenu[0].click).toBe('function')
    expect(typeof helpMenu[2].click).toBe('function')
    expect(typeof helpMenu[3].click).toBe('function')
    expect(typeof helpMenu[4].click).toBe('function')

    helpMenu[2].click?.(undefined as never, undefined as never, undefined as never)
    helpMenu[3].click?.(undefined as never, undefined as never, undefined as never)
    helpMenu[4].click?.(undefined as never, undefined as never, undefined as never)

    expect(onCopyBugReport).toHaveBeenCalledTimes(1)
    expect(onOpenLogFolder).toHaveBeenCalledTimes(1)
    expect(onShowVersion).toHaveBeenCalledTimes(1)
  })

  it('dispatches menu commands to the live target webContents and ignores missing or destroyed targets', () => {
    const sent: Array<{ channel: string; args: unknown[] }> = []
    const liveWebContents: WebContentsLike = {
      isDestroyed: () => false,
      send: (channel, ...args) => {
        sent.push({ channel, args })
      }
    }
    const getTargetWebContents = vi.fn(() => liveWebContents)
    const template = createApplicationMenuTemplate({ getTargetWebContents })

    const openFolderItem = getSubmenu(template, 'File')[0]
    const toggleThemeItem = getSubmenu(template, 'Settings')[1]
    const toggleSettingsItem = getSubmenu(template, 'Settings')[0]
    const openManualItem = getSubmenu(template, 'Help')[0]

    const fakeWindow = { id: 1 } as unknown as BaseWindow
    openFolderItem.click?.(undefined as never, fakeWindow, undefined as never)
    toggleThemeItem.click?.(undefined as never, undefined, undefined as never)
    toggleSettingsItem.click?.(undefined as never, fakeWindow, undefined as never)
    openManualItem.click?.(undefined as never, fakeWindow, undefined as never)

    expect(getTargetWebContents).toHaveBeenNthCalledWith(1, fakeWindow)
    expect(getTargetWebContents).toHaveBeenNthCalledWith(2, undefined)
    expect(getTargetWebContents).toHaveBeenNthCalledWith(3, fakeWindow)
    expect(getTargetWebContents).toHaveBeenNthCalledWith(4, fakeWindow)
    expect(sent).toEqual([
      { channel: MENU_IPC_CHANNELS.command, args: ['open-folder'] },
      { channel: MENU_IPC_CHANNELS.command, args: ['toggle-theme'] },
      { channel: MENU_IPC_CHANNELS.command, args: ['toggle-settings'] },
      { channel: MENU_IPC_CHANNELS.command, args: ['open-manual'] }
    ])

    // Destroyed or missing webContents must not throw or send
    const destroyedSend = vi.fn()
    const destroyedTemplate = createApplicationMenuTemplate({
      getTargetWebContents: () => ({
        isDestroyed: () => true,
        send: destroyedSend
      })
    })
    getSubmenu(destroyedTemplate, 'File')[0].click?.(
      undefined as never,
      undefined,
      undefined as never
    )
    expect(destroyedSend).not.toHaveBeenCalled()

    const emptyTemplate = createApplicationMenuTemplate({
      getTargetWebContents: () => undefined
    })
    expect(() =>
      getSubmenu(emptyTemplate, 'Settings')[1].click?.(
        undefined as never,
        undefined,
        undefined as never
      )
    ).not.toThrow()
  })
})
