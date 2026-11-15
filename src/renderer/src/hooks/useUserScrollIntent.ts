import {
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
    (container: HTMLElement, event: Pick<MouseEvent, 'target' | 'clientX' | 'clientY'>): void => {
      isPointerDownRef.current = true
      if (event.target === container) {
        const rect = container.getBoundingClientRect()
        const isOnScrollbarOrUnmeasured =
          rect.width === 0 ||
          event.clientX - rect.left >= container.clientWidth ||
          event.clientY - rect.top >= container.clientHeight
        if (isOnScrollbarOrUnmeasured) {
          markUserScrollIntent()
        }
      }
    },
    [markUserScrollIntent]
  )

  const handlePointerStart = useCallback(
    (event: ReactPointerEvent<HTMLElement> | ReactMouseEvent<HTMLElement>): void => {
      applyPointerStart(event.currentTarget, event)
    },
    [applyPointerStart]
  )

  const handleKeyDown = useCallback(
    (event: Pick<KeyboardEvent, 'altKey' | 'ctrlKey' | 'metaKey' | 'key'>): void => {
      if (isScrollNavigationKey(event)) {
        markUserScrollIntent()
      }
    },
    [markUserScrollIntent]
  )

  const attachScrollIntentListeners = useCallback(
    (element: HTMLElement): (() => void) => {
      const onPointerStart = (event: MouseEvent | PointerEvent): void => {
        applyPointerStart(element, event)
      }
      const bindings: ReadonlyArray<
        readonly [keyof HTMLElementEventMap, EventListener, AddEventListenerOptions?]
      > = [
        ['wheel', markUserScrollIntent, { passive: true }],
        ['touchstart', markUserScrollIntent, { passive: true }],
        ['pointerdown', onPointerStart as EventListener],
        ['mousedown', onPointerStart as EventListener],
        ['pointerup', clearPointerDown],
        ['pointercancel', clearPointerDown],
        ['mouseup', clearPointerDown],
        ['keydown', handleKeyDown as unknown as EventListener]
      ]

      for (const [eventName, handler, options] of bindings) {
        element.addEventListener(eventName, handler, options)
      }
      return () => {
        for (const [eventName, handler] of bindings) {
          element.removeEventListener(eventName, handler)
        }
      }
    },
    [applyPointerStart, clearPointerDown, handleKeyDown, markUserScrollIntent]
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
