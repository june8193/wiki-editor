export type GitChangesViewMode = 'list' | 'tree'
export type GitChangesGroupKey = 'staged' | 'changes'

export interface GitChangesViewState {
  viewMode: GitChangesViewMode
  isStagedCollapsed: boolean
  isChangesCollapsed: boolean
  collapsedTreeDirs: ReadonlySet<string>
}

/**
 * Creates the default session-only view state for the Changes section.
 */
export function createDefaultGitChangesViewState(): GitChangesViewState {
  return {
    viewMode: 'list',
    isStagedCollapsed: false,
    isChangesCollapsed: false,
    collapsedTreeDirs: new Set()
  }
}

/**
 * Toggles the Changes file display mode between flat list and compressed tree.
 */
export function toggleGitChangesViewMode(state: GitChangesViewState): GitChangesViewState {
  return {
    ...state,
    viewMode: state.viewMode === 'list' ? 'tree' : 'list'
  }
}

/**
 * Toggles the collapsed state of either the `Staged Changes` or `Changes` subgroup.
 */
export function toggleGitChangesGroupCollapsed(
  state: GitChangesViewState,
  group: GitChangesGroupKey
): GitChangesViewState {
  return group === 'staged'
    ? { ...state, isStagedCollapsed: !state.isStagedCollapsed }
    : { ...state, isChangesCollapsed: !state.isChangesCollapsed }
}

/**
 * Toggles the collapsed state of a compressed folder node inside the Changes tree view.
 */
export function toggleGitChangesTreeDirCollapsed(
  state: GitChangesViewState,
  dirKey: string
): GitChangesViewState {
  const next = new Set(state.collapsedTreeDirs)
  if (next.has(dirKey)) {
    next.delete(dirKey)
  } else {
    next.add(dirKey)
  }
  return {
    ...state,
    collapsedTreeDirs: next
  }
}

/**
 * Clears all collapsed tree directory entries on workspace switch while preserving reference equality on no-ops.
 */
export function resetGitChangesTreeCollapsedDirs(
  state: GitChangesViewState
): GitChangesViewState {
  if (state.collapsedTreeDirs.size === 0) {
    return state
  }
  return {
    ...state,
    collapsedTreeDirs: new Set()
  }
}
