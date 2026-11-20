import { describe, expect, it } from 'vitest'
import {
  ACCORDION_MAX_TOP_RATIO,
  ACCORDION_MIN_TOP_RATIO,
  ACCORDION_RATIO_STEP,
  ACCORDION_RESET_RATIO,
  clampSectionHeightRatio,
  computeTwoSectionLayout,
  stepSectionHeightRatio,
  toSectionHeightPercent
} from './accordionSplit'
import {
  createDefaultRightSidebarSplitState,
  RIGHT_SIDEBAR_DEFAULT_OUTLINE_RATIO,
  toggleRightSidebarOutlineCollapsed,
  toggleRightSidebarPropertiesCollapsed,
  updateRightSidebarOutlineRatio
} from './rightSidebarSplit'

describe('accordionSplit & rightSidebarSplit', () => {
  it('defines shared bounds and creates right sidebar default state with 35% outline / 65% properties', () => {
    expect(ACCORDION_MIN_TOP_RATIO).toBe(0.2)
    expect(ACCORDION_MAX_TOP_RATIO).toBe(0.8)
    expect(ACCORDION_RATIO_STEP).toBe(0.05)
    expect(ACCORDION_RESET_RATIO).toBe(0.5)
    expect(RIGHT_SIDEBAR_DEFAULT_OUTLINE_RATIO).toBe(0.35)

    expect(createDefaultRightSidebarSplitState()).toEqual({
      isOutlineCollapsed: false,
      isPropertiesCollapsed: false,
      outlineHeightRatio: 0.35
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
    const defaultState = createDefaultRightSidebarSplitState()
    expect(
      computeTwoSectionLayout(
        defaultState.isOutlineCollapsed,
        defaultState.isPropertiesCollapsed,
        defaultState.outlineHeightRatio,
        RIGHT_SIDEBAR_DEFAULT_OUTLINE_RATIO
      )
    ).toEqual({
      showTopBody: true,
      showBottomBody: true,
      showResizer: true,
      topFlexRatio: 0.35,
      bottomFlexRatio: 0.65
    })

    // Only top expanded -> resizer hidden, top takes 100% height
    expect(computeTwoSectionLayout(false, true, 0.35, RIGHT_SIDEBAR_DEFAULT_OUTLINE_RATIO)).toEqual({
      showTopBody: true,
      showBottomBody: false,
      showResizer: false,
      topFlexRatio: 1,
      bottomFlexRatio: null
    })

    // Only bottom expanded -> resizer hidden, bottom takes 100% height
    expect(computeTwoSectionLayout(true, false, 0.35, RIGHT_SIDEBAR_DEFAULT_OUTLINE_RATIO)).toEqual({
      showTopBody: false,
      showBottomBody: true,
      showResizer: false,
      topFlexRatio: null,
      bottomFlexRatio: 1
    })

    // Both collapsed -> resizer hidden, headers align at top
    expect(computeTwoSectionLayout(true, true, 0.35, RIGHT_SIDEBAR_DEFAULT_OUTLINE_RATIO)).toEqual({
      showTopBody: false,
      showBottomBody: false,
      showResizer: false,
      topFlexRatio: null,
      bottomFlexRatio: null
    })
  })

  it('updates collapse flags and clamped outline ratios while preserving ratio across collapse/expand', () => {
    const initial = createDefaultRightSidebarSplitState()
    const resized = updateRightSidebarOutlineRatio(initial, 0.65)
    expect(resized.outlineHeightRatio).toBe(0.65)
    expect(updateRightSidebarOutlineRatio(resized, 0.65)).toBe(resized)
    expect(updateRightSidebarOutlineRatio(resized, 0.99).outlineHeightRatio).toBe(0.8)
    expect(updateRightSidebarOutlineRatio(resized, 0.05).outlineHeightRatio).toBe(0.2)

    const collapsedOutline = toggleRightSidebarOutlineCollapsed(resized)
    expect(collapsedOutline).toEqual({
      isOutlineCollapsed: true,
      isPropertiesCollapsed: false,
      outlineHeightRatio: 0.65
    })
    const collapsedBoth = toggleRightSidebarPropertiesCollapsed(collapsedOutline)
    expect(collapsedBoth).toEqual({
      isOutlineCollapsed: true,
      isPropertiesCollapsed: true,
      outlineHeightRatio: 0.65
    })
    expect(toggleRightSidebarOutlineCollapsed(collapsedBoth).outlineHeightRatio).toBe(0.65)
  })
})
