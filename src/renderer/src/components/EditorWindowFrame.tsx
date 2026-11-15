import { type ReactNode, useCallback, useState } from 'react'
import { ListTree } from 'lucide-react'
import type { AppConfig } from '@shared/config'
import type { ConfirmDialogState } from '../hooks/useConfirmDialog'
import { useDocumentOutline } from '../hooks/useDocumentOutline'
import {
  clampSidebarWidth,
  RIGHT_SIDEBAR_DEFAULT_WIDTH,
  RIGHT_SIDEBAR_WIDTH_BOUNDS
} from '../utils/sidebarWidth'
import { ConfirmDialog } from './ConfirmDialog'
import { DocumentOutlinePanel } from './DocumentOutlinePanel'
import { PaneWorkspace, type PaneWorkspaceProps } from './PaneWorkspace'
import { SidebarResizer } from './SidebarResizer'

interface RightSidebarState {
  isCollapsed: boolean
  width: number
}

export type WindowFramePaneWorkspaceProps = Omit<PaneWorkspaceProps, 'scrollRequest'>

export function buildPaneWorkspaceProps(
  config: Pick<AppConfig, 'theme' | 'autoSave' | 'showHeadingNumbers' | 'customCommands'>,
  editor: Pick<WindowFramePaneWorkspaceProps, 'layout' | 'buffers' | 'dragState'> & {
    paneActions: WindowFramePaneWorkspaceProps['actions']
    setSplitRatio: WindowFramePaneWorkspaceProps['onSetSplitRatio']
    splitWithTab: WindowFramePaneWorkspaceProps['onSplitWithTab']
  },
  isShortcutDisabled: boolean
): WindowFramePaneWorkspaceProps {
  return {
    layout: editor.layout,
    buffers: editor.buffers,
    theme: config.theme,
    autoSave: config.autoSave,
    showHeadingNumbers: config.showHeadingNumbers,
    customCommands: config.customCommands,
    isShortcutDisabled,
    dragState: editor.dragState,
    onSetSplitRatio: editor.setSplitRatio,
    onSplitWithTab: editor.splitWithTab,
    actions: editor.paneActions
  }
}

export interface EditorWindowFrameProps {
  paneWorkspaceProps: WindowFramePaneWorkspaceProps
  onToggleHeadingNumbers: () => void
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
  paneWorkspaceProps,
  onToggleHeadingNumbers,
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

  const outline = useDocumentOutline(
    paneWorkspaceProps.layout,
    paneWorkspaceProps.buffers,
    paneWorkspaceProps.actions
  )

  return (
    <div className="app-shell" data-theme={paneWorkspaceProps.theme}>
      {errorMessage && (
        <div className="error-banner" role="alert">
          {errorMessage}
        </div>
      )}

      <main className="app-main">
        {leftSidebarSlot}

        <PaneWorkspace
          {...paneWorkspaceProps}
          scrollRequest={outline.scrollRequest}
          actions={outline.paneActions}
        />

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
              <DocumentOutlinePanel
                {...outline.documentOutlineProps}
                showHeadingNumbers={paneWorkspaceProps.showHeadingNumbers ?? true}
                onToggleHeadingNumbers={onToggleHeadingNumbers}
                onCollapse={handleCollapseRightSidebar}
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
