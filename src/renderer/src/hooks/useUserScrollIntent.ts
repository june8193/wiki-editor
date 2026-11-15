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

function isScrollNavigationKey(
  event: Pick<KeyboardEvent, 'altKey' | 'ctrlKey' | 'metaKey' | 'key'>
): boolean {
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

  const applyPointerStart = useCallback(
    (container: HTMLElement, target: EventTarget | null, clientX: number, clientY: number): void => {
      isPointerDownRef.current = true
      if (target === container) {
        const rect = container.getBoundingClientRect()
        const isOnScrollbarOrUnmeasured =
          rect.width === 0 ||
          clientX - rect.left >= container.clientWidth ||
          clientY - rect.top >= container.clientHeight
        if (isOnScrollbarOrUnmeasured) {
          markUserScrollIntent()
        }
      }
    },
    [markUserScrollIntent]
  )

  const handlePointerStart = useCallback(
    (event: ReactPointerEvent<HTMLElement> | ReactMouseEvent<HTMLElement>): void => {
      applyPointerStart(event.currentTarget, event.target, event.clientX, event.clientY)
    },
    [applyPointerStart]
  )

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>): void => {
      if (isScrollNavigationKey(event)) {
        markUserScrollIntent()
      }
    },
    [markUserScrollIntent]
  )

  const attachScrollIntentListeners = useCallback(
    (element: HTMLElement): (() => void) => {
      const onPointerStart = (event: MouseEvent | PointerEvent): void => {
        applyPointerStart(element, event.target, event.clientX, event.clientY)
      }
      const onKeyDown = (event: KeyboardEvent): void => {
        if (isScrollNavigationKey(event)) {
          markUserScrollIntent()
        }
      }

      element.addEventListener('wheel', markUserScrollIntent, { passive: true })
      element.addEventListener('touchstart', markUserScrollIntent, { passive: true })
      element.addEventListener('pointerdown', onPointerStart)
      element.addEventListener('mousedown', onPointerStart)
      element.addEventListener('pointerup', clearPointerDown)
      element.addEventListener('pointercancel', clearPointerDown)
      element.addEventListener('mouseup', clearPointerDown)
      element.addEventListener('keydown', onKeyDown)

      return () => {
        element.removeEventListener('wheel', markUserScrollIntent)
        element.removeEventListener('touchstart', markUserScrollIntent)
        element.removeEventListener('pointerdown', onPointerStart)
        element.removeEventListener('mousedown', onPointerStart)
        element.removeEventListener('pointerup', clearPointerDown)
        element.removeEventListener('pointercancel', clearPointerDown)
        element.removeEventListener('mouseup', clearPointerDown)
        element.removeEventListener('keydown', onKeyDown)
      }
    },
    [applyPointerStart, clearPointerDown, markUserScrollIntent]
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
    scrollIntentHandlers,
    attachScrollIntentListeners
  }
}
