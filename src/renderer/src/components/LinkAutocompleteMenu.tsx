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
  onHoverIndex: (index: number) => void
  onDismiss: () => void
}

/** Floating cursor-anchored listbox popup for section and workspace file link autocomplete candidates. */
export function LinkAutocompleteMenu({
  isOpen,
  candidates,
  selectedIndex,
  position,
  menuRef,
  onSelect,
  onHoverIndex,
  onDismiss
}: LinkAutocompleteMenuProps) {
  useDismissable(isOpen, menuRef, onDismiss)

  if (!isOpen || candidates.length === 0) {
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
      {candidates.map((candidate, index) => {
        const isSelected = index === selectedIndex
        const badge = candidate.kind === 'heading' ? `H${candidate.heading.level}` : 'MD'
        const label = candidate.kind === 'heading' ? candidate.title : candidate.name
        const meta = candidate.kind === 'heading' ? `#${candidate.slug}` : candidate.relativePath
        return (
          <button
            key={candidate.id}
            type="button"
            role="option"
            aria-selected={isSelected}
            className={isSelected ? 'link-autocomplete-item is-selected' : 'link-autocomplete-item'}
            onMouseDown={(event) => {
              // Prevent moving focus/selection away from the editor before insertion runs.
              event.preventDefault()
            }}
            onMouseEnter={() => onHoverIndex(index)}
            onClick={() => onSelect(candidate)}
          >
            <span className="link-autocomplete-badge">{badge}</span>
            <span className="link-autocomplete-content">
              <span className="link-autocomplete-title">{label}</span>
              <span className="link-autocomplete-slug">{meta}</span>
            </span>
          </button>
        )
      })}
    </div>
  )
}
