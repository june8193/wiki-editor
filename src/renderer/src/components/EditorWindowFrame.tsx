import { type ReactNode, type Ref, useCallback, useMemo, useRef, useState } from 'react'
import { ListTree } from 'lucide-react'
import type { AppConfig } from '@shared/config'
import type { DocumentSearchJumpRequest } from '@shared/search'
import type { WorkspaceEntry } from '@shared/workspace'
import { isMarkdownDocument, type SidebarDocumentContext } from '../editor/editorModes'
import type { ConfirmDialogState } from '../hooks/useConfirmDialog'
import { useDocumentOutline } from '../hooks/useDocumentOutline'
import {
  ImageTransferContext,
  type ImageTransferContextValue
} from '../hooks/useEditorImageTransfer'
import { useFrontmatterSchema } from '../hooks/useFrontmatterSchema'
import {
  useMarkdownLinkNavigation,
  type UseMarkdownLinkNavigationOptions
} from '../hooks/useMarkdownLinkNavigation'
import { usePaneDocumentFind } from '../hooks/usePaneDocumentFind'
import { getPaneActiveTab } from '../stores/PaneTabStore'
import {
  createTwoSectionSplitState,
  toggleBottomSectionCollapsed,
  toggleTopSectionCollapsed,
  type TwoSectionSplitState,
  updateTopSectionRatio
} from '../utils/accordionSplit'
import { getGitFileBaseName } from '../utils/gitFilePresentation'
import {
  clampSidebarWidth,
  RIGHT_SIDEBAR_DEFAULT_WIDTH,
  RIGHT_SIDEBAR_WIDTH_BOUNDS
} from '../utils/sidebarWidth'
import { ConfirmDialog } from './ConfirmDialog'
import type { GitDiffContentState } from './GitDiffViewer'
import type { PaneInteractionActions } from './PaneTabBar'
import { PaneWorkspace, type PaneWorkspaceProps } from './PaneWorkspace'
import {
  RIGHT_SIDEBAR_DEFAULT_OUTLINE_RATIO,
  RightSidebarPanel
} from './RightSidebarPanel'
import { SidebarResizer } from './SidebarResizer'

const DEFAULT_IMAGE_TRANSFER_CONTEXT: ImageTransferContextValue = {}

interface RightSidebarState {
  isCollapsed: boolean
  width: number
}

