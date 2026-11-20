import type { CSSProperties, ReactNode } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'

function joinClassNames(...names: Array<string | false | undefined>): string {
  return names.filter(Boolean).join(' ')
}

export function getAccordionSectionFlexStyle(flexRatio: number | null): CSSProperties | undefined {
  return flexRatio !== null ? { flex: `${flexRatio} 1 0%` } : undefined
}

export interface AccordionSectionClassNames {
  section?: string
  header?: string
  toggle?: string
  body?: string
}

export interface SidebarAccordionSectionProps {
  title: string
  ariaLabel?: string
  badge?: ReactNode
  headerActions?: ReactNode
  isExpanded: boolean
  flexRatio: number | null
  classNames?: AccordionSectionClassNames
  onToggle: () => void
  children: ReactNode
}

/**
 * Shared collapsible sidebar accordion section isolating the header toggle button
 * from sibling header auxiliary controls.
 */
export function SidebarAccordionSection({
  title,
  ariaLabel,
  badge,
  headerActions,
  isExpanded,
  flexRatio,
  classNames,
  onToggle,
  children
}: SidebarAccordionSectionProps) {
  return (
    <section
      className={joinClassNames('accordion-section', classNames?.section, !isExpanded && 'is-collapsed')}
      aria-label={ariaLabel ?? title}
      style={getAccordionSectionFlexStyle(flexRatio)}
    >
      <div className={joinClassNames('accordion-header', classNames?.header)}>
        <button
          type="button"
          className={joinClassNames('accordion-toggle', classNames?.toggle)}
          aria-expanded={isExpanded}
          onClick={onToggle}
        >
          <span className="accordion-chevron" aria-hidden="true">
            {isExpanded ? (
              <ChevronDown size={13} strokeWidth={1.75} />
            ) : (
              <ChevronRight size={13} strokeWidth={1.75} />
            )}
          </span>
          <span className="accordion-title">{title}</span>
          {badge}
        </button>
        {headerActions}
      </div>
      {isExpanded && (
        <div className={joinClassNames('accordion-body', classNames?.body)}>{children}</div>
      )}
    </section>
  )
}
