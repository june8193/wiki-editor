import { describe, expect, it } from 'vitest'
import {
  clampSidebarWidth,
  getLeftSidebarWidthBounds,
  LEFT_SIDEBAR_DEFAULT_WIDTH
} from './sidebarWidth'

describe('sidebarWidth', () => {
  it('calculates left sidebar default, min, and max bounds across window widths', () => {
    expect(LEFT_SIDEBAR_DEFAULT_WIDTH).toBe(260)

    expect(getLeftSidebarWidthBounds(1400)).toEqual({
      min: 180,
      max: 600,
      defaultWidth: 260
    })
    expect(getLeftSidebarWidthBounds(1200)).toEqual({
      min: 180,
      max: 600,
      defaultWidth: 260
    })
    expect(getLeftSidebarWidthBounds(1024)).toEqual({
      min: 180,
      max: 512,
      defaultWidth: 260
    })
    expect(getLeftSidebarWidthBounds(500)).toEqual({
      min: 180,
      max: 250,
      defaultWidth: 260
    })
    expect(getLeftSidebarWidthBounds(360)).toEqual({
      min: 180,
      max: 180,
      defaultWidth: 260
    })
    expect(getLeftSidebarWidthBounds(300)).toEqual({
      min: 180,
      max: 180,
      defaultWidth: 260
    })
    expect(getLeftSidebarWidthBounds(0)).toEqual({
      min: 180,
      max: 180,
      defaultWidth: 260
    })
    expect(getLeftSidebarWidthBounds(Number.NaN)).toEqual({
      min: 180,
      max: 600,
      defaultWidth: 260
    })
  })

  it('clamps left sidebar widths against window-derived bounds and handles non-finite inputs', () => {
    const standardBounds = getLeftSidebarWidthBounds(1024)
    expect(clampSidebarWidth(100, standardBounds)).toBe(180)
    expect(clampSidebarWidth(180, standardBounds)).toBe(180)
    expect(clampSidebarWidth(320, standardBounds)).toBe(320)
    expect(clampSidebarWidth(512, standardBounds)).toBe(512)
    expect(clampSidebarWidth(550, standardBounds)).toBe(512)
    expect(clampSidebarWidth(Number.NaN, standardBounds)).toBe(260)

    const wideBounds = getLeftSidebarWidthBounds(1400)
    expect(clampSidebarWidth(550, wideBounds)).toBe(550)
    expect(clampSidebarWidth(650, wideBounds)).toBe(600)

    const narrowBounds = getLeftSidebarWidthBounds(400)
    expect(clampSidebarWidth(260, narrowBounds)).toBe(200)
    expect(clampSidebarWidth(Number.POSITIVE_INFINITY, narrowBounds)).toBe(200)

    const minOnlyBounds = getLeftSidebarWidthBounds(300)
    expect(clampSidebarWidth(260, minOnlyBounds)).toBe(180)
  })

  it('clamps widths against arbitrary min/max/default bounds', () => {
    const fixedBounds = { min: 180, max: 500, defaultWidth: 240 }
    expect(clampSidebarWidth(120, fixedBounds)).toBe(180)
    expect(clampSidebarWidth(240, fixedBounds)).toBe(240)
    expect(clampSidebarWidth(620, fixedBounds)).toBe(500)
    expect(clampSidebarWidth(Number.NaN, fixedBounds)).toBe(240)
    expect(clampSidebarWidth(Number.NaN, { min: 180, max: 200, defaultWidth: 240 })).toBe(200)
  })
})
