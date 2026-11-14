import { RefObject, useLayoutEffect } from 'react'

/**
 * Synchronizes a scrollable container's vertical scroll offset when switching or restoring tabs.
 */
export function useSyncScrollTop(ref: RefObject<HTMLElement | null>, scrollTop: number): void {
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    if (Math.abs(el.scrollTop - scrollTop) > 1) {
      el.scrollTop = scrollTop
    }
  }, [ref, scrollTop])
}
