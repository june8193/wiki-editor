import { describe, expect, it, vi } from 'vitest'
import { createApplicationMenuTemplate, createVersionMessageBoxOptions } from './menu'

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
  it('creates Help menu with Version item that invokes onShowVersion on click', () => {
    const onShowVersion = vi.fn()
    const template = createApplicationMenuTemplate({ onShowVersion })

    expect(template).toHaveLength(1)
    expect(template[0].label).toBe('Help')

    const submenu = template[0].submenu
    expect(Array.isArray(submenu)).toBe(true)
    if (!Array.isArray(submenu)) {
      throw new Error('Expected submenu to be an array')
    }

    expect(submenu).toHaveLength(1)
    expect(submenu[0].label).toBe('Version')
    expect(typeof submenu[0].click).toBe('function')

    submenu[0].click?.(
      undefined as never,
      undefined as never,
      undefined as never
    )

    expect(onShowVersion).toHaveBeenCalledTimes(1)
  })
})