export type WindowFramePaneWorkspaceProps = Omit<
  PaneWorkspaceProps,
  'scrollRequest' | 'searchJumpRequest' | 'onActiveHeadingChange' | 'getPaneFindControl'
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
    workspaceMarkdownFiles?: readonly WorkspaceEntry[]
  }
): WindowFramePaneWorkspaceProps {
  return {
    layout: editor.layout,
    buffers: editor.buffers,
    diffsByKey: extras?.diffsByKey ?? {},
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

export interface EditorWindowFrameProps {
  shellRef?: Ref<HTMLDivElement>
  paneWorkspaceProps: WindowFramePaneWorkspaceProps
  searchJumpRequest?: DocumentSearchJumpRequest | null
  showHeadingNumbers: boolean
  onToggleHeadingNumbers: () => void
  workspaceRootPath?: string | null
  openWorkspaceFile: UseMarkdownLinkNavigationOptions['openWorkspaceFile']
  reportErrorBanner: UseMarkdownLinkNavigationOptions['reportErrorBanner']
  imageTransferContextValue?: ImageTransferContextValue
  initialRightSidebarCollapsed?: boolean
  errorMessage: string | null
  pendingDialog: ConfirmDialogState | null
  onDismissDialog: () => void
  leftSidebarSlot?: ReactNode
  settingsPanelSlot?: ReactNode
}

/**
 * Shared window frame rendering the error banner, optional activity bar and left sidebar slot,
 * pane workspace, collapsible right sidebar (document outline), optional settings panel slot,
 * and confirm dialog.
 */
export function EditorWindowFrame({
  shellRef,
  paneWorkspaceProps,
  searchJumpRequest = null,
  showHeadingNumbers,
  onToggleHeadingNumbers,
  workspaceRootPath = null,
  openWorkspaceFile,
  reportErrorBanner,
  imageTransferContextValue,
  initialRightSidebarCollapsed = false,
  errorMessage,
  pendingDialog,
  onDismissDialog,
  leftSidebarSlot,
  settingsPanelSlot
}: EditorWindowFrameProps) {
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

  const { schemaResult, isSchemaLoading, createDefaultSchema } = useFrontmatterSchema({
    workspaceRootPath,
    onError: reportErrorBanner
  })

  const paneFind = usePaneDocumentFind({
    layout: paneWorkspaceProps.layout,
    buffers: paneWorkspaceProps.buffers,
    workspaceRootPath,
    isShortcutDisabled: Boolean(paneWorkspaceProps.isShortcutDisabled),
    shellRef: localShellRef
  })

  const outline = useDocumentOutline(
    paneWorkspaceProps.layout,
    paneWorkspaceProps.buffers,
    paneWorkspaceProps.actions
  )

  const handleNavigateMarkdownLink = useMarkdownLinkNavigation({
    panes: paneWorkspaceProps.layout.panes,
    buffers: paneWorkspaceProps.buffers,
    workspaceRootPath,
    openWorkspaceFile,
    dispatchHeadingScroll: outline.dispatchHeadingScroll,
    reportErrorBanner
  })

  const paneActions = useMemo<PaneInteractionActions>(
    () => ({
      ...outline.paneActions,
      onNavigateLink: handleNavigateMarkdownLink
    }),
    [handleNavigateMarkdownLink, outline.paneActions]
  )

  const activePane = paneWorkspaceProps.layout.panes[paneWorkspaceProps.layout.activePaneId]
  const activeTab = getPaneActiveTab(activePane)
  const activeBuffer =
    activeTab?.kind === 'document' ? paneWorkspaceProps.buffers[activeTab.bufferKey] : undefined
  const activeBufferKey = activeBuffer?.key ?? null
  const rightSidebarDocument: SidebarDocumentContext = {
    documentName:
      activeTab?.kind === 'diff'
        ? getGitFileBaseName(activeTab.diff.request.path)
        : (activeBuffer?.name ?? null),
    documentKey: activeBufferKey,
    content: activeBuffer?.content ?? '',
    isMarkdownDocument: activeBuffer ? isMarkdownDocument(activeBuffer) : false
  }
  const onOutlinePaneChangeContent = outline.paneActions.onChangeContent

  const handlePropertiesChangeContent = useCallback(
    (nextContent: string): void => {
      if (!activeBufferKey) return
      onOutlinePaneChangeContent(activeBufferKey, nextContent)
    },
    [activeBufferKey, onOutlinePaneChangeContent]
  )

  return (
    <div ref={setMergedShellRef} className="app-shell" data-theme={paneWorkspaceProps.theme}>
      {errorMessage && (
        <div className="error-banner" role="alert">
          {errorMessage}
        </div>
      )}

      <main className="app-main">
        {leftSidebarSlot}

        <ImageTransferContext.Provider
          value={imageTransferContextValue ?? DEFAULT_IMAGE_TRANSFER_CONTEXT}
        >
          <PaneWorkspace
            {...paneWorkspaceProps}
            scrollRequest={outline.scrollRequest}
            searchJumpRequest={searchJumpRequest}
            getPaneFindControl={paneFind.getPaneFindControl}
            onActiveHeadingChange={outline.handleActiveHeadingChange}
            actions={paneActions}
          />
        </ImageTransferContext.Provider>

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
                  activeHeadingIndex: outline.activeHeadingIndex,
                  onSelectHeading: outline.selectHeading,
                  showHeadingNumbers,
                  onToggleHeadingNumbers,
                  onCollapse: handleCollapseRightSidebar
                }}
                propertiesProps={{
                  schemaResult,
                  isSchemaLoading,
                  onChangeContent: handlePropertiesChangeContent,
                  onCreateDefaultSchema: createDefaultSchema
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

      {settingsPanelSlot}

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
