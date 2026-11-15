import { CSSProperties, SyntheticEvent } from 'react'
import type { CustomCommandConfig, ThemeMode } from '@shared/config'
import { DocumentBufferSnapshot } from '../stores/DocumentBufferStore'
import { getPaneActiveTab, PaneState, SplitMode } from '../stores/PaneTabStore'
import {
  DocumentEditor,
  type OutlineActiveHeadingReport,
  type OutlineScrollRequest
} from './DocumentEditor'
import {
  DraggingTabPayload,
  handleTabMoveDrop,
  isPaneTabTriggerTarget,
  PaneInteractionActions,
  PaneTabBar
} from './PaneTabBar'

interface PaneViewProps {
  pane: PaneState
  splitMode: SplitMode
  isActivePane: boolean
  flexRatio?: number
  theme: ThemeMode
  autoSave: boolean
  showHeadingNumbers?: boolean
  customCommands?: readonly CustomCommandConfig[]
  scrollRequest?: OutlineScrollRequest | null
  isShortcutDisabled?: boolean
  buffers: DocumentBufferSnapshot
  draggingTab: DraggingTabPayload | null
  onDragStartTab: (payload: DraggingTabPayload) => void
  onDragEndTab: () => void
  onActiveHeadingChange?: (report: OutlineActiveHeadingReport) => void
  actions: PaneInteractionActions
}

export function PaneView({
  pane,
  splitMode,
  isActivePane,
  flexRatio,
  theme,
  autoSave,
  showHeadingNumbers = true,
  customCommands,
  scrollRequest = null,
  isShortcutDisabled = false,
  buffers,
  draggingTab,
  onDragStartTab,
  onDragEndTab,
  onActiveHeadingChange,
  actions
}: PaneViewProps) {
  const activeTab = getPaneActiveTab(pane)
  const activeBuffer = activeTab ? (buffers[activeTab.bufferKey] ?? null) : null
  const activeScrollRequest =
    activeTab && scrollRequest && scrollRequest.paneId === pane.id && scrollRequest.tabId === activeTab.id
      ? scrollRequest
      : null
  const canMoveToSplit = !(splitMode === 'single' && pane.tabs.length <= 1)
  const paneStyle: CSSProperties | undefined =
    flexRatio !== undefined ? { flex: `${flexRatio} 1 0%` } : undefined
  const handlePaneFocusEvent = (event: SyntheticEvent): void => {
    if (!isPaneTabTriggerTarget(event.target)) {
      actions.onFocusPane(pane.id)
    }
  }

  return (
    <section
      className={`workspace-pane${isActivePane ? ' is-active-pane' : ''}`}
      data-testid={`pane-${pane.id}`}
      aria-label={pane.id === 'primary' ? '주 편집기 영역' : '보조 편집기 영역'}
      style={paneStyle}
      onMouseDown={handlePaneFocusEvent}
      onFocusCapture={handlePaneFocusEvent}
      onDragOver={(event) => {
        if (draggingTab) {
          event.preventDefault()
        }
      }}
      onDrop={(event) =>
        handleTabMoveDrop(event, draggingTab, onDragEndTab, pane.id, actions.onMoveTab, {
          ignoreSamePane: true
        })
      }
    >
      {pane.tabs.length > 0 && (
        <PaneTabBar
          paneId={pane.id}
          tabs={pane.tabs}
          activeTabId={pane.activeTabId}
          canMoveToSplit={canMoveToSplit}
          buffers={buffers}
          draggingTab={draggingTab}
          onDragStartTab={onDragStartTab}
          onDragEndTab={onDragEndTab}
          actions={actions}
        />
      )}

      {activeTab && activeBuffer ? (
        <DocumentEditor
          key={activeTab.id}
          document={activeBuffer}
          tab={activeTab}
          theme={theme}
          autoSave={autoSave}
          showHeadingNumbers={showHeadingNumbers}
          customCommands={customCommands}
          scrollRequest={activeScrollRequest}
          isShortcutDisabled={isShortcutDisabled}
          onChangeContent={(nextContent) => actions.onChangeContent(activeBuffer.key, nextContent)}
          onSave={() => actions.onSaveBuffer(activeBuffer.key)}
          onUpdateViewState={(patch) => actions.onUpdateTabViewState(pane.id, activeTab.id, patch)}
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
