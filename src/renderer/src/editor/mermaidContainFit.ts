import type { MermaidIntrinsicBounds } from './mermaidSvgBounds'

const MERMAID_MIN_HEIGHT_PX = 64
const MERMAID_MAX_HEIGHT_PX = 1600
export const MERMAID_DEFAULT_FALLBACK_HEIGHT_PX = 240

export interface MermaidHeightBounds {
  min: number
  max: number
}

const DEFAULT_MERMAID_HEIGHT_BOUNDS: MermaidHeightBounds = {
  min: MERMAID_MIN_HEIGHT_PX,
  max: MERMAID_MAX_HEIGHT_PX
}

export interface MeasuredViewportBox {
  availableWidth: number
  verticalInset: number
}

export interface MermaidContainFitMetrics {
  autoViewportHeightPx: number
  heightBounds: MermaidHeightBounds
  fittedSvgWidthPx: number
  fittedSvgHeightPx: number
}

export interface MermaidViewportFitResult {
  fitMetrics: MermaidContainFitMetrics | null
  autoViewportHeightPx: number | null
  heightBounds: MermaidHeightBounds
}

interface SvgInlineStyleSnapshot {
  width: string
  height: string
  maxWidth: string
}

const originalSvgInlineStyles = new WeakMap<SVGSVGElement, SvgInlineStyleSnapshot>()

/**
 * Clamps Mermaid viewport container height to `[bounds.min, bounds.max]` integer pixels.
 */
export function clampMermaidHeight(
  value: number,
  bounds: MermaidHeightBounds = DEFAULT_MERMAID_HEIGHT_BOUNDS
): number {
  if (!Number.isFinite(value)) {
    return MERMAID_DEFAULT_FALLBACK_HEIGHT_PX
  }
  const clamped = Math.min(bounds.max, Math.max(bounds.min, value))
  return Math.round(clamped)
}

function computeContainFitMetrics(
  bounds: MermaidIntrinsicBounds,
  box: MeasuredViewportBox,
  customHeightPx: number | null
): MermaidContainFitMetrics {
  const safeWidth = Math.max(1, box.availableWidth)
  const safeInset = Math.max(0, box.verticalInset)
  const initialScale = Math.min(1, safeWidth / bounds.naturalWidth)
  const autoViewportHeightPx = Math.round(bounds.naturalHeight * initialScale + safeInset)
  const heightBounds: MermaidHeightBounds = {
    min: Math.min(MERMAID_MIN_HEIGHT_PX, autoViewportHeightPx),
    max: Math.max(MERMAID_MAX_HEIGHT_PX, autoViewportHeightPx)
  }

  let scale = initialScale
  if (customHeightPx !== null) {
    const clampedHeight = clampMermaidHeight(customHeightPx, heightBounds)
    const availableHeight = Math.max(1, clampedHeight - safeInset)
    scale = Math.min(safeWidth / bounds.naturalWidth, availableHeight / bounds.naturalHeight)
  }

  return {
    autoViewportHeightPx,
    heightBounds,
    fittedSvgWidthPx: Math.min(safeWidth, Math.round(bounds.naturalWidth * scale * 100) / 100),
    fittedSvgHeightPx: Math.round(bounds.naturalHeight * scale * 100) / 100
  }
}

/**
 * Resolves Contain-fit metrics when intrinsic bounds and viewport width are available,
 * or falls back cleanly to default height bounds for unbounded SVGs / unmeasured layouts.
 */
export function computeFitMetricsOrFallback(
  bounds: MermaidIntrinsicBounds | null,
  box: MeasuredViewportBox,
  customHeightPx: number | null
): MermaidViewportFitResult {
  if (!bounds || box.availableWidth <= 0) {
    return {
      fitMetrics: null,
      autoViewportHeightPx: null,
      heightBounds: DEFAULT_MERMAID_HEIGHT_BOUNDS
    }
  }
  const fitMetrics = computeContainFitMetrics(bounds, box, customHeightPx)
  return {
    fitMetrics,
    autoViewportHeightPx: fitMetrics.autoViewportHeightPx,
    heightBounds: fitMetrics.heightBounds
  }
}

function sumCssPx(
  style: CSSStyleDeclaration | null,
  properties: ReadonlyArray<
    | 'paddingLeft'
    | 'paddingRight'
    | 'paddingTop'
    | 'paddingBottom'
    | 'borderLeftWidth'
    | 'borderRightWidth'
    | 'borderTopWidth'
    | 'borderBottomWidth'
  >
): number {
  if (!style) return 0
  let total = 0
  for (const prop of properties) {
    total += Number.parseFloat(style[prop]) || 0
  }
  return total
}

/**
 * Measures the usable inner SVG stage width and total vertical padding/border box inset.
 */
export function readViewportBox(el: HTMLDivElement | null): MeasuredViewportBox {
  if (!el) {
    return { availableWidth: 0, verticalInset: 0 }
  }
  const rect = el.getBoundingClientRect()
  const style = typeof window !== 'undefined' ? window.getComputedStyle(el) : null
  const horizontalInset = sumCssPx(style, [
    'paddingLeft',
    'paddingRight',
    'borderLeftWidth',
    'borderRightWidth'
  ])
  const verticalInset = sumCssPx(style, [
    'paddingTop',
    'paddingBottom',
    'borderTopWidth',
    'borderBottomWidth'
  ])
  const rawWidth = rect.width > 0 ? rect.width : el.clientWidth

  return {
    availableWidth: rawWidth > 0 ? Math.max(1, rawWidth - horizontalInset) : 0,
    verticalInset
  }
}

/**
 * Applies Contain-fitted SVG dimensions and conditional `max-width` removal to a live `<svg>`
 * element, preserving and restoring its original Mermaid inline styles when falling back.
 */
export function applySvgContainFitStyles(
  svgEl: SVGSVGElement,
  fitMetrics: MermaidContainFitMetrics | null,
  isCustomHeight: boolean
): void {
  let original = originalSvgInlineStyles.get(svgEl)
  if (!original) {
    original = {
      width: svgEl.style.width,
      height: svgEl.style.height,
      maxWidth: svgEl.style.maxWidth
    }
    originalSvgInlineStyles.set(svgEl, original)
  }

  if (!fitMetrics) {
    svgEl.style.width = original.width
    svgEl.style.height = original.height
    svgEl.style.maxWidth = original.maxWidth
    return
  }

  svgEl.style.width = `${fitMetrics.fittedSvgWidthPx}px`
  svgEl.style.height = `${fitMetrics.fittedSvgHeightPx}px`
  if (isCustomHeight) {
    svgEl.style.removeProperty('max-width')
  } else {
    svgEl.style.maxWidth = original.maxWidth
  }
}
