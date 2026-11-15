import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef
} from 'react'

const USER_SCROLL_INTENT_WINDOW_MS = 250
const POINTER_RELEASE_EVENTS = ['pointerup', 'pointercancel', 'mouseup', 'blur'] as const

function isScrollNavigationKey(event: ReactKeyboardEvent<HTMLElement>): boolean {
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

/**
 * Tracks whether a scrollable container's upcoming `scroll` event originates
 * from user input (wheel, touch, scrollbar interaction, drag-scroll, or scroll keys)
 * rather than programmatic scrolling, without leaving non-scroll clicks armed.
 */
export function useUserScrollIntent() {
  const userScrollIntentUntilRef = useRef(0)
  const isPointerDownRef = useRef(false)

  const clearPointerDown = useCallback((): void => {
    isPointerDownRef.current = false
  }, [])

  const markUserScrollIntent = useCallback((): void => {
    userScrollIntentUntilRef.current = Date.now() + USER_SCROLL_INTENT_WINDOW_MS
  }, [])

  const resetScrollIntent = useCallback((): void => {
    userScrollIntentUntilRef.current = 0
    isPointerDownRef.current = false
  }, [])

  const consumeUserScrollIntent = useCallback((): boolean => {
    const isUserScroll =
      isPointerDownRef.current || Date.now() <= userScrollIntentUntilRef.current
    userScrollIntentUntilRef.current = 0
    return isUserScroll
  }, [])

  useEffect(() => {
    for (const eventName of POINTER_RELEASE_EVENTS) {
      window.addEventListener(eventName, clearPointerDown)
    }
    return () => {
      for (const eventName of POINTER_RELEASE_EVENTS) {
        window.removeEventListener(eventName, clearPointerDown)
      }
    }
  }, [clearPointerDown])

  const handlePointerStart = useCallback(
    (event: ReactPointerEvent<HTMLElement> | ReactMouseEvent<HTMLElement>): void => {
      isPointerDownRef.current = true
      if (event.target === event.currentTarget) {
        const rect = event.currentTarget.getBoundingClientRect()
        const isOnScrollbarOrUnmeasured =
          rect.width === 0 ||
          event.clientX - rect.left >= event.currentTarget.clientWidth ||
          event.clientY - rect.top >= event.currentTarget.clientHeight
        if (isOnScrollbarOrUnmeasured) {
          markUserScrollIntent()
        }
      }
    },
    [markUserScrollIntent]
  )

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>): void => {
      if (isScrollNavigationKey(event)) {
        markUserScrollIntent()
      }
    },
    [markUserScrollIntent]
  )

  const scrollIntentHandlers = useMemo(
    () => ({
      onWheel: markUserScrollIntent,
      onTouchStart: markUserScrollIntent,
      onPointerDown: handlePointerStart,
      onMouseDown: handlePointerStart,
      onPointerUp: clearPointerDown,
      onPointerCancel: clearPointerDown,
      onMouseUp: clearPointerDown,
      onKeyDown: handleKeyDown
    }),
    [clearPointerDown, handleKeyDown, handlePointerStart, markUserScrollIntent]
  )

  return {
    markUserScrollIntent,
    resetScrollIntent,
    consumeUserScrollIntent,
    scrollIntentHandlers
  }
}
