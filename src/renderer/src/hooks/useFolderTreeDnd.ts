import { DragEvent as ReactDragEvent, useCallback, useEffect, useRef, useState } from 'react'
import { isSupportedImageFile } from '@shared/assets'
import {
  filterTopLevelWorkspaceEntries,
  getWorkspacePathKey,
  isSameWorkspacePath,
  type WorkspaceEntry,
  type WorkspaceSummary
} from '@shared/workspace'
import {
  formatWorkspaceDragPaths,
  parseWorkspaceDragPaths,
  WORKSPACE_ENTRY_DRAG_MIME,
  WORKSPACE_IMAGE_DRAG_MIME
} from '../utils/dragMimeTypes'
import {
  canDropEntriesIntoTargetDir,
  isNestedUnderAnyDraggedDir,
  resolveEntryDropTargetDir
} from '../utils/folderTree'

const AUTO_EXPAND_HOVER_DELAY_MS = 500

interface UseFolderTreeDndOptions {
  workspace: WorkspaceSummary | null
  expandedDirs: ReadonlySet<string>
  entryByKey: ReadonlyMap<string, WorkspaceEntry>
  isPathSelected: (entryPath: string) => boolean
  resolveActionTargets: (entry: WorkspaceEntry) => readonly WorkspaceEntry[]
  onSelectPath: (path: string | null) => void
  onEnsureExpanded: (dirPath: string) => Promise<void>
  onMoveEntries: (sourcePaths: readonly string[], targetDirPath: string) => Promise<void>
  onDragStartWorkspaceImages?: (filePaths: readonly string[]) => void
  onDragEndWorkspaceImage?: () => void
}

/**
 * Manages HTML5 drag-and-drop entry move state, drop-target highlighting, and 500ms folder auto-expand.
 */
