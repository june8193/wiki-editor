import type { CSSProperties, ReactNode } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'

function joinClassNames(...names: Array<string | false | undefined>): string {
  return names.filter(Boolean).join(' ')
}

export function getAccordionSectionFlexStyle(flexRatio: number | null): CSSProperties | undefined {
  return flexRatio !== null ? { flex: `${flexRatio} 1 0%` } : undefined
}

export interface SidebarAccordionSectionProps {
  title: string
  ariaLabel?: string
  badge?: ReactNode
  headerActions?: ReactNode
  isExpanded: boolean
  flexRatio: number | null
  sectionClassName?: string
  headerClassName?: string
  toggleClassName?: string
  chevronClassName?: string
  titleClassName?: string
  bodyClassName?: string
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
  sectionClassName,
  headerClassName,
  toggleClassName,
  chevronClassName,
  titleClassName,
  bodyClassName,
  onToggle,
  children
}: SidebarAccordionSectionProps) {
  return (
    <section
      className={joinClassNames('accordion-section', sectionClassName, !isExpanded && 'is-collapsed')}
      aria-label={ariaLabel ?? title}
      style={getAccordionSectionFlexStyle(flexRatio)}
    >
      <div className={joinClassNames('accordion-header', headerClassName)}>
        <button
          type="button"
          className={joinClassNames('accordion-toggle', toggleClassName)}
          aria-expanded={isExpanded}
          onClick={onToggle}
        >
          <span
            className={joinClassNames('accordion-chevron', chevronClassName)}
            aria-hidden="true"
          >
            {isExpanded ? (
              <ChevronDown size={13} strokeWidth={1.75} />
            ) : (
              <ChevronRight size={13} strokeWidth={1.75} />
            )}
          </span>
          <span className={joinClassNames('accordion-title', titleClassName)}>{title}</span>
          {badge}
        </button>
        {headerActions}
      </div>
      {isExpanded && (
        <div className={joinClassNames('accordion-body', bodyClassName)}>{children}</div>
      )}
    </section>
  )
}
