import { type ReactNode, type Ref, useCallback, useMemo, useRef, useState, useSyncExternalStore } from 'react'
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
import type { PaneNavigationCoordinator } from '../stores/PaneNavigationCoordinator'
import { getPaneActiveTab, type PaneId } from '../stores/PaneTabStore'
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
import { FrontmatterSchemaModal } from './FrontmatterSchemaModal'
import type { GitDiffContentState, GitDiffNavigationProps } from './GitDiffViewer'
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
    getDiffNavigation?: (request: GitDiffRequest) => GitDiffNavigationProps | undefined
    workspaceMarkdownFiles?: readonly WorkspaceEntry[]
  }
): WindowFramePaneWorkspaceProps {
  return {
    layout: editor.layout,
    buffers: editor.buffers,
    diffsByKey: extras?.diffsByKey ?? {},
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
  titleBarSlot?: ReactNode
  leftSidebarSlot?: ReactNode
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
  titleBarSlot,
  leftSidebarSlot,
  settingsPanelSlot,
  manualModalSlot,
  isSchemaModalDismissDisabled = false
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

  const paneFind = usePaneDocumentFind({
    layout: paneWorkspaceProps.layout,
    buffers: paneWorkspaceProps.buffers,
    workspaceRootPath,
    isShortcutDisabled: Boolean(paneWorkspaceProps.isShortcutDisabled),
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

  const paneActions = useMemo<PaneInteractionActions>(
    () => ({
      ...paneWorkspaceProps.actions,
      onNavigateLink: handleNavigateMarkdownLink
    }),
    [handleNavigateMarkdownLink, paneWorkspaceProps.actions]
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

        <ImageTransferContext.Provider
          value={imageTransferContextValue ?? DEFAULT_IMAGE_TRANSFER_CONTEXT}
        >
          <PaneWorkspace
            {...paneWorkspaceProps}
            scrollRequest={navState.outlineScrollRequest}
            searchJumpRequest={navState.searchJumpRequest}
            getPaneFindControl={paneFind.getPaneFindControl}
            onActiveHeadingChange={navigation.reportActiveHeading}
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
                  activeHeadingIndex: navState.activeHeadingIndex,
                  onSelectHeading: navigation.selectOutlineHeading,
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
