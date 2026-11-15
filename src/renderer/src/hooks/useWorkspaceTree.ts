import { useCallback, useEffect, useRef, useState } from 'react'
import {
  getParentPath,
  isNestedOrSamePath,
  isSameWorkspacePath,
  remapPathPrefix,
  toWorkspaceRelativePath,
  WorkspaceEntry,
  WorkspaceEntryKind,
  WorkspaceSummary
} from '@shared/workspace'
import { logRendererInfo } from '../logging/rendererLogger'
import { toErrorMessage } from '../utils/toErrorMessage'

export interface WorkspaceTreeState {
  rootEntries: readonly WorkspaceEntry[]
  childrenByDir: Readonly<Record<string, readonly WorkspaceEntry[]>>
  expandedDirs: ReadonlySet<string>
  loadingDirs: ReadonlySet<string>
  selectedPath: string | null
}

export interface OpenWorkspaceOptions {
  silentError?: boolean
  onSilentError?: () => void
}

interface UseWorkspaceTreeOptions {
  onError: (message: string | null, error?: unknown) => void
  onWorkspaceOpened?: () => void
  onWorkspaceChanged?: () => void
  onEntryRenamed?: (oldPath: string, renamed: WorkspaceEntry) => void
  onEntryDeleted?: (deletedPath: string) => void
  onFileCreated?: (created: WorkspaceEntry) => void
}

/**
 * Manages workspace selection, 1-depth lazy folder loading, CRUD operations, and file watching.
 */
