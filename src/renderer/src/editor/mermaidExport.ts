import type { ThemeMode } from '@shared/config'
import { sanitizeDiagramFileNamePart } from '@shared/diagram'
import type { DiagramExportFormat } from '@shared/ipc'

export const MERMAID_EXPORT_PADDING_PX = 16
export const DEFAULT_PNG_EXPORT_SCALE = 2
export const MAX_PNG_DIMENSION_PX = 8192
export const MAX_PNG_AREA_PX = 67_108_864

export const MERMAID_EXPORT_BACKGROUND_COLORS: Record<ThemeMode, string> = {
  light: '#ffffff',
  dark: '#161b22'
}

export interface NormalizedMermaidSvg {
  svg: string
  width: number
  height: number
}

interface SvgBounds {
  minX: number
  minY: number
  width: number
  height: number
}

const SVG_NS = 'http://www.w3.org/2000/svg'
const XLINK_NS = 'http://www.w3.org/1999/xlink'

function formatSvgNumber(value: number): string {
  return String(Number(value.toFixed(4)))
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

function extractSvgBounds(svgElement: SVGSVGElement): SvgBounds {
  const fromViewBox = parseViewBox(svgElement.getAttribute('viewBox'))
  if (fromViewBox) {
    return fromViewBox
  }

  const width = parseSvgPixelLength(svgElement.getAttribute('width'))
  const height = parseSvgPixelLength(svgElement.getAttribute('height'))
  if (width !== null && height !== null) {
    return { minX: 0, minY: 0, width, height }
  }

  throw new Error('Mermaid SVG 크기를 확인할 수 없습니다.')
}

function ensureXmlNamespaces(svgElement: SVGSVGElement): void {
  let hasXlinkPrefix = false
  const elements: Element[] = [svgElement, ...Array.from(svgElement.querySelectorAll('*'))]

  for (const element of elements) {
    // HTML5 parser preserves an explicit xmlns attribute alongside element.namespaceURI;
    // dropping the redundant attribute prevents XMLSerializer from emitting duplicate xmlns attrs.
    if (element.namespaceURI && element.getAttribute('xmlns') === element.namespaceURI) {
      element.removeAttribute('xmlns')
    }
    if (!hasXlinkPrefix) {
      for (const attr of Array.from(element.attributes)) {
        if (attr.name.startsWith('xlink:')) {
          hasXlinkPrefix = true
          break
        }
      }
    }
  }

  if (hasXlinkPrefix && !svgElement.hasAttribute('xmlns:xlink')) {
    svgElement.setAttribute('xmlns:xlink', XLINK_NS)
  }
}

/**
 * Normalizes a rendered Mermaid SVG into a standalone XML SVG with 16px outer padding,
 * explicit pixel dimensions, cleaned responsive max-width styling, an opaque theme
 * background layer, and preserved foreignObject XML namespaces.
 */
export function normalizeMermaidSvg(svgMarkup: string, theme: ThemeMode): NormalizedMermaidSvg {
  if (typeof svgMarkup !== 'string' || svgMarkup.trim().length === 0) {
    throw new Error('내보낼 Mermaid SVG 마크업이 비어 있습니다.')
  }

  const doc = new DOMParser().parseFromString(svgMarkup, 'text/html')
  const svgElement = doc.body.querySelector('svg')
  if (!svgElement) {
    throw new Error('내보낼 Mermaid SVG 요소를 찾을 수 없습니다.')
  }

  const bounds = extractSvgBounds(svgElement as unknown as SVGSVGElement)
  const paddedMinX = bounds.minX - MERMAID_EXPORT_PADDING_PX
  const paddedMinY = bounds.minY - MERMAID_EXPORT_PADDING_PX
  const paddedWidth = Number((bounds.width + MERMAID_EXPORT_PADDING_PX * 2).toFixed(4))
  const paddedHeight = Number((bounds.height + MERMAID_EXPORT_PADDING_PX * 2).toFixed(4))

  const minXStr = formatSvgNumber(paddedMinX)
  const minYStr = formatSvgNumber(paddedMinY)
  const widthStr = formatSvgNumber(paddedWidth)
  const heightStr = formatSvgNumber(paddedHeight)

  svgElement.setAttribute('viewBox', `${minXStr} ${minYStr} ${widthStr} ${heightStr}`)
  svgElement.setAttribute('width', widthStr)
  svgElement.setAttribute('height', heightStr)

  const typedSvg = svgElement as unknown as SVGSVGElement
  typedSvg.style?.removeProperty('max-width')
  if (!svgElement.getAttribute('style')?.trim()) {
    svgElement.removeAttribute('style')
  }

  const backgroundRect = doc.createElementNS(SVG_NS, 'rect')
  backgroundRect.setAttribute('x', minXStr)
  backgroundRect.setAttribute('y', minYStr)
  backgroundRect.setAttribute('width', widthStr)
  backgroundRect.setAttribute('height', heightStr)
  backgroundRect.setAttribute('fill', MERMAID_EXPORT_BACKGROUND_COLORS[theme])
  svgElement.insertBefore(backgroundRect, svgElement.firstChild)

  ensureXmlNamespaces(typedSvg)

  return {
    svg: new XMLSerializer().serializeToString(svgElement),
    width: paddedWidth,
    height: paddedHeight
  }
}

function computeRasterDimensions(
  logicalWidth: number,
  logicalHeight: number
): { pixelWidth: number; pixelHeight: number } {
  const maxScaleByDimension = Math.min(
    MAX_PNG_DIMENSION_PX / logicalWidth,
    MAX_PNG_DIMENSION_PX / logicalHeight
  )
  const maxScaleByArea = Math.sqrt(MAX_PNG_AREA_PX / (logicalWidth * logicalHeight))
  const effectiveScale = Math.min(DEFAULT_PNG_EXPORT_SCALE, maxScaleByDimension, maxScaleByArea)

  let pixelWidth = Math.max(1, Math.round(logicalWidth * effectiveScale))
  let pixelHeight = Math.max(1, Math.round(logicalHeight * effectiveScale))

  if (
    pixelWidth > MAX_PNG_DIMENSION_PX ||
    pixelHeight > MAX_PNG_DIMENSION_PX ||
    pixelWidth * pixelHeight > MAX_PNG_AREA_PX
  ) {
    pixelWidth = Math.max(1, Math.floor(logicalWidth * effectiveScale))
    pixelHeight = Math.max(1, Math.floor(logicalHeight * effectiveScale))
  }

  return {
    pixelWidth,
    pixelHeight
  }
}

function encodeSvgDataUri(normalizedSvg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(normalizedSvg)}`
}

function loadSvgImage(svgDataUri: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.decoding = 'sync'
    const cleanup = (): void => {
      img.onload = null
      img.onerror = null
    }
    img.onload = () => {
      cleanup()
      resolve(img)
    }
    img.onerror = () => {
      cleanup()
      reject(new Error('Mermaid SVG 이미지를 디코딩할 수 없습니다.'))
    }
    img.src = svgDataUri
  })
}

function canvasToPngBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob(
        (blob) => {
          if (!blob) {
            reject(new Error('PNG 이미지를 생성하지 못했습니다.'))
            return
          }
          void blob
            .arrayBuffer()
            .then((buffer) => {
              const bytes = new Uint8Array(buffer)
              if (bytes.byteLength === 0) {
                reject(new Error('생성된 PNG 이미지가 비어 있습니다.'))
                return
              }
              resolve(bytes)
            })
            .catch(reject)
        },
        'image/png'
      )
    } catch (error) {
      reject(error)
    }
  })
}

/**
 * Normalizes a Mermaid SVG with active theme background and 16px outer padding,
 * encodes it as an offline UTF-8 SVG data URI, clamps oversized dimensions, and
 * rasterizes to 2x PNG bytes via an offscreen HTML canvas.
 */
export async function rasterizeMermaidSvgToPng(
  svgMarkup: string,
  theme: ThemeMode
): Promise<Uint8Array> {
  const normalized = normalizeMermaidSvg(svgMarkup, theme)
  const { pixelWidth, pixelHeight } = computeRasterDimensions(normalized.width, normalized.height)
  const svgDataUri = encodeSvgDataUri(normalized.svg)

  const img = await loadSvgImage(svgDataUri)
  const canvas = document.createElement('canvas')
  canvas.width = pixelWidth
  canvas.height = pixelHeight

  const ctx = canvas.getContext('2d')
  if (!ctx) {
    throw new Error('2D 캔버스 컨텍스트를 생성할 수 없습니다.')
  }

  ctx.clearRect(0, 0, pixelWidth, pixelHeight)
  ctx.drawImage(img, 0, 0, pixelWidth, pixelHeight)
  return await canvasToPngBytes(canvas)
}

/**
 * Generates a Windows-safe default filename (`<title>-diagram.<ext>`) from the active
 * document title, falling back to `mermaid-diagram.<ext>` when empty after sanitization.
 */
export function buildMermaidExportFileName(
  documentTitle: string | undefined,
  format: DiagramExportFormat
): string {
  const sanitizedTitle = documentTitle ? sanitizeDiagramFileNamePart(documentTitle) : ''
  const baseName = sanitizedTitle.length > 0 ? `${sanitizedTitle}-diagram` : 'mermaid-diagram'
  return `${baseName}.${format}`
}
