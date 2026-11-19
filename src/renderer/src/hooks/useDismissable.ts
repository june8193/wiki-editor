import { RefObject, useEffect } from 'react'

export interface UseDismissableOptions {
  capture?: boolean
}

export type DismissReason = 'outside' | 'escape'

/**
 * Dismisses a floating popover or context menu on outside mousedown or Escape key.
 */
export function useDismissable(
  isOpen: boolean,
  containerRef: RefObject<HTMLElement | null>,
  onDismiss: (reason?: DismissReason) => void,
  options?: UseDismissableOptions
): void {
  const capture = options?.capture ?? false

  useEffect(() => {
    if (!isOpen) return

    const handleOutsideMouseDown = (event: MouseEvent): void => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        onDismiss('outside')
      }
    }

    const handleEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onDismiss('escape')
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
