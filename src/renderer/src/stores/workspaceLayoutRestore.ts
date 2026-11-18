import { isSupportedImageFile } from '@shared/assets'
import type { DocumentBuffer } from '@shared/documentBuffer'
import { extractTabViewState } from '@shared/window'
import {
  getParentPath,
  getWorkspaceDisplayName,
  getWorkspacePathKey,
  isSameWorkspacePath,
  readDirectoriesSettled,
  reanchorPathInWorkspace,
  resolveNormalizedWorkspacePath,
  type WorkspaceEntry
} from '@shared/workspace'
import {
  createEmptyPersistedWorkspaceLayout,
  filterPersistedPaneTabsForWorkspace,
  type PersistedWorkspacePaneLayout,
  type PersistedWorkspacePaneState,
  type PersistedWorkspaceTabState,
  reconcileLoadedWorkspaceLayout
} from '@shared/workspaceState'
import type { RestoreWorkspaceLayoutInput } from './PaneTabStore'
import type {
  RendererBufferSyncClient,
  WorkspaceFileOpenRequest
} from './RendererBufferSyncClient'

export interface RestoreWorkspaceLayoutOptions {
  rootPath: string
  persistedLayout: PersistedWorkspacePaneLayout | null
  rootEntries?: readonly WorkspaceEntry[]
  restoredChildrenByDir?: Readonly<Record<string, readonly WorkspaceEntry[]>>
  readDir: (dirPath?: string) => Promise<WorkspaceEntry[]>
  isCancelled?: () => boolean
}

export interface RestoreWorkspaceLayoutResult {
  restored: boolean
  hadPrunedTabs: boolean
  reconciledLayout: PersistedWorkspacePaneLayout
}

type WorkspaceLayoutSyncTarget = Pick<
  RendererBufferSyncClient,
  'isMounted' | 'openWorkspaceFilesSilently' | 'commitRestoredWorkspaceLayout'
>

interface CandidateFileDescriptor extends WorkspaceFileOpenRequest {
  isImage: boolean
}

function buildDirectoryEntriesIndex(
  rootPath: string,
  rootEntries?: readonly WorkspaceEntry[],
  restoredChildrenByDir?: Readonly<Record<string, readonly WorkspaceEntry[]>>
): Map<string, readonly WorkspaceEntry[]> {
  const dirEntriesByKey = new Map<string, readonly WorkspaceEntry[]>()
  if (rootEntries) {
    dirEntriesByKey.set(getWorkspacePathKey(rootPath), rootEntries)
  }
  if (restoredChildrenByDir) {
    for (const [dirPath, entries] of Object.entries(restoredChildrenByDir)) {
      dirEntriesByKey.set(getWorkspacePathKey(dirPath), entries)
    }
  }
  return dirEntriesByKey
}

function collectUniqueCandidateFiles(
  rootPath: string,
  candidateTabs: readonly PersistedWorkspaceTabState[]
): Map<string, CandidateFileDescriptor> {
  const uniqueFiles = new Map<string, CandidateFileDescriptor>()
  for (const tab of candidateTabs) {
    const key = getWorkspacePathKey(tab.path)
    if (!key || uniqueFiles.has(key)) continue
    const loadPath = reanchorPathInWorkspace(rootPath, tab.path)
    uniqueFiles.set(key, {
      key,
      loadPath,
      name: getWorkspaceDisplayName(loadPath),
      isImage: isSupportedImageFile(loadPath)
    })
  }
  return uniqueFiles
}

async function verifyAndCollectRestorableFiles(
  syncTarget: WorkspaceLayoutSyncTarget,
  options: RestoreWorkspaceLayoutOptions,
  candidateTabs: readonly PersistedWorkspaceTabState[]
): Promise<{
  filesToOpen: WorkspaceFileOpenRequest[]
  hadMissingImage: boolean
  cancelled: boolean
}> {
  const uniqueFiles = collectUniqueCandidateFiles(options.rootPath, candidateTabs)
  const dirEntriesByKey = buildDirectoryEntriesIndex(
    options.rootPath,
    options.rootEntries,
    options.restoredChildrenByDir
  )

  const missingParentDirs = new Map<string, string>()
  for (const file of uniqueFiles.values()) {
    if (!file.isImage) continue
    const parentDir = getParentPath(file.loadPath, options.rootPath)
    const parentKey = getWorkspacePathKey(parentDir)
    if (!dirEntriesByKey.has(parentKey) && !missingParentDirs.has(parentKey)) {
      missingParentDirs.set(parentKey, parentDir)
    }
  }

  if (missingParentDirs.size > 0) {
    const loadedDirs = await readDirectoriesSettled(
      options.readDir,
      [...missingParentDirs.values()]
    )
    for (const loaded of loadedDirs) {
      dirEntriesByKey.set(getWorkspacePathKey(loaded.dirPath), loaded.entries)
    }
    if (!syncTarget.isMounted || options.isCancelled?.()) {
      return { filesToOpen: [], hadMissingImage: false, cancelled: true }
    }
  }

  const filesToOpen: WorkspaceFileOpenRequest[] = []
  let hadMissingImage = false
  for (const file of uniqueFiles.values()) {
    if (!file.isImage) {
      filesToOpen.push({ key: file.key, loadPath: file.loadPath, name: file.name })
      continue
    }
    const parentDir = getParentPath(file.loadPath, options.rootPath)
    const parentEntries = dirEntriesByKey.get(getWorkspacePathKey(parentDir))
    const matchedImage = parentEntries?.find(
      (entry) => entry.kind === 'file' && isSameWorkspacePath(entry.path, file.loadPath)
    )
    if (!matchedImage) {
      hadMissingImage = true
      continue
    }
    filesToOpen.push({ key: file.key, loadPath: matchedImage.path, name: matchedImage.name })
  }

  return { filesToOpen, hadMissingImage, cancelled: false }
}

