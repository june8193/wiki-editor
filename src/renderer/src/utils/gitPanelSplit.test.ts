import { describe, expect, it } from 'vitest'
import {
  computeGitSectionLayout,
  createDefaultGitPanelSplitState,
  GIT_PANEL_DEFAULT_CHANGES_RATIO,
  toggleGitChangesCollapsed,
  toggleGitGraphCollapsed,
  updateChangesHeightRatio
} from './gitPanelSplit'

describe('gitPanelSplit', () => {
  it('creates default split state with both sections expanded at 50% ratio', () => {
    expect(GIT_PANEL_DEFAULT_CHANGES_RATIO).toBe(0.5)

    expect(createDefaultGitPanelSplitState()).toEqual({
      isChangesCollapsed: false,
      isGraphCollapsed: false,
      changesHeightRatio: 0.5
    })
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

  it('provides pure state updaters for accordion toggles and clamped height ratio updates', () => {
    const initial = createDefaultGitPanelSplitState()
    const changesCollapsed = toggleGitChangesCollapsed(initial)
    expect(changesCollapsed).toEqual({
      isChangesCollapsed: true,
      isGraphCollapsed: false,
      changesHeightRatio: 0.5
    })
    expect(toggleGitChangesCollapsed(changesCollapsed)).toEqual(initial)

    const graphCollapsed = toggleGitGraphCollapsed(changesCollapsed)
    expect(graphCollapsed).toEqual({
      isChangesCollapsed: true,
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
