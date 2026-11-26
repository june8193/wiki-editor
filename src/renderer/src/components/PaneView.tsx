import { CSSProperties, SyntheticEvent, useCallback, useMemo } from 'react'
import type { ThemeMode } from '@shared/config'
import type { DocumentBufferSnapshot } from '@shared/documentBuffer'
import type { DocumentSearchJumpRequest } from '@shared/search'
import type { WorkspaceEntry } from '@shared/workspace'
import type { GitDiffRequest } from '@shared/git'
import type { OutlineActiveHeadingReport, OutlineScrollRequest } from '../editor/outlineScrollSpy'
import { getPaneActiveTab, GitDiffViewMode, PaneState, SplitMode } from '../stores/PaneTabStore'
import { formatGitDiffTabKey } from '../utils/gitFilePresentation'
import { DocumentEditor, type DocumentEditorFindControl } from './DocumentEditor'
import {
  type GitDiffContentState,
  type GitDiffNavigationProps,
  GitDiffViewer
} from './GitDiffViewer'
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
  isShortcutDisabled?: boolean
  workspaceMarkdownFiles?: readonly WorkspaceEntry[]
  buffers: DocumentBufferSnapshot
  diffsByKey: Record<string, GitDiffContentState>
  getDiffNavigation?: (request: GitDiffRequest) => GitDiffNavigationProps | undefined
  dragState: TabDragUiState
  findControl?: DocumentEditorFindControl
  onActiveHeadingChange?: (report: OutlineActiveHeadingReport) => void
  actions: PaneInteractionActions
}

const LOADING_DIFF_STATE: GitDiffContentState = { status: 'loading' }

export function PaneView({
  pane,
  splitMode,
  isActivePane,
  flexRatio,
  theme,
  autoSave,
  scrollRequest = null,
  searchJumpRequest = null,
  isShortcutDisabled = false,
  workspaceMarkdownFiles,
  buffers,
  diffsByKey,
  getDiffNavigation,
  dragState,
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
  const activeDiffTabId = activeTab?.kind === 'diff' ? activeTab.id : null
  const handleChangeDiffViewMode = useCallback(
    (nextMode: GitDiffViewMode) => {
      if (activeDiffTabId) {
        actions.onChangeDiffViewMode(pane.id, activeDiffTabId, nextMode)
      }
    },
    [actions.onChangeDiffViewMode, pane.id, activeDiffTabId]
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
          navigation={diffNavigation}
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
