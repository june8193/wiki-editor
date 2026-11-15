import { describe, expect, it, vi } from 'vitest'
import { createMainWindowOptions, registerWindowNavigationGuard } from './window'

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
})

describe('registerWindowNavigationGuard', () => {
  it('blocks window navigation and denies new-window requests unconditionally', () => {
    let willNavigateHandler: ((event: { preventDefault: () => void }, url: string) => void) | undefined
    let windowOpenHandler: ((details: { url: string }) => { action: 'allow' | 'deny' }) | undefined

    const mockWebContents = {
      on(event: 'will-navigate', listener: (event: { preventDefault: () => void }, url: string) => void) {
        if (event === 'will-navigate') {
          willNavigateHandler = listener
        }
      },
      setWindowOpenHandler(handler: (details: { url: string }) => { action: 'allow' | 'deny' }) {
        windowOpenHandler = handler
      }
    }

    registerWindowNavigationGuard(mockWebContents)

    expect(willNavigateHandler).toBeDefined()
    expect(windowOpenHandler).toBeDefined()

    for (const targetUrl of [
      'https://example.com',
      'file:///C:/wiki/other.md',
      'http://localhost:5173/other.md'
    ]) {
      const preventDefault = vi.fn()
      willNavigateHandler!({ preventDefault }, targetUrl)
      expect(preventDefault).toHaveBeenCalledTimes(1)
      expect(windowOpenHandler!({ url: targetUrl })).toEqual({ action: 'deny' })
    }
  })
})
