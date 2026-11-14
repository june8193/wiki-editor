import type { BaseWindow, MenuItemConstructorOptions } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { MENU_IPC_CHANNELS } from '@shared/ipc'
import type { WebContentsLike } from './ipc/ipcHelpers'
import { createApplicationMenuTemplate } from './menu'

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

describe('createApplicationMenuTemplate', () => {
  it('defines File, Edit, View, Settings, and Window menus with expected items, roles, and accelerator', () => {
    const template = createApplicationMenuTemplate({
      getTargetWebContents: () => undefined
    })

    expect(template.map((item) => item.label)).toEqual([
      'File',
      'Edit',
      'View',
      'Settings',
      'Window'
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
