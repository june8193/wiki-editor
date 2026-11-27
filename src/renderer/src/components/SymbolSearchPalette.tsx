import { type KeyboardEvent as ReactKeyboardEvent, useCallback, useEffect, useRef, useState } from 'react'
import { Search, X } from 'lucide-react'
import { toErrorMessage } from '@shared/errors'
import type { SymbolCandidateMatch, SymbolQueryRequest } from '@shared/symbol'
import { normalizeRepoPath, rankDeclarationCandidates } from '../editor/symbolNavigation'
import type { SymbolPaletteScopeInfo } from '../hooks/useSymbolNavigationController'
import { isKeyboardEventComposing } from '../utils/workspaceSearch'

export interface SymbolSearchPaletteProps {
  isOpen: boolean
  scopeInfo: SymbolPaletteScopeInfo
  searchSymbols: (request: SymbolQueryRequest) => Promise<SymbolCandidateMatch[]>
  onSelectMatch: (match: SymbolCandidateMatch, pinned: boolean) => void
  onClose: () => void
}

const SYMBOL_SEARCH_DEBOUNCE_MS = 160

/**
 * Floating `Ctrl+T` Symbol Search Palette for on-demand declaration search across the active
 * working-tree or Git Ref scope, prioritizing files changed in the current Diff/Compare context.
 */
