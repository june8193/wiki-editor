import { useRef } from 'react'
import type { CustomCommandConfig } from '@shared/config'
import { useDismissable } from '../hooks/useDismissable'
import type { SlashMenuPosition } from '../hooks/useSlashMenu'

interface SlashCommandMenuProps {
  isOpen: boolean
  items: readonly CustomCommandConfig[]
  selectedIndex: number
  position: SlashMenuPosition
  onSelect: (command: CustomCommandConfig) => void
  onHoverIndex: (index: number) => void
  onDismiss: () => void
}

/**
 * Autocomplete popup rendered near the active editor cursor for slash commands.
 */
export function SlashCommandMenu({
  isOpen,
  items,
  selectedIndex,
  position,
  onSelect,
  onHoverIndex,
  onDismiss
}: SlashCommandMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null)
  useDismissable(isOpen, menuRef, onDismiss)

  if (!isOpen || items.length === 0) {
    return null
  }

  return (
    <div
      ref={menuRef}
      className="slash-command-menu"
      role="listbox"
      aria-label="슬래시 명령어 자동완성"
      style={{ top: `${position.top}px`, left: `${position.left}px` }}
    >
      {items.map((item, index) => {
        const isSelected = index === selectedIndex
        return (
          <button
            key={item.trigger}
            type="button"
            role="option"
            aria-selected={isSelected}
            className={`slash-command-item${isSelected ? ' is-selected' : ''}`}
            onMouseDown={(e) => {
              // Prevent moving focus/selection away from the editor before insertion runs.
              e.preventDefault()
            }}
            onMouseEnter={() => onHoverIndex(index)}
            onClick={() => onSelect(item)}
          >
            <span className="slash-command-trigger">/{item.trigger}</span>
            <span className="slash-command-meta">
              <span className="slash-command-label">{item.label}</span>
              {item.description ? (
                <span className="slash-command-desc">{item.description}</span>
              ) : null}
            </span>
          </button>
        )
      })}
    </div>
  )
}