function collectBuffersToCommit(
  reconciledLayout: PersistedWorkspacePaneLayout,
  loadedBuffersByKey: ReadonlyMap<string, DocumentBuffer>
): DocumentBuffer[] {
  const uniqueBuffers = new Map<string, DocumentBuffer>()
  for (const tab of [
    ...reconciledLayout.panes.primary.tabs,
    ...reconciledLayout.panes.secondary.tabs
  ]) {
    const pathKey = getWorkspacePathKey(tab.path)
    if (uniqueBuffers.has(pathKey)) continue
    const buffer = loadedBuffersByKey.get(pathKey)
    if (buffer) {
      uniqueBuffers.set(pathKey, buffer)
    }
  }
  return [...uniqueBuffers.values()]
}

function toRestoreLayoutInput(
  reconciledLayout: PersistedWorkspacePaneLayout,
  resolvedKeyByPathKey: ReadonlyMap<string, string>
): RestoreWorkspaceLayoutInput {
  const toRestorePane = (pane: PersistedWorkspacePaneState) => ({
    tabs: pane.tabs.map((tab) => ({
      bufferKey: resolvedKeyByPathKey.get(getWorkspacePathKey(tab.path))!,
      ...extractTabViewState(tab)
    })),
    activeTabKey: pane.activeTabPath
      ? (resolvedKeyByPathKey.get(getWorkspacePathKey(pane.activeTabPath)) ?? null)
      : null
  })

  return {
    splitMode: reconciledLayout.splitMode,
    splitRatio: reconciledLayout.splitRatio,
    activePaneId: reconciledLayout.activePaneId,
    panes: {
      primary: toRestorePane(reconciledLayout.panes.primary),
      secondary: toRestorePane(reconciledLayout.panes.secondary)
    }
  }
}

/**
 * Validates, opens, reconciles, and commits persisted workspace pane tabs without raising
 * error banners for missing or pruned files.
 */
export async function restoreWorkspacePaneLayout(
  syncTarget: WorkspaceLayoutSyncTarget,
  options: RestoreWorkspaceLayoutOptions
): Promise<RestoreWorkspaceLayoutResult> {
  const emptyResult = (
    restored: boolean,
    hadPrunedTabs = false
  ): RestoreWorkspaceLayoutResult => ({
    restored,
    hadPrunedTabs,
    reconciledLayout: createEmptyPersistedWorkspaceLayout()
  })

  const normalizedRoot = resolveNormalizedWorkspacePath(options.rootPath)
  if (!normalizedRoot || !options.persistedLayout) {
    return emptyResult(true)
  }

  const primaryFiltered = filterPersistedPaneTabsForWorkspace(
    normalizedRoot,
    options.persistedLayout.panes.primary
  )
  const secondaryFiltered = filterPersistedPaneTabsForWorkspace(
    normalizedRoot,
    options.persistedLayout.panes.secondary
  )
  let hadPrunedTabs = primaryFiltered.hadInvalid || secondaryFiltered.hadInvalid

  if (primaryFiltered.tabs.length === 0 && secondaryFiltered.tabs.length === 0) {
    const hadNonEmptyLayout =
      options.persistedLayout.splitMode !== 'single' ||
      options.persistedLayout.panes.primary.tabs.length > 0 ||
      options.persistedLayout.panes.secondary.tabs.length > 0
    return emptyResult(true, hadPrunedTabs || hadNonEmptyLayout)
  }

  const { filesToOpen, hadMissingImage, cancelled } = await verifyAndCollectRestorableFiles(
    syncTarget,
    options,
    [...primaryFiltered.tabs, ...secondaryFiltered.tabs]
  )
  if (cancelled) {
    return emptyResult(false)
  }
  hadPrunedTabs = hadPrunedTabs || hadMissingImage

  const loadedBuffersByKey = await syncTarget.openWorkspaceFilesSilently(filesToOpen)
  if (!syncTarget.isMounted || options.isCancelled?.()) {
    return emptyResult(false)
  }

  const { reconciledLayout, hadDroppedTabs: hadDroppedLoadedTabs } = reconcileLoadedWorkspaceLayout(
    normalizedRoot,
    options.persistedLayout,
    primaryFiltered.tabs,
    secondaryFiltered.tabs,
    (tabPath) => loadedBuffersByKey.get(getWorkspacePathKey(tabPath))?.path ?? null
  )
  hadPrunedTabs = hadPrunedTabs || hadDroppedLoadedTabs

  const loadedBuffers = collectBuffersToCommit(reconciledLayout, loadedBuffersByKey)
  const committed = syncTarget.commitRestoredWorkspaceLayout(
    loadedBuffers,
    (resolvedKeyByPathKey) => toRestoreLayoutInput(reconciledLayout, resolvedKeyByPathKey)
  )
  if (!committed) {
    return emptyResult(false)
  }

  return {
    restored: true,
    hadPrunedTabs,
    reconciledLayout
  }
}
