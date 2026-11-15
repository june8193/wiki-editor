import { describe, expect, it } from 'vitest'
import { formatWindowTitle } from '@shared/window'
import {
  clampWindowBoundsToWorkArea,
  computeCursorAuxiliaryBounds,
  computeOffsetAuxiliaryBounds,
  createAuxiliaryWindowOptions,
  createMainWindowOptions,
  isPointInsideWindowBounds,
  isPointOutsideAllWindows
} from './window'

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

describe('createAuxiliaryWindowOptions', () => {
  it('enforces 960x760 defaults, 520x420 minimums, security webPreferences, and formatted title', () => {
    const preloadPath = 'C:\\app\\out\\preload\\index.js'
    const options = createAuxiliaryWindowOptions(preloadPath, {
      bounds: { x: 140, y: 140 },
      title: formatWindowTitle('guide.md')
    })

    expect(options).toMatchObject({
      width: 960,
      height: 760,
      minWidth: 520,
      minHeight: 420,
      x: 140,
      y: 140,
      show: false,
      title: 'guide.md - Wiki Editor',
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    })
  })
})

describe('formatWindowTitle', () => {
  it('formats title with active document name or falls back to Wiki Editor', () => {
    expect(formatWindowTitle('notes.md')).toBe('notes.md - Wiki Editor')
    expect(formatWindowTitle('')).toBe('Wiki Editor')
    expect(formatWindowTitle('   ')).toBe('Wiki Editor')
    expect(formatWindowTitle(null)).toBe('Wiki Editor')
    expect(formatWindowTitle(undefined)).toBe('Wiki Editor')
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
