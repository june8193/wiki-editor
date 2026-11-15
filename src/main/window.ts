import type { BrowserWindowConstructorOptions, WebPreferences } from 'electron'
import {
  AUXILIARY_WINDOW_DEFAULT_HEIGHT,
  AUXILIARY_WINDOW_DEFAULT_WIDTH,
  AUXILIARY_WINDOW_MIN_HEIGHT,
  AUXILIARY_WINDOW_MIN_WIDTH,
  AUXILIARY_WINDOW_OFFSET_X,
  AUXILIARY_WINDOW_OFFSET_Y,
  clampWindowBoundsToWorkArea,
  computeCursorAuxiliaryBounds,
  computeOffsetAuxiliaryBounds,
  isPointInsideWindowBounds,
  isPointOutsideAllWindows,
  type ScreenLike,
  type ScreenPoint,
  WINDOW_BASE_TITLE,
  type WindowBounds
} from '@shared/window'

export {
  AUXILIARY_WINDOW_DEFAULT_HEIGHT,
  AUXILIARY_WINDOW_DEFAULT_WIDTH,
  AUXILIARY_WINDOW_MIN_HEIGHT,
  AUXILIARY_WINDOW_MIN_WIDTH,
  AUXILIARY_WINDOW_OFFSET_X,
  AUXILIARY_WINDOW_OFFSET_Y,
  clampWindowBoundsToWorkArea,
  computeCursorAuxiliaryBounds,
  computeOffsetAuxiliaryBounds,
  isPointInsideWindowBounds,
  isPointOutsideAllWindows,
  type ScreenLike,
  type ScreenPoint,
  type WindowBounds
}

export const MAIN_WINDOW_DEFAULT_WIDTH = 1280
export const MAIN_WINDOW_DEFAULT_HEIGHT = 820
export const MAIN_WINDOW_MIN_WIDTH = 800
export const MAIN_WINDOW_MIN_HEIGHT = 560

export interface AuxiliaryWindowOptionsInput {
  bounds?: Partial<WindowBounds>
  title?: string
}

function createSecureWebPreferences(preloadPath: string): WebPreferences {
  return {
    preload: preloadPath,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true
  }
}

/**
 * Creates secure BrowserWindow options enforcing context isolation and disabled Node integration.
 */
export function createMainWindowOptions(preloadPath: string): BrowserWindowConstructorOptions {
  return {
    width: MAIN_WINDOW_DEFAULT_WIDTH,
    height: MAIN_WINDOW_DEFAULT_HEIGHT,
    minWidth: MAIN_WINDOW_MIN_WIDTH,
    minHeight: MAIN_WINDOW_MIN_HEIGHT,
    show: false,
    title: WINDOW_BASE_TITLE,
    webPreferences: createSecureWebPreferences(preloadPath)
  }
}

/**
 * Creates secure BrowserWindow options for a detached auxiliary editor window.
 */
export function createAuxiliaryWindowOptions(
  preloadPath: string,
  options?: AuxiliaryWindowOptionsInput
): BrowserWindowConstructorOptions {
  const width = options?.bounds?.width ?? AUXILIARY_WINDOW_DEFAULT_WIDTH
  const height = options?.bounds?.height ?? AUXILIARY_WINDOW_DEFAULT_HEIGHT

  return {
    width,
    height,
    minWidth: AUXILIARY_WINDOW_MIN_WIDTH,
    minHeight: AUXILIARY_WINDOW_MIN_HEIGHT,
    ...(options?.bounds?.x !== undefined ? { x: options.bounds.x } : {}),
    ...(options?.bounds?.y !== undefined ? { y: options.bounds.y } : {}),
    show: false,
    title: options?.title ?? WINDOW_BASE_TITLE,
    webPreferences: createSecureWebPreferences(preloadPath)
  }
}
