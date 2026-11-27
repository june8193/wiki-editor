import { describe, expect, it, vi } from 'vitest'
import {
  clampWindowBoundsToWorkArea,
  computeCursorAuxiliaryBounds,
  computeOffsetAuxiliaryBounds,
  computeOffsetMainBounds,
  formatBaseWindowTitle,
  formatWindowTitle,
  getTitleBarOverlayOptions,
  isPointInsideWindowBounds,
  isPointOutsideAllWindows
} from '@shared/window'
import {
  createAuxiliaryWindowOptions,
  createMainWindowOptions,
  hardenWindowNavigation,
  registerWindowNavigationGuard
} from './window'

describe('createMainWindowOptions', () => {
  it('enforces 1280x820 defaults, 900x600 minimums, optional bounds, hidden titleBarOverlay, and secure webPreferences', () => {
    const preloadPath = 'C:\\app\\out\\preload\\index.js'
    const options = createMainWindowOptions(preloadPath, {
      appVersion: '1.9.0',
      theme: 'dark'
    })

    expect(options).toMatchObject({
      width: 1280,
      height: 820,
      minWidth: 900,
      minHeight: 600,
      show: false,
      title: 'Wiki Editor v1.9.0',
      titleBarStyle: 'hidden',
      autoHideMenuBar: true,
      titleBarOverlay: {
        color: '#21262d',
        symbolColor: '#e6edf3',
        height: 32
      },
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    })

    const offsetOptions = createMainWindowOptions(preloadPath, {
      bounds: { x: 140, y: 160, width: 1280, height: 820 }
    })
    expect(offsetOptions).toMatchObject({
      x: 140,
      y: 160,
      width: 1280,
      height: 820,
      minWidth: 900,
      minHeight: 600,
      title: 'Wiki Editor',
      titleBarStyle: 'hidden',
      autoHideMenuBar: true,
      titleBarOverlay: {
        color: '#f0f3f7',
        symbolColor: '#1f2328',
        height: 32
      }
    })
    expect(options.icon).toBeUndefined()

    const iconOptions = createMainWindowOptions(preloadPath, {
      icon: 'C:\\app\\build\\icon.png'
    })
    expect(iconOptions.icon).toBe('C:\\app\\build\\icon.png')
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

describe('createAuxiliaryWindowOptions', () => {
  it('enforces 960x760 defaults, 520x420 minimums, hidden titleBarOverlay, security webPreferences, and formatted title', () => {
    const preloadPath = 'C:\\app\\out\\preload\\index.js'
    const options = createAuxiliaryWindowOptions(preloadPath, {
      bounds: { x: 140, y: 140 },
      title: formatWindowTitle('guide.md', '1.9.0'),
      theme: 'light'
    })

    expect(options).toMatchObject({
      width: 960,
      height: 760,
      minWidth: 520,
      minHeight: 420,
      x: 140,
      y: 140,
      show: false,
      title: 'guide.md - Wiki Editor v1.9.0',
      titleBarStyle: 'hidden',
      autoHideMenuBar: true,
      titleBarOverlay: {
        color: '#f0f3f7',
        symbolColor: '#1f2328',
        height: 32
      },
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    })
    expect(options.icon).toBeUndefined()

    const iconOptions = createAuxiliaryWindowOptions(preloadPath, {
      icon: 'C:\\app\\build\\icon.png'
    })
    expect(iconOptions.icon).toBe('C:\\app\\build\\icon.png')
  })
})

describe('formatBaseWindowTitle, formatWindowTitle, and getTitleBarOverlayOptions', () => {
  it('formats base window title with optional normalized version', () => {
    expect(formatBaseWindowTitle('1.9.0')).toBe('Wiki Editor v1.9.0')
    expect(formatBaseWindowTitle('v1.9.0')).toBe('Wiki Editor v1.9.0')
    expect(formatBaseWindowTitle('  V2.0.0  ')).toBe('Wiki Editor v2.0.0')
    expect(formatBaseWindowTitle('')).toBe('Wiki Editor')
    expect(formatBaseWindowTitle('   ')).toBe('Wiki Editor')
    expect(formatBaseWindowTitle(null)).toBe('Wiki Editor')
    expect(formatBaseWindowTitle(undefined)).toBe('Wiki Editor')
  })

  it('formats title with active document name and optional version or falls back to base title', () => {
    expect(formatWindowTitle('notes.md')).toBe('notes.md - Wiki Editor')
    expect(formatWindowTitle('notes.md', '1.9.0')).toBe('notes.md - Wiki Editor v1.9.0')
    expect(formatWindowTitle(null, '1.9.0')).toBe('Wiki Editor v1.9.0')
    expect(formatWindowTitle('')).toBe('Wiki Editor')
    expect(formatWindowTitle('   ')).toBe('Wiki Editor')
    expect(formatWindowTitle(null)).toBe('Wiki Editor')
    expect(formatWindowTitle(undefined)).toBe('Wiki Editor')
  })

  it('formats title with workspace name for main and auxiliary windows', () => {
    expect(formatWindowTitle(null, '1.9.0', 'my-wiki')).toBe('my-wiki - Wiki Editor v1.9.0')
    expect(formatWindowTitle(null, null, 'my-wiki')).toBe('my-wiki - Wiki Editor')
    expect(formatWindowTitle('notes.md', '1.9.0', 'my-wiki')).toBe(
      'notes.md - my-wiki - Wiki Editor v1.9.0'
    )
    expect(formatWindowTitle('notes.md', '1.9.0', '   ')).toBe('notes.md - Wiki Editor v1.9.0')
  })

  it('returns theme-matched titleBarOverlay options', () => {
    expect(getTitleBarOverlayOptions('light')).toEqual({
      color: '#f0f3f7',
      symbolColor: '#1f2328',
      height: 32
    })
    expect(getTitleBarOverlayOptions('dark')).toEqual({
      color: '#21262d',
      symbolColor: '#e6edf3',
      height: 32
    })
  })
})

describe('computeOffsetAuxiliaryBounds and clampWindowBoundsToWorkArea', () => {
  it('offsets auxiliary window by (+40, +40) and clamps within nearest display workArea', () => {
    const fakeScreen = {
      getDisplayNearestPoint: ({ x }: { x: number; y: number }) =>
        x < 0
          ? { workArea: { x: -1920, y: 0, width: 1920, height: 1040 } }
          : { workArea: { x: 0, y: 0, width: 1920, height: 1040 } }
    }

    // Fits comfortably inside primary display workArea
    expect(
      computeOffsetAuxiliaryBounds({ x: 100, y: 120, width: 1280, height: 820 }, fakeScreen)
    ).toEqual({
      x: 140,
      y: 160,
      width: 960,
      height: 760
    })

    // Near bottom-right edge -> clamps so entire 960x760 window fits inside workArea
    expect(
      computeOffsetAuxiliaryBounds({ x: 1100, y: 400, width: 1280, height: 820 }, fakeScreen)
    ).toEqual({
      x: 960,
      y: 280,
      width: 960,
      height: 760
    })

    // Left monitor with negative coordinates -> clamps to [-1920, 0]
    expect(
      computeOffsetAuxiliaryBounds({ x: -1950, y: -30, width: 1280, height: 820 }, fakeScreen)
    ).toEqual({
      x: -1910,
      y: 10,
      width: 960,
      height: 760
    })

    // Straddling source window whose (+40, +40) offset point (-10, 140) is on left display even while center (+590) is on right display
    expect(
      computeOffsetAuxiliaryBounds({ x: -50, y: 100, width: 1280, height: 820 }, fakeScreen)
    ).toEqual({
      x: -960,
      y: 140,
      width: 960,
      height: 760
    })

    // Smaller display workArea than default 960x760 -> shrinks to fit workArea
    expect(
      clampWindowBoundsToWorkArea(
        { x: 50, y: 50, width: 960, height: 760 },
        { x: 0, y: 0, width: 800, height: 600 }
      )
    ).toEqual({
      x: 0,
      y: 0,
      width: 800,
      height: 600
    })
  })

  it('offsets new main window by (+40, +40) at 1280x820 and clamps within nearest display workArea', () => {
    const fakeScreen = {
      getDisplayNearestPoint: ({ x }: { x: number; y: number }) =>
        x < 0
          ? { workArea: { x: -1920, y: 0, width: 1920, height: 1040 } }
          : { workArea: { x: 0, y: 0, width: 1920, height: 1080 } }
    }

    expect(
      computeOffsetMainBounds({ x: 100, y: 120, width: 1280, height: 820 }, fakeScreen)
    ).toEqual({
      x: 140,
      y: 160,
      width: 1280,
      height: 820
    })

    // Near bottom-right edge -> clamped inside 1920x1080 workArea
    expect(
      computeOffsetMainBounds({ x: 800, y: 350, width: 1280, height: 820 }, fakeScreen)
    ).toEqual({
      x: 640,
      y: 260,
      width: 1280,
      height: 820
    })
  })
})

describe('computeCursorAuxiliaryBounds and window bounds hit testing', () => {
  it('places auxiliary window at drop cursor position clamped to target display workArea', () => {
    const fakeScreen = {
      getDisplayNearestPoint: ({ x }: { x: number; y: number }) =>
        x < 0
          ? { workArea: { x: -1920, y: 0, width: 1920, height: 1040 } }
          : { workArea: { x: 0, y: 0, width: 1920, height: 1040 } }
    }

    // Drop near top-left of primary monitor -> stays at cursor position
    expect(computeCursorAuxiliaryBounds({ x: 300, y: 150 }, fakeScreen)).toEqual({
      x: 300,
      y: 150,
      width: 960,
      height: 760
    })

    // Drop near bottom-right of primary monitor -> clamped inside workArea
    expect(computeCursorAuxiliaryBounds({ x: 1500, y: 600 }, fakeScreen)).toEqual({
      x: 960,
      y: 280,
      width: 960,
      height: 760
    })

    // Drop on secondary left monitor -> selects left workArea and clamps inside it
    expect(computeCursorAuxiliaryBounds({ x: -1200, y: 500 }, fakeScreen)).toEqual({
      x: -1200,
      y: 280,
      width: 960,
      height: 760
    })
  })

  it('evaluates point containment across all open window outer bounds using half-open intervals', () => {
    const mainBounds = { x: 100, y: 120, width: 1280, height: 820 }
    const auxBounds = { x: 1420, y: 120, width: 960, height: 760 }

    expect(isPointInsideWindowBounds({ x: 100, y: 120 }, mainBounds)).toBe(true)
    expect(isPointInsideWindowBounds({ x: 1379, y: 939 }, mainBounds)).toBe(true)
    expect(isPointInsideWindowBounds({ x: 1380, y: 500 }, mainBounds)).toBe(false)
    expect(isPointInsideWindowBounds({ x: 500, y: 940 }, mainBounds)).toBe(false)

    // Gap between main (ends at 1380) and aux (starts at 1420) is outside all windows
    expect(isPointOutsideAllWindows({ x: 1400, y: 300 }, [mainBounds, auxBounds])).toBe(true)
    // Inside aux window is NOT outside all windows
    expect(isPointOutsideAllWindows({ x: 1500, y: 300 }, [mainBounds, auxBounds])).toBe(false)
    // Above main window is outside all windows
    expect(isPointOutsideAllWindows({ x: 500, y: 50 }, [mainBounds, auxBounds])).toBe(true)
    // Non-finite coordinates never trigger outside-window detachment
    expect(isPointOutsideAllWindows({ x: Number.NaN, y: 50 }, [mainBounds])).toBe(false)
  })
})
