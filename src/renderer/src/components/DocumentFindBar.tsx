import { type KeyboardEvent } from 'react'
import { ChevronDown, ChevronUp, X } from 'lucide-react'
import type { SearchMatchOptions } from '@shared/search'
import { dispatchFindBarKeyAction } from '../editor/documentFind'
import { useSearchInputFocus } from '../hooks/useSearchInputFocus'
import type { SearchFocusRequest } from '../utils/workspaceSearch'
import { SearchOptionGroup } from './SearchOptionGroup'

export interface DocumentFindBarProps {
  query: string
  options: SearchMatchOptions
  matchCount: number
  activeMatchIndex: number
  errorMessage: string | null
  focusRequest: SearchFocusRequest | null
  onConsumeFocusNonce?: (nonce: number) => boolean
  onQueryChange: (nextQuery: string) => void
  onToggleOption: (optionKey: keyof SearchMatchOptions) => void
  onNextMatch: () => void
  onPreviousMatch: () => void
  onClose: () => void
}

/**
 * Floating in-document Find Bar rendered in the top-right corner of the active Document Editor body.
 */
export function DocumentFindBar({
  query,
  options,
  matchCount,
  activeMatchIndex,
  errorMessage,
  focusRequest,
  onConsumeFocusNonce,
  onQueryChange,
  onToggleOption,
  onNextMatch,
  onPreviousMatch,
  onClose
}: DocumentFindBarProps) {
  const inputRef = useSearchInputFocus(focusRequest, onConsumeFocusNonce)

  const keyHandlers = { onNextMatch, onPreviousMatch, onClose }

  const handleInputKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    dispatchFindBarKeyAction(event, { allowEnter: true }, keyHandlers)
  }

  const handleContainerKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    dispatchFindBarKeyAction(event, { allowEnter: false }, keyHandlers)
  }

  const countText =
    query.length === 0 || errorMessage !== null
      ? ''
      : matchCount === 0
        ? '결과 없음'
        : `${activeMatchIndex + 1} / ${matchCount}`

  return (
    <section
      className="document-find-bar"
      aria-label="문서 내 찾기 바"
      onKeyDown={handleContainerKeyDown}
    >
      <div className="document-find-row">
        <input
          ref={inputRef}
          type="text"
          className="document-find-input"
          aria-label="문서 내 검색어 입력"
          placeholder="찾기"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={handleInputKeyDown}
        />

        <SearchOptionGroup
          options={options}
          ariaLabel="문서 내 찾기 옵션"
          onToggleOption={onToggleOption}
        />

        <span
          className={`document-find-count${query.length > 0 && errorMessage === null && matchCount === 0 ? ' is-empty' : ''}`}
          aria-live="polite"
        >
          {countText}
        </span>

        <div className="document-find-nav-group">
          <button
            type="button"
            className="icon-btn document-find-nav-btn"
            aria-label="이전 일치"
            title="이전 일치 (Shift+Enter / Shift+F3)"
            disabled={matchCount === 0}
            onClick={onPreviousMatch}
          >
            <ChevronUp size={14} strokeWidth={1.75} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="icon-btn document-find-nav-btn"
            aria-label="다음 일치"
            title="다음 일치 (Enter / F3)"
            disabled={matchCount === 0}
            onClick={onNextMatch}
          >
            <ChevronDown size={14} strokeWidth={1.75} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="icon-btn document-find-close-btn"
            aria-label="찾기 바 닫기"
            title="닫기 (Esc)"
            onClick={onClose}
          >
            <X size={14} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </div>
      </div>

      {errorMessage && (
        <div className="document-find-error" role="alert">
          {errorMessage}
        </div>
      )}
    </section>
  )
}
