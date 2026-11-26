import { CSSProperties, SyntheticEvent, useCallback, useMemo } from 'react'
import type { ThemeMode } from '@shared/config'
import type { DocumentBufferSnapshot } from '@shared/documentBuffer'
import type { DocumentSearchJumpRequest } from '@shared/search'
import type { WorkspaceEntry } from '@shared/workspace'
import type { GitDiffRequest } from '@shared/git'
import type { OutlineActiveHeadingReport, OutlineScrollRequest } from '../editor/outlineScrollSpy'
import type {
  PaneDiffJumpRequest,
  PaneSnapshotJumpRequest
} from '../stores/PaneNavigationCoordinator'
import {
  formatGitSnapshotTabKey,
  getPaneActiveTab,
  GitDiffViewMode,
  PaneState,
  SplitMode
} from '../stores/PaneTabStore'
import { formatGitDiffTabKey } from '../utils/gitFilePresentation'
import { DocumentEditor, type DocumentEditorFindControl } from './DocumentEditor'
import {
  type GitDiffContentState,
  type GitDiffNavigationProps,
  GitDiffViewer
} from './GitDiffViewer'
import { type SnapshotContentState, SnapshotViewer } from './SnapshotViewer'
import {
  allowWikiTabDragOver,
  handleTabMoveDrop,
  type TabDragUiState,
  type TabDropMoveOptions
} from '../stores/tabDragDrop'
import { isPaneTabTriggerTarget, type PaneInteractionActions, PaneTabBar } from './PaneTabBar'

interface PaneViewProps {
  pane: PaneState
  splitMode: SplitMode
  isActivePane: boolean
  flexRatio?: number
  theme: ThemeMode
  autoSave: boolean
  scrollRequest?: OutlineScrollRequest | null
  searchJumpRequest?: DocumentSearchJumpRequest | null
  diffJumpRequest?: PaneDiffJumpRequest | null
  snapshotJumpRequest?: PaneSnapshotJumpRequest | null
  isShortcutDisabled?: boolean
  workspaceMarkdownFiles?: readonly WorkspaceEntry[]
  buffers: DocumentBufferSnapshot
  diffsByKey: Record<string, GitDiffContentState>
  snapshotsByKey?: Record<string, SnapshotContentState>
  getDiffNavigation?: (request: GitDiffRequest) => GitDiffNavigationProps | undefined
  dragState: TabDragUiState
  history?: { canGoBack: boolean; canGoForward: boolean }
  findControl?: DocumentEditorFindControl
  onActiveHeadingChange?: (report: OutlineActiveHeadingReport) => void
  actions: PaneInteractionActions
}

const LOADING_DIFF_STATE: GitDiffContentState = { status: 'loading' }
const LOADING_SNAPSHOT_STATE: SnapshotContentState = { status: 'loading' }

