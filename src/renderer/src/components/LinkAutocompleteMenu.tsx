import type { RefObject } from 'react'
import type { LinkCandidate } from '../editor/LinkAutocompleteEngine'
import { useDismissable } from '../hooks/useDismissable'
import type { LinkMenuPosition } from '../hooks/useLinkMenu'

export interface LinkAutocompleteMenuProps {
  isOpen: boolean
  candidates: readonly LinkCandidate[]
  selectedIndex: number
  position: LinkMenuPosition
  menuRef: RefObject<HTMLDivElement | null>
  onSelect: (candidate: LinkCandidate) => void
  onDismiss: () => void
}

/** Floating cursor-anchored listbox popup for section link autocomplete candidates. */
export function LinkAutocompleteMenu({
  isOpen,
  candidates,
  selectedIndex,
  position,
  menuRef,
  onSelect,
  onDismiss
}: LinkAutocompleteMenuProps) {
  useDismissable(isOpen, menuRef, onDismiss)

  if (!isOpen) {
    return null
  }

  return (
    <div
      ref={menuRef}
      className="link-autocomplete-menu"
      role="listbox"
      aria-label="링크 자동완성"
      style={{ top: position.top, left: position.left }}
    >
      {candidates.length === 0 ? (
        <div className="link-autocomplete-empty" role="presentation">
          일치하는 헤딩이 없습니다
        </div>
      ) : (
        candidates.map((candidate, index) => {
          const isSelected = index === selectedIndex
          return (
            <button
              key={candidate.id}
              type="button"
              role="option"
              aria-selected={isSelected}
              className={isSelected ? 'link-autocomplete-item is-selected' : 'link-autocomplete-item'}
              onMouseDown={(event) => {
                event.preventDefault()
                onSelect(candidate)
              }}
            >
              <span className="link-autocomplete-badge">{`H${candidate.heading.level}`}</span>
              <span className="link-autocomplete-content">
                <span className="link-autocomplete-title">{candidate.title}</span>
                <span className="link-autocomplete-slug">{`#${candidate.slug}`}</span>
              </span>
            </button>
          )
        })
      )}
    </div>
  )
}
