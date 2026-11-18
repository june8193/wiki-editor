import { clampMermaidHeight, type MermaidHeightBounds } from './mermaidContainFit'

export const MERMAID_EDGE_AUTOSCROLL_THRESHOLD_PX = 36
const MERMAID_EDGE_AUTOSCROLL_MIN_STEP_PX = 2
const MERMAID_EDGE_AUTOSCROLL_MAX_STEP_PX = 28
const MERMAID_EDGE_AUTOSCROLL_DIRECTION_DEADZONE_PX = 2

export interface MermaidScrollResizeSessionOptions {
  viewportEl: HTMLDivElement | null
  startClientY: number
  startHeight: number
  heightBounds: MermaidHeightBounds
  onHeightChange: (nextHeightPx: number) => void
}

export interface MermaidScrollResizeSession {
  updatePointer: (clientY: number) => void
  stop: () => void
}

type EdgeAutoScrollCommand =
  | { direction: 'down'; stepPx: number }
  | { direction: 'up'; stepPx: number }

function isScrollableOverflow(overflowY: string): boolean {
  return overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay'
}

/**
 * Walks ancestor elements from `element` to find the nearest vertical scroll container.
 */
export function findNearestScrollContainer(element: HTMLElement | null): HTMLElement | null {
  if (typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') {
    return null
  }
  let current = element?.parentElement ?? null
  while (current) {
    if (isScrollableOverflow(window.getComputedStyle(current).overflowY)) {
      return current
    }
    current = current.parentElement
  }
  return null
}

function computeAutoScrollStepPx(penetrationPx: number): number {
  const scaled = Math.round(Math.max(0, penetrationPx) * 0.45)
  return Math.min(
    MERMAID_EDGE_AUTOSCROLL_MAX_STEP_PX,
    Math.max(MERMAID_EDGE_AUTOSCROLL_MIN_STEP_PX, scaled)
  )
}

function resolveEdgeAutoScrollCommand(
  containerRect: DOMRect,
  scrollTop: number,
  lastClientY: number,
  startClientY: number,
  currentHeightPx: number,
  maxHeightPx: number
): EdgeAutoScrollCommand | null {
  if (containerRect.height <= 0) {
    return null
  }
  const bottomThresholdY = containerRect.bottom - MERMAID_EDGE_AUTOSCROLL_THRESHOLD_PX
  if (
    lastClientY >= bottomThresholdY &&
    lastClientY > startClientY + MERMAID_EDGE_AUTOSCROLL_DIRECTION_DEADZONE_PX &&
    currentHeightPx < maxHeightPx
  ) {
    return { direction: 'down', stepPx: computeAutoScrollStepPx(lastClientY - bottomThresholdY) }
  }
  const topThresholdY = containerRect.top + MERMAID_EDGE_AUTOSCROLL_THRESHOLD_PX
  if (
    lastClientY <= topThresholdY &&
    lastClientY < startClientY - MERMAID_EDGE_AUTOSCROLL_DIRECTION_DEADZONE_PX &&
    scrollTop > 0
  ) {
    return { direction: 'up', stepPx: computeAutoScrollStepPx(topThresholdY - lastClientY) }
  }
  return null
}

/**
 * Starts a Mermaid vertical resize drag session anchored to ancestor scroll-container
 * document coordinates (`clientY - containerRect.top + scrollTop`) with rAF upper/lower
 * edge auto-scrolling, falling back to screen `clientY` deltas when mounted standalone.
 */