export function PaneView({
  pane,
  splitMode,
  isActivePane,
  flexRatio,
  theme,
  autoSave,
  scrollRequest = null,
  searchJumpRequest = null,
  diffJumpRequest = null,
  snapshotJumpRequest = null,
  isShortcutDisabled = false,
  workspaceMarkdownFiles,
  buffers,
  diffsByKey,
  snapshotsByKey,
  getDiffNavigation,
  dragState,
  history,
  findControl,
  onActiveHeadingChange,
  actions
}: PaneViewProps) {
  const activeTab = getPaneActiveTab(pane)
  const activeBuffer =
    activeTab?.kind === 'document' ? (buffers[activeTab.bufferKey] ?? null) : null
  const activeDiffState =
    activeTab?.kind === 'diff'
      ? (diffsByKey[formatGitDiffTabKey(activeTab.diff.request)] ?? LOADING_DIFF_STATE)
      : null
  const activeSnapshotState =
    activeTab?.kind === 'snapshot'
      ? (snapshotsByKey?.[formatGitSnapshotTabKey(activeTab.snapshot.request)] ??
          LOADING_SNAPSHOT_STATE)
      : null
  const activeDiffTabId = activeTab?.kind === 'diff' ? activeTab.id : null
  const handleChangeDiffViewMode = useCallback(
    (nextMode: GitDiffViewMode) => {
      if (activeDiffTabId) {
        actions.onChangeDiffViewMode(pane.id, activeDiffTabId, nextMode)
      }
    },
    [actions.onChangeDiffViewMode, pane.id, activeDiffTabId]
  )
  const onSymbolNavigate = actions.onSymbolNavigate
  const onSymbolContextMenu = actions.onSymbolContextMenu
  const onFindReferences = actions.onFindReferences
  const bindDiffSymbolHandler = useCallback(
    (
      handler:
        | ((
            paneId: typeof pane.id,
            tabId: string,
            req: import('../editor/symbolHoverDom').SymbolNavigateRequest
          ) => void)
        | undefined
    ) =>
      handler && activeDiffTabId
        ? (req: import('../editor/symbolHoverDom').SymbolNavigateRequest) =>
            handler(pane.id, activeDiffTabId, req)
        : undefined,
    [pane.id, activeDiffTabId]
  )
  const handleDiffSymbolNavigate = useMemo(
    () => bindDiffSymbolHandler(onSymbolNavigate),
    [bindDiffSymbolHandler, onSymbolNavigate]
  )
  const handleDiffSymbolContextMenu = useMemo(
    () => bindDiffSymbolHandler(onSymbolContextMenu),
    [bindDiffSymbolHandler, onSymbolContextMenu]
  )
  const handleDiffFindReferences = useMemo(
    () => bindDiffSymbolHandler(onFindReferences),
    [bindDiffSymbolHandler, onFindReferences]
  )
  const diffNavigation = useMemo(
    () => (activeTab?.kind === 'diff' ? getDiffNavigation?.(activeTab.diff.request) : undefined),
    [activeTab, getDiffNavigation]
  )
  const activeScrollRequest =
    activeTab && scrollRequest && scrollRequest.paneId === pane.id && scrollRequest.tabId === activeTab.id
      ? scrollRequest
      : null
  const activeSearchJumpRequest =
    activeTab &&
    searchJumpRequest &&
    searchJumpRequest.paneId === pane.id &&
    searchJumpRequest.tabId === activeTab.id
      ? searchJumpRequest
      : null
  const activeDiffJumpRequest =
    activeTab?.kind === 'diff' &&
    diffJumpRequest &&
    diffJumpRequest.paneId === pane.id &&
    diffJumpRequest.tabId === activeTab.id
      ? diffJumpRequest
      : null
  const activeSnapshotJumpRequest =
    activeTab?.kind === 'snapshot' &&
    snapshotJumpRequest &&
    snapshotJumpRequest.paneId === pane.id &&
    snapshotJumpRequest.tabId === activeTab.id
      ? snapshotJumpRequest
      : null
  const canMoveToSplit = !(splitMode === 'single' && pane.tabs.length <= 1)
  const paneStyle: CSSProperties | undefined =
    flexRatio !== undefined ? { flex: `${flexRatio} 1 0%` } : undefined
  const handlePaneFocusEvent = (event: SyntheticEvent): void => {
    if (!isPaneTabTriggerTarget(event.target)) {
      actions.onFocusPane(pane.id)
    }
  }

  const paneDropOptions: TabDropMoveOptions = {
    canAcceptExternal: pane.tabs.length === 0,
    ignoreSamePane: true
  }

  return (
    <section
      className={`workspace-pane${isActivePane ? ' is-active-pane' : ''}`}
      data-testid={`pane-${pane.id}`}
      aria-label={pane.id === 'primary' ? '주 편집기 영역' : '보조 편집기 영역'}
      style={paneStyle}
      onMouseDown={handlePaneFocusEvent}
      onFocusCapture={handlePaneFocusEvent}
      onDragOver={(event) => allowWikiTabDragOver(event, dragState, pane.id, paneDropOptions)}
      onDrop={(event) => handleTabMoveDrop(event, dragState, pane.id, actions, paneDropOptions)}
    >
      {pane.tabs.length > 0 && (
        <PaneTabBar
          paneId={pane.id}
          tabs={pane.tabs}
          activeTabId={pane.activeTabId}
          canMoveToSplit={canMoveToSplit}
          buffers={buffers}
          dragState={dragState}
          history={history}
          actions={actions}
        />
      )}

      {activeTab?.kind === 'diff' && activeDiffState ? (
        <GitDiffViewer
          request={activeTab.diff.request}
          viewMode={activeTab.diff.viewMode}
          state={activeDiffState}
          onChangeViewMode={handleChangeDiffViewMode}
          onOpenFile={actions.onOpenDiffTargetFile}
          onSymbolNavigate={onSymbolNavigate ? handleDiffSymbolNavigate : undefined}
          onSymbolContextMenu={onSymbolContextMenu ? handleDiffSymbolContextMenu : undefined}
          onFindReferences={onFindReferences ? handleDiffFindReferences : undefined}
          navigation={diffNavigation}
          jumpRequest={activeDiffJumpRequest}
        />
      ) : activeTab?.kind === 'snapshot' && activeSnapshotState ? (
        <SnapshotViewer
          key={activeTab.id}
          request={activeTab.snapshot.request}
          state={activeSnapshotState}
          scrollTop={activeTab.snapshot.scrollTop}
          jumpRequest={activeSnapshotJumpRequest}
          onScrollTopChange={(nextScrollTop) =>
            actions.onUpdateSnapshotScrollTop?.(pane.id, activeTab.id, nextScrollTop)
          }
          onOpenLocalFile={actions.onOpenSnapshotTargetFile}
          onSymbolNavigate={(req) => actions.onSymbolNavigate?.(pane.id, activeTab.id, req)}
          onSymbolContextMenu={(req) => actions.onSymbolContextMenu?.(pane.id, activeTab.id, req)}
          onFindReferences={(req) => actions.onFindReferences?.(pane.id, activeTab.id, req)}
        />
      ) : activeTab?.kind === 'document' && activeBuffer ? (
        <DocumentEditor
          key={activeTab.id}
          document={activeBuffer}
          tab={activeTab}
          theme={theme}
          autoSave={autoSave}
          scrollRequest={activeScrollRequest}
          searchJumpRequest={activeSearchJumpRequest}
          isActive={isActivePane}
          isShortcutDisabled={isShortcutDisabled}
          workspaceMarkdownFiles={workspaceMarkdownFiles}
          findControl={findControl}
          onChangeContent={(nextContent) => actions.onChangeContent(activeBuffer.key, nextContent)}
          onSave={() => actions.onSaveBuffer(activeBuffer.key)}
          onChangeEncoding={(nextEncoding) =>
            actions.onChangeEncoding?.(activeBuffer.key, nextEncoding)
          }
          onReopenWithEncoding={(targetEncoding) =>
            actions.onReopenWithEncoding?.(activeBuffer.key, targetEncoding)
          }
          onUpdateViewState={(patch) => actions.onUpdateTabViewState(pane.id, activeTab.id, patch)}
          onNavigateLink={(href) => actions.onNavigateLink?.(pane.id, activeTab.id, href)}
          onSymbolNavigate={
            actions.onSymbolNavigate
              ? (req) => actions.onSymbolNavigate!(pane.id, activeTab.id, req)
              : undefined
          }
          onSymbolContextMenu={
            actions.onSymbolContextMenu
              ? (req) => actions.onSymbolContextMenu!(pane.id, activeTab.id, req)
              : undefined
          }
          onFindReferences={
            actions.onFindReferences
              ? (req) => actions.onFindReferences!(pane.id, activeTab.id, req)
              : undefined
          }
          onActiveHeadingChange={
            onActiveHeadingChange
              ? (update) =>
                  onActiveHeadingChange({
                    context: {
                      paneId: pane.id,
                      tabId: activeTab.id,
                      mode: update.mode
                    },
                    headingIndex: update.headingIndex,
                    isUserScroll: update.isUserScroll
                  })
              : undefined
          }
        />
      ) : (
        <section className="workspace-placeholder">
          {pane.id === 'primary' ? (
            <>
              <p>마크다운 위키 에디터 준비 완료</p>
              <p className="workspace-placeholder-hint">
                폴더를 열어 문서를 선택하거나, 설정에서 config.json을 직접 편집할 수 있습니다.
              </p>
            </>
          ) : (
            <>
              <p>보조 분할 영역</p>
              <p className="workspace-placeholder-hint">
                탭을 이 영역으로 드래그하거나 탭 메뉴에서 분할 열기를 선택하세요.
              </p>
            </>
          )}
        </section>
      )}
    </section>
  )
}
