import { describe, expect, it } from 'vitest'
import {
  ACCORDION_MAX_TOP_RATIO,
  ACCORDION_MIN_TOP_RATIO,
  ACCORDION_RATIO_STEP,
  ACCORDION_RESET_RATIO,
  clampSectionHeightRatio,
  computeTwoSectionLayout,
  createTwoSectionSplitState,
  stepSectionHeightRatio,
  toggleBottomSectionCollapsed,
  toggleTopSectionCollapsed,
  toSectionHeightPercent,
  updateTopSectionRatio
} from './accordionSplit'

describe('accordionSplit', () => {
  it('defines shared bounds and creates split states for 0.5 default and 0.35 right-sidebar default', () => {
    expect(ACCORDION_MIN_TOP_RATIO).toBe(0.2)
    expect(ACCORDION_MAX_TOP_RATIO).toBe(0.8)
    expect(ACCORDION_RATIO_STEP).toBe(0.05)
    expect(ACCORDION_RESET_RATIO).toBe(0.5)

    expect(createTwoSectionSplitState()).toEqual({
      isTopCollapsed: false,
      isBottomCollapsed: false,
      topHeightRatio: 0.5
    })
    expect(createTwoSectionSplitState(0.35)).toEqual({
      isTopCollapsed: false,
      isBottomCollapsed: false,
      topHeightRatio: 0.35
    })
  })

  it('clamps, steps, and converts ratio to integer percentage with fallback support', () => {
    expect(clampSectionHeightRatio(0.1)).toBe(0.2)
    expect(clampSectionHeightRatio(0.95)).toBe(0.8)
    expect(clampSectionHeightRatio(Number.NaN, 0.35)).toBe(0.35)

    expect(stepSectionHeightRatio(0.35, 0.05, 0.35)).toBe(0.4)
    expect(stepSectionHeightRatio(0.35, -0.05, 0.35)).toBe(0.3)
    expect(stepSectionHeightRatio(0.2, -0.05, 0.35)).toBe(0.2)
    expect(stepSectionHeightRatio(0.8, 0.05, 0.35)).toBe(0.8)
    expect(stepSectionHeightRatio(Number.NaN, 0.05, 0.35)).toBe(0.4)

    expect(toSectionHeightPercent(0.35, 0.35)).toBe(35)
    expect(toSectionHeightPercent(0.1, 0.35)).toBe(20)
    expect(toSectionHeightPercent(0.9, 0.35)).toBe(80)
    expect(toSectionHeightPercent(Number.NaN, 0.35)).toBe(35)
  })

  it('computes visibility, resizer presence, and flex distribution for all collapse combinations', () => {
    const defaultState = createTwoSectionSplitState(0.35)
    expect(computeTwoSectionLayout(defaultState, 0.35)).toEqual({
      showTopBody: true,
      showBottomBody: true,
      showResizer: true,
      topFlexRatio: 0.35,
      bottomFlexRatio: 0.65
    })

    // Clamps out-of-range ratios when computing expanded layout
    expect(
      computeTwoSectionLayout({ isTopCollapsed: false, isBottomCollapsed: false, topHeightRatio: 0.95 })
    ).toEqual({
      showTopBody: true,
      showBottomBody: true,
      showResizer: true,
      topFlexRatio: 0.8,
      bottomFlexRatio: 0.2
    })

    // Only top expanded -> resizer hidden, top takes 100% height
    expect(
      computeTwoSectionLayout({ isTopCollapsed: false, isBottomCollapsed: true, topHeightRatio: 0.35 }, 0.35)
    ).toEqual({
      showTopBody: true,
      showBottomBody: false,
      showResizer: false,
      topFlexRatio: 1,
      bottomFlexRatio: null
    })

    // Only bottom expanded -> resizer hidden, bottom takes 100% height
    expect(
      computeTwoSectionLayout({ isTopCollapsed: true, isBottomCollapsed: false, topHeightRatio: 0.35 }, 0.35)
    ).toEqual({
      showTopBody: false,
      showBottomBody: true,
      showResizer: false,
      topFlexRatio: null,
      bottomFlexRatio: 1
    })

    // Both collapsed -> resizer hidden, headers align at top
    expect(
      computeTwoSectionLayout({ isTopCollapsed: true, isBottomCollapsed: true, topHeightRatio: 0.35 }, 0.35)
    ).toEqual({
      showTopBody: false,
      showBottomBody: false,
      showResizer: false,
      topFlexRatio: null,
      bottomFlexRatio: null
    })
  })

  it('updates collapse flags and clamped ratios while preserving ratio across collapse/expand', () => {
    const initial = createTwoSectionSplitState(0.35)
    const resized = updateTopSectionRatio(initial, 0.65, 0.35)
    expect(resized.topHeightRatio).toBe(0.65)
    expect(updateTopSectionRatio(resized, 0.65, 0.35)).toBe(resized)
    expect(updateTopSectionRatio(resized, 0.99, 0.35).topHeightRatio).toBe(0.8)
    expect(updateTopSectionRatio(resized, 0.05, 0.35).topHeightRatio).toBe(0.2)

    const collapsedTop = toggleTopSectionCollapsed(resized)
    expect(collapsedTop).toEqual({
      isTopCollapsed: true,
      isBottomCollapsed: false,
      topHeightRatio: 0.65
    })
    expect(toggleTopSectionCollapsed(collapsedTop)).toEqual(resized)

    const collapsedBoth = toggleBottomSectionCollapsed(collapsedTop)
    expect(collapsedBoth).toEqual({
      isTopCollapsed: true,
      isBottomCollapsed: true,
      topHeightRatio: 0.65
    })
    expect(toggleTopSectionCollapsed(collapsedBoth).topHeightRatio).toBe(0.65)
  })
})
