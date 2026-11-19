import { type KeyboardEvent, useEffect, useRef } from 'react'
import { ChevronDown, ChevronUp, X } from 'lucide-react'
import type { SearchMatchOptions } from '@shared/search'
import { resolveFindBarKeyAction } from '../editor/documentFind'
import { SEARCH_OPTION_BUTTONS, type SearchFocusRequest } from '../utils/workspaceSearch'

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
  const inputRef = useRef<HTMLInputElement | null>(null)
  const lastHandledFocusNonceRef = useRef(0)

  useEffect(() => {
    if (!focusRequest || focusRequest.nonce === 0) return
    if (focusRequest.nonce === lastHandledFocusNonceRef.current) return
    if (onConsumeFocusNonce && !onConsumeFocusNonce(focusRequest.nonce)) {
      lastHandledFocusNonceRef.current = focusRequest.nonce
      return
    }
    lastHandledFocusNonceRef.current = focusRequest.nonce

    const input = inputRef.current
    if (!input) return
    input.focus()
    if (focusRequest.selectAll && input.value.length > 0) {
      input.select()
    }
  }, [focusRequest, onConsumeFocusNonce])

  const dispatchAction = (
    event: KeyboardEvent<HTMLElement>,
    action: 'next' | 'prev' | 'close' | null
  ): boolean => {
    if (!action) return false
    event.preventDefault()
    event.stopPropagation()
    if (action === 'next') {
      onNextMatch()
    } else if (action === 'prev') {
      onPreviousMatch()
    } else {
      onClose()
    }
    return true
  }

  const handleInputKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    const action = resolveFindBarKeyAction(
      {
        key: event.key,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        isComposing: event.nativeEvent.isComposing
      },
      { allowEnter: true }
    )
    dispatchAction(event, action)
  }

  const handleContainerKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    const action = resolveFindBarKeyAction(
      {
        key: event.key,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        isComposing: event.nativeEvent.isComposing
      },
      { allowEnter: false }
    )
    dispatchAction(event, action)
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

        <div className="search-options-group" role="group" aria-label="문서 내 찾기 옵션">
          {SEARCH_OPTION_BUTTONS.map((btn) => {
            const isActive = options[btn.key]
            return (
              <button
                key={btn.key}
                type="button"
                className={`search-option-btn${isActive ? ' is-active' : ''}`}
                aria-label={btn.ariaLabel}
                title={btn.title}
                aria-pressed={isActive}
                onClick={() => onToggleOption(btn.key)}
              >
                {btn.shortLabel}
              </button>
            )
          })}
        </div>

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
