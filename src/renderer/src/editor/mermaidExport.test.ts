import { describe, expect, it, vi } from 'vitest'
import { installSvgCanvasStub } from '../test/svgCanvasStub'
import {
  defaultCanvasPngRasterAdapter,
  type DiagramSvgRasterRequest,
  normalizeMermaidSvg,
  rasterizeMermaidSvgToPng
} from './mermaidExport'

describe('mermaidExport', () => {
  it('normalizes Mermaid SVG with 16px padded viewBox, explicit dimensions, stripped max-width, bottom theme background rect, and valid XML foreignObject serialization', () => {
    const rawSvg = [
      '<svg id="mermaid-1" width="100%" viewBox="10 20 200 100" style="max-width: 200px; font-family: sans-serif;">',
      '<style>#mermaid-1 .edge > path { stroke: #333; }</style>',
      '<g><foreignObject width="100" height="30"><div xmlns="http://www.w3.org/1999/xhtml"><span class="nodeLabel">A &amp; B<br>C</span></div></foreignObject></g>',
      '</svg>'
    ].join('')

    const lightResult = normalizeMermaidSvg(rawSvg, 'light')
    expect(lightResult.width).toBe(232)
    expect(lightResult.height).toBe(132)

    const lightDoc = new DOMParser().parseFromString(lightResult.svg, 'image/svg+xml')
    expect(lightDoc.querySelector('parsererror')).toBeNull()

    const lightSvg = lightDoc.documentElement
    expect(lightSvg.tagName).toBe('svg')
    expect(lightSvg.getAttribute('xmlns')).toBe('http://www.w3.org/2000/svg')
    expect(lightSvg.getAttribute('viewBox')).toBe('-6 4 232 132')
    expect(lightSvg.getAttribute('width')).toBe('232')
    expect(lightSvg.getAttribute('height')).toBe('132')
    expect(lightSvg.getAttribute('style') ?? '').not.toContain('max-width')
    expect(lightSvg.getAttribute('style')).toContain('font-family: sans-serif')

    const lightFirstChild = lightSvg.firstElementChild
    expect(lightFirstChild?.tagName).toBe('rect')
    expect(lightFirstChild?.getAttribute('x')).toBe('-6')
    expect(lightFirstChild?.getAttribute('y')).toBe('4')
    expect(lightFirstChild?.getAttribute('width')).toBe('232')
    expect(lightFirstChild?.getAttribute('height')).toBe('132')
    expect(lightFirstChild?.getAttribute('fill')).toBe('#ffffff')

    const foreignObject = lightSvg.querySelector('foreignObject')
    expect(foreignObject).not.toBeNull()
    const htmlChild = foreignObject?.firstElementChild
    expect(htmlChild?.namespaceURI).toBe('http://www.w3.org/1999/xhtml')
    expect(lightResult.svg).toContain('<br />')

    // Dark theme uses #161b22 surface color and strips style completely when max-width was the only style
    const darkInput =
      '<svg width="150" height="80px" style="max-width: 150px;"><g><rect width="150" height="80"/></g></svg>'
    const darkResult = normalizeMermaidSvg(darkInput, 'dark')
    expect(darkResult.width).toBe(182)
    expect(darkResult.height).toBe(112)

    const darkDoc = new DOMParser().parseFromString(darkResult.svg, 'image/svg+xml')
    expect(darkDoc.querySelector('parsererror')).toBeNull()
    const darkSvg = darkDoc.documentElement
    expect(darkSvg.getAttribute('viewBox')).toBe('-16 -16 182 112')
    expect(darkSvg.getAttribute('width')).toBe('182')
    expect(darkSvg.getAttribute('height')).toBe('112')
    expect(darkSvg.hasAttribute('style')).toBe(false)
    expect(darkSvg.firstElementChild?.tagName).toBe('rect')
    expect(darkSvg.firstElementChild?.getAttribute('fill')).toBe('#161b22')

    // Rejects SVG without explicit viewBox or positive numeric dimensions
    expect(() => normalizeMermaidSvg('<svg width="100%" height="100%"><g/></svg>', 'light')).toThrow()
    expect(() => normalizeMermaidSvg('<div>not svg</div>', 'light')).toThrow()
  })

  it('rasterizes normalized SVG to 2x PNG via offline data URI and clamps oversized diagrams within 8192px / 67,108,864px limits preserving aspect ratio', async () => {
    const requests: DiagramSvgRasterRequest[] = []
    const expectedPng = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
    const rasterAdapter = vi.fn(async (request: DiagramSvgRasterRequest) => {
      requests.push(request)
      return expectedPng
    })

    // 1. Standard 200x100 SVG -> padded 232x132 -> 2x raster 464x264 with dark #161b22 surface
    const standardSvg = '<svg viewBox="0 0 200 100"><rect width="200" height="100"/></svg>'
    const bytes = await rasterizeMermaidSvgToPng(standardSvg, 'dark', rasterAdapter)
    expect(bytes).toBe(expectedPng)
    expect(requests).toHaveLength(1)
    expect(requests[0].svgDataUri.startsWith('data:image/svg+xml;charset=utf-8,')).toBe(true)
    const decodedStandardSvg = decodeURIComponent(
      requests[0].svgDataUri.slice('data:image/svg+xml;charset=utf-8,'.length)
    )
    expect(decodedStandardSvg).toContain('width="232"')
    expect(decodedStandardSvg).toContain('height="132"')
    expect(decodedStandardSvg).toContain('fill="#161b22"')
    expect(requests[0]).toMatchObject({
      pixelWidth: 464,
      pixelHeight: 264
    })

    // 2. Extremely wide diagram (padded 10000 x 2000) -> clamped to max side 8192 keeping 5:1 aspect ratio
    const wideSvg = '<svg viewBox="0 0 9968 1968"><rect width="9968" height="1968"/></svg>'
    await rasterizeMermaidSvgToPng(wideSvg, 'light', rasterAdapter)
    expect(requests[1].pixelWidth).toBe(8192)
    expect(requests[1].pixelHeight).toBe(1638)
    expect(requests[1].pixelWidth * requests[1].pixelHeight).toBeLessThanOrEqual(67_108_864)

    // 3. Oversized square diagram (padded 5000 x 5000 -> 2x would exceed 8192px and 67,108,864px) -> clamped to 8192 x 8192
    const squareSvg = '<svg viewBox="0 0 4968 4968"><rect width="4968" height="4968"/></svg>'
    await rasterizeMermaidSvgToPng(squareSvg, 'light', rasterAdapter)
    expect(requests[2].pixelWidth).toBe(8192)
    expect(requests[2].pixelHeight).toBe(8192)
    expect(requests[2].pixelWidth * requests[2].pixelHeight).toBe(67_108_864)
  })

  it('decodes SVG data URI into an offscreen canvas and extracts PNG bytes via defaultCanvasPngRasterAdapter', async () => {
    const stub = installSvgCanvasStub()

    try {
      const pngBytes = await defaultCanvasPngRasterAdapter({
        svgDataUri: 'data:image/svg+xml;charset=utf-8,%3Csvg%3E%3C/svg%3E',
        pixelWidth: 200,
        pixelHeight: 100
      })
      expect(Array.from(pngBytes)).toEqual([137, 80, 78, 71, 1, 200])
      expect(stub.clearRectSpy).toHaveBeenCalledWith(0, 0, 200, 100)
      expect(stub.drawImageSpy).toHaveBeenCalledWith(expect.anything(), 0, 0, 200, 100)

      stub.setFailDecode(true)
      await expect(
        defaultCanvasPngRasterAdapter({
          svgDataUri: 'data:image/svg+xml;charset=utf-8,%3Csvg%3E%3C/svg%3E',
          pixelWidth: 200,
          pixelHeight: 100
        })
      ).rejects.toThrow()

      stub.setFailDecode(false)
      stub.setEmitNullBlob(true)
      await expect(
        defaultCanvasPngRasterAdapter({
          svgDataUri: 'data:image/svg+xml;charset=utf-8,%3Csvg%3E%3C/svg%3E',
          pixelWidth: 200,
          pixelHeight: 100
        })
      ).rejects.toThrow()
    } finally {
      stub.restore()
    }
  })
})
