import { type ReactNode, type Ref, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { ListTree } from 'lucide-react'
import type { AppConfig } from '@shared/config'
import { toErrorMessage } from '@shared/errors'
import { FRONTMATTER_SCHEMA_FILE } from '@shared/frontmatter'
import type { GitDiffRequest } from '@shared/git'
import type { WorkspaceEntry } from '@shared/workspace'
import { isMarkdownDocument, type SidebarDocumentContext } from '../editor/editorModes'
import type { ConfirmDialogState } from '../hooks/useConfirmDialog'
import {
  ImageTransferContext,
  type ImageTransferContextValue
} from '../hooks/useEditorImageTransfer'
import type { useFrontmatterFieldValues } from '../hooks/useFrontmatterFieldValues'
import type { useFrontmatterSchema } from '../hooks/useFrontmatterSchema'
import type { OpenedWorkspaceDocument } from '../hooks/useEditorWorkspace'
import {
  useMarkdownLinkNavigation,
  type UseMarkdownLinkNavigationOptions
} from '../hooks/useMarkdownLinkNavigation'
import { usePaneDocumentFind } from '../hooks/usePaneDocumentFind'
import { useSymbolNavigationController } from '../hooks/useSymbolNavigationController'
import { useWikiApi } from '../hooks/useWikiApi'
import type { PaneNavigationCoordinator } from '../stores/PaneNavigationCoordinator'
import { formatGitSnapshotTabKey, getPaneActiveTab, type PaneId } from '../stores/PaneTabStore'
import {
  createTwoSectionSplitState,
  toggleBottomSectionCollapsed,
  toggleTopSectionCollapsed,
  type TwoSectionSplitState,
  updateTopSectionRatio
} from '../utils/accordionSplit'
import { formatGitDiffTabKey, getGitFileBaseName } from '../utils/gitFilePresentation'
import {
  clampSidebarWidth,
  RIGHT_SIDEBAR_DEFAULT_WIDTH,
  RIGHT_SIDEBAR_WIDTH_BOUNDS
} from '../utils/sidebarWidth'
import { ConfirmDialog } from './ConfirmDialog'
import { FrontmatterSchemaModal } from './FrontmatterSchemaModal'
import type { GitDiffContentState, GitDiffNavigationProps } from './GitDiffViewer'
import type { SnapshotContentState } from './SnapshotViewer'
import type { PaneInteractionActions } from './PaneTabBar'
import { PaneWorkspace, type PaneWorkspaceProps } from './PaneWorkspace'
import {
  RIGHT_SIDEBAR_DEFAULT_OUTLINE_RATIO,
  RightSidebarPanel
} from './RightSidebarPanel'
import { SidebarResizer } from './SidebarResizer'
import { SymbolCandidatePopover } from './SymbolCandidatePopover'
import { SymbolContextMenu } from './SymbolContextMenu'
import { SymbolSearchPalette } from './SymbolSearchPalette'
import { isEventOutsideShell, isSymbolSearchShortcut } from '../utils/workspaceSearch'

const DEFAULT_IMAGE_TRANSFER_CONTEXT: ImageTransferContextValue = {}

interface RightSidebarState {
  isCollapsed: boolean
  width: number
}

export type WindowFramePaneWorkspaceProps = Omit<
  PaneWorkspaceProps,
  | 'scrollRequest'
  | 'searchJumpRequest'
  | 'diffJumpRequest'
  | 'snapshotJumpRequest'
  | 'historyByPane'
  | 'onActiveHeadingChange'
  | 'getPaneFindControl'
>

export function buildPaneWorkspaceProps(
  config: Pick<AppConfig, 'theme' | 'autoSave'>,
  editor: Pick<WindowFramePaneWorkspaceProps, 'layout' | 'buffers' | 'dragState'> & {
    paneActions: WindowFramePaneWorkspaceProps['actions']
    setSplitRatio: WindowFramePaneWorkspaceProps['onSetSplitRatio']
    splitWithTab: WindowFramePaneWorkspaceProps['onSplitWithTab']
  },
  isShortcutDisabled: boolean,
  extras?: {
    diffsByKey?: Record<string, GitDiffContentState>
    snapshotsByKey?: Record<string, SnapshotContentState>
    getDiffNavigation?: (request: GitDiffRequest) => GitDiffNavigationProps | undefined
    workspaceMarkdownFiles?: readonly WorkspaceEntry[]
  }
): WindowFramePaneWorkspaceProps {
  return {
    layout: editor.layout,
    buffers: editor.buffers,
    diffsByKey: extras?.diffsByKey ?? {},
    snapshotsByKey: extras?.snapshotsByKey,
    getDiffNavigation: extras?.getDiffNavigation,
    theme: config.theme,
    autoSave: config.autoSave,
    isShortcutDisabled,
    workspaceMarkdownFiles: extras?.workspaceMarkdownFiles,
    dragState: editor.dragState,
    onSetSplitRatio: editor.setSplitRatio,
    onSplitWithTab: editor.splitWithTab,
    actions: editor.paneActions
  }
}

export type FrontmatterSchemaController = ReturnType<typeof useFrontmatterSchema>
export type FrontmatterFieldValuesController = ReturnType<typeof useFrontmatterFieldValues>

export interface EditorWindowFrameProps {
  shellRef?: Ref<HTMLDivElement>
  paneWorkspaceProps: WindowFramePaneWorkspaceProps
  navigation: PaneNavigationCoordinator
  showHeadingNumbers: boolean
  onToggleHeadingNumbers: () => void
  workspaceRootPath?: string | null
  getActiveDiffChangedFiles?: (request: GitDiffRequest) => ReadonlySet<string> | undefined
  frontmatterSchema: FrontmatterSchemaController
  frontmatterFieldValues: FrontmatterFieldValuesController
  openWorkspaceFile: (
    filePath: string,
    targetPaneId?: PaneId,
    explicitName?: string,
    isCancelled?: () => boolean
  ) => Promise<OpenedWorkspaceDocument | null>
  reportErrorBanner: UseMarkdownLinkNavigationOptions['reportErrorBanner']
  imageTransferContextValue?: ImageTransferContextValue
  initialRightSidebarCollapsed?: boolean
  errorMessage: string | null
  pendingDialog: ConfirmDialogState | null
  onDismissDialog: () => void
  isSchemaModalOpen: boolean
  onOpenSchemaModal: () => void
  onCloseSchemaModal: () => void
  onSymbolPaletteOpenChange?: (isOpen: boolean) => void
  titleBarSlot?: ReactNode
  leftSidebarSlot?: ReactNode
  terminalPanelSlot?: ReactNode
  settingsPanelSlot?: ReactNode
  manualModalSlot?: ReactNode
  isSchemaModalDismissDisabled?: boolean
}

/**
 * Shared window frame rendering the error banner, optional activity bar and left sidebar slot,
 * pane workspace, collapsible right sidebar (document outline), optional settings panel slot,
 * schema management modal, and confirm dialog.
 */
export function EditorWindowFrame({
  shellRef,
  paneWorkspaceProps,
  navigation,
  showHeadingNumbers,
  onToggleHeadingNumbers,
  workspaceRootPath = null,
  getActiveDiffChangedFiles,
  frontmatterSchema,
  frontmatterFieldValues,
  openWorkspaceFile,
  reportErrorBanner,
  imageTransferContextValue,
  initialRightSidebarCollapsed = false,
  errorMessage,
  pendingDialog,
  onDismissDialog,
  isSchemaModalOpen,
  onOpenSchemaModal,
  onCloseSchemaModal,
  onSymbolPaletteOpenChange,
  titleBarSlot,
  leftSidebarSlot,
  terminalPanelSlot,
  settingsPanelSlot,
  manualModalSlot,
  isSchemaModalDismissDisabled = false
}: EditorWindowFrameProps) {
  const wikiApi = useWikiApi()
  const [rightSidebar, setRightSidebar] = useState<RightSidebarState>(() => ({
    isCollapsed: initialRightSidebarCollapsed,
    width: RIGHT_SIDEBAR_DEFAULT_WIDTH
  }))
  const [rightSidebarSplit, setRightSidebarSplit] = useState<TwoSectionSplitState>(() =>
    createTwoSectionSplitState(RIGHT_SIDEBAR_DEFAULT_OUTLINE_RATIO)
  )
  const localShellRef = useRef<HTMLDivElement | null>(null)
  const setMergedShellRef = useCallback(
    (node: HTMLDivElement | null): void => {
      localShellRef.current = node
      if (typeof shellRef === 'function') {
        shellRef(node)
      } else if (shellRef && 'current' in shellRef) {
        ;(shellRef as { current: HTMLDivElement | null }).current = node
      }
    },
    [shellRef]
  )

  const handleCollapseRightSidebar = useCallback((): void => {
    setRightSidebar((prev) => (prev.isCollapsed ? prev : { ...prev, isCollapsed: true }))
  }, [])

  const handleExpandRightSidebar = useCallback((): void => {
    setRightSidebar((prev) => (prev.isCollapsed ? { ...prev, isCollapsed: false } : prev))
  }, [])

  const handleResizeRightSidebar = useCallback((nextWidth: number): void => {
    const clampedWidth = clampSidebarWidth(nextWidth, RIGHT_SIDEBAR_WIDTH_BOUNDS)
    setRightSidebar((prev) =>
      prev.width === clampedWidth ? prev : { ...prev, width: clampedWidth }
    )
  }, [])

  const handleToggleOutlineCollapsed = useCallback((): void => {
    setRightSidebarSplit(toggleTopSectionCollapsed)
  }, [])

  const handleTogglePropertiesCollapsed = useCallback((): void => {
    setRightSidebarSplit(toggleBottomSectionCollapsed)
  }, [])

  const handleResizeOutlineRatio = useCallback((nextRatio: number): void => {
    setRightSidebarSplit((prev) =>
      updateTopSectionRatio(prev, nextRatio, RIGHT_SIDEBAR_DEFAULT_OUTLINE_RATIO)
    )
  }, [])

  const handleEnsureReferencesVisible = useCallback((): void => {
    setRightSidebar((prev) => (prev.isCollapsed ? { ...prev, isCollapsed: false } : prev))
    setRightSidebarSplit((prev) =>
      prev.isBottomCollapsed ? toggleBottomSectionCollapsed(prev) : prev
    )
  }, [])

  const {
    schemaResult,
    isSchemaLoading,
    createDefaultSchema,
    saveSchema,
    ensureSchemaFilePath
  } = frontmatterSchema
  const { valuesByField, refreshFieldValues } = frontmatterFieldValues
  const canManageSchema = Boolean(workspaceRootPath || schemaResult !== null)

  const workspaceRootRef = useRef(workspaceRootPath)
  workspaceRootRef.current = workspaceRootPath

  const openSchemaRawJsonFile = useCallback(async (): Promise<boolean> => {
    const startedRoot = workspaceRootRef.current
    const targetPath = await ensureSchemaFilePath()
    if (startedRoot !== workspaceRootRef.current) return false
    if (!targetPath) {
      throw new Error('프론트매터 스키마 파일을 준비하지 못했습니다.')
    }
    const opened = await openWorkspaceFile(
      targetPath,
      undefined,
      FRONTMATTER_SCHEMA_FILE,
      () => startedRoot !== workspaceRootRef.current
    )
    if (startedRoot !== workspaceRootRef.current) return false
    return Boolean(opened)
  }, [ensureSchemaFilePath, openWorkspaceFile])

  const [isSymbolPaletteOpen, setIsSymbolPaletteOpen] = useState(false)
  const updateSymbolPaletteOpen = useCallback(
    (nextOpen: boolean): void => {
      setIsSymbolPaletteOpen(nextOpen)
      onSymbolPaletteOpenChange?.(nextOpen)
    },
    [onSymbolPaletteOpenChange]
  )

  useEffect(() => {
    updateSymbolPaletteOpen(false)
  }, [updateSymbolPaletteOpen, workspaceRootPath])

  const effectiveShortcutDisabled = Boolean(paneWorkspaceProps.isShortcutDisabled) || isSymbolPaletteOpen

  const paneFind = usePaneDocumentFind({
    layout: paneWorkspaceProps.layout,
    buffers: paneWorkspaceProps.buffers,
    workspaceRootPath,
    isShortcutDisabled: effectiveShortcutDisabled,
    shellRef: localShellRef
  })

  const navState = useSyncExternalStore(navigation.subscribe, navigation.getSnapshot)

  const handleNavigateMarkdownLink = useMarkdownLinkNavigation({
    panes: paneWorkspaceProps.layout.panes,
    buffers: paneWorkspaceProps.buffers,
    workspaceRootPath,
    openWorkspaceFile,
    dispatchHeadingScroll: navigation.dispatchOutlineHeadingScroll,
    reportErrorBanner
  })

  const symbolNav = useSymbolNavigationController({
    layout: paneWorkspaceProps.layout,
    buffers: paneWorkspaceProps.buffers,
    diffsByKey: paneWorkspaceProps.diffsByKey,
    snapshotsByKey: paneWorkspaceProps.snapshotsByKey,
    workspaceRootPath,
    navigation,
    openSnapshotTab: paneWorkspaceProps.actions.onOpenSnapshotTab,
    getActiveDiffChangedFiles,
    onRevealReferencesSection: handleEnsureReferencesVisible,
    wikiApi
  })

  const paneActions = useMemo<PaneInteractionActions>(
    () => ({
      ...paneWorkspaceProps.actions,
      onNavigateLink: handleNavigateMarkdownLink,
      onSymbolNavigate: symbolNav.handleSymbolNavigate,
      onSymbolContextMenu: symbolNav.handleSymbolContextMenu,
      onFindReferences: symbolNav.handleFindReferences,
      onGoBack: (paneId) => void navigation.goBack(paneId),
      onGoForward: (paneId) => void navigation.goForward(paneId)
    }),
    [
      handleNavigateMarkdownLink,
      navigation,
      paneWorkspaceProps.actions,
      symbolNav.handleFindReferences,
      symbolNav.handleSymbolNavigate,
      symbolNav.handleSymbolContextMenu
    ]
  )

  const activePaneId = paneWorkspaceProps.layout.activePaneId
  const isShortcutDisabled = effectiveShortcutDisabled
  const isOtherModalOpen = Boolean(paneWorkspaceProps.isShortcutDisabled) && !isSymbolPaletteOpen
  const resolveActivePaletteScope = symbolNav.resolveActivePaletteScope
  useEffect(() => {
    const handleSymbolPaletteShortcut = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || !isSymbolSearchShortcut(event)) return
      if (isEventOutsideShell(event.target, localShellRef.current)) return
      if (isSymbolPaletteOpen) {
        event.preventDefault()
        updateSymbolPaletteOpen(false)
        return
      }
      if (isOtherModalOpen) return
      const scopeInfo = resolveActivePaletteScope()
      if (!scopeInfo.workspaceRootPath) return
      event.preventDefault()
      updateSymbolPaletteOpen(true)
    }
    window.addEventListener('keydown', handleSymbolPaletteShortcut)
    return () => {
      window.removeEventListener('keydown', handleSymbolPaletteShortcut)
    }
  }, [isOtherModalOpen, isSymbolPaletteOpen, resolveActivePaletteScope, updateSymbolPaletteOpen])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || isShortcutDisabled) return
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
      if (event.key === 'ArrowLeft') {
        event.preventDefault()
        void navigation.goBack(activePaneId)
      } else if (event.key === 'ArrowRight') {
        event.preventDefault()
        void navigation.goForward(activePaneId)
      }
    }
    const handleMouseUp = (event: MouseEvent): void => {
      if (isShortcutDisabled) return
      if (event.button === 3) {
        event.preventDefault()
        void navigation.goBack(activePaneId)
      } else if (event.button === 4) {
        event.preventDefault()
        void navigation.goForward(activePaneId)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [activePaneId, isShortcutDisabled, navigation])

  const activePane = paneWorkspaceProps.layout.panes[paneWorkspaceProps.layout.activePaneId]
  const activeTab = getPaneActiveTab(activePane)
  const activeBuffer =
    activeTab?.kind === 'document' ? paneWorkspaceProps.buffers[activeTab.bufferKey] : undefined
  const activeBufferKey = activeBuffer?.key ?? null
  const activeDiffKey =
    activeTab?.kind === 'diff' ? formatGitDiffTabKey(activeTab.diff.request) : null
  const activeDiffState = activeDiffKey ? paneWorkspaceProps.diffsByKey[activeDiffKey] : undefined
  const activeSnapshotKey =
    activeTab?.kind === 'snapshot' ? formatGitSnapshotTabKey(activeTab.snapshot.request) : null
  const activeSnapshotState = activeSnapshotKey
    ? paneWorkspaceProps.snapshotsByKey?.[activeSnapshotKey]
    : undefined
  const rightSidebarDocument: SidebarDocumentContext =
    activeTab?.kind === 'diff'
      ? {
          documentName: getGitFileBaseName(activeTab.diff.request.path),
          documentKey: activeDiffKey,
          content: '',
          isMarkdownDocument: false,
          diffContext: {
            rawPatch:
              activeDiffState?.status === 'loaded' ? activeDiffState.diff.rawPatch : null,
            filePath: activeTab.diff.request.path,
            status: activeTab.diff.request.status
          }
        }
      : activeTab?.kind === 'snapshot'
        ? {
            documentName: getGitFileBaseName(activeTab.snapshot.request.path),
            documentKey: activeSnapshotKey,
            content:
              activeSnapshotState?.status === 'loaded' && !activeSnapshotState.snapshot.isBinary
                ? activeSnapshotState.snapshot.content
                : '',
            isMarkdownDocument: false
          }
        : {
            documentName: activeBuffer?.name ?? null,
            documentKey: activeBufferKey,
            content: activeBuffer?.content ?? '',
            isMarkdownDocument: activeBuffer ? isMarkdownDocument(activeBuffer) : false
          }
  const onPaneChangeContent = paneWorkspaceProps.actions.onChangeContent

  const handlePropertiesChangeContent = useCallback(
    (nextContent: string): void => {
      if (!activeBufferKey) return
      onPaneChangeContent(activeBufferKey, nextContent)
    },
    [activeBufferKey, onPaneChangeContent]
  )

  return (
    <div ref={setMergedShellRef} className="app-shell" data-theme={paneWorkspaceProps.theme}>
      {titleBarSlot}
      {errorMessage && (
        <div className="error-banner" role="alert">
          {errorMessage}
        </div>
      )}

      <main className="app-main">
        {leftSidebarSlot}

        <div className="center-workspace-column">
          <ImageTransferContext.Provider
            value={imageTransferContextValue ?? DEFAULT_IMAGE_TRANSFER_CONTEXT}
          >
            <PaneWorkspace
              {...paneWorkspaceProps}
              isShortcutDisabled={effectiveShortcutDisabled}
              scrollRequest={navState.outlineScrollRequest}
              searchJumpRequest={navState.searchJumpRequest}
              diffJumpRequest={navState.diffJumpRequest}
              snapshotJumpRequest={navState.snapshotJumpRequest}
              historyByPane={navState.historyByPane}
              getPaneFindControl={paneFind.getPaneFindControl}
              onActiveHeadingChange={navigation.reportActiveHeading}
              actions={paneActions}
            />
          </ImageTransferContext.Provider>
          {terminalPanelSlot}
        </div>

        {!rightSidebar.isCollapsed ? (
          <>
            <SidebarResizer
              edge="left"
              width={rightSidebar.width}
              bounds={RIGHT_SIDEBAR_WIDTH_BOUNDS}
              ariaLabel="우측 사이드바 너비 조절"
              onResize={handleResizeRightSidebar}
            />
            <aside
              className="right-sidebar"
              aria-label="우측 사이드바"
              style={{ width: `${rightSidebar.width}px` }}
            >
              <RightSidebarPanel
                document={rightSidebarDocument}
                splitState={rightSidebarSplit}
                onToggleOutlineCollapsed={handleToggleOutlineCollapsed}
                onTogglePropertiesCollapsed={handleTogglePropertiesCollapsed}
                onResizeOutlineRatio={handleResizeOutlineRatio}
                outlineProps={{
                  activeHeadingIndex: navState.activeHeadingIndex,
                  onSelectHeading: navigation.selectOutlineHeading,
                  onSelectSymbol: navigation.selectOutlineSymbol,
                  showHeadingNumbers,
                  onToggleHeadingNumbers,
                  onCollapse: handleCollapseRightSidebar
                }}
                propertiesProps={{
                  schemaResult,
                  fieldValuesByKey: valuesByField,
                  isSchemaLoading,
                  canManageSchema,
                  onChangeContent: handlePropertiesChangeContent,
                  onCreateDefaultSchema: createDefaultSchema,
                  onRequestFieldValues: refreshFieldValues,
                  onOpenSchemaModal,
                  onOpenSchemaRawJson: () => {
                    const startedRoot = workspaceRootRef.current
                    reportErrorBanner(null)
                    void openSchemaRawJsonFile().catch((error: unknown) => {
                      if (startedRoot === workspaceRootRef.current) {
                        reportErrorBanner(
                          toErrorMessage(error, '프론트매터 스키마 파일을 준비하지 못했습니다.'),
                          error
                        )
                      }
                    })
                  }
                }}
                referencesProps={{
                  state: symbolNav.referencesState
                }}
              />
            </aside>
          </>
        ) : (
          <button
            type="button"
            className="right-sidebar-expand-tab"
            aria-label="문서 목차 펼치기"
            title="문서 목차 펼치기"
            onClick={handleExpandRightSidebar}
          >
            <ListTree size={18} strokeWidth={1.75} aria-hidden="true" />
          </button>
        )}
      </main>

      {isSchemaModalOpen && canManageSchema && (
        <FrontmatterSchemaModal
          schemaResult={schemaResult}
          isDismissDisabled={pendingDialog !== null || isSchemaModalDismissDisabled}
          shellRef={localShellRef}
          onSaveSchema={saveSchema}
          onOpenRawJson={async () => {
            const startedRoot = workspaceRootRef.current
            const opened = await openSchemaRawJsonFile()
            if (startedRoot !== workspaceRootRef.current) return
            if (!opened) {
              reportErrorBanner(null)
              throw new Error('스키마 JSON 파일을 열지 못했습니다.')
            }
            onCloseSchemaModal()
          }}
          onClose={onCloseSchemaModal}
        />
      )}

      {settingsPanelSlot}

      {manualModalSlot}

      <SymbolCandidatePopover
        popover={symbolNav.candidatePopover}
        notFoundNotice={symbolNav.notFoundTooltip}
        onSelectCandidate={symbolNav.selectCandidate}
        onDismiss={symbolNav.dismissPopover}
      />

      <SymbolContextMenu
        menu={symbolNav.contextMenu}
        onGoToDefinition={symbolNav.runContextMenuGoToDefinition}
        onFindReferences={symbolNav.runContextMenuFindReferences}
        onDismiss={symbolNav.dismissContextMenu}
        onClampPosition={symbolNav.clampContextMenuPosition}
      />

      {isSymbolPaletteOpen && (
        <SymbolSearchPalette
          isOpen={isSymbolPaletteOpen}
          scopeInfo={symbolNav.resolveActivePaletteScope()}
          searchSymbols={(request) =>
            wikiApi.workspace.searchSymbols?.(request) ?? Promise.resolve([])
          }
          onSelectMatch={(match, pinned) => {
            symbolNav.jumpToPaletteMatch(match, symbolNav.resolveActivePaletteScope(), pinned)
          }}
          onClose={() => updateSymbolPaletteOpen(false)}
        />
      )}

      {pendingDialog && (
        <ConfirmDialog
          title={pendingDialog.title}
          message={pendingDialog.message}
          confirmLabel={pendingDialog.confirmLabel}
          confirmTone={pendingDialog.confirmTone}
          secondaryLabel={pendingDialog.secondaryLabel}
          onConfirm={() => void pendingDialog.onConfirm()}
          onSecondary={
            pendingDialog.onSecondary ? () => void pendingDialog.onSecondary!() : undefined
          }
          onCancel={() => {
            pendingDialog.onCancel?.()
            onDismissDialog()
          }}
        />
      )}
    </div>
  )
}
