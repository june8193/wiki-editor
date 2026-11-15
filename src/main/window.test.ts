import { describe, expect, it, vi } from 'vitest'
import { createMainWindowOptions, hardenWindowNavigation } from './window'

describe('createMainWindowOptions', () => {
  it('enforces contextIsolation: true, nodeIntegration: false, and sandbox: true with preload path', () => {
    const preloadPath = 'C:\\app\\out\\preload\\index.js'
    const options = createMainWindowOptions(preloadPath)

    expect(options.webPreferences).toMatchObject({
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    })
  })

  it('prevents accidental file drop and external URL navigation via will-navigate', () => {
    let listener: ((event: { preventDefault: () => void }, url: string) => void) | undefined
    const fakeWebContents = {
      getURL: () => 'file:///app/out/renderer/index.html',
      on: vi.fn((eventName: string, fn: typeof listener) => {
        if (eventName === 'will-navigate') {
          listener = fn
        }
      })
    }

    hardenWindowNavigation(fakeWebContents)
    expect(fakeWebContents.on).toHaveBeenCalledWith('will-navigate', expect.any(Function))

    const droppedFileEvent = { preventDefault: vi.fn() }
    listener?.(droppedFileEvent, 'file:///C:/Users/me/Desktop/photo.png')
    expect(droppedFileEvent.preventDefault).toHaveBeenCalledTimes(1)

    const externalUrlEvent = { preventDefault: vi.fn() }
    listener?.(externalUrlEvent, 'https://example.com')
    expect(externalUrlEvent.preventDefault).toHaveBeenCalledTimes(1)

    const sameRendererEvent = { preventDefault: vi.fn() }
    listener?.(sameRendererEvent, 'file:///app/out/renderer/index.html#section')
    expect(sameRendererEvent.preventDefault).not.toHaveBeenCalled()
  })
})
