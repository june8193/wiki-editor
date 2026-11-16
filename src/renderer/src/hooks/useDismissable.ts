import { RefObject, useEffect } from 'react'

export interface UseDismissableOptions {
  capture?: boolean
}

/**
 * Dismisses a floating popover or context menu on outside mousedown or Escape key.
 */
export function useDismissable(
  isOpen: boolean,
  containerRef: RefObject<HTMLElement | null>,
  onDismiss: () => void,
  options?: UseDismissableOptions
): void {
  const capture = options?.capture ?? false

  useEffect(() => {
    if (!isOpen) return

    const handleOutsideMouseDown = (event: MouseEvent): void => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        onDismiss()
      }
    }

    const handleEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onDismiss()
      }
    }

    document.addEventListener('mousedown', handleOutsideMouseDown, capture)
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('mousedown', handleOutsideMouseDown, capture)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [capture, containerRef, isOpen, onDismiss])
}
