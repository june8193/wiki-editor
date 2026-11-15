import type { BrowserWindowConstructorOptions, Rectangle, WebPreferences } from 'electron'
import { WINDOW_BASE_TITLE } from '@shared/window'

export const MAIN_WINDOW_DEFAULT_WIDTH = 1280
export const MAIN_WINDOW_DEFAULT_HEIGHT = 820
export const MAIN_WINDOW_MIN_WIDTH = 800
export const MAIN_WINDOW_MIN_HEIGHT = 560

export const AUXILIARY_WINDOW_DEFAULT_WIDTH = 960
export const AUXILIARY_WINDOW_DEFAULT_HEIGHT = 760
export const AUXILIARY_WINDOW_MIN_WIDTH = 520
export const AUXILIARY_WINDOW_MIN_HEIGHT = 420
export const AUXILIARY_WINDOW_OFFSET_X = 40
export const AUXILIARY_WINDOW_OFFSET_Y = 40

export interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface ScreenLike {
  getDisplayNearestPoint: (point: { x: number; y: number }) => { workArea: Rectangle }
}

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
 * Clamps candidate window bounds so the entire window stays inside the target display workArea.
 */
export function clampWindowBoundsToWorkArea(
  bounds: WindowBounds,
  workArea: Rectangle
): WindowBounds {
  const width = Math.min(bounds.width, workArea.width)
  const height = Math.min(bounds.height, workArea.height)
  const maxX = workArea.x + workArea.width - width
  const maxY = workArea.y + workArea.height - height

  return {
    x: Math.min(Math.max(bounds.x, workArea.x), maxX),
    y: Math.min(Math.max(bounds.y, workArea.y), maxY),
    width,
    height
  }
}

/**
 * Computes auxiliary window bounds offset by (+40, +40) from source window and clamped to display workArea.
 */
export function computeOffsetAuxiliaryBounds(
  sourceBounds: WindowBounds,
  screenLike?: ScreenLike
): WindowBounds {
  const candidate: WindowBounds = {
    x: sourceBounds.x + AUXILIARY_WINDOW_OFFSET_X,
    y: sourceBounds.y + AUXILIARY_WINDOW_OFFSET_Y,
    width: AUXILIARY_WINDOW_DEFAULT_WIDTH,
    height: AUXILIARY_WINDOW_DEFAULT_HEIGHT
  }

  if (!screenLike) {
    return candidate
  }

  const offsetPoint = {
    x: Math.round(candidate.x),
    y: Math.round(candidate.y)
  }
  const { workArea } = screenLike.getDisplayNearestPoint(offsetPoint)
  return clampWindowBoundsToWorkArea(candidate, workArea)
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
