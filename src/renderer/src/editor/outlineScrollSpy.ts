import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { type MarkdownHeading, resolveActiveHeadingIndexByOffsets } from './MarkdownTocEngine'

const HEADING_SELECTOR = 'h1, h2, h3, h4, h5, h6'

function resolveMatchingHeadingElements(
  container: HTMLElement,
  headings: readonly MarkdownHeading[]
): HTMLElement[] {
  const allHeadings = Array.from(container.querySelectorAll<HTMLElement>(HEADING_SELECTOR))
  if (allHeadings.length === headings.length) {
    return allHeadings
  }

  const byId = new Map<string, HTMLElement>()
  for (const el of allHeadings) {
    if (el.id && !byId.has(el.id)) {
      byId.set(el.id, el)
    }
  }

  const matched: HTMLElement[] = []
  for (const heading of headings) {
    const match = byId.get(heading.slug)
    if (match) {
      matched.push(match)
    }
  }
  return matched.length === headings.length ? matched : allHeadings
}

/**
 * Measures heading positions inside a scrollable rendered markdown container (Preview / WYSIWYG)
 * and resolves the active 0-based outline heading index, returning `null` when layout geometry
 * is absent (e.g., unmocked jsdom) or when the scroll position sits in the preface.
 */
export function measureActiveHeadingIndexInContainer(
  container: HTMLElement,
  headings: readonly MarkdownHeading[]
): number | null {
  if (headings.length === 0) return null

  const headingEls = resolveMatchingHeadingElements(container, headings)
  if (headingEls.length === 0) return null

  const containerRect = container.getBoundingClientRect()
  const headingRects = headingEls.map((el) => el.getBoundingClientRect())
  const hasLayoutGeometry =
    container.clientHeight > 0 ||
    container.scrollHeight > 0 ||
    containerRect.height > 0 ||
    headingRects.some((rect) => rect.height > 0 || rect.top !== containerRect.top)

  if (!hasLayoutGeometry) {
    return null
  }

  const headingTopOffsets = headingRects.map((rect) => rect.top - containerRect.top)
  return resolveActiveHeadingIndexByOffsets({
    headingTopOffsets,
    scrollTop: container.scrollTop,
    scrollHeight: container.scrollHeight,
    clientHeight: container.clientHeight
  })
}

/**
 * Returns true if a keyboard event on a scrollable preview container represents a scroll navigation key.
 */
export function isScrollNavigationKey(event: ReactKeyboardEvent<HTMLElement>): boolean {
  if (event.altKey) return false
  if ((event.ctrlKey || event.metaKey) && event.key !== 'Home' && event.key !== 'End') {
    return false
  }
  return (
    event.key === 'ArrowUp' ||
    event.key === 'ArrowDown' ||
    event.key === 'PageUp' ||
    event.key === 'PageDown' ||
    event.key === 'Home' ||
    event.key === 'End' ||
    event.key === ' ' ||
    event.key === 'Spacebar'
  )
}
