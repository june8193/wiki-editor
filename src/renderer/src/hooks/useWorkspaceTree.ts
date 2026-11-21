import { useCallback, useEffect, useRef, useState } from 'react'
import {
  filterTopLevelWorkspaceEntries,
  getParentPath,
  getWorkspacePathKey,
  isMarkdownFileName,
  isNestedOrSameWorkspacePath,
  isSameWorkspacePath,
  readDirectoriesSettled,
  remapPathPrefix,
  toWorkspaceRelativePath,
  WorkspaceChangeEvent,
  WorkspaceEntry,
  WorkspaceEntryKind,
  WorkspaceMovedEntry,
  WorkspaceSummary
} from '@shared/workspace'
import { toErrorMessage } from '@shared/errors'
import type { OpenedWorkspaceTreeData } from '../stores/MainWindowWorkspaceLifecycle'
import { useWikiApi } from './useWikiApi'

export interface WorkspaceTreeState {
  rootEntries: readonly WorkspaceEntry[]
  childrenByDir: Readonly<Record<string, readonly WorkspaceEntry[]>>
  expandedDirs: ReadonlySet<string>
  loadingDirs: ReadonlySet<string>
  selectedPaths: readonly string[]
}

function dedupeWorkspacePaths(paths: readonly string[]): string[] {
  const seen = new Set<string>()
  const unique: string[] = []
  for (const path of paths) {
    const key = getWorkspacePathKey(path)
    if (!key || seen.has(key)) continue
    seen.add(key)
    unique.push(path)
  }
  return unique
}

interface UseWorkspaceTreeOptions {
  onError: (message: string | null, error?: unknown) => void
  onWorkspaceChanged?: (event: WorkspaceChangeEvent) => void
  onEntryRenamed?: (oldPath: string, renamed: WorkspaceEntry) => void
  onEntryDeleted?: (deletedPath: string) => void
  onFileCreated?: (created: WorkspaceEntry) => void
}

/**
 * Manages pure directory tree state, multi-selection, 1-depth lazy folder loading,
 * file/folder CRUD, and file-watch tree refreshes.
 */