export function SymbolSearchPalette({
  isOpen,
  scopeInfo,
  searchSymbols,
  onSelectMatch,
  onClose
}: SymbolSearchPaletteProps) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SymbolCandidateMatch[]>([])
  const [activeIndex, setActiveIndex] = useState(0)
  const [isLoading, setIsLoading] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [hasSearched, setHasSearched] = useState(false)

  const inputRef = useRef<HTMLInputElement | null>(null)
  const isComposingRef = useRef(false)
  const debounceTimerRef = useRef<number | null>(null)
  const requestSeqRef = useRef(0)
  const lastSearchedQueryRef = useRef('')

  const clearDebounce = useCallback(() => {
    if (debounceTimerRef.current !== null) {
      window.clearTimeout(debounceTimerRef.current)
      debounceTimerRef.current = null
    }
  }, [])

  const executeSearch = useCallback(
    async (rawQuery: string) => {
      const trimmed = rawQuery.trim()
      if (!trimmed) {
        requestSeqRef.current += 1
        lastSearchedQueryRef.current = ''
        setResults([])
        setActiveIndex(0)
        setIsLoading(false)
        setErrorMessage(null)
        setHasSearched(false)
        return
      }

      const seq = ++requestSeqRef.current
      lastSearchedQueryRef.current = trimmed
      setIsLoading(true)
      setErrorMessage(null)

      try {
        const rawMatches = await searchSymbols({
          declarationQuery: trimmed,
          scope: scopeInfo.scope,
          maxResults: 80
        })
        if (requestSeqRef.current !== seq) return

        const ranked = rankDeclarationCandidates(rawMatches, {
          currentFilePath: scopeInfo.currentFilePath,
          changedFilePaths: scopeInfo.changedFilePaths,
          isInActiveDiffHunk: scopeInfo.isInCurrentDiffHunk
            ? (candidate) => scopeInfo.isInCurrentDiffHunk!(candidate.path, candidate.lineNumber)
            : undefined
        })
        setResults(ranked)
        setActiveIndex(0)
        setHasSearched(true)
      } catch (error) {
        if (requestSeqRef.current !== seq) return
        setResults([])
        setActiveIndex(0)
        setHasSearched(true)
        setErrorMessage(toErrorMessage(error, '심볼을 검색하지 못했습니다.'))
      } finally {
        if (requestSeqRef.current === seq) {
          setIsLoading(false)
        }
      }
    },
    [
      scopeInfo.changedFilePaths,
      scopeInfo.currentFilePath,
      scopeInfo.isInCurrentDiffHunk,
      scopeInfo.scope,
      searchSymbols
    ]
  )

  useEffect(() => {
    if (!isOpen) {
      clearDebounce()
      requestSeqRef.current += 1
      isComposingRef.current = false
      setQuery('')
      setResults([])
      setActiveIndex(0)
      setIsLoading(false)
      setErrorMessage(null)
      setHasSearched(false)
      lastSearchedQueryRef.current = ''
      return
    }
    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus()
    })
    return () => {
      window.cancelAnimationFrame(frame)
      clearDebounce()
    }
  }, [clearDebounce, isOpen])

  useEffect(() => {
    if (!isOpen) return
    const handleWindowKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !isKeyboardEventComposing(event) && !isComposingRef.current) {
        event.preventDefault()
        event.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', handleWindowKeyDown, true)
    return () => {
      window.removeEventListener('keydown', handleWindowKeyDown, true)
    }
  }, [isOpen, onClose])

  if (!isOpen) {
    return null
  }

  const scheduleSearch = (nextQuery: string): void => {
    clearDebounce()
    if (!nextQuery.trim()) {
      void executeSearch('')
      return
    }
    debounceTimerRef.current = window.setTimeout(() => {
      debounceTimerRef.current = null
      void executeSearch(nextQuery)
    }, SYMBOL_SEARCH_DEBOUNCE_MS)
  }

  const handleQueryChange = (nextQuery: string): void => {
    setQuery(nextQuery)
    if (isComposingRef.current) {
      return
    }
    scheduleSearch(nextQuery)
  }

  const handleCompositionEnd = (nextQuery: string): void => {
    isComposingRef.current = false
    scheduleSearch(nextQuery)
  }

  const handleInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (isKeyboardEventComposing(event) || isComposingRef.current) {
      return
    }
    if (event.key === 'ArrowDown') {
      if (results.length === 0) return
      event.preventDefault()
      setActiveIndex((prev) => (prev + 1) % results.length)
      return
    }
    if (event.key === 'ArrowUp') {
      if (results.length === 0) return
      event.preventDefault()
      setActiveIndex((prev) => (prev - 1 + results.length) % results.length)
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      const trimmed = query.trim()
      if (!trimmed) return
      if (trimmed !== lastSearchedQueryRef.current || debounceTimerRef.current !== null) {
        clearDebounce()
        void executeSearch(trimmed)
        return
      }
      const selected = results[activeIndex]
      if (selected) {
        onSelectMatch(selected, event.shiftKey)
        onClose()
      }
    }
  }

  const scopeBadgeText =
    scopeInfo.scope.kind === 'working-tree' ? '워킹트리' : `🔒 ${scopeInfo.scopeLabel}`

  return (
    <div
      className="symbol-palette-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose()
        }
      }}
    >
      <div
        className="symbol-palette-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="심볼 검색 팔레트"
        data-testid="symbol-search-palette"
      >
        <div className="symbol-palette-input-row">
          <Search size={15} strokeWidth={1.75} className="symbol-palette-icon" aria-hidden="true" />
          <input
            ref={inputRef}
            type="text"
            className="symbol-palette-input"
            aria-label="심볼 이름 검색"
            placeholder="심볼 선언 검색 (함수, 클래스, 타입, 변수)..."
            value={query}
            onCompositionStart={() => {
              isComposingRef.current = true
            }}
            onCompositionEnd={(event) => handleCompositionEnd(event.currentTarget.value)}
            onChange={(event) => handleQueryChange(event.target.value)}
            onKeyDown={handleInputKeyDown}
          />
          <span className="symbol-palette-scope-badge" title="검색 시점">
            {scopeBadgeText}
          </span>
          <button
            type="button"
            className="icon-btn symbol-palette-close-btn"
            aria-label="심볼 검색 팔레트 닫기"
            title="닫기 (Esc)"
            onClick={onClose}
          >
            <X size={14} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </div>

        <div className="symbol-palette-results" role="listbox" aria-label="심볼 검색 결과">
          {errorMessage ? (
            <div className="symbol-palette-status is-error" role="alert">
              {errorMessage}
            </div>
          ) : isLoading ? (
            <div className="symbol-palette-status">검색 중...</div>
          ) : !query.trim() ? (
            <div className="symbol-palette-status">
              심볼 이름을 입력하세요. Enter로 즉시 검색, ↑/↓로 선택할 수 있습니다.
            </div>
          ) : hasSearched && results.length === 0 ? (
            <div className="symbol-palette-status">일치하는 심볼 선언을 찾지 못했습니다.</div>
          ) : (
            results.map((match, index) => {
              const isSelected = index === activeIndex
              const isChanged = Boolean(
                scopeInfo.changedFilePaths?.has(normalizeRepoPath(match.path))
              )
              return (
                <button
                  key={`${match.path}:${match.lineNumber}:${match.columnStart}:${index}`}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  className={`symbol-palette-item${isSelected ? ' is-selected' : ''}`}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={(event) => {
                    onSelectMatch(match, event.shiftKey)
                    onClose()
                  }}
                >
                  <div className="symbol-palette-item-top">
                    <span className="symbol-palette-item-path">
                      {match.path}:{match.lineNumber}
                    </span>
                    {isChanged && <span className="symbol-palette-changed-badge">변경</span>}
                  </div>
                  <div className="symbol-palette-item-line">{match.lineText.trim()}</div>
                </button>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}
