import type { ReactNode } from 'react'
import { ListTree } from 'lucide-react'
import type { WindowEditorShellState } from '../hooks/useWindowEditorShell'
import { RIGHT_SIDEBAR_WIDTH_BOUNDS } from '../utils/sidebarWidth'
import { ConfirmDialog } from './ConfirmDialog'
import { DocumentOutlinePanel } from './DocumentOutlinePanel'
import { PaneWorkspace } from './PaneWorkspace'
import { SidebarResizer } from './SidebarResizer'

export interface EditorWindowFrameProps {
  shell: WindowEditorShellState
  canDetachToNewWindow: boolean
  leftChrome?: ReactNode
  overlay?: ReactNode
}

/**
 * Shared editor shell frame rendering error banner, optional left chrome, multi-pane editor
 * workspace, right document outline sidebar, optional overlays, and confirmation dialogs.
 */
export function EditorWindowFrame({
  shell,
  canDetachToNewWindow,
  leftChrome,
  overlay
}: EditorWindowFrameProps) {
  return (
    <div className="app-shell" data-theme={shell.config.theme}>
      {shell.errorMessage && (
        <div className="error-banner" role="alert">
          {shell.errorMessage}
        </div>
      )}

      <main className="app-main">
        {leftChrome}

        <PaneWorkspace
          layout={shell.layout}
          buffers={shell.buffers}
          theme={shell.config.theme}
          autoSave={shell.config.autoSave}
          showHeadingNumbers={shell.config.showHeadingNumbers}
          customCommands={shell.config.customCommands}
          scrollRequest={shell.outlineScrollRequest}
          isShortcutDisabled={shell.isEditorShortcutDisabled}
          canDetachToNewWindow={canDetachToNewWindow}
          onSetSplitRatio={shell.setSplitRatio}
          onSplitWithTab={shell.splitWithTab}
          actions={shell.paneActions}
        />

        {!shell.rightSidebar.isCollapsed ? (
          <>
            <SidebarResizer
              edge="left"
              width={shell.rightSidebar.width}
              bounds={RIGHT_SIDEBAR_WIDTH_BOUNDS}
              ariaLabel="우측 사이드바 너비 조절"
              onResize={shell.handleResizeRightSidebar}
            />
            <aside
              className="right-sidebar"
              aria-label="우측 사이드바"
              style={{ width: `${shell.rightSidebar.width}px` }}
            >
              <DocumentOutlinePanel
                documentName={shell.activeBuffer?.name ?? null}
                content={shell.activeBuffer?.content ?? ''}
                isMarkdownDocument={shell.isActiveMarkdown}
                showHeadingNumbers={shell.config.showHeadingNumbers}
                onToggleHeadingNumbers={shell.toggleShowHeadingNumbers}
                onSelectHeading={shell.handleSelectOutlineHeading}
                onInsertToc={shell.handleOutlineInsertToc}
                onApplyHeadingNumbers={shell.handleOutlineApplyHeadingNumbers}
                onStripHeadingNumbers={shell.handleOutlineStripHeadingNumbers}
                onCollapse={shell.handleCollapseRightSidebar}
              />
            </aside>
          </>
        ) : (
          <button
            type="button"
            className="right-sidebar-expand-tab"
            aria-label="문서 목차 펼치기"
            title="문서 목차 펼치기"
            onClick={shell.handleExpandRightSidebar}
          >
            <ListTree size={18} strokeWidth={1.75} aria-hidden="true" />
          </button>
        )}
      </main>

      {overlay}

      {shell.pendingDialog && (
        <ConfirmDialog
          title={shell.pendingDialog.title}
          message={shell.pendingDialog.message}
          confirmLabel={shell.pendingDialog.confirmLabel}
          secondaryLabel={shell.pendingDialog.secondaryLabel}
          onConfirm={() => void shell.pendingDialog!.onConfirm()}
          onSecondary={
            shell.pendingDialog.onSecondary
              ? () => void shell.pendingDialog!.onSecondary!()
              : undefined
          }
          onCancel={() => {
            shell.pendingDialog?.onCancel?.()
            shell.setPendingDialog(null)
          }}
        />
      )}
    </div>
  )
}
