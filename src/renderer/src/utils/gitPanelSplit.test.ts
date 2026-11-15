import { describe, expect, it } from 'vitest'
import {
  clampChangesHeightRatio,
  computeGitSectionLayout,
  createDefaultGitPanelSplitState,
  GIT_PANEL_CHANGES_RATIO_STEP,
  GIT_PANEL_DEFAULT_CHANGES_RATIO,
  GIT_PANEL_MAX_CHANGES_RATIO,
  GIT_PANEL_MIN_CHANGES_RATIO,
  stepChangesHeightRatio,
  toChangesHeightPercent
} from './gitPanelSplit'

describe('gitPanelSplit', () => {
  it('creates default split state with both sections expanded at 50% ratio', () => {
    expect(GIT_PANEL_DEFAULT_CHANGES_RATIO).toBe(0.5)
    expect(GIT_PANEL_MIN_CHANGES_RATIO).toBe(0.2)
    expect(GIT_PANEL_MAX_CHANGES_RATIO).toBe(0.8)
    expect(GIT_PANEL_CHANGES_RATIO_STEP).toBe(0.05)

    expect(createDefaultGitPanelSplitState()).toEqual({
      isChangesCollapsed: false,
      isGraphCollapsed: false,
      changesHeightRatio: 0.5
    })
  })

  it('clamps changes height ratio to [0.2, 0.8] and falls back to 0.5 for non-finite values', () => {
    expect(clampChangesHeightRatio(0)).toBe(0.2)
    expect(clampChangesHeightRatio(-0.5)).toBe(0.2)
    expect(clampChangesHeightRatio(0.1999)).toBe(0.2)
    expect(clampChangesHeightRatio(0.2)).toBe(0.2)
    expect(clampChangesHeightRatio(0.35)).toBe(0.35)
    expect(clampChangesHeightRatio(0.5)).toBe(0.5)
    expect(clampChangesHeightRatio(0.8)).toBe(0.8)
    expect(clampChangesHeightRatio(0.8001)).toBe(0.8)
    expect(clampChangesHeightRatio(1.5)).toBe(0.8)

    expect(clampChangesHeightRatio(Number.NaN)).toBe(0.5)
    expect(clampChangesHeightRatio(Number.POSITIVE_INFINITY)).toBe(0.5)
    expect(clampChangesHeightRatio(Number.NEGATIVE_INFINITY)).toBe(0.5)
  })

  it('steps ratio cleanly within [0.2, 0.8] and converts to integer percentage [20, 80]', () => {
    expect(stepChangesHeightRatio(0.5, 0.05)).toBe(0.55)
    expect(stepChangesHeightRatio(0.55, -0.05)).toBe(0.5)
    expect(stepChangesHeightRatio(0.3, 0.05)).toBe(0.35)
    expect(stepChangesHeightRatio(0.22, -0.05)).toBe(0.2)
    expect(stepChangesHeightRatio(0.78, 0.05)).toBe(0.8)
    expect(stepChangesHeightRatio(Number.NaN, 0.05)).toBe(0.55)

    expect(toChangesHeightPercent(0.1)).toBe(20)
    expect(toChangesHeightPercent(0.5)).toBe(50)
    expect(toChangesHeightPercent(0.654)).toBe(65)
    expect(toChangesHeightPercent(0.95)).toBe(80)
    expect(toChangesHeightPercent(Number.NaN)).toBe(50)
  })

  it('computes section visibility, resizer presence, and flex distribution for all collapse combinations', () => {
    expect(
      computeGitSectionLayout({
        isChangesCollapsed: false,
        isGraphCollapsed: false,
        changesHeightRatio: 0.65
      })
    ).toEqual({
      showChangesBody: true,
      showGraphBody: true,
      showResizer: true,
      changesFlexRatio: 0.65,
      graphFlexRatio: 0.35
    })

    // Clamps out-of-range ratios when computing expanded layout
    expect(
      computeGitSectionLayout({
        isChangesCollapsed: false,
        isGraphCollapsed: false,
        changesHeightRatio: 0.95
      })
    ).toEqual({
      showChangesBody: true,
      showGraphBody: true,
      showResizer: true,
      changesFlexRatio: 0.8,
      graphFlexRatio: 0.2
    })

    // Only Changes expanded -> resizer hidden, Changes takes 100% remaining height
    expect(
      computeGitSectionLayout({
        isChangesCollapsed: false,
        isGraphCollapsed: true,
        changesHeightRatio: 0.35
      })
    ).toEqual({
      showChangesBody: true,
      showGraphBody: false,
      showResizer: false,
      changesFlexRatio: 1,
      graphFlexRatio: null
    })

    // Only Graph expanded -> resizer hidden, Graph takes 100% remaining height
    expect(
      computeGitSectionLayout({
        isChangesCollapsed: true,
        isGraphCollapsed: false,
        changesHeightRatio: 0.35
      })
    ).toEqual({
      showChangesBody: false,
      showGraphBody: true,
      showResizer: false,
      changesFlexRatio: null,
      graphFlexRatio: 1
    })

    // Both collapsed -> resizer hidden, both sections collapse to header only
    expect(
      computeGitSectionLayout({
        isChangesCollapsed: true,
        isGraphCollapsed: true,
        changesHeightRatio: 0.35
      })
    ).toEqual({
      showChangesBody: false,
      showGraphBody: false,
      showResizer: false,
      changesFlexRatio: null,
      graphFlexRatio: null
    })
  })
})
