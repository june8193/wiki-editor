import { type KeyboardEvent as ReactKeyboardEvent, type RefObject, useCallback, useEffect, useRef, useState } from 'react'
import { type PointerDragStartEvent, usePointerDragSession } from './usePointerDragSession'

export const MERMAID_MIN_ZOOM = 0.25
export const MERMAID_MAX_ZOOM = 4
export const MERMAID_DEFAULT_ZOOM = 1
export const MERMAID_ZOOM_STEP = 0.25
export const MERMAID_WHEEL_ZOOM_STEP = 0.1
export const MERMAID_MIN_HEIGHT_PX = 120
export const MERMAID_MAX_HEIGHT_PX = 1200
export const MERMAID_DEFAULT_FALLBACK_HEIGHT_PX = 240
export const MERMAID_KEYBOARD_HEIGHT_STEP_PX = 24

export interface MermaidViewportState {
  viewportRef: RefObject<HTMLDivElement | null>
  zoom: number
  zoomPercent: number
  pan: { x: number; y: number }
  effectiveHeightPx: number | null
  hasSvg: boolean
  canZoomIn: boolean
  canZoomOut: boolean
  isPanning: boolean
  isResizingHeight: boolean
  handleZoomIn: () => void
  handleZoomOut: () => void
  handleResetZoom: () => void
  handlePanStart: (event: PointerDragStartEvent) => void
  handleResizeStart: (event: PointerDragStartEvent) => void
  handleResizeKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void
  handleResizeDoubleClick: () => void
}

export interface UseMermaidViewportOptions {
  hasSvg: boolean
}

interface ViewportInternalState {
  zoom: number
  pan: { x: number; y: number }
  customHeightPx: number | null
  lockedAutoHeightPx: number | null
}

function normalizeZero(value: number): number {
  return value === 0 ? 0 : value
}

function roundTwoDecimals(value: number): number {
  return normalizeZero(Math.round(value * 100) / 100)
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

/**
 * Clamps Mermaid viewport container height to `[120, 1200]` integer pixels.
 */
export function clampMermaidHeight(value: number): number {
  if (!Number.isFinite(value)) {
    return MERMAID_DEFAULT_FALLBACK_HEIGHT_PX
  }
  const clamped = Math.min(MERMAID_MAX_HEIGHT_PX, Math.max(MERMAID_MIN_HEIGHT_PX, value))
  return Math.round(clamped)
}

function isIdentityViewport(zoom: number, pan: { x: number; y: number }): boolean {
  return zoom === MERMAID_DEFAULT_ZOOM && pan.x === 0 && pan.y === 0
}

/**
 * Manages view-only zoom (`25%`–`400%`), drag panning, `Ctrl`/`Cmd`+wheel cursor-centered zooming,
 * and bottom-handle height resizing (`120px`–`1200px`) for a Mermaid diagram viewport.
 */
export function useMermaidViewport({ hasSvg }: UseMermaidViewportOptions): MermaidViewportState {
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const [state, setState] = useState<ViewportInternalState>({
    zoom: MERMAID_DEFAULT_ZOOM,
    pan: { x: 0, y: 0 },
    customHeightPx: null,
    lockedAutoHeightPx: null
  })

  const stateRef = useRef(state)
  stateRef.current = state

  const hasSvgRef = useRef(hasSvg)
  hasSvgRef.current = hasSvg

  const panOriginRef = useRef<{
    startX: number
    startY: number
    startPanX: number
    startPanY: number
  } | null>(null)

  const resizeOriginRef = useRef<{
    startY: number
    startHeight: number
  } | null>(null)

  const measureViewportHeight = useCallback((): number | null => {
    const el = viewportRef.current
    if (!el) return null
    const rect = el.getBoundingClientRect()
    return rect.height > 0 ? Math.round(rect.height) : null
  }, [])

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

  useEffect(() => {
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

  const resolveResizeBaseHeight = useCallback((): number => {
    const current = stateRef.current
    return (
      current.customHeightPx ??
      current.lockedAutoHeightPx ??
      measureViewportHeight() ??
      MERMAID_DEFAULT_FALLBACK_HEIGHT_PX
    )
  }, [measureViewportHeight])

  const commitCustomHeight = useCallback((rawHeightPx: number) => {
    const nextHeight = clampMermaidHeight(rawHeightPx)
    setState((prev) =>
      prev.customHeightPx === nextHeight
        ? prev
        : { ...prev, customHeightPx: nextHeight, lockedAutoHeightPx: null }
    )
  }, [])

  const resizeSession = usePointerDragSession({
    bodyClassName: 'is-resizing-mermaid',
    cursor: 'row-resize',
    onDragStart: (event) => {
      resizeOriginRef.current = {
        startY: event.clientY,
        startHeight: resolveResizeBaseHeight()
      }
    },
    onDragMove: (event) => {
      const origin = resizeOriginRef.current
      if (!origin || typeof event.clientY !== 'number') {
        return
      }
      commitCustomHeight(origin.startHeight + (event.clientY - origin.startY))
    },
    onDragEnd: () => {
      resizeOriginRef.current = null
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

      commitCustomHeight(resolveResizeBaseHeight() + keySign * MERMAID_KEYBOARD_HEIGHT_STEP_PX)
    },
    [commitCustomHeight, resolveResizeBaseHeight]
  )

  const handleResizeDoubleClick = useCallback(() => {
    if (!hasSvgRef.current) return
    setState((prev) => ({
      ...prev,
      customHeightPx: null,
      lockedAutoHeightPx: isIdentityViewport(prev.zoom, prev.pan) ? null : prev.lockedAutoHeightPx
    }))
  }, [])

  const effectiveHeightPx = state.customHeightPx ?? state.lockedAutoHeightPx

  return {
    viewportRef,
    zoom: state.zoom,
    zoomPercent: Math.round(state.zoom * 100),
    pan: state.pan,
    effectiveHeightPx,
    hasSvg,
    canZoomIn: hasSvg && state.zoom < MERMAID_MAX_ZOOM,
    canZoomOut: hasSvg && state.zoom > MERMAID_MIN_ZOOM,
    isPanning: panSession.isDragging,
    isResizingHeight: resizeSession.isDragging,
    handleZoomIn,
    handleZoomOut,
    handleResetZoom,
    handlePanStart,
    handleResizeStart,
    handleResizeKeyDown,
    handleResizeDoubleClick
  }
}
