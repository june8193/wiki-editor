import { RefObject, useLayoutEffect } from 'react'

/**
 * Updates an element's `scrollTop` only when it differs by more than 1px.
 */
export function syncElementScrollTop(el: HTMLElement, scrollTop: number): boolean {
  if (Math.abs(el.scrollTop - scrollTop) <= 1) {
    return false
  }
  el.scrollTop = scrollTop
  return true
}

/**
 * Synchronizes a scrollable container's vertical scroll offset when switching or restoring tabs.
 */
export function useSyncScrollTop(ref: RefObject<HTMLElement | null>, scrollTop: number): void {
  useLayoutEffect(() => {
    const el = ref.current
    if (el) {
      syncElementScrollTop(el, scrollTop)
    }
  }, [ref, scrollTop])
}