export function startMermaidScrollResizeSession({
  viewportEl,
  startClientY,
  startHeight,
  heightBounds,
  onHeightChange
}: MermaidScrollResizeSessionOptions): MermaidScrollResizeSession {
  const scrollContainer = findNearestScrollContainer(viewportEl)
  const startDocY = scrollContainer
    ? startClientY - scrollContainer.getBoundingClientRect().top + scrollContainer.scrollTop
    : null

  let lastClientY = startClientY
  let currentHeightPx = clampMermaidHeight(startHeight, heightBounds)
  let rafId: number | null = null
  let isApplyingAutoScroll = false
  let isStopped = false

  const cancelPendingFrame = (): void => {
    if (rafId !== null && typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') {
      window.cancelAnimationFrame(rafId)
      rafId = null
    }
  }

  const syncHeightFromPointer = (): void => {
    if (isStopped) return
    const deltaY =
      scrollContainer && startDocY !== null
        ? lastClientY - scrollContainer.getBoundingClientRect().top + scrollContainer.scrollTop - startDocY
        : lastClientY - startClientY
    const nextHeight = clampMermaidHeight(startHeight + deltaY, heightBounds)
    currentHeightPx = nextHeight
    onHeightChange(nextHeight)
  }

  const getActiveCommand = (): EdgeAutoScrollCommand | null => {
    if (isStopped || !scrollContainer || !viewportEl || !viewportEl.isConnected) {
      return null
    }
    return resolveEdgeAutoScrollCommand(
      scrollContainer.getBoundingClientRect(),
      scrollContainer.scrollTop,
      lastClientY,
      startClientY,
      currentHeightPx,
      heightBounds.max
    )
  }

  const applyBottomAutoScrollStep = (stepPx: number): boolean => {
    if (!scrollContainer || !viewportEl) return false
    const prevHeight = currentHeightPx
    const targetHeight = clampMermaidHeight(prevHeight + stepPx, heightBounds)
    const gain = targetHeight - prevHeight
    if (gain <= 0) {
      return false
    }

    // Expand viewport DOM height before advancing scrollTop so document-bottom scrollHeight grows first.
    const prevInlineHeight = viewportEl.style.height
    viewportEl.style.height = `${targetHeight}px`

    const prevScrollTop = scrollContainer.scrollTop
    isApplyingAutoScroll = true
    try {
      scrollContainer.scrollTop = prevScrollTop + gain
    } finally {
      isApplyingAutoScroll = false
    }

    const actualDelta = Math.max(0, scrollContainer.scrollTop - prevScrollTop)
    const finalHeight =
      actualDelta < gain
        ? clampMermaidHeight(prevHeight + actualDelta, heightBounds)
        : targetHeight

    if (finalHeight !== targetHeight) {
      viewportEl.style.height =
        finalHeight === prevHeight && prevInlineHeight === '' ? '' : `${finalHeight}px`
    }
    if (finalHeight !== prevHeight) {
      currentHeightPx = finalHeight
      onHeightChange(finalHeight)
    }
    return actualDelta > 0
  }

  const applyTopAutoScrollStep = (stepPx: number): boolean => {
    if (!scrollContainer) return false
    const prevScrollTop = scrollContainer.scrollTop
    if (prevScrollTop <= 0) {
      return false
    }

    isApplyingAutoScroll = true
    try {
      scrollContainer.scrollTop = Math.max(0, prevScrollTop - stepPx)
    } finally {
      isApplyingAutoScroll = false
    }
    if (scrollContainer.scrollTop >= prevScrollTop) {
      return false
    }

    syncHeightFromPointer()
    return scrollContainer.scrollTop > 0
  }

  const stepAutoScroll = (): void => {
    rafId = null
    const command = getActiveCommand()
    if (!command) {
      return
    }

    const shouldContinue =
      command.direction === 'down'
        ? applyBottomAutoScrollStep(command.stepPx)
        : applyTopAutoScrollStep(command.stepPx)

    if (shouldContinue) {
      syncAutoScrollLoop()
    }
  }

  const scheduleFrame = (): void => {
    if (
      rafId !== null ||
      isStopped ||
      typeof window === 'undefined' ||
      typeof window.requestAnimationFrame !== 'function'
    ) {
      return
    }
    rafId = window.requestAnimationFrame(stepAutoScroll)
  }

  const syncAutoScrollLoop = (): void => {
    if (getActiveCommand()) {
      scheduleFrame()
    } else {
      cancelPendingFrame()
    }
  }

  const handleContainerScroll = (): void => {
    if (isApplyingAutoScroll) return
    syncHeightFromPointer()
    syncAutoScrollLoop()
  }

  if (scrollContainer) {
    scrollContainer.addEventListener('scroll', handleContainerScroll, { passive: true })
  }

  return {
    updatePointer(clientY: number): void {
      if (isStopped) return
      lastClientY = clientY
      syncHeightFromPointer()
      syncAutoScrollLoop()
    },
    stop(): void {
      if (isStopped) return
      isStopped = true
      cancelPendingFrame()
      if (scrollContainer) {
        scrollContainer.removeEventListener('scroll', handleContainerScroll)
      }
    }
  }
}
