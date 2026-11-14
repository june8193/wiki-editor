import { CSSProperties } from 'react'
import { DocumentBufferSnapshot } from '../stores/DocumentBufferStore'
import { CursorPosition, PaneId, PaneState } from '../stores/PaneTabStore'
import { DocumentEditor } from './DocumentEditor'
import { DraggingTabPayload, PaneTabBar, parseDraggingTabPayload } from './PaneTabBar'

interface PaneViewProps {
  pane: PaneState
  isActivePane: boolean
  flexRatio?: number
  autoSave: boolean
  buffers: DocumentBufferSnapshot
  draggingTab: DraggingTabPayload | null
  onDragStartTab: (payload: DraggingTabPayload) => void
  onDragEndTab: () => void
  onFocusPane: (paneId: PaneId) => void
  onActivateTab: (paneId: PaneId, tabId: string) => void
  onCloseTab: (paneId: PaneId, tabId: string) => void
  onMoveTab: (
    sourcePaneId: PaneId,
    targetPaneId: PaneId,
    tabId: string,
    targetIndex?: number
  ) => void
  onDuplicateTab: (sourcePaneId: PaneId, tabId: string) => void
  onChangeContent: (bufferKey: string, nextContent: string) => void
  onSaveBuffer: (bufferKey: string) => void
  onUpdateTabViewState: (
    paneId: PaneId,
    tabId: string,
    patch: { cursor?: CursorPosition; scrollTop?: number }
  ) => void
}

export function PaneView({
  pane,
  isActivePane,
  flexRatio,
  autoSave,
  buffers,
  draggingTab,
  onDragStartTab,
  onDragEndTab,
  onFocusPane,
  onActivateTab,
  onCloseTab,
  onMoveTab,
  onDuplicateTab,
  onChangeContent,
  onSaveBuffer,
  onUpdateTabViewState
}: PaneViewProps) {
  const activeTab = pane.activeTabId
    ? (pane.tabs.find((tab) => tab.id === pane.activeTabId) ?? null)
    : null
  const activeBuffer = activeTab ? (buffers[activeTab.bufferKey] ?? null) : null
  const paneStyle: CSSProperties | undefined =
    flexRatio !== undefined ? { flex: `${flexRatio} 1 0%` } : undefined

  return (
    <section
      className={`workspace-pane${isActivePane ? ' is-active-pane' : ''}`}
      data-testid={`pane-${pane.id}`}
      aria-label={pane.id === 'primary' ? '주 편집기 영역' : '보조 편집기 영역'}
      style={paneStyle}
      onMouseDown={() => onFocusPane(pane.id)}
      onFocusCapture={() => onFocusPane(pane.id)}
      onDragOver={(event) => {
        if (draggingTab) {
          event.preventDefault()
        }
      }}
      onDrop={(event) => {
        const payload = parseDraggingTabPayload(event, draggingTab)
        if (!payload || payload.paneId === pane.id) return
        event.preventDefault()
        onMoveTab(payload.paneId, pane.id, payload.tabId)
        onDragEndTab()
      }}
    >
      {pane.tabs.length > 0 && (
        <PaneTabBar
          paneId={pane.id}
          tabs={pane.tabs}
          activeTabId={pane.activeTabId}
          buffers={buffers}
          draggingTab={draggingTab}
          onDragStartTab={onDragStartTab}
          onDragEndTab={onDragEndTab}
          onActivateTab={onActivateTab}
          onCloseTab={onCloseTab}
          onMoveTab={onMoveTab}
          onDuplicateTab={onDuplicateTab}
        />
      )}

      {activeTab && activeBuffer ? (
        <DocumentEditor
          key={activeTab.id}
          document={activeBuffer}
          tab={activeTab}
          autoSave={autoSave}
          onChangeContent={(nextContent) => onChangeContent(activeBuffer.key, nextContent)}
          onSave={() => onSaveBuffer(activeBuffer.key)}
          onUpdateViewState={(patch) => onUpdateTabViewState(pane.id, activeTab.id, patch)}
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
