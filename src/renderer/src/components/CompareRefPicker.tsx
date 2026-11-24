import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, FolderGit2, GitBranch, Globe, Search } from 'lucide-react'
import type { GitCompareRef, GitCompareRefList } from '@shared/git'
import { type DismissReason, useDismissable } from '../hooks/useDismissable'
import { findCompareRefOption } from '../stores/CompareSession'

export interface CompareRefPickerProps {
  label: 'Base' | 'Compare'
  triggerAriaLabel: string
  dialogAriaLabel: string
  refs: GitCompareRefList | null
  selectedRef: string | null
  disabled?: boolean
  onSelectRef: (ref: string) => void
}

interface CompareRefGroup {
  title: string
  items: readonly GitCompareRef[]
}

function filterCompareRefGroups(
  refs: GitCompareRefList | null,
  query: string
): CompareRefGroup[] {
  if (!refs) return []
  const normalized = query.trim().toLowerCase()
  const matches = (item: GitCompareRef): boolean => {
    if (!normalized) return true
    return (
      item.displayName.toLowerCase().includes(normalized) ||
      item.ref.toLowerCase().includes(normalized) ||
      (item.worktreeName?.toLowerCase().includes(normalized) ?? false) ||
      (item.branchName?.toLowerCase().includes(normalized) ?? false)
    )
  }

  return [
    { title: 'Worktrees', items: refs.worktrees.filter(matches) },
    { title: 'Local Branches', items: refs.localBranches.filter(matches) },
    { title: 'Remote Branches', items: refs.remoteBranches.filter(matches) }
  ].filter((group) => group.items.length > 0)
}

function RefKindIcon({ kind }: { kind: GitCompareRef['kind'] }) {
  if (kind === 'worktree') {
    return <FolderGit2 size={13} strokeWidth={1.75} aria-hidden="true" />
  }
  if (kind === 'remote-branch') {
    return <Globe size={13} strokeWidth={1.75} aria-hidden="true" />
  }
  return <GitBranch size={13} strokeWidth={1.75} aria-hidden="true" />
}

/**
 * Searchable grouped Ref picker popover (`Worktrees`, `Local Branches`, `Remote Branches`)
 * for selecting either the `Base` or `Compare` target in the Compare panel.
 */
export function CompareRefPicker({
  label,
  triggerAriaLabel,
  dialogAriaLabel,
  refs,
  selectedRef,
  disabled = false,
  onSelectRef
}: CompareRefPickerProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [query, setQuery] = useState('')
  const containerRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const searchInputRef = useRef<HTMLInputElement | null>(null)

  const close = useCallback((reason?: DismissReason): void => {
    setIsOpen(false)
    setQuery('')
    if (reason === 'escape' && containerRef.current?.contains(document.activeElement)) {
      triggerRef.current?.focus()
    }
  }, [])

  useDismissable(isOpen, containerRef, close)

  useEffect(() => {
    if (disabled) {
      setIsOpen(false)
    }
  }, [disabled])

  useEffect(() => {
    if (isOpen) {
      searchInputRef.current?.focus()
    }
  }, [isOpen])

  const selectedOption = useMemo(() => findCompareRefOption(refs, selectedRef), [refs, selectedRef])
  const displayValue = selectedOption?.displayName ?? selectedRef ?? '선택...'
  const groups = useMemo(() => filterCompareRefGroups(refs, query), [refs, query])

  return (
    <div className="compare-ref-picker" ref={containerRef}>
      <button
        ref={triggerRef}
        type="button"
        className="compare-ref-trigger"
        aria-label={`${triggerAriaLabel}: ${displayValue}`}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        disabled={disabled || !refs}
        title={`${label}: ${displayValue}`}
        onClick={() => {
          setIsOpen((prev) => {
            if (prev) setQuery('')
            return !prev
          })
        }}
      >
        <span className="compare-ref-trigger-label">{label}</span>
        <span className="compare-ref-trigger-value">{displayValue}</span>
        <ChevronDown size={13} strokeWidth={1.75} className="compare-ref-trigger-chevron" aria-hidden="true" />
      </button>

      {isOpen && (
        <div
          className="compare-ref-popover"
          role="dialog"
          aria-label={dialogAriaLabel}
        >
          <div className="compare-ref-search-wrap">
            <Search size={13} strokeWidth={1.75} className="compare-ref-search-icon" aria-hidden="true" />
            <input
              ref={searchInputRef}
              type="text"
              className="compare-ref-search-input"
              placeholder="브랜치 또는 워크트리 검색..."
              aria-label="Ref 검색"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>

          <div className="compare-ref-groups">
            {groups.length === 0 ? (
              <p className="compare-ref-empty">일치하는 브랜치나 워크트리가 없습니다.</p>
            ) : (
              groups.map((group) => (
                <div key={group.title} className="compare-ref-group">
                  <div className="compare-ref-group-title">{group.title}</div>
                  {group.items.map((item) => {
                    const isSelected = item.ref === selectedRef
                    return (
                      <button
                        key={item.id}
                        type="button"
                        className={`compare-ref-option${isSelected ? ' is-selected' : ''}`}
                        onClick={() => {
                          onSelectRef(item.ref)
                          close()
                        }}
                      >
                        <RefKindIcon kind={item.kind} />
                        <span className="compare-ref-option-name">{item.displayName}</span>
                        {item.isCurrent && <span className="compare-ref-option-badge">HEAD</span>}
                        {isSelected && (
                          <Check size={13} strokeWidth={2} className="compare-ref-option-check" aria-hidden="true" />
                        )}
                      </button>
                    )
                  })}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}
