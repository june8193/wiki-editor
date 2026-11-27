import type { BrowserWindowConstructorOptions, WebPreferences } from 'electron'
import type { ThemeMode } from '@shared/config'
import {
  AUXILIARY_WINDOW_DEFAULT_HEIGHT,
  AUXILIARY_WINDOW_DEFAULT_WIDTH,
  AUXILIARY_WINDOW_MIN_HEIGHT,
  AUXILIARY_WINDOW_MIN_WIDTH,
  formatBaseWindowTitle,
  getTitleBarOverlayOptions,
  MACOS_TRAFFIC_LIGHT_POSITION,
  MAIN_WINDOW_DEFAULT_HEIGHT,
  MAIN_WINDOW_DEFAULT_WIDTH,
  MAIN_WINDOW_MIN_HEIGHT,
  MAIN_WINDOW_MIN_WIDTH,
  type WindowBounds
} from '@shared/window'

export {
  MAIN_WINDOW_DEFAULT_HEIGHT,
  MAIN_WINDOW_DEFAULT_WIDTH,
  MAIN_WINDOW_MIN_HEIGHT,
  MAIN_WINDOW_MIN_WIDTH
}

export interface MainWindowOptionsInput {
  bounds?: Partial<WindowBounds>
  icon?: string
  theme?: ThemeMode
  appVersion?: string
  platform?: NodeJS.Platform
}

export interface AuxiliaryWindowOptionsInput {
  bounds?: Partial<WindowBounds>
  title?: string
  icon?: string
  theme?: ThemeMode
  appVersion?: string
  platform?: NodeJS.Platform
}

export interface NavigationGuardedWebContents {
  on(event: 'will-navigate', listener: (event: { preventDefault: () => void }, url: string) => void): unknown
  setWindowOpenHandler(handler: (details: { url: string }) => { action: 'allow' | 'deny' }): void
}

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

function createSecureWebPreferences(preloadPath: string): WebPreferences {
  return {
    preload: preloadPath,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true
  }
}

function buildWindowOptions(
  preloadPath: string,
  defaults: { width: number; height: number; minWidth: number; minHeight: number },
  options?: {
    bounds?: Partial<WindowBounds>
    title?: string
    icon?: string
    theme?: ThemeMode
    appVersion?: string
    platform?: NodeJS.Platform
  }
): BrowserWindowConstructorOptions {
  const width = options?.bounds?.width ?? defaults.width
  const height = options?.bounds?.height ?? defaults.height
  const platform = options?.platform ?? process.platform

  return {
    width,
    height,
    minWidth: defaults.minWidth,
    minHeight: defaults.minHeight,
    ...(options?.bounds?.x !== undefined ? { x: options.bounds.x } : {}),
    ...(options?.bounds?.y !== undefined ? { y: options.bounds.y } : {}),
    ...(options?.icon ? { icon: options.icon } : {}),
    show: false,
    title: options?.title ?? formatBaseWindowTitle(options?.appVersion),
    titleBarStyle: 'hidden',
    titleBarOverlay: getTitleBarOverlayOptions(options?.theme ?? 'light'),
    ...(platform === 'darwin' ? { trafficLightPosition: MACOS_TRAFFIC_LIGHT_POSITION } : {}),
    autoHideMenuBar: true,
    webPreferences: createSecureWebPreferences(preloadPath)
  }
}

/**
 * Creates secure BrowserWindow options enforcing context isolation and disabled Node integration.
 */
export function createMainWindowOptions(
  preloadPath: string,
  options?: MainWindowOptionsInput
): BrowserWindowConstructorOptions {
  return buildWindowOptions(
    preloadPath,
    {
      width: MAIN_WINDOW_DEFAULT_WIDTH,
      height: MAIN_WINDOW_DEFAULT_HEIGHT,
      minWidth: MAIN_WINDOW_MIN_WIDTH,
      minHeight: MAIN_WINDOW_MIN_HEIGHT
    },
    options
  )
}

/**
 * Creates secure BrowserWindow options for a detached auxiliary editor window.
 */
export function createAuxiliaryWindowOptions(
  preloadPath: string,
  options?: AuxiliaryWindowOptionsInput
): BrowserWindowConstructorOptions {
  return buildWindowOptions(
    preloadPath,
    {
      width: AUXILIARY_WINDOW_DEFAULT_WIDTH,
      height: AUXILIARY_WINDOW_DEFAULT_HEIGHT,
      minWidth: AUXILIARY_WINDOW_MIN_WIDTH,
      minHeight: AUXILIARY_WINDOW_MIN_HEIGHT
    },
    options
  )
}

/**
 * Blocks renderer-initiated document navigations and popups at the Electron BrowserWindow layer.
 */
export function registerWindowNavigationGuard(webContents: NavigationGuardedWebContents): void {
  webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  webContents.on('will-navigate', (event) => {
    event.preventDefault()
  })
}
