import {
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import {
  MERMAID_DEFAULT_FALLBACK_HEIGHT_PX,
  type MeasuredViewportBox,
  type MermaidHeightBounds,
  applySvgContainFitStyles,
  clampMermaidHeight,
  computeFitMetricsOrFallback,
  readViewportBox,
  roundTwoDecimals
} from '../editor/mermaidContainFit'
import { extractMermaidIntrinsicBounds } from '../editor/mermaidSvgBounds'
import { type PointerDragStartEvent, usePointerDragSession } from './usePointerDragSession'

export const MERMAID_MIN_ZOOM = 0.25
export const MERMAID_MAX_ZOOM = 4
export const MERMAID_DEFAULT_ZOOM = 1
export const MERMAID_ZOOM_STEP = 0.25
export const MERMAID_WHEEL_ZOOM_STEP = 0.1
export const MERMAID_KEYBOARD_HEIGHT_STEP_PX = 24

export interface MermaidViewportState {
  viewportRef: RefObject<HTMLDivElement | null>
  stageRef: RefObject<HTMLDivElement | null>
  zoom: number
  zoomPercent: number
  pan: { x: number; y: number }
  effectiveHeightPx: number | null
  autoViewportHeightPx: number | null
  activeResizeHeightPx: number | null
  heightBounds: MermaidHeightBounds
  isCustomHeight: boolean
  hasSvg: boolean
  canZoomIn: boolean
  canZoomOut: boolean
  canResetView: boolean
  isPanning: boolean
  isResizingHeight: boolean
  handleZoomIn: () => void
  handleZoomOut: () => void
  handleResetZoom: () => void
  handleResetView: () => void
  handlePanStart: (event: PointerDragStartEvent) => void
  handleResizeStart: (event: PointerDragStartEvent) => void
  handleResizeKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void
  handleResizeDoubleClick: () => void
}

export interface UseMermaidViewportOptions {
  hasSvg: boolean
  svgMarkup?: string | null
}

interface ViewportInternalState {
  zoom: number
  pan: { x: number; y: number }
  customHeightPx: number | null
  lockedAutoHeightPx: number | null
}

/**
 * Clamps Mermaid viewport zoom to `[0.25, 4]` with 2-decimal precision.
 */
export function clampMermaidZoom(value: number): number {
  if (!Number.isFinite(value)) {
    return MERMAID_DEFAULT_ZOOM
  }
  const clamped = Math.min(MERMAID_MAX_ZOOM, Math.max(MERMAID_MIN_ZOOM, value))
  return roundTwoDecimals(clamped)
}

function isIdentityViewport(zoom: number, pan: { x: number; y: number }): boolean {
  return zoom === MERMAID_DEFAULT_ZOOM && pan.x === 0 && pan.y === 0
}

/**
 * Manages view-only zoom (`25%`–`400%`), drag panning, `Ctrl`/`Cmd`+wheel cursor-centered zooming,
 * Contain-fitted SVG scaling, and dynamic-range bottom-handle height resizing.
 */
export function useMermaidViewport({
  hasSvg,
  svgMarkup = null
}: UseMermaidViewportOptions): MermaidViewportState {
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const stageRef = useRef<HTMLDivElement | null>(null)
  const [state, setState] = useState<ViewportInternalState>({
    zoom: MERMAID_DEFAULT_ZOOM,
    pan: { x: 0, y: 0 },
    customHeightPx: null,
    lockedAutoHeightPx: null
  })
  const [measuredBox, setMeasuredBox] = useState<MeasuredViewportBox>({
    availableWidth: 0,
    verticalPadding: 0
  })
  const [dragStartHeightPx, setDragStartHeightPx] = useState<number | null>(null)

  const intrinsicBounds = useMemo(
    () => (svgMarkup ? extractMermaidIntrinsicBounds(svgMarkup) : null),
    [svgMarkup]
  )

  const stateRef = useRef(state)
  stateRef.current = state

  const hasSvgRef = useRef(hasSvg)
  hasSvgRef.current = hasSvg

  const intrinsicBoundsRef = useRef(intrinsicBounds)
  intrinsicBoundsRef.current = intrinsicBounds

  const syncMeasuredViewport = useCallback((): MeasuredViewportBox => {
    const nextBox = readViewportBox(viewportRef.current)
    setMeasuredBox((prev) =>
      prev.availableWidth === nextBox.availableWidth &&
      prev.verticalPadding === nextBox.verticalPadding
        ? prev
        : nextBox
    )
    return nextBox
  }, [])

  const panOriginRef = useRef<{
    startX: number
    startY: number
    startPanX: number
    startPanY: number
  } | null>(null)

  const resizeOriginRef = useRef<{
    startY: number
    startHeight: number
    heightBounds: MermaidHeightBounds
  } | null>(null)

  const measureViewportHeight = useCallback((): number | null => {
    const el = viewportRef.current
    if (!el) return null
    const rect = el.getBoundingClientRect()
    return rect.height > 0 ? Math.round(rect.height) : null
  }, [])

  useLayoutEffect(() => {
    const viewportEl = viewportRef.current
    if (!hasSvg || !viewportEl) {
      return
    }
    syncMeasuredViewport()

    if (typeof ResizeObserver === 'undefined') {
      return
    }
    const observer = new ResizeObserver(() => {
      syncMeasuredViewport()
    })
    observer.observe(viewportEl)
    return () => {
      observer.disconnect()
    }
  }, [hasSvg, svgMarkup, syncMeasuredViewport])

  const applyZoomTransition = useCallback(
    (
      nextZoomResolver: (prev: ViewportInternalState) => number,
      panResolver?: (prev: ViewportInternalState, nextZoom: number) => { x: number; y: number }
    ) => {
      const measuredHeight = measureViewportHeight()
      setState((prev) => {
        const nextZoom = nextZoomResolver(prev)
        const nextPan = panResolver ? panResolver(prev, nextZoom) : prev.pan
        if (nextZoom === prev.zoom && nextPan.x === prev.pan.x && nextPan.y === prev.pan.y) {
          return prev
        }
        const identity = isIdentityViewport(nextZoom, nextPan)
        const nextLockedAutoHeightPx =
          prev.customHeightPx !== null
            ? null
            : identity
              ? null
              : (prev.lockedAutoHeightPx ?? measuredHeight)

        return {
          ...prev,
          zoom: nextZoom,
          pan: nextPan,
          lockedAutoHeightPx: nextLockedAutoHeightPx
        }
      })
    },
    [measureViewportHeight]
  )

  const handleZoomIn = useCallback(() => {
    if (!hasSvgRef.current) return
    applyZoomTransition((prev) => clampMermaidZoom(prev.zoom + MERMAID_ZOOM_STEP))
  }, [applyZoomTransition])

  const handleZoomOut = useCallback(() => {
    if (!hasSvgRef.current) return
    applyZoomTransition((prev) => clampMermaidZoom(prev.zoom - MERMAID_ZOOM_STEP))
  }, [applyZoomTransition])

  const handleResetZoom = useCallback(() => {
    if (!hasSvgRef.current) return
    setState((prev) => {
      if (isIdentityViewport(prev.zoom, prev.pan) && prev.lockedAutoHeightPx === null) {
        return prev
      }
      return {
        ...prev,
        zoom: MERMAID_DEFAULT_ZOOM,
        pan: { x: 0, y: 0 },
        lockedAutoHeightPx: null
      }
    })
  }, [])

  const handleResetView = useCallback(() => {
    if (!hasSvgRef.current) return
    setState((prev) => {
      if (
        isIdentityViewport(prev.zoom, prev.pan) &&
        prev.customHeightPx === null &&
        prev.lockedAutoHeightPx === null
      ) {
        return prev
      }
      return {
        zoom: MERMAID_DEFAULT_ZOOM,
        pan: { x: 0, y: 0 },
        customHeightPx: null,
        lockedAutoHeightPx: null
      }
    })
  }, [])

  useLayoutEffect(() => {
    const viewportEl = viewportRef.current
    if (!hasSvg || !viewportEl) {
      return
    }

    const handleWheel = (event: WheelEvent): void => {
      if (!hasSvgRef.current || !(event.ctrlKey || event.metaKey)) {
        return
      }
      if (event.deltaY === 0) {
        return
      }
      event.preventDefault()

      const rect = viewportEl.getBoundingClientRect()
      const hasMeasuredBox = rect.width > 0 || rect.height > 0
      const offsetX = hasMeasuredBox ? event.clientX - (rect.left + rect.width / 2) : 0
      const offsetY = hasMeasuredBox ? event.clientY - (rect.top + rect.height / 2) : 0
      const direction = event.deltaY < 0 ? 1 : -1

      applyZoomTransition(
        (prev) => clampMermaidZoom(prev.zoom + direction * MERMAID_WHEEL_ZOOM_STEP),
        (prev, nextZoom) => {
          if (nextZoom === prev.zoom) {
            return prev.pan
          }
          const ratio = nextZoom / prev.zoom
          return {
            x: roundTwoDecimals(offsetX - (offsetX - prev.pan.x) * ratio),
            y: roundTwoDecimals(offsetY - (offsetY - prev.pan.y) * ratio)
          }
        }
      )
    }

    viewportEl.addEventListener('wheel', handleWheel, { passive: false })
    return () => {
      viewportEl.removeEventListener('wheel', handleWheel)
    }
  }, [applyZoomTransition, hasSvg])

  const panSession = usePointerDragSession({
    bodyClassName: 'is-panning-mermaid',
    cursor: 'grabbing',
    onDragStart: (event) => {
      const current = stateRef.current
      panOriginRef.current = {
        startX: event.clientX,
        startY: event.clientY,
        startPanX: current.pan.x,
        startPanY: current.pan.y
      }
      if (current.customHeightPx === null && current.lockedAutoHeightPx === null) {
        const measuredHeight = measureViewportHeight()
        if (measuredHeight !== null) {
          setState((prev) =>
            prev.customHeightPx === null && prev.lockedAutoHeightPx === null
              ? { ...prev, lockedAutoHeightPx: measuredHeight }
              : prev
          )
        }
      }
    },
    onDragMove: (event) => {
      const origin = panOriginRef.current
      if (!origin || typeof event.clientX !== 'number' || typeof event.clientY !== 'number') {
        return
      }
      const nextPan = {
        x: roundTwoDecimals(origin.startPanX + (event.clientX - origin.startX)),
        y: roundTwoDecimals(origin.startPanY + (event.clientY - origin.startY))
      }
      setState((prev) => {
        if (prev.pan.x === nextPan.x && prev.pan.y === nextPan.y) {
          return prev
        }
        return { ...prev, pan: nextPan }
      })
    },
    onDragEnd: () => {
      panOriginRef.current = null
      setState((prev) => {
        if (prev.lockedAutoHeightPx !== null && isIdentityViewport(prev.zoom, prev.pan)) {
          return { ...prev, lockedAutoHeightPx: null }
        }
        return prev
      })
    }
  })

  const handlePanStart = useCallback(
    (event: PointerDragStartEvent) => {
      if (!hasSvgRef.current) return
      panSession.handleDragStart(event)
    },
    [panSession]
  )

  const resolveResizeBaseHeight = useCallback(
    (autoViewportHeightPx: number | null, heightBounds: MermaidHeightBounds): number => {
      const current = stateRef.current
      if (current.customHeightPx !== null) {
        return clampMermaidHeight(current.customHeightPx, heightBounds)
      }
      return (
        current.lockedAutoHeightPx ??
        measureViewportHeight() ??
        autoViewportHeightPx ??
        MERMAID_DEFAULT_FALLBACK_HEIGHT_PX
      )
    },
    [measureViewportHeight]
  )

  const commitCustomHeight = useCallback((rawHeightPx: number, heightBounds: MermaidHeightBounds) => {
    const nextHeight = clampMermaidHeight(rawHeightPx, heightBounds)
    setState((prev) =>
      prev.customHeightPx === nextHeight
        ? prev
        : { ...prev, customHeightPx: nextHeight, lockedAutoHeightPx: null }
    )
  }, [])

  const resolveLiveResizeContext = useCallback(() => {
    const box = syncMeasuredViewport()
    const { autoViewportHeightPx, heightBounds } = computeFitMetricsOrFallback(
      intrinsicBoundsRef.current,
      box,
      stateRef.current.customHeightPx
    )
    return {
      startHeight: resolveResizeBaseHeight(autoViewportHeightPx, heightBounds),
      heightBounds
    }
  }, [resolveResizeBaseHeight, syncMeasuredViewport])

  const resizeSession = usePointerDragSession({
    bodyClassName: 'is-resizing-mermaid',
    cursor: 'row-resize',
    onDragStart: (event) => {
      const { startHeight, heightBounds } = resolveLiveResizeContext()
      resizeOriginRef.current = {
        startY: event.clientY,
        startHeight,
        heightBounds
      }
      setDragStartHeightPx(startHeight)
    },
    onDragMove: (event) => {
      const origin = resizeOriginRef.current
      if (!origin || typeof event.clientY !== 'number') {
        return
      }
      commitCustomHeight(origin.startHeight + (event.clientY - origin.startY), origin.heightBounds)
    },
    onDragEnd: () => {
      resizeOriginRef.current = null
      setDragStartHeightPx(null)
    }
  })

  const handleResizeStart = useCallback(
    (event: PointerDragStartEvent) => {
      if (!hasSvgRef.current) return
      resizeSession.handleDragStart(event)
    },
    [resizeSession]
  )

  const handleResizeKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (!hasSvgRef.current) return
      const keySign = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0
      if (keySign === 0) return
      event.preventDefault()

      const { startHeight, heightBounds } = resolveLiveResizeContext()
      commitCustomHeight(startHeight + keySign * MERMAID_KEYBOARD_HEIGHT_STEP_PX, heightBounds)
    },
    [commitCustomHeight, resolveLiveResizeContext]
  )

  const handleResizeDoubleClick = useCallback(() => {
    if (!hasSvgRef.current) return
    setState((prev) => ({
      ...prev,
      customHeightPx: null,
      lockedAutoHeightPx: isIdentityViewport(prev.zoom, prev.pan) ? null : prev.lockedAutoHeightPx
    }))
  }, [])

  const { fitMetrics, autoViewportHeightPx, heightBounds } = useMemo(
    () => computeFitMetricsOrFallback(intrinsicBounds, measuredBox, state.customHeightPx),
    [intrinsicBounds, measuredBox, state.customHeightPx]
  )

  const isCustomHeight = state.customHeightPx !== null

  useLayoutEffect(() => {
    if (!hasSvg) return
    const svgEl = stageRef.current?.querySelector('svg')
    if (!svgEl) return
    applySvgContainFitStyles(svgEl, fitMetrics, isCustomHeight)
  }, [fitMetrics, hasSvg, isCustomHeight, svgMarkup])

  const effectiveHeightPx =
    state.customHeightPx !== null
      ? clampMermaidHeight(state.customHeightPx, heightBounds)
      : state.lockedAutoHeightPx

  const activeResizeHeightPx = resizeSession.isDragging
    ? (effectiveHeightPx ?? dragStartHeightPx ?? autoViewportHeightPx)
    : null

  const canResetView =
    hasSvg && (!isIdentityViewport(state.zoom, state.pan) || state.customHeightPx !== null)

  return {
    viewportRef,
    stageRef,
    zoom: state.zoom,
    zoomPercent: Math.round(state.zoom * 100),
    pan: state.pan,
    effectiveHeightPx,
    autoViewportHeightPx,
    activeResizeHeightPx,
    heightBounds,
    isCustomHeight,
    hasSvg,
    canZoomIn: hasSvg && state.zoom < MERMAID_MAX_ZOOM,
    canZoomOut: hasSvg && state.zoom > MERMAID_MIN_ZOOM,
    canResetView,
    isPanning: panSession.isDragging,
    isResizingHeight: resizeSession.isDragging,
    handleZoomIn,
    handleZoomOut,
    handleResetZoom,
    handleResetView,
    handlePanStart,
    handleResizeStart,
    handleResizeKeyDown,
    handleResizeDoubleClick
  }
}
