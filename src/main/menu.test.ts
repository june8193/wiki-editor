import type { BaseWindow, MenuItemConstructorOptions } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { MENU_IPC_CHANNELS } from '@shared/ipc'
import type { WebContentsLike } from './ipc/ipcHelpers'
import { createApplicationMenuTemplate, createVersionMessageBoxOptions } from './menu'

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

describe('createApplicationMenuTemplate', () => {
  it('defines File, Edit, View, Settings, Window, and Help menus with expected items, roles, and accelerator', () => {
    const template = createApplicationMenuTemplate({
      getTargetWebContents: () => undefined,
      onShowVersion: () => {}
    })

    expect(template.map((item) => item.label)).toEqual([
      'File',
      'Edit',
      'View',
      'Settings',
      'Window',
      'Help'
    ])

    const fileMenu = getSubmenu(template, 'File')
    expect(fileMenu.map((item) => item.label ?? item.role ?? item.type)).toEqual([
      '폴더 열기...',
      'separator',
      'quit'
    ])
    expect(fileMenu[0].accelerator).toBe('CmdOrCtrl+O')

    const editMenu = getSubmenu(template, 'Edit')
    expect(editMenu.map((item) => item.role ?? item.type)).toEqual([
      'undo',
      'redo',
      'separator',
      'cut',
      'copy',
      'paste',
      'selectAll'
    ])

    const viewMenu = getSubmenu(template, 'View')
    expect(viewMenu.map((item) => item.label ?? item.role ?? item.type)).toEqual([
      '테마 전환',
      'separator',
      'reload',
      'forceReload',
      'toggleDevTools',
      'separator',
      'resetZoom',
      'zoomIn',
      'zoomOut',
      'separator',
      'togglefullscreen'
    ])

    const settingsMenu = getSubmenu(template, 'Settings')
    expect(settingsMenu.map((item) => item.label)).toEqual(['설정 패널'])

    const windowMenu = getSubmenu(template, 'Window')
    expect(windowMenu.map((item) => item.role)).toEqual(['minimize', 'zoom', 'close'])

    const helpMenu = getSubmenu(template, 'Help')
    expect(helpMenu.map((item) => item.label)).toEqual(['Version'])
  })

  it('invokes onShowVersion when Help > Version is clicked', () => {
    const onShowVersion = vi.fn()
    const template = createApplicationMenuTemplate({ onShowVersion })

    const helpMenu = getSubmenu(template, 'Help')
    expect(typeof helpMenu[0].click).toBe('function')

    helpMenu[0].click?.(undefined as never, undefined as never, undefined as never)

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
    const toggleThemeItem = getSubmenu(template, 'View')[0]
    const toggleSettingsItem = getSubmenu(template, 'Settings')[0]

    const fakeWindow = { id: 1 } as unknown as BaseWindow
    openFolderItem.click?.(undefined as never, fakeWindow, undefined as never)
    toggleThemeItem.click?.(undefined as never, undefined, undefined as never)
    toggleSettingsItem.click?.(undefined as never, fakeWindow, undefined as never)

    expect(getTargetWebContents).toHaveBeenNthCalledWith(1, fakeWindow)
    expect(getTargetWebContents).toHaveBeenNthCalledWith(2, undefined)
    expect(getTargetWebContents).toHaveBeenNthCalledWith(3, fakeWindow)
    expect(sent).toEqual([
      { channel: MENU_IPC_CHANNELS.command, args: ['open-folder'] },
      { channel: MENU_IPC_CHANNELS.command, args: ['toggle-theme'] },
      { channel: MENU_IPC_CHANNELS.command, args: ['toggle-settings'] }
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
      getSubmenu(emptyTemplate, 'View')[0].click?.(undefined as never, undefined, undefined as never)
    ).not.toThrow()
  })
})
