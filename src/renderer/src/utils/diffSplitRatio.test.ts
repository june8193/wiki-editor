import { describe, expect, it } from 'vitest'
import { DEFAULT_SPLIT_RATIO, MAX_SPLIT_RATIO, MIN_SPLIT_RATIO } from '@shared/window'
import {
  clampDiffSplitRatio,
  DIFF_GUTTER_WIDTH_PX,
  DIFF_MIN_CODE_WIDTH_PX,
  DIFF_MIN_SIDE_WIDTH_PX,
  getDiffSplitColumnWidths,
  getDiffSplitRatioBounds
} from './diffSplitRatio'

describe('diffSplitRatio', () => {
  it('exposes expected gutter and minimum side width constants', () => {
    expect(DIFF_GUTTER_WIDTH_PX).toBe(48)
    expect(DIFF_MIN_CODE_WIDTH_PX).toBe(60)
    expect(DIFF_MIN_SIDE_WIDTH_PX).toBe(108)
  })

  it('returns default [0.15, 0.85] bounds when tableWidth is omitted or non-positive', () => {
    expect(getDiffSplitRatioBounds()).toEqual({ min: MIN_SPLIT_RATIO, max: MAX_SPLIT_RATIO })
    expect(getDiffSplitRatioBounds(0)).toEqual({ min: MIN_SPLIT_RATIO, max: MAX_SPLIT_RATIO })
    expect(getDiffSplitRatioBounds(-100)).toEqual({ min: MIN_SPLIT_RATIO, max: MAX_SPLIT_RATIO })
    expect(getDiffSplitRatioBounds(Number.NaN)).toEqual({
      min: MIN_SPLIT_RATIO,
      max: MAX_SPLIT_RATIO
    })
  })

  it('locks bounds to 0.5 when tableWidth cannot fit both minimum sides', () => {
    expect(getDiffSplitRatioBounds(DIFF_MIN_SIDE_WIDTH_PX * 2)).toEqual({
      min: DEFAULT_SPLIT_RATIO,
      max: DEFAULT_SPLIT_RATIO
    })
    expect(getDiffSplitRatioBounds(180)).toEqual({
      min: DEFAULT_SPLIT_RATIO,
      max: DEFAULT_SPLIT_RATIO
    })
  })

  it('tightens bounds to guarantee minimum side width on narrow tables', () => {
    // 300px table -> minSideRatio = 108 / 300 = 0.36 (> 0.15)
    const bounds = getDiffSplitRatioBounds(300)
    expect(bounds.min).toBeCloseTo(0.36, 4)
    expect(bounds.max).toBeCloseTo(0.64, 4)
  })

  it('keeps default [0.15, 0.85] bounds on wide tables', () => {
    expect(getDiffSplitRatioBounds(1000)).toEqual({
      min: MIN_SPLIT_RATIO,
      max: MAX_SPLIT_RATIO
    })
  })

  it('clamps and rounds ratio and falls back to default for non-finite values', () => {
    expect(clampDiffSplitRatio(Number.NaN, 1000)).toBe(DEFAULT_SPLIT_RATIO)
    expect(clampDiffSplitRatio(Number.POSITIVE_INFINITY, 1000)).toBe(DEFAULT_SPLIT_RATIO)
    expect(clampDiffSplitRatio(0.05, 1000)).toBe(0.15)
    expect(clampDiffSplitRatio(0.95, 1000)).toBe(0.85)
    expect(clampDiffSplitRatio(0.1, 300)).toBe(0.36)
    expect(clampDiffSplitRatio(0.9, 300)).toBe(0.64)
    expect(clampDiffSplitRatio(0.3333333, 1000)).toBe(0.3333)
  })

  it('computes left and right code column calc widths from effectiveRatio', () => {
    expect(getDiffSplitColumnWidths(0.6, 1000)).toEqual({
      effectiveRatio: 0.6,
      leftCodeWidth: 'calc(60% - 48px)',
      rightCodeWidth: 'calc(40% - 48px)'
    })

    expect(getDiffSplitColumnWidths(0.1, 300)).toEqual({
      effectiveRatio: 0.36,
      leftCodeWidth: 'calc(36% - 48px)',
      rightCodeWidth: 'calc(64% - 48px)'
    })
  })
})
