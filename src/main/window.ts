import type { BrowserWindowConstructorOptions } from 'electron'

export interface NavigationWebContentsLike {
  getURL(): string
  on(
    event: 'will-navigate',
    listener: (event: { preventDefault: () => void }, url: string) => void
  ): void
}

function isAllowedWindowNavigation(currentUrl: string, targetUrl: string): boolean {
  let target: URL
  try {
    target = new URL(targetUrl)
  } catch {
    return false
  }

  if (!currentUrl) {
    return target.protocol === 'file:' || target.protocol === 'http:' || target.protocol === 'https:'
  }

  let current: URL
  try {
    current = new URL(currentUrl)
  } catch {
    return false
  }

  if (current.protocol === 'file:' && target.protocol === 'file:') {
    return target.pathname.toLowerCase() === current.pathname.toLowerCase()
  }

  if (
    (current.protocol === 'http:' || current.protocol === 'https:') &&
    current.protocol === target.protocol
  ) {
    return target.origin === current.origin
  }

  return false
}

/**
 * Blocks accidental file drops or external URL navigations inside the application window.
 */
export function hardenWindowNavigation(webContents: NavigationWebContentsLike): void {
  webContents.on('will-navigate', (event, url) => {
    if (!isAllowedWindowNavigation(webContents.getURL(), url)) {
      event.preventDefault()
    }
  })
}

/**
 * Creates secure BrowserWindow options enforcing context isolation and disabled Node integration.
 */
export function createMainWindowOptions(preloadPath: string): BrowserWindowConstructorOptions {
  return {
    width: 1280,
    height: 820,
    minWidth: 800,
    minHeight: 560,
    show: false,
    title: 'Wiki Editor',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  }
}
