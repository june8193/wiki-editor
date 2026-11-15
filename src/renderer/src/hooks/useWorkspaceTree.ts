import { useCallback, useEffect, useRef, useState } from 'react'
import {
  getParentPath,
  isMarkdownFileName,
  isNestedOrSamePath,
  isSameWorkspacePath,
  remapPathPrefix,
  toWorkspaceRelativePath,
  WorkspaceChangeEvent,
  WorkspaceEntry,
  WorkspaceEntryKind,
  WorkspaceSummary
} from '@shared/workspace'
import { logRendererInfo } from '../logging/rendererLogger'
import { toErrorMessage } from '@shared/errors'
import { useWikiApi } from './useWikiApi'

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
  onWorkspaceChanged?: (event: WorkspaceChangeEvent) => void
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
  const wikiApi = useWikiApi()
  const [workspace, setWorkspace] = useState<WorkspaceSummary | null>(null)
  const [rootEntries, setRootEntries] = useState<WorkspaceEntry[]>([])
  const [childrenByDir, setChildrenByDir] = useState<Record<string, WorkspaceEntry[]>>({})
  const [markdownFiles, setMarkdownFiles] = useState<WorkspaceEntry[]>([])
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(() => new Set())
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(() => new Set())
  const [selectedTreePath, setSelectedTreePath] = useState<string | null>(null)

  const mountedRef = useRef<boolean>(true)
  const workspaceRef = useRef<WorkspaceSummary | null>(null)
  const expandedDirsRef = useRef<Set<string>>(expandedDirs)
  const openRequestSeqRef = useRef<number>(0)
  const markdownFilesSeqRef = useRef<number>(0)
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

      const results = await Promise.allSettled(
        expandedList.map(async (dirPath) => ({
          dirPath,
          entries: await wikiApi.workspace.readDir(dirPath)
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
      void wikiApi.workspace.unwatch().catch(() => undefined)
    }
  }, [refreshTree, wikiApi])

  const openWorkspace = useCallback(
    async (targetPath: string, options?: OpenWorkspaceOptions): Promise<boolean> => {
      const seq = ++openRequestSeqRef.current
      if (!options?.silentError) {
        callbacksRef.current.onError(null)
      }
      try {
        const info = await wikiApi.workspace.open(targetPath)
        if (!mountedRef.current || seq !== openRequestSeqRef.current) return false
        const initialMarkdownFiles = await wikiApi.workspace
          .listMarkdownFiles()
          .catch(() => [] as WorkspaceEntry[])
        if (!mountedRef.current || seq !== openRequestSeqRef.current) {
          return false
        }
        markdownFilesSeqRef.current += 1
        setWorkspace({ rootPath: info.rootPath, name: info.name })
        setRootEntries(info.entries)
        setChildrenByDir({})
        setMarkdownFiles(initialMarkdownFiles)
        setExpandedDirs(new Set())
        setSelectedTreePath(null)
        logRendererInfo('ui', 'Workspace opened', { rootPath: info.rootPath, name: info.name })
        callbacksRef.current.onWorkspaceOpened?.()
        await wikiApi.workspace.watch().catch(() => undefined)
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
    [wikiApi]
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
    [refreshDirectory, refreshMarkdownFiles, wikiApi]
  )

  const renameEntry = useCallback(
    async (targetPath: string, newName: string): Promise<void> => {
      const currentWs = workspaceRef.current
      if (!currentWs) return
      callbacksRef.current.onError(null)
      try {
        const renamed = await wikiApi.workspace.renameEntry(targetPath, newName)
        if (!mountedRef.current) return

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
    [refreshDirectory, refreshMarkdownFiles, wikiApi]
  )

  const deleteEntry = useCallback(
    async (entry: WorkspaceEntry): Promise<void> => {
      const currentWs = workspaceRef.current
      if (!currentWs) return
      callbacksRef.current.onError(null)
      try {
        await wikiApi.workspace.deleteEntry(entry.path)
        if (!mountedRef.current) return

        const parentDir = getParentPath(entry.path, currentWs.rootPath)
        await refreshDirectory(parentDir)
        if (entry.kind === 'directory' || isMarkdownFileName(entry.name)) {
          await refreshMarkdownFiles(currentWs.rootPath)
        }

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
    [refreshDirectory, refreshMarkdownFiles, wikiApi]
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
    markdownFiles,
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
