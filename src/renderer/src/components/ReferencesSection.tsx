import { memo, useMemo } from 'react'
import type { SymbolCandidateMatch } from '@shared/symbol'
import { isSymbolSupportedFile } from '../editor/codeSymbolExtractor'
import type { SidebarDocumentContext } from '../editor/editorModes'
import { SidebarAccordionSection } from './SidebarAccordionSection'

export interface ReferencesSearchState {
  status: 'idle' | 'loading' | 'loaded' | 'error'
  symbolName?: string
  scopeLabel?: string
  fallbackNotice?: string
  errorMessage?: string
  matches: readonly SymbolCandidateMatch[]
  changedFilePaths?: ReadonlySet<string>
  activeMatchKey?: string | null
  onSelectMatch?: (match: SymbolCandidateMatch) => void
}

export const IDLE_REFERENCES_STATE: ReferencesSearchState = {
  status: 'idle',
  matches: []
}

export interface ReferencesSectionProps {
  state: ReferencesSearchState
  isExpanded?: boolean
  flexRatio?: number | null
  onToggleExpanded: () => void
}

interface ReferenceFileGroup {
  path: string
  isChanged: boolean
  items: SymbolCandidateMatch[]
}

/**
 * Returns true when the active right-sidebar document context represents a symbol-supported
 * code file, code Diff tab, or code Snapshot tab (switching the bottom accordion to References).
 */
export function isCodeReferencesDocument(document: SidebarDocumentContext): boolean {
  const targetFile = document.diffContext
    ? (document.diffContext.filePath ?? document.documentName)
    : document.documentName
  return Boolean(targetFile) && !document.isMarkdownDocument && isSymbolSupportedFile(targetFile)
}

export function formatReferenceMatchKey(match: SymbolCandidateMatch): string {
  return `${match.path}:${match.lineNumber}:${match.columnStart}`
}

/**
 * Right sidebar accordion section displaying time-consistent symbol references grouped by file.
 * Replaces DocumentPropertiesSection when a code file, code Diff tab, or code Snapshot tab is active.
 */
export const ReferencesSection = memo(function ReferencesSection({
  state,
  isExpanded = true,
  flexRatio = null,
  onToggleExpanded
}: ReferencesSectionProps) {
  const fileGroups = useMemo<ReferenceFileGroup[]>(() => {
    if (state.status !== 'loaded' || state.matches.length === 0) {
      return []
    }
    const groupsByPath = new Map<string, ReferenceFileGroup>()
    for (const match of state.matches) {
      let group = groupsByPath.get(match.path)
      if (!group) {
        group = {
          path: match.path,
          isChanged: Boolean(state.changedFilePaths?.has(match.path)),
          items: []
        }
        groupsByPath.set(match.path, group)
      }
      group.items.push(match)
    }
    return Array.from(groupsByPath.values())
  }, [state.changedFilePaths, state.matches, state.status])

  const headerBadge =
    state.status === 'loaded' ? (
      <span className="properties-count-badge" aria-label={`참조 ${state.matches.length}건`}>
        {state.matches.length}
      </span>
    ) : undefined

  const renderBody = () => {
    if (state.status === 'idle') {
      return (
        <p className="properties-empty-text">
          식별자를 우클릭하여 &apos;레퍼런스 찾기&apos; 또는 Shift+F12를 실행하세요.
        </p>
      )
    }
    if (state.status === 'loading') {
      return <p className="properties-empty-text">레퍼런스를 검색하는 중...</p>
    }
    if (state.status === 'error') {
      return (
        <p className="properties-empty-text is-error">
          {state.errorMessage ?? '레퍼런스를 검색하지 못했습니다.'}
        </p>
      )
    }

    return (
      <div className="references-body">
        <div className="references-summary-bar">
          {state.symbolName && <span className="references-symbol-name">{state.symbolName}</span>}
          {state.scopeLabel && <span className="references-scope-badge">{state.scopeLabel}</span>}
          <span className="references-count-label">{state.matches.length}건</span>
        </div>

        {state.fallbackNotice && (
          <div className="references-fallback-notice" role="status">
            {state.fallbackNotice}
          </div>
        )}

        {state.matches.length === 0 ? (
          <p className="properties-empty-text">참조를 찾을 수 없습니다.</p>
        ) : (
          <div className="references-group-list" role="list">
            {fileGroups.map((group) => (
              <div key={group.path} className="references-file-group" role="listitem">
                <div className="references-file-header">
                  <span className="references-file-path" title={group.path}>
                    {group.path}
                  </span>
                  {group.isChanged && <span className="references-changed-badge">변경됨</span>}
                  <span className="references-file-count">{group.items.length}</span>
                </div>
                <div className="references-match-list">
                  {group.items.map((match) => {
                    const key = formatReferenceMatchKey(match)
                    const isActive = state.activeMatchKey === key
                    return (
                      <button
                        key={key}
                        type="button"
                        className={`references-match-item${isActive ? ' is-active' : ''}`}
                        onClick={() => state.onSelectMatch?.(match)}
                      >
                        <span className="references-match-line">:{match.lineNumber}</span>
                        <span className="references-match-text">{match.lineText.trim()}</span>
                      </button>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    )
  }

  return (
    <SidebarAccordionSection
      title="레퍼런스"
      ariaLabel="레퍼런스"
      badge={headerBadge}
      isExpanded={isExpanded}
      flexRatio={flexRatio}
      onToggle={onToggleExpanded}
    >
      {renderBody()}
    </SidebarAccordionSection>
  )
})