export function useWorkspaceTree({
  onError,
  onWorkspaceChanged,
  onEntryRenamed,
  onEntryDeleted,
  onFileCreated
}: UseWorkspaceTreeOptions) {
  const wikiApi = useWikiApi()
  const [workspace, setWorkspace] = useState<WorkspaceSummary | null>(null)
  const [rootEntries, setRootEntries] = useState<WorkspaceEntry[]>([])
  const [childrenByDir, setChildrenByDir] = useState<Record<string, WorkspaceEntry[]>>({})
  const [markdownFiles, setMarkdownFiles] = useState<WorkspaceEntry[]>([])
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(() => new Set())
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(() => new Set())
  const [selectedTreePaths, setSelectedTreePathsState] = useState<string[]>([])
  const [selectionAnchorPath, setSelectionAnchorPath] = useState<string | null>(null)
  const selectedTreePath = selectedTreePaths[selectedTreePaths.length - 1] ?? null

  const mountedRef = useRef<boolean>(true)
  const workspaceRef = useRef<WorkspaceSummary | null>(null)
  const expandedDirsRef = useRef<Set<string>>(expandedDirs)
  const selectionAnchorPathRef = useRef<string | null>(selectionAnchorPath)
  const markdownFilesSeqRef = useRef<number>(0)
  const callbacksRef = useRef({
    onError,
    onWorkspaceChanged,
    onEntryRenamed,
    onEntryDeleted,
    onFileCreated
  })

  workspaceRef.current = workspace
  expandedDirsRef.current = expandedDirs
  selectionAnchorPathRef.current = selectionAnchorPath
  callbacksRef.current = {
    onError,
    onWorkspaceChanged,
    onEntryRenamed,
    onEntryDeleted,
    onFileCreated
  }

  const refreshMarkdownFiles = useCallback(async (expectedRootPath?: string): Promise<void> => {
    const targetRoot = expectedRootPath ?? workspaceRef.current?.rootPath
    if (!targetRoot) {
      markdownFilesSeqRef.current += 1
      setMarkdownFiles([])
      return
    }

    const seq = ++markdownFilesSeqRef.current
    try {
      const files = await wikiApi.workspace.listMarkdownFiles()
      if (
        !mountedRef.current ||
        seq !== markdownFilesSeqRef.current ||
        workspaceRef.current?.rootPath !== targetRoot
      ) {
        return
      }
      setMarkdownFiles(files)
    } catch {
      // Keep the last known list if background file enumeration fails transiently.
    }
  }, [wikiApi])

  const refreshTree = useCallback(async (): Promise<void> => {
    const currentWs = workspaceRef.current
    if (!currentWs) return

    void refreshMarkdownFiles(currentWs.rootPath)
    try {
      const topEntries = await wikiApi.workspace.readDir()
      if (!mountedRef.current || workspaceRef.current?.rootPath !== currentWs.rootPath) return
      setRootEntries(topEntries)

      const expandedList = [...expandedDirsRef.current]
      if (expandedList.length === 0) {
        setChildrenByDir({})
        return
      }

      const loadedDirs = await readDirectoriesSettled(wikiApi.workspace.readDir, expandedList)
      if (!mountedRef.current || workspaceRef.current?.rootPath !== currentWs.rootPath) return

      const nextChildren: Record<string, WorkspaceEntry[]> = {}
      for (const loaded of loadedDirs) {
        nextChildren[loaded.dirPath] = loaded.entries
      }
      setChildrenByDir(nextChildren)
    } catch (error: unknown) {
      if (mountedRef.current) {
        callbacksRef.current.onError(
          toErrorMessage(error, '폴더 트리를 새로고침하지 못했습니다.'),
          error
        )
      }
    }
  }, [refreshMarkdownFiles, wikiApi])

  useEffect(() => {
    mountedRef.current = true
    const unsubscribe = wikiApi.workspace.onChanged((event) => {
      if (!mountedRef.current) return
      void refreshTree()
      callbacksRef.current.onWorkspaceChanged?.(event)
    })

    return () => {
      mountedRef.current = false
      unsubscribe()
    }
  }, [refreshTree, wikiApi])

  const setSelectedTreePath = useCallback((path: string | null): void => {
    if (path === null) {
      setSelectedTreePathsState([])
      setSelectionAnchorPath(null)
      return
    }
    setSelectedTreePathsState([path])
    setSelectionAnchorPath(path)
  }, [])

  const toggleSelectTreePath = useCallback((path: string): void => {
    setSelectedTreePathsState((prev) => {
      const exists = prev.some((item) => isSameWorkspacePath(item, path))
      if (exists) {
        return prev.filter((item) => !isSameWorkspacePath(item, path))
      }
      return [...prev, path]
    })
    setSelectionAnchorPath(path)
  }, [])

  const selectTreePathRange = useCallback(
    (targetPath: string, visibleEntries: readonly WorkspaceEntry[]): void => {
      const targetIndex = visibleEntries.findIndex((entry) =>
        isSameWorkspacePath(entry.path, targetPath)
      )
      if (targetIndex === -1) {
        setSelectedTreePath(targetPath)
        return
      }
      const currentAnchor = selectionAnchorPathRef.current
      const anchorIndex = currentAnchor
        ? visibleEntries.findIndex((entry) => isSameWorkspacePath(entry.path, currentAnchor))
        : -1
      if (anchorIndex === -1) {
        setSelectedTreePath(visibleEntries[targetIndex].path)
        return
      }
      const start = Math.min(anchorIndex, targetIndex)
      const end = Math.max(anchorIndex, targetIndex)
      setSelectedTreePathsState(visibleEntries.slice(start, end + 1).map((entry) => entry.path))
    },
    [setSelectedTreePath]
  )

  const getExpandedDirs = useCallback((): ReadonlySet<string> => expandedDirsRef.current, [])

  const applyOpenedWorkspace = useCallback(
    (opened: OpenedWorkspaceTreeData): void => {
      const nextExpandedDirs = new Set(opened.expandedDirs)
      const nextChildrenByDir: Record<string, WorkspaceEntry[]> = {}
      for (const [dir, entries] of Object.entries(opened.childrenByDir)) {
        nextChildrenByDir[dir] = [...entries]
      }
      markdownFilesSeqRef.current += 1
      workspaceRef.current = opened.workspace
      expandedDirsRef.current = nextExpandedDirs
      setWorkspace(opened.workspace)
      setRootEntries([...opened.rootEntries])
      setChildrenByDir(nextChildrenByDir)
      setMarkdownFiles([...opened.markdownFiles])
      setExpandedDirs(nextExpandedDirs)
      setSelectedTreePath(null)
    },
    [setSelectedTreePath]
  )

  const loadDirectoryChildren = useCallback(async (dirPath: string): Promise<void> => {
    const currentWs = workspaceRef.current
    if (!currentWs) return
    setLoadingDirs((prev) => new Set(prev).add(dirPath))
    try {
      const entries = await wikiApi.workspace.readDir(dirPath)
      if (!mountedRef.current || workspaceRef.current?.rootPath !== currentWs.rootPath) return
      setChildrenByDir((prev) => ({ ...prev, [dirPath]: entries }))
    } catch (error: unknown) {
      if (mountedRef.current) {
        callbacksRef.current.onError(
          toErrorMessage(error, '하위 폴더를 불러오지 못했습니다.'),
          error
        )
      }
    } finally {
      if (mountedRef.current) {
        setLoadingDirs((prev) => {
          const next = new Set(prev)
          next.delete(dirPath)
          return next
        })
      }
    }
  }, [wikiApi])

  const expandDirectory = useCallback(
    async (dirPath: string): Promise<void> => {
      if (!expandedDirsRef.current.has(dirPath)) {
        setExpandedDirs((prev) => new Set(prev).add(dirPath))
      }
      if (!childrenByDir[dirPath]) {
        await loadDirectoryChildren(dirPath)
      }
    },
    [childrenByDir, loadDirectoryChildren]
  )

  const toggleDirectory = useCallback(
    (entry: WorkspaceEntry): void => {
      if (expandedDirsRef.current.has(entry.path)) {
        setExpandedDirs((prev) => {
          const next = new Set(prev)
          next.delete(entry.path)
          return next
        })
        return
      }
      void expandDirectory(entry.path)
    },
    [expandDirectory]
  )

  const resolveCreateParentDir = useCallback((): string | null => {
    if (!workspace) return null
    if (!selectedTreePath) return workspace.rootPath

    let matched = rootEntries.find((item) => item.path === selectedTreePath)
    if (!matched) {
      for (const children of Object.values(childrenByDir)) {
        matched = children.find((item) => item.path === selectedTreePath)
        if (matched) break
      }
    }
    if (matched?.kind === 'directory') {
      return matched.path
    }
    return getParentPath(selectedTreePath, workspace.rootPath)
  }, [workspace, selectedTreePath, rootEntries, childrenByDir])

  const refreshDirectory = useCallback(async (dirPath: string): Promise<void> => {
    const currentWs = workspaceRef.current
    if (!currentWs) return
    const entries = await wikiApi.workspace.readDir(dirPath)
    if (!mountedRef.current || workspaceRef.current?.rootPath !== currentWs.rootPath) return
    if (isSameWorkspacePath(dirPath, currentWs.rootPath)) {
      setRootEntries(entries)
    } else {
      setChildrenByDir((prev) => ({ ...prev, [dirPath]: entries }))
    }
  }, [wikiApi])

  const createEntry = useCallback(
    async (parentDirPath: string, name: string, kind: WorkspaceEntryKind): Promise<void> => {
      const currentWs = workspaceRef.current
      callbacksRef.current.onError(null)
      try {
        const created = await wikiApi.workspace.createEntry(parentDirPath, name, kind, '')
        if (!mountedRef.current) return
        await refreshDirectory(parentDirPath)
        if (currentWs && kind === 'file' && isMarkdownFileName(created.name)) {
          await refreshMarkdownFiles(currentWs.rootPath)
        }
        setSelectedTreePath(created.path)
        if (kind === 'file') {
          callbacksRef.current.onFileCreated?.(created)
        }
      } catch (error: unknown) {
        if (mountedRef.current) {
          callbacksRef.current.onError(
            toErrorMessage(error, '새 항목을 생성하지 못했습니다.'),
            error
          )
        }
      }
    },
    [refreshDirectory, refreshMarkdownFiles, setSelectedTreePath, wikiApi]
  )

  const applyTreePathRemappings = useCallback(
    (
      remappings: readonly WorkspaceMovedEntry[],
      rootPath: string
    ): void => {
      const remapWithEntries = (
        candidatePath: string,
        entries: readonly WorkspaceMovedEntry[]
      ): string => {
        const matched = entries.find((item) =>
          item.entry.kind === 'directory'
            ? isNestedOrSameWorkspacePath(candidatePath, item.oldPath)
            : isSameWorkspacePath(candidatePath, item.oldPath)
        )
        return matched
          ? remapPathPrefix(candidatePath, matched.oldPath, matched.entry.path)
          : candidatePath
      }

      const dirRemappings = remappings.filter((item) => item.entry.kind === 'directory')
      if (dirRemappings.length > 0) {
        setExpandedDirs((prev) => {
          const next = new Set<string>()
          for (const dir of prev) {
            next.add(remapWithEntries(dir, dirRemappings))
          }
          return next
        })
        setChildrenByDir((prev) => {
          const next: Record<string, WorkspaceEntry[]> = {}
          for (const [dir, entries] of Object.entries(prev)) {
            const remappedDir = remapWithEntries(dir, dirRemappings)
            next[remappedDir] = entries.map((item) => {
              const remappedPath = remapWithEntries(item.path, dirRemappings)
              if (remappedPath === item.path) return item
              return {
                ...item,
                path: remappedPath,
                relativePath:
                  toWorkspaceRelativePath(rootPath, remappedPath) || item.relativePath
              }
            })
          }
          return next
        })
      }

      setSelectedTreePathsState((prev) =>
        dedupeWorkspacePaths(prev.map((path) => remapWithEntries(path, remappings)))
      )
      setSelectionAnchorPath((prev) => (prev ? remapWithEntries(prev, remappings) : prev))
    },
    []
  )

  const renameEntry = useCallback(
    async (targetPath: string, newName: string): Promise<void> => {
      const currentWs = workspaceRef.current
      if (!currentWs) return
      callbacksRef.current.onError(null)
      try {
        const renamed = await wikiApi.workspace.renameEntry(targetPath, newName)
        if (!mountedRef.current) return

        applyTreePathRemappings([{ oldPath: targetPath, entry: renamed }], currentWs.rootPath)
        const parentDir = getParentPath(targetPath, currentWs.rootPath)
        await refreshDirectory(parentDir)
        if (
          renamed.kind === 'directory' ||
          isMarkdownFileName(renamed.name) ||
          isMarkdownFileName(targetPath)
        ) {
          await refreshMarkdownFiles(currentWs.rootPath)
        }
        setSelectedTreePath(renamed.path)

        callbacksRef.current.onEntryRenamed?.(targetPath, renamed)
      } catch (error: unknown) {
        if (mountedRef.current) {
          callbacksRef.current.onError(toErrorMessage(error, '이름을 변경하지 못했습니다.'), error)
        }
      }
    },
    [applyTreePathRemappings, refreshDirectory, refreshMarkdownFiles, setSelectedTreePath, wikiApi]
  )

  const refreshAffectedDirectories = useCallback(
    async (
      candidateDirs: readonly string[],
      rootPath: string,
      isExcludedDir: (dirPath: string) => boolean,
      shouldRefreshMarkdown: boolean
    ): Promise<void> => {
      const dirsToRefresh = dedupeWorkspacePaths(
        candidateDirs.filter((dirPath) => !isExcludedDir(dirPath))
      )

      await Promise.all(dirsToRefresh.map((dirPath) => refreshDirectory(dirPath)))
      if (!mountedRef.current || workspaceRef.current?.rootPath !== rootPath) return

      if (shouldRefreshMarkdown) {
        await refreshMarkdownFiles(rootPath)
      }
    },
    [refreshDirectory, refreshMarkdownFiles]
  )

  const moveEntries = useCallback(
    async (sourcePaths: readonly string[], targetDirPath: string): Promise<void> => {
      const currentWs = workspaceRef.current
      if (!currentWs || sourcePaths.length === 0) return
      callbacksRef.current.onError(null)
      try {
        const movedEntries = await wikiApi.workspace.moveEntries([...sourcePaths], targetDirPath)
        if (!mountedRef.current || movedEntries.length === 0) return

        applyTreePathRemappings(movedEntries, currentWs.rootPath)
        for (const moved of movedEntries) {
          callbacksRef.current.onEntryRenamed?.(moved.oldPath, moved.entry)
        }

        const candidateDirs = [
          ...movedEntries.map((moved) => getParentPath(moved.oldPath, currentWs.rootPath)),
          targetDirPath
        ]
        const isInsideMovedDir = (dirPath: string): boolean =>
          movedEntries.some(
            (moved) =>
              moved.entry.kind === 'directory' &&
              isNestedOrSameWorkspacePath(dirPath, moved.oldPath)
          )
        const shouldRefreshMarkdown = movedEntries.some(
          (moved) =>
            moved.entry.kind === 'directory' ||
            isMarkdownFileName(moved.entry.name) ||
            isMarkdownFileName(moved.oldPath)
        )
        await refreshAffectedDirectories(
          candidateDirs,
          currentWs.rootPath,
          isInsideMovedDir,
          shouldRefreshMarkdown
        )
      } catch (error: unknown) {
        if (mountedRef.current) {
          callbacksRef.current.onError(toErrorMessage(error, '항목을 이동하지 못했습니다.'), error)
        }
      }
    },
    [applyTreePathRemappings, refreshAffectedDirectories, wikiApi]
  )

  const deleteEntries = useCallback(
    async (entries: readonly WorkspaceEntry[]): Promise<void> => {
      const currentWs = workspaceRef.current
      if (!currentWs || entries.length === 0) return
      const targets = filterTopLevelWorkspaceEntries(entries)
      if (targets.length === 0) return

      callbacksRef.current.onError(null)
      const deletedTargets: WorkspaceEntry[] = []
      try {
        for (const target of targets) {
          await wikiApi.workspace.deleteEntry(target.path)
          if (!mountedRef.current) return
          deletedTargets.push(target)
        }
      } catch (error: unknown) {
        if (mountedRef.current) {
          callbacksRef.current.onError(
            toErrorMessage(error, '항목을 삭제하지 못했습니다.'),
            error
          )
        }
      }

      if (!mountedRef.current || deletedTargets.length === 0) return

      const isUnderDeletedTarget = (candidatePath: string): boolean =>
        deletedTargets.some((target) => isNestedOrSameWorkspacePath(candidatePath, target.path))

      setExpandedDirs((prev) => {
        const next = new Set<string>()
        for (const dir of prev) {
          if (!isUnderDeletedTarget(dir)) {
            next.add(dir)
          }
        }
        return next
      })
      setChildrenByDir((prev) => {
        const next: Record<string, WorkspaceEntry[]> = {}
        for (const [dir, dirEntries] of Object.entries(prev)) {
          if (!isUnderDeletedTarget(dir)) {
            next[dir] = dirEntries
          }
        }
        return next
      })
      setSelectedTreePathsState((prev) => prev.filter((path) => !isUnderDeletedTarget(path)))
      setSelectionAnchorPath((prev) => (prev && isUnderDeletedTarget(prev) ? null : prev))

      for (const target of deletedTargets) {
        callbacksRef.current.onEntryDeleted?.(target.path)
      }

      const candidateDirs = deletedTargets.map((target) =>
        getParentPath(target.path, currentWs.rootPath)
      )
      const shouldRefreshMarkdown = deletedTargets.some(
        (target) => target.kind === 'directory' || isMarkdownFileName(target.name)
      )
      await refreshAffectedDirectories(
        candidateDirs,
        currentWs.rootPath,
        isUnderDeletedTarget,
        shouldRefreshMarkdown
      )
    },
    [refreshAffectedDirectories, wikiApi]
  )

  const treeState: WorkspaceTreeState = {
    rootEntries,
    childrenByDir,
    expandedDirs,
    loadingDirs,
    selectedPaths: selectedTreePaths
  }

  return {
    workspace,
    treeState,
    markdownFiles,
    getExpandedDirs,
    applyOpenedWorkspace,
    setSelectedTreePath,
    toggleSelectTreePath,
    selectTreePathRange,
    resolveCreateParentDir,
    refreshTree,
    toggleDirectory,
    ensureExpanded: expandDirectory,
    createEntry,
    renameEntry,
    moveEntries,
    deleteEntries
  }
}
