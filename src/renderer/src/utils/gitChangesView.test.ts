import { describe, expect, it } from 'vitest'
import {
  createDefaultGitChangesViewState,
  resetGitChangesTreeCollapsedDirs,
  toggleGitChangesGroupCollapsed,
  toggleGitChangesTreeDirCollapsed,
  toggleGitChangesViewMode
} from './gitChangesView'

describe('gitChangesView', () => {
  it('updates session-only Changes view state immutably and resets tree folder collapses on workspace change', () => {
    const initial = createDefaultGitChangesViewState()
    expect(initial.viewMode).toBe('list')
    expect(initial.isStagedCollapsed).toBe(false)
    expect(initial.isChangesCollapsed).toBe(false)
    expect(initial.collapsedTreeDirs.size).toBe(0)

    const inTreeMode = toggleGitChangesViewMode(initial)
    expect(inTreeMode.viewMode).toBe('tree')
    expect(toggleGitChangesViewMode(inTreeMode).viewMode).toBe('list')

    const stagedCollapsed = toggleGitChangesGroupCollapsed(inTreeMode, 'staged')
    expect(stagedCollapsed.isStagedCollapsed).toBe(true)
    expect(stagedCollapsed.isChangesCollapsed).toBe(false)

    const changesCollapsed = toggleGitChangesGroupCollapsed(stagedCollapsed, 'changes')
    expect(changesCollapsed.isStagedCollapsed).toBe(true)
    expect(changesCollapsed.isChangesCollapsed).toBe(true)

    const dirCollapsed = toggleGitChangesTreeDirCollapsed(changesCollapsed, 'changes:docs/guide')
    expect(dirCollapsed.collapsedTreeDirs.has('changes:docs/guide')).toBe(true)
    expect(initial.collapsedTreeDirs.size).toBe(0)

    const dirReopened = toggleGitChangesTreeDirCollapsed(dirCollapsed, 'changes:docs/guide')
    expect(dirReopened.collapsedTreeDirs.has('changes:docs/guide')).toBe(false)
    expect(resetGitChangesTreeCollapsedDirs(dirReopened)).toBe(dirReopened)

    const resetAfterSwitch = resetGitChangesTreeCollapsedDirs(dirCollapsed)
    expect(resetAfterSwitch.collapsedTreeDirs.size).toBe(0)
    expect(resetAfterSwitch.viewMode).toBe('tree')
    expect(resetAfterSwitch.isStagedCollapsed).toBe(true)
  })
})