export function useWorkspaceTree({
  onError,
  onWorkspaceOpened,
  onWorkspaceChanged,
  onEntryRenamed,
  onEntryDeleted,
  onFileCreated
}: UseWorkspaceTreeOptions) {
  const [workspace, setWorkspace] = useState<WorkspaceSummary | null>(null)
  const [rootEntries, setRootEntries] = useState<WorkspaceEntry[]>([])
  const [childrenByDir, setChildrenByDir] = useState<Record<string, WorkspaceEntry[]>>({})
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(() => new Set())
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(() => new Set())
  const [selectedTreePath, setSelectedTreePath] = useState<string | null>(null)

  const mountedRef = useRef<boolean>(true)
  const workspaceRef = useRef<WorkspaceSummary | null>(null)
  const expandedDirsRef = useRef<Set<string>>(expandedDirs)
  const openRequestSeqRef = useRef<number>(0)
  const callbacksRef = useRef({
    onError,
    onWorkspaceOpened,
    onWorkspaceChanged,
    onEntryRenamed,
    onEntryDeleted,
    onFileCreated
  })

  workspaceRef.current = workspace
  expandedDirsRef.current = expandedDirs
  callbacksRef.current = {
    onError,
    onWorkspaceOpened,
    onWorkspaceChanged,
    onEntryRenamed,
    onEntryDeleted,
    onFileCreated
  }

  const refreshTree = useCallback(async (): Promise<void> => {
    const currentWs = workspaceRef.current
    if (!currentWs) return

    try {
      const topEntries = await window.wikiApi.workspace.readDir()
      if (!mountedRef.current || workspaceRef.current?.rootPath !== currentWs.rootPath) return
      setRootEntries(topEntries)

      const expandedList = [...expandedDirsRef.current]
      if (expandedList.length === 0) {
        setChildrenByDir({})
        return
      }

      const results = await Promise.allSettled(
        expandedList.map(async (dirPath) => ({
          dirPath,
          entries: await window.wikiApi.workspace.readDir(dirPath)
        }))
      )
      if (!mountedRef.current || workspaceRef.current?.rootPath !== currentWs.rootPath) return

      const nextChildren: Record<string, WorkspaceEntry[]> = {}
      for (const result of results) {
        if (result.status === 'fulfilled') {
          nextChildren[result.value.dirPath] = result.value.entries
        }
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
  }, [])

  useEffect(() => {
    mountedRef.current = true
    const unsubscribe = window.wikiApi.workspace.onChanged(() => {
      if (!mountedRef.current) return
      void refreshTree()
      callbacksRef.current.onWorkspaceChanged?.()
    })

    return () => {
      mountedRef.current = false
      unsubscribe()
      void window.wikiApi.workspace.unwatch().catch(() => undefined)
    }
  }, [refreshTree])

  const openWorkspace = useCallback(
    async (targetPath: string, options?: OpenWorkspaceOptions): Promise<boolean> => {
      const seq = ++openRequestSeqRef.current
      if (!options?.silentError) {
        callbacksRef.current.onError(null)
      }
      try {
        const info = await window.wikiApi.workspace.open(targetPath)
        if (!mountedRef.current || seq !== openRequestSeqRef.current) return false
        setWorkspace({ rootPath: info.rootPath, name: info.name })
        setRootEntries(info.entries)
        setChildrenByDir({})
        setExpandedDirs(new Set())
        setSelectedTreePath(null)
        logRendererInfo('ui', 'Workspace opened', { rootPath: info.rootPath, name: info.name })
        callbacksRef.current.onWorkspaceOpened?.()
        await window.wikiApi.workspace.watch().catch(() => undefined)
        return true
      } catch (error: unknown) {
        if (!mountedRef.current || seq !== openRequestSeqRef.current) return false
        if (options?.silentError) {
          options.onSilentError?.()
        } else {
          callbacksRef.current.onError(
            toErrorMessage(error, '워크스페이스를 열지 못했습니다.'),
            error
          )
        }
        return false
      }
    },
    []
  )

  const loadDirectoryChildren = useCallback(async (dirPath: string): Promise<void> => {
    const currentWs = workspaceRef.current
    if (!currentWs) return
    setLoadingDirs((prev) => new Set(prev).add(dirPath))
    try {
      const entries = await window.wikiApi.workspace.readDir(dirPath)
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
  }, [])

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
    const entries = await window.wikiApi.workspace.readDir(dirPath)
    if (!mountedRef.current || workspaceRef.current?.rootPath !== currentWs.rootPath) return
    if (isSameWorkspacePath(dirPath, currentWs.rootPath)) {
      setRootEntries(entries)
    } else {
      setChildrenByDir((prev) => ({ ...prev, [dirPath]: entries }))
    }
  }, [])

  const createEntry = useCallback(
    async (parentDirPath: string, name: string, kind: WorkspaceEntryKind): Promise<void> => {
      callbacksRef.current.onError(null)
      try {
        const created = await window.wikiApi.workspace.createEntry(parentDirPath, name, kind, '')
        if (!mountedRef.current) return
        await refreshDirectory(parentDirPath)
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
    [refreshDirectory]
  )

  const renameEntry = useCallback(
    async (targetPath: string, newName: string): Promise<void> => {
      const currentWs = workspaceRef.current
      if (!currentWs) return
      callbacksRef.current.onError(null)
      try {
        const renamed = await window.wikiApi.workspace.renameEntry(targetPath, newName)
        if (!mountedRef.current) return

        const parentDir = getParentPath(targetPath, currentWs.rootPath)
        await refreshDirectory(parentDir)
        setSelectedTreePath(renamed.path)

        if (renamed.kind === 'directory') {
          setExpandedDirs((prev) => {
            const next = new Set<string>()
            for (const dir of prev) {
              next.add(remapPathPrefix(dir, targetPath, renamed.path))
            }
            return next
          })
          setChildrenByDir((prev) => {
            const next: Record<string, WorkspaceEntry[]> = {}
            for (const [dir, entries] of Object.entries(prev)) {
              const remappedDir = remapPathPrefix(dir, targetPath, renamed.path)
              next[remappedDir] = entries.map((item) => {
                const remappedPath = remapPathPrefix(item.path, targetPath, renamed.path)
                return {
                  ...item,
                  path: remappedPath,
                  relativePath:
                    toWorkspaceRelativePath(currentWs.rootPath, remappedPath) || item.relativePath
                }
              })
            }
            return next
          })
        }

        callbacksRef.current.onEntryRenamed?.(targetPath, renamed)
      } catch (error: unknown) {
        if (mountedRef.current) {
          callbacksRef.current.onError(toErrorMessage(error, '이름을 변경하지 못했습니다.'), error)
        }
      }
    },
    [refreshDirectory]
  )

  const deleteEntry = useCallback(
    async (entry: WorkspaceEntry): Promise<void> => {
      const currentWs = workspaceRef.current
      if (!currentWs) return
      callbacksRef.current.onError(null)
      try {
        await window.wikiApi.workspace.deleteEntry(entry.path)
        if (!mountedRef.current) return

        const parentDir = getParentPath(entry.path, currentWs.rootPath)
        await refreshDirectory(parentDir)

        setExpandedDirs((prev) => {
          const next = new Set<string>()
          for (const dir of prev) {
            if (!isNestedOrSamePath(dir, entry.path)) {
              next.add(dir)
            }
          }
          return next
        })
        setChildrenByDir((prev) => {
          const next: Record<string, WorkspaceEntry[]> = {}
          for (const [dir, entries] of Object.entries(prev)) {
            if (!isNestedOrSamePath(dir, entry.path)) {
              next[dir] = entries
            }
          }
          return next
        })
        setSelectedTreePath((prev) =>
          prev && isNestedOrSamePath(prev, entry.path) ? null : prev
        )
        callbacksRef.current.onEntryDeleted?.(entry.path)
      } catch (error: unknown) {
        if (mountedRef.current) {
          callbacksRef.current.onError(
            toErrorMessage(error, '항목을 삭제하지 못했습니다.'),
            error
          )
        }
      }
    },
    [refreshDirectory]
  )

  const treeState: WorkspaceTreeState = {
    rootEntries,
    childrenByDir,
    expandedDirs,
    loadingDirs,
    selectedPath: selectedTreePath
  }

  return {
    workspace,
    treeState,
    setSelectedTreePath,
    resolveCreateParentDir,
    openWorkspace,
    refreshTree,
    toggleDirectory,
    ensureExpanded: expandDirectory,
    createEntry,
    renameEntry,
    deleteEntry
  }
}
