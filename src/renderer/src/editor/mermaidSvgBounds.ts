export interface SvgBounds {
  minX: number
  minY: number
  width: number
  height: number
}

export interface MermaidIntrinsicBounds {
  naturalWidth: number
  naturalHeight: number
}

function parseViewBox(rawViewBox: string | null): SvgBounds | null {
  if (!rawViewBox) {
    return null
  }
  const parts = rawViewBox.trim().split(/[\s,]+/)
  if (parts.length !== 4) {
    return null
  }
  const [minX, minY, width, height] = parts.map((part) => Number(part))
  if (
    !Number.isFinite(minX) ||
    !Number.isFinite(minY) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return null
  }
  return { minX, minY, width, height }
}

function parseSvgPixelLength(rawLength: string | null): number | null {
  if (!rawLength) {
    return null
  }
  const match = rawLength.trim().match(/^(\d+(?:\.\d+)?|\.\d+)(?:px)?$/i)
  if (!match) {
    return null
  }
  const value = Number(match[1])
  return Number.isFinite(value) && value > 0 ? value : null
}

/**
 * Parses sanitized SVG markup into an `SVGSVGElement`, returning `null` if absent or empty.
 */
export function parseSvgElement(svgMarkup: string): SVGSVGElement | null {
  if (typeof svgMarkup !== 'string' || svgMarkup.trim().length === 0) {
    return null
  }
  const doc = new DOMParser().parseFromString(svgMarkup, 'text/html')
  return (doc.body.querySelector('svg') as SVGSVGElement | null) ?? null
}

/**
 * Attempts to read SVG bounds from `viewBox` or numeric `width`/`height` attributes.
 */
export function tryExtractSvgBounds(svgElement: SVGSVGElement): SvgBounds | null {
  const fromViewBox = parseViewBox(svgElement.getAttribute('viewBox'))
  if (fromViewBox) {
    return fromViewBox
  }

  const width = parseSvgPixelLength(svgElement.getAttribute('width'))
  const height = parseSvgPixelLength(svgElement.getAttribute('height'))
  if (width !== null && height !== null) {
    return { minX: 0, minY: 0, width, height }
  }

  return null
}

/**
 * Extracts required SVG bounds for export, throwing if intrinsic dimensions are unavailable.
 */
export function extractSvgBounds(svgElement: SVGSVGElement): SvgBounds {
  const bounds = tryExtractSvgBounds(svgElement)
  if (bounds) {
    return bounds
  }
  throw new Error('Mermaid SVG 크기를 확인할 수 없습니다.')
}

/**
 * Extracts natural SVG logical dimensions from `viewBox` or numeric `width`/`height`
 * attributes, returning `null` when valid intrinsic dimensions cannot be determined.
 */
export function extractMermaidIntrinsicBounds(svgMarkup: string): MermaidIntrinsicBounds | null {
  const svgElement = parseSvgElement(svgMarkup)
  if (!svgElement) {
    return null
  }
  const bounds = tryExtractSvgBounds(svgElement)
  if (!bounds) {
    return null
  }
  return {
    naturalWidth: bounds.width,
    naturalHeight: bounds.height
  }
}
