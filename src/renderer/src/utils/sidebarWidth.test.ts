import { describe, expect, it } from 'vitest'
import {
  clampLeftSidebarWidth,
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

  it('clamps left sidebar widths to [180, min(600, windowWidth * 0.5)] and handles non-finite inputs', () => {
    expect(clampLeftSidebarWidth(100, 1024)).toBe(180)
    expect(clampLeftSidebarWidth(180, 1024)).toBe(180)
    expect(clampLeftSidebarWidth(320, 1024)).toBe(320)
    expect(clampLeftSidebarWidth(512, 1024)).toBe(512)
    expect(clampLeftSidebarWidth(550, 1024)).toBe(512)

    expect(clampLeftSidebarWidth(550, 1400)).toBe(550)
    expect(clampLeftSidebarWidth(650, 1400)).toBe(600)

    expect(clampLeftSidebarWidth(260, 400)).toBe(200)
    expect(clampLeftSidebarWidth(260, 300)).toBe(180)

    expect(clampLeftSidebarWidth(Number.NaN, 1024)).toBe(260)
    expect(clampLeftSidebarWidth(Number.POSITIVE_INFINITY, 400)).toBe(200)
  })

  it('clamps generic sidebar widths against arbitrary min/max limits', () => {
    expect(clampSidebarWidth(120, 180, 500, 240)).toBe(180)
    expect(clampSidebarWidth(240, 180, 500, 240)).toBe(240)
    expect(clampSidebarWidth(620, 180, 500, 240)).toBe(500)
    expect(clampSidebarWidth(Number.NaN, 180, 500, 240)).toBe(240)
    expect(clampSidebarWidth(Number.NaN, 180, 200, 240)).toBe(200)
  })
})
