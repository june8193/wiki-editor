import { type KeyboardEvent, type ReactNode } from 'react'
import { ChevronDown, ChevronRight, FileText, RotateCw } from 'lucide-react'
import type {
  SearchMatchOptions,
  TextMatchSpan,
  WorkspaceSearchFileResult,
  WorkspaceSearchLineMatch,
  WorkspaceSearchResponse
} from '@shared/search'
import { getWorkspacePathKey } from '@shared/workspace'
import { useSearchInputFocus } from '../hooks/useSearchInputFocus'
import { type SearchFocusRequest, splitTextByMatchSpans } from '../utils/workspaceSearch'
import { SearchOptionGroup } from './SearchOptionGroup'

function renderHighlightedText(text: string, spans: readonly TextMatchSpan[]): ReactNode {
  const segments = splitTextByMatchSpans(text, spans)
  return segments.map((segment, index) =>
    segment.isMatch ? (
      <mark key={index} className="search-match-highlight">
        {segment.text}
      </mark>
    ) : (
      segment.text
    )
  )
}

export interface SearchSidebarPanelProps {
  workspaceRootPath: string | null
  query: string
  options: SearchMatchOptions
  response: WorkspaceSearchResponse | null
  errorMessage: string | null
  isSearching: boolean
  collapsedFileKeys: ReadonlySet<string>
  focusRequest: SearchFocusRequest | null
  onQueryChange: (nextQuery: string, isComposing: boolean) => void
  onCompositionStart: () => void
  onCompositionEnd: (finalQuery: string) => void
  onSubmitSearch: () => void
  onToggleOption: (optionKey: keyof SearchMatchOptions) => void
  onToggleFileCollapsed: (filePath: string) => void
  onOpenFile: (file: WorkspaceSearchFileResult) => void
  onOpenLineMatch: (file: WorkspaceSearchFileResult, line: WorkspaceSearchLineMatch) => void
}

/**
 * Left sidebar Search View panel for workspace-wide filename, path, and text content search.
 */
