import {
  filterTopLevelWorkspaceEntries,
  getParentPath,
  getWorkspacePathKey,
  isNestedOrSameWorkspacePath,
  isSameWorkspacePath,
  type WorkspaceEntry
} from '@shared/workspace'
import type { WorkspaceTreeState } from '../hooks/useWorkspaceTree'

/** Flattens currently visible (expanded) folder tree entries in render order. */
export function collectVisibleTreeEntries(
  entries: readonly WorkspaceEntry[],
  tree: Pick<WorkspaceTreeState, 'expandedDirs' | 'childrenByDir'>,
  acc: WorkspaceEntry[] = []
): WorkspaceEntry[] {
  for (const entry of entries) {
    acc.push(entry)
    if (entry.kind === 'directory' && tree.expandedDirs.has(entry.path)) {
      const children = tree.childrenByDir[entry.path] ?? []
      collectVisibleTreeEntries(children, tree, acc)
    }
  }
  return acc
}

/** Builds a canonical path-key lookup map over loaded workspace tree entries. */
export function buildTreeEntryMap(
  tree: Pick<WorkspaceTreeState, 'rootEntries' | 'childrenByDir'>
): Map<string, WorkspaceEntry> {
  const map = new Map<string, WorkspaceEntry>()
  const addBatch = (entries: readonly WorkspaceEntry[]): void => {
    for (const entry of entries) {
      const key = getWorkspacePathKey(entry.path)
      if (!map.has(key)) {
        map.set(key, entry)
      }
    }
  }
  addBatch(tree.rootEntries)
  for (const children of Object.values(tree.childrenByDir)) {
    addBatch(children)
  }
  return map
}

/** Resolves selected WorkspaceEntry items, keeping visible tree order first. */
export function resolveSelectedTreeEntries(
  visibleEntries: readonly WorkspaceEntry[],
  entryByKey: ReadonlyMap<string, WorkspaceEntry>,
  selectedPaths: readonly string[],
  selectedPathKeys: ReadonlySet<string>
): WorkspaceEntry[] {
  const picked: WorkspaceEntry[] = []
  const addedKeys = new Set<string>()
  for (const entry of visibleEntries) {
    const key = getWorkspacePathKey(entry.path)
    if (selectedPathKeys.has(key) && !addedKeys.has(key)) {
      addedKeys.add(key)
      picked.push(entry)
    }
  }
  for (const selectedPath of selectedPaths) {
    const key = getWorkspacePathKey(selectedPath)
    if (addedKeys.has(key)) continue
    const found = entryByKey.get(key)
    if (found) {
      addedKeys.add(key)
      picked.push(found)
    }
  }
  return picked
}

/** Resolves the target directory for dropping onto a directory row, file row, or tree root. */
export function resolveEntryDropTargetDir(entry: WorkspaceEntry | null, rootPath: string): string {
  if (!entry) return rootPath
  return entry.kind === 'directory' ? entry.path : getParentPath(entry.path, rootPath)
}

/** Returns true when `candidateDirPath` is equal to or nested inside any dragged directory. */
export function isNestedUnderAnyDraggedDir(
  candidateDirPath: string,
  topLevelDragged: readonly WorkspaceEntry[]
): boolean {
  return topLevelDragged.some(
    (item) => item.kind === 'directory' && isNestedOrSameWorkspacePath(candidateDirPath, item.path)
  )
}

/** Returns true when `draggedItems` can meaningfully move into `targetDirPath`. */
export function canDropEntriesIntoTargetDir(
  draggedItems: readonly WorkspaceEntry[],
  targetDirPath: string,
  rootPath: string
): boolean {
  if (draggedItems.length === 0) {
    return false
  }
  const topLevel = filterTopLevelWorkspaceEntries(draggedItems)
  if (isNestedUnderAnyDraggedDir(targetDirPath, topLevel)) {
    return false
  }
  return !topLevel.every((item) =>
    isSameWorkspacePath(getParentPath(item.path, rootPath), targetDirPath)
  )
}
