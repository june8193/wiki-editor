import { describe, expect, it } from 'vitest'
import {
  clampTerminalHeight,
  getTerminalHeightBounds,
  TERMINAL_DEFAULT_HEIGHT,
  TERMINAL_MIN_HEIGHT
} from './terminalHeight'

describe('terminalHeight', () => {
  it('computes height bounds from window height with a safe minimum and default', () => {
    const bounds = getTerminalHeightBounds(800)
    expect(bounds.min).toBe(TERMINAL_MIN_HEIGHT)
    expect(bounds.defaultHeight).toBe(TERMINAL_DEFAULT_HEIGHT)
    expect(bounds.max).toBe(560)
  })

  it('clamps non-finite, too-small, and too-large heights into [min, max]', () => {
    const bounds = { min: 120, max: 480, defaultHeight: 240 }
    expect(clampTerminalHeight(Number.NaN, bounds)).toBe(240)
    expect(clampTerminalHeight(40, bounds)).toBe(120)
    expect(clampTerminalHeight(900, bounds)).toBe(480)
    expect(clampTerminalHeight(300, bounds)).toBe(300)
  })
})
