import type { SearchMatchOptions } from '@shared/search'
import { SEARCH_OPTION_BUTTONS } from '../utils/workspaceSearch'

export interface SearchOptionGroupProps {
  options: SearchMatchOptions
  ariaLabel: string
  onToggleOption: (optionKey: keyof SearchMatchOptions) => void
}

/**
 * Shared toggle button group (`Aa`, `ab`, `.*`) used by Workspace Search and in-document Find Bar.
 */
export function SearchOptionGroup({
  options,
  ariaLabel,
  onToggleOption
}: SearchOptionGroupProps) {
  return (
    <div className="search-options-group" role="group" aria-label={ariaLabel}>
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
  )
}
