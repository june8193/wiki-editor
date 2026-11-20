import { describe, expect, it } from 'vitest'
import {
  clampChangesHeightRatio,
  computeGitSectionLayout,
  createDefaultGitPanelSplitState,
  GIT_PANEL_CHANGES_RATIO_STEP,
  GIT_PANEL_DEFAULT_CHANGES_RATIO,
  GIT_PANEL_MAX_CHANGES_RATIO,
  GIT_PANEL_MIN_CHANGES_RATIO,
  resetGitStashesCollapsed,
  setGitStashesCollapsed,
  stepChangesHeightRatio,
  toChangesHeightPercent,
  toggleGitChangesCollapsed,
  toggleGitGraphCollapsed,
  toggleGitStashesCollapsed,
  updateChangesHeightRatio
} from './gitPanelSplit'

describe('gitPanelSplit', () => {
  it('creates default split state with Changes/Graph expanded at 50% ratio and Stashes collapsed', () => {
    expect(GIT_PANEL_DEFAULT_CHANGES_RATIO).toBe(0.5)
    expect(GIT_PANEL_MIN_CHANGES_RATIO).toBe(0.2)
    expect(GIT_PANEL_MAX_CHANGES_RATIO).toBe(0.8)
    expect(GIT_PANEL_CHANGES_RATIO_STEP).toBe(0.05)

    expect(createDefaultGitPanelSplitState()).toEqual({
      isChangesCollapsed: false,
      isStashesCollapsed: true,
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

  it('computes section visibility, resizer presence, Stashes compact/fill mode, and flex distribution for all collapse combinations', () => {
    expect(
      computeGitSectionLayout({
        isChangesCollapsed: false,
        isStashesCollapsed: true,
        isGraphCollapsed: false,
        changesHeightRatio: 0.65
      })
    ).toEqual({
      showChangesBody: true,
      showStashesBody: false,
      showGraphBody: true,
      showResizer: true,
      changesFlexRatio: 0.65,
      stashesFlexRatio: null,
      stashesBodyMode: 'hidden',
      graphFlexRatio: 0.35
    })

    // Clamps out-of-range ratios when computing expanded layout, Stashes uses compact mode when both neighbors expanded
    expect(
      computeGitSectionLayout({
        isChangesCollapsed: false,
        isStashesCollapsed: false,
        isGraphCollapsed: false,
        changesHeightRatio: 0.95
      })
    ).toEqual({
      showChangesBody: true,
      showStashesBody: true,
      showGraphBody: true,
      showResizer: true,
      changesFlexRatio: 0.8,
      stashesFlexRatio: null,
      stashesBodyMode: 'compact',
      graphFlexRatio: 0.2
    })

    // Only Changes expanded + Stashes expanded -> resizer hidden, Changes takes 100% remaining, Stashes compact
    expect(
      computeGitSectionLayout({
        isChangesCollapsed: false,
        isStashesCollapsed: false,
        isGraphCollapsed: true,
        changesHeightRatio: 0.35
      })
    ).toEqual({
      showChangesBody: true,
      showStashesBody: true,
      showGraphBody: false,
      showResizer: false,
      changesFlexRatio: 1,
      stashesFlexRatio: null,
      stashesBodyMode: 'compact',
      graphFlexRatio: null
    })

    // Only Graph expanded + Stashes expanded -> resizer hidden, Graph takes 100% remaining, Stashes compact
    expect(
      computeGitSectionLayout({
        isChangesCollapsed: true,
        isStashesCollapsed: false,
        isGraphCollapsed: false,
        changesHeightRatio: 0.35
      })
    ).toEqual({
      showChangesBody: false,
      showStashesBody: true,
      showGraphBody: true,
      showResizer: false,
      changesFlexRatio: null,
      stashesFlexRatio: null,
      stashesBodyMode: 'compact',
      graphFlexRatio: 1
    })

    // Both Changes and Graph collapsed + Stashes expanded -> Stashes fills remaining space (flex: 1)
    expect(
      computeGitSectionLayout({
        isChangesCollapsed: true,
        isStashesCollapsed: false,
        isGraphCollapsed: true,
        changesHeightRatio: 0.35
      })
    ).toEqual({
      showChangesBody: false,
      showStashesBody: true,
      showGraphBody: false,
      showResizer: false,
      changesFlexRatio: null,
      stashesFlexRatio: 1,
      stashesBodyMode: 'fill',
      graphFlexRatio: null
    })

    // All three collapsed -> resizer hidden, all sections collapse to header only
    expect(
      computeGitSectionLayout({
        isChangesCollapsed: true,
        isStashesCollapsed: true,
        isGraphCollapsed: true,
        changesHeightRatio: 0.35
      })
    ).toEqual({
      showChangesBody: false,
      showStashesBody: false,
      showGraphBody: false,
      showResizer: false,
      changesFlexRatio: null,
      stashesFlexRatio: null,
      stashesBodyMode: 'hidden',
      graphFlexRatio: null
    })
  })

  it('provides pure state updaters for accordion toggles, stash expand/reset, and clamped height ratio updates', () => {
    const initial = createDefaultGitPanelSplitState()
    const changesCollapsed = toggleGitChangesCollapsed(initial)
    expect(changesCollapsed).toEqual({
      isChangesCollapsed: true,
      isStashesCollapsed: true,
      isGraphCollapsed: false,
      changesHeightRatio: 0.5
    })
    expect(toggleGitChangesCollapsed(changesCollapsed)).toEqual(initial)

    const stashesExpanded = toggleGitStashesCollapsed(changesCollapsed)
    expect(stashesExpanded).toEqual({
      isChangesCollapsed: true,
      isStashesCollapsed: false,
      isGraphCollapsed: false,
      changesHeightRatio: 0.5
    })
    expect(setGitStashesCollapsed(stashesExpanded, false)).toBe(stashesExpanded)
    expect(setGitStashesCollapsed(initial, false).isStashesCollapsed).toBe(false)
    expect(resetGitStashesCollapsed(initial)).toBe(initial)
    expect(resetGitStashesCollapsed(stashesExpanded).isStashesCollapsed).toBe(true)

    const graphCollapsed = toggleGitGraphCollapsed(changesCollapsed)
    expect(graphCollapsed).toEqual({
      isChangesCollapsed: true,
      isStashesCollapsed: true,
      isGraphCollapsed: true,
      changesHeightRatio: 0.5
    })

    const resized = updateChangesHeightRatio(initial, 0.7)
    expect(resized.changesHeightRatio).toBe(0.7)
    expect(updateChangesHeightRatio(resized, 0.7)).toBe(resized)
    expect(updateChangesHeightRatio(resized, 0.99).changesHeightRatio).toBe(0.8)
    expect(updateChangesHeightRatio(resized, 0.05).changesHeightRatio).toBe(0.2)
  })
})
