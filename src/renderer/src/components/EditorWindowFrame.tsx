import type { ReactNode } from 'react'
import { ListTree } from 'lucide-react'
import type { CustomCommandConfig, ThemeMode } from '@shared/config'
import type { PendingDialogState } from '../hooks/useWindowAlerts'
import { RIGHT_SIDEBAR_WIDTH_BOUNDS } from '../utils/sidebarWidth'
import { ConfirmDialog } from './ConfirmDialog'
import { DocumentOutlinePanel, type DocumentOutlinePanelProps } from './DocumentOutlinePanel'
import { PaneWorkspace, type PaneWorkspaceProps } from './PaneWorkspace'
import { SidebarResizer } from './SidebarResizer'

export interface EditorWindowFrameProps {
  theme: ThemeMode
  autoSave: boolean
  showHeadingNumbers: boolean
  customCommands: readonly CustomCommandConfig[]
  errorMessage: string | null
  pendingDialog: PendingDialogState | null
  onDismissDialog: () => void
  onToggleHeadingNumbers: () => void
  workspaceProps: Omit<PaneWorkspaceProps, 'theme' | 'autoSave' | 'showHeadingNumbers' | 'customCommands'>
  outlinePanelProps: Omit<
    DocumentOutlinePanelProps,
    'showHeadingNumbers' | 'onToggleHeadingNumbers' | 'onCollapse'
  >
  rightSidebar: {
    isCollapsed: boolean
    width: number
    onCollapse: () => void
    onExpand: () => void
    onResize: (nextWidth: number) => void
  }
  leftChrome?: ReactNode
  overlay?: ReactNode
}

/**
 * Shared editor shell frame rendering error banner, optional left chrome, multi-pane editor
 * workspace, right document outline sidebar, optional overlays, and confirmation dialogs.
 */
export function EditorWindowFrame({
  theme,
  autoSave,
  showHeadingNumbers,
  customCommands,
  errorMessage,
  pendingDialog,
  onDismissDialog,
  onToggleHeadingNumbers,
  workspaceProps,
  outlinePanelProps,
  rightSidebar,
  leftChrome,
  overlay
}: EditorWindowFrameProps) {
  return (
    <div className="app-shell" data-theme={theme}>
      {errorMessage && (
        <div className="error-banner" role="alert">
          {errorMessage}
        </div>
      )}

      <main className="app-main">
        {leftChrome}

        <PaneWorkspace
          {...workspaceProps}
          theme={theme}
          autoSave={autoSave}
          showHeadingNumbers={showHeadingNumbers}
          customCommands={customCommands}
        />

        {!rightSidebar.isCollapsed ? (
          <>
            <SidebarResizer
              edge="left"
              width={rightSidebar.width}
              bounds={RIGHT_SIDEBAR_WIDTH_BOUNDS}
              ariaLabel="우측 사이드바 너비 조절"
              onResize={rightSidebar.onResize}
            />
            <aside
              className="right-sidebar"
              aria-label="우측 사이드바"
              style={{ width: `${rightSidebar.width}px` }}
            >
              <DocumentOutlinePanel
                {...outlinePanelProps}
                showHeadingNumbers={showHeadingNumbers}
                onToggleHeadingNumbers={onToggleHeadingNumbers}
                onCollapse={rightSidebar.onCollapse}
              />
            </aside>
          </>
        ) : (
          <button
            type="button"
            className="right-sidebar-expand-tab"
            aria-label="문서 목차 펼치기"
            title="문서 목차 펼치기"
            onClick={rightSidebar.onExpand}
          >
            <ListTree size={18} strokeWidth={1.75} aria-hidden="true" />
          </button>
        )}
      </main>

      {overlay}

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