export function useFolderTreeDnd({
  workspace,
  expandedDirs,
  entryByKey,
  isPathSelected,
  resolveActionTargets,
  onSelectPath,
  onEnsureExpanded,
  onMoveEntries,
  onDragStartWorkspaceImages,
  onDragEndWorkspaceImage
}: UseFolderTreeDndOptions) {
  const [dropTargetDirPath, setDropTargetDirPath] = useState<string | null>(null)
  const draggingEntriesRef = useRef<readonly WorkspaceEntry[]>([])
  const autoExpandTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingAutoExpandDirRef = useRef<string | null>(null)

  const clearAutoExpandTimer = useCallback((): void => {
    if (autoExpandTimerRef.current !== null) {
      clearTimeout(autoExpandTimerRef.current)
      autoExpandTimerRef.current = null
    }
    pendingAutoExpandDirRef.current = null
  }, [])

  const clearDragState = useCallback((): void => {
    clearAutoExpandTimer()
    draggingEntriesRef.current = []
    setDropTargetDirPath(null)
  }, [clearAutoExpandTimer])

  useEffect(() => clearDragState, [clearDragState])
  useEffect(() => clearDragState(), [clearDragState, workspace?.rootPath])

  const hasWorkspaceEntryDrag = (dataTransfer: DataTransfer | null | undefined): boolean =>
    draggingEntriesRef.current.length > 0 ||
    Array.from(dataTransfer?.types ?? []).includes(WORKSPACE_ENTRY_DRAG_MIME)

  const resolveDraggedEntriesFromTransfer = (
    dataTransfer: DataTransfer | null | undefined
  ): readonly WorkspaceEntry[] => {
    const pathsFromData = parseWorkspaceDragPaths(
      dataTransfer?.getData(WORKSPACE_ENTRY_DRAG_MIME)
    )
    if (pathsFromData.length > 0) {
      return pathsFromData.map((path) => {
        const matched = entryByKey.get(getWorkspacePathKey(path))
        return matched ?? { name: path, path, relativePath: path, kind: 'file' as const }
      })
    }
    return draggingEntriesRef.current
  }

  const scheduleAutoExpandIfEligible = (
    entry: WorkspaceEntry | null,
    draggedItems: readonly WorkspaceEntry[]
  ): void => {
    if (!entry || entry.kind !== 'directory' || expandedDirs.has(entry.path)) {
      clearAutoExpandTimer()
      return
    }
    const topLevel = filterTopLevelWorkspaceEntries(draggedItems)
    if (isNestedUnderAnyDraggedDir(entry.path, topLevel)) {
      clearAutoExpandTimer()
      return
    }
    if (pendingAutoExpandDirRef.current === entry.path) {
      return
    }
    clearAutoExpandTimer()
    const targetDirToExpand = entry.path
    pendingAutoExpandDirRef.current = targetDirToExpand
    autoExpandTimerRef.current = setTimeout(() => {
      autoExpandTimerRef.current = null
      pendingAutoExpandDirRef.current = null
      void onEnsureExpanded(targetDirToExpand)
    }, AUTO_EXPAND_HOVER_DELAY_MS)
  }

  const handleEntryDragStart = (
    event: ReactDragEvent<HTMLElement>,
    entry: WorkspaceEntry,
    isRenaming: boolean
  ): void => {
    if (isRenaming) {
      return
    }
    event.stopPropagation()
    const draggedEntries = resolveActionTargets(entry)
    if (!isPathSelected(entry.path)) {
      onSelectPath(entry.path)
    }
    draggingEntriesRef.current = draggedEntries
    const draggedPaths = draggedEntries.map((item) => item.path)
    const draggedImagePaths = draggedEntries
      .filter((item) => item.kind === 'file' && isSupportedImageFile(item.path))
      .map((item) => item.path)

    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = draggedImagePaths.length > 0 ? 'copyMove' : 'move'
      event.dataTransfer.setData(
        WORKSPACE_ENTRY_DRAG_MIME,
        formatWorkspaceDragPaths(draggedPaths)
      )
      if (draggedImagePaths.length > 0) {
        event.dataTransfer.setData(
          WORKSPACE_IMAGE_DRAG_MIME,
          formatWorkspaceDragPaths(draggedImagePaths)
        )
      }
    }
    onDragStartWorkspaceImages?.(draggedImagePaths)
  }

  const handleTreeDragOver = (
    event: ReactDragEvent<HTMLElement>,
    hoverEntry: WorkspaceEntry | null
  ): void => {
    if (!workspace || !hasWorkspaceEntryDrag(event.dataTransfer)) {
      return
    }
    if (hoverEntry) {
      event.stopPropagation()
    }
    const targetDirPath = resolveEntryDropTargetDir(hoverEntry, workspace.rootPath)
    const draggedItems = draggingEntriesRef.current
    const canDrop =
      draggedItems.length > 0
        ? canDropEntriesIntoTargetDir(draggedItems, targetDirPath, workspace.rootPath)
        : Array.from(event.dataTransfer?.types ?? []).includes(WORKSPACE_ENTRY_DRAG_MIME)

    if (canDrop) {
      event.preventDefault()
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = 'move'
      }
      setDropTargetDirPath((prev) =>
        prev && isSameWorkspacePath(prev, targetDirPath) ? prev : targetDirPath
      )
    } else {
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = 'none'
      }
      setDropTargetDirPath(null)
    }
    scheduleAutoExpandIfEligible(hoverEntry?.kind === 'directory' ? hoverEntry : null, draggedItems)
  }

  const handleTreeDrop = (
    event: ReactDragEvent<HTMLElement>,
    dropEntry: WorkspaceEntry | null
  ): void => {
    if (!workspace || !hasWorkspaceEntryDrag(event.dataTransfer)) {
      return
    }
    event.preventDefault()
    event.stopPropagation()
    const targetDirPath = resolveEntryDropTargetDir(dropEntry, workspace.rootPath)
    const draggedItems = resolveDraggedEntriesFromTransfer(event.dataTransfer)
    const canDrop = canDropEntriesIntoTargetDir(draggedItems, targetDirPath, workspace.rootPath)
    const sourcePaths = draggedItems.map((item) => item.path)
    clearDragState()
    onDragEndWorkspaceImage?.()
    if (!canDrop) {
      return
    }
    void onMoveEntries(sourcePaths, targetDirPath)
  }

  const handleTreeDragLeave = (event: ReactDragEvent<HTMLElement>): void => {
    const related = event.relatedTarget
    if (related instanceof Node && event.currentTarget.contains(related)) {
      return
    }
    clearAutoExpandTimer()
    setDropTargetDirPath(null)
  }

  const handleTreeDragEnd = (): void => {
    clearDragState()
    onDragEndWorkspaceImage?.()
  }

  return {
    dropTargetDirPath,
    handleEntryDragStart,
    handleTreeDragOver,
    handleTreeDrop,
    handleTreeDragLeave,
    handleTreeDragEnd
  }
}