export function SearchSidebarPanel({
  workspaceRootPath,
  query,
  options,
  response,
  errorMessage,
  isSearching,
  collapsedFileKeys,
  focusRequest,
  onQueryChange,
  onCompositionStart,
  onCompositionEnd,
  onSubmitSearch,
  onToggleOption,
  onToggleFileCollapsed,
  onOpenFile,
  onOpenLineMatch
}: SearchSidebarPanelProps) {
  const inputRef = useSearchInputFocus(focusRequest)

  const handleInputKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== 'Enter') return
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    event.preventDefault()
    onSubmitSearch()
  }

  const renderBody = () => {
    if (!workspaceRootPath) {
      return (
        <div className="sidebar-empty">
          <p className="sidebar-empty-text">열린 워크스페이스 없음</p>
          <p className="workspace-placeholder-hint">
            폴더를 열면 워크스페이스 전체 문서를 검색할 수 있습니다.
          </p>
        </div>
      )
    }

    if (errorMessage) {
      return (
        <div className="search-results-body">
          <div className="search-inline-error" role="alert">
            {errorMessage}
          </div>
        </div>
      )
    }

    if (query.length === 0) {
      return (
        <div className="sidebar-empty">
          <p className="sidebar-empty-text">검색어를 입력하세요.</p>
          <p className="workspace-placeholder-hint">
            파일명, 경로 및 텍스트 문서 내용을 검색합니다.
          </p>
        </div>
      )
    }

    if (isSearching && !response) {
      return (
        <div className="search-status-message" role="status">
          검색 중...
        </div>
      )
    }

    if (!response) {
      return null
    }

    const summaryText =
      response.totalMatchCount > 0
        ? `${response.totalFileCount}개 파일 · ${response.totalMatchCount}건 일치`
        : `${response.totalFileCount}개 파일 (파일명 일치)`

    return (
      <div className="search-results-body">
        {response.truncated && (
          <div className="search-truncated-banner" role="status">
            결과 상한에 도달해 일부 결과만 표시됩니다. 검색어를 더 구체화해 주세요.
          </div>
        )}

        {response.files.length === 0 ? (
          isSearching ? (
            <div className="search-status-message" role="status">
              검색 중...
            </div>
          ) : (
            <div className="sidebar-empty">
              <p className="sidebar-empty-text">일치하는 결과가 없습니다.</p>
            </div>
          )
        ) : (
          <>
            <div className="search-results-summary">
              <span>{summaryText}</span>
              {isSearching && <span className="search-summary-loading">검색 중...</span>}
            </div>
            <ul className="search-result-list" role="list" aria-label="검색 결과 목록">
              {response.files.map((file) => {
                const fileKey = getWorkspacePathKey(file.path)
                const hasLineMatches = file.lineMatches.length > 0
                const hasNameMatches = file.nameMatches.length > 0
                const isCollapsed = hasLineMatches && collapsedFileKeys.has(fileKey)
                return (
                  <li key={fileKey} className="search-file-group">
                    <button
                      type="button"
                      className={`search-file-header-btn${hasNameMatches ? ' is-name-match' : ''}`}
                      aria-expanded={hasLineMatches ? !isCollapsed : undefined}
                      title={file.relativePath}
                      onClick={() =>
                        hasLineMatches ? onToggleFileCollapsed(file.path) : onOpenFile(file)
                      }
                    >
                      <span className="search-file-icon" aria-hidden="true">
                        {hasLineMatches ? (
                          isCollapsed ? (
                            <ChevronRight size={14} strokeWidth={1.75} />
                          ) : (
                            <ChevronDown size={14} strokeWidth={1.75} />
                          )
                        ) : (
                          <FileText size={14} strokeWidth={1.75} />
                        )}
                      </span>
                      <span className="search-file-path">
                        {renderHighlightedText(file.relativePath, file.nameMatches)}
                      </span>
                      {file.totalMatchCount > 0 ? (
                        <span
                          className="search-file-badge"
                          aria-label={`일치 ${file.totalMatchCount}건`}
                        >
                          {file.totalMatchCount}
                        </span>
                      ) : (
                        <span className="search-file-badge is-name-only">파일명</span>
                      )}
                    </button>

                    {hasLineMatches && !isCollapsed && (
                      <ul className="search-line-list" role="list">
                        {file.lineMatches.map((line) => (
                          <li key={`${fileKey}:${line.lineNumber}`} className="search-line-row">
                            <button
                              type="button"
                              className="search-line-btn"
                              onClick={() => onOpenLineMatch(file, line)}
                            >
                              <span className="search-line-number">{line.lineNumber}</span>
                              <span className="search-line-text">
                                {renderHighlightedText(line.lineText, line.matches)}
                              </span>
                            </button>
                          </li>
                        ))}
                        {file.truncatedInFile && (
                          <li className="search-file-truncated-note">
                            일부 일치만 표시됨 (전체 {file.totalMatchCount}건)
                          </li>
                        )}
                      </ul>
                    )}
                  </li>
                )
              })}
            </ul>
          </>
        )}
      </div>
    )
  }

  return (
    <section className="search-sidebar" aria-label="검색 뷰">
      <div className="sidebar-header">
        <div className="sidebar-title-row">
          <span className="sidebar-title">검색</span>
          <button
            type="button"
            className="icon-btn search-refresh-btn"
            aria-label="검색 새로고침"
            title="새로고침"
            disabled={!workspaceRootPath || query.length === 0}
            onClick={onSubmitSearch}
          >
            <RotateCw size={14} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </div>

        <div className="search-controls">
          <input
            ref={inputRef}
            type="text"
            className="search-input"
            aria-label="검색어 입력"
            placeholder="검색어 입력"
            value={query}
            onChange={(event) => {
              const nativeEvent = event.nativeEvent as InputEvent | undefined
              onQueryChange(event.target.value, Boolean(nativeEvent?.isComposing))
            }}
            onCompositionStart={onCompositionStart}
            onCompositionEnd={(event) => onCompositionEnd(event.currentTarget.value)}
            onKeyDown={handleInputKeyDown}
          />
          <SearchOptionGroup
            options={options}
            ariaLabel="검색 옵션"
            onToggleOption={onToggleOption}
          />
        </div>
      </div>

      {renderBody()}
    </section>
  )
}
