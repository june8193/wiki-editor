import { describe, expect, it } from 'vitest'
import { installSvgCanvasStub } from '../test/svgCanvasStub'
import {
  buildMermaidExportFileName,
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

  it('rasterizes normalized SVG to 2x PNG via offline data URI, clamps oversized diagrams within 8192px / 67,108,864px preserving aspect ratio, and surfaces decode/blob failures', async () => {
    const stub = installSvgCanvasStub()

    try {
      // 1. Standard 200x100 SVG -> padded 232x132 -> 2x raster 464x264 with dark #161b22 surface
      const standardSvg = '<svg viewBox="0 0 200 100"><rect width="200" height="100"/></svg>'
      const bytes = await rasterizeMermaidSvgToPng(standardSvg, 'dark')
      expect(Array.from(bytes)).toEqual([137, 80, 78, 71, 2, 464 & 0xff])
      expect(stub.calls).toHaveLength(1)
      expect(stub.calls[0].svgDataUri.startsWith('data:image/svg+xml;charset=utf-8,')).toBe(true)
      expect(stub.calls[0].decodedSvg).toContain('width="232"')
      expect(stub.calls[0].decodedSvg).toContain('height="132"')
      expect(stub.calls[0].decodedSvg).toContain('fill="#161b22"')
      expect(stub.calls[0]).toMatchObject({
        pixelWidth: 464,
        pixelHeight: 264
      })
      expect(stub.clearRectSpy).toHaveBeenCalledWith(0, 0, 464, 264)
      expect(stub.drawImageSpy).toHaveBeenCalledWith(expect.anything(), 0, 0, 464, 264)

      // 2. Extremely wide diagram (padded 10000 x 2000) -> clamped to max side 8192 keeping 5:1 aspect ratio
      const wideSvg = '<svg viewBox="0 0 9968 1968"><rect width="9968" height="1968"/></svg>'
      await rasterizeMermaidSvgToPng(wideSvg, 'light')
      expect(stub.calls[1].pixelWidth).toBe(8192)
      expect(stub.calls[1].pixelHeight).toBe(1638)
      expect(stub.calls[1].pixelWidth * stub.calls[1].pixelHeight).toBeLessThanOrEqual(67_108_864)

      // 3. Oversized square diagram (padded 5000 x 5000 -> 2x would exceed 8192px and 67,108,864px) -> clamped to 8192 x 8192
      const squareSvg = '<svg viewBox="0 0 4968 4968"><rect width="4968" height="4968"/></svg>'
      await rasterizeMermaidSvgToPng(squareSvg, 'light')
      expect(stub.calls[2].pixelWidth).toBe(8192)
      expect(stub.calls[2].pixelHeight).toBe(8192)
      expect(stub.calls[2].pixelWidth * stub.calls[2].pixelHeight).toBe(67_108_864)

      // 4. Decode and empty-blob failures propagate as rejections
      stub.setFailDecode(true)
      await expect(rasterizeMermaidSvgToPng(standardSvg, 'light')).rejects.toThrow()

      stub.setFailDecode(false)
      stub.setEmitNullBlob(true)
      await expect(rasterizeMermaidSvgToPng(standardSvg, 'light')).rejects.toThrow()
    } finally {
      stub.restore()
    }
  })

  it('builds default export file names from document titles, strips Windows forbidden characters and edge whitespace/periods, and falls back to mermaid-diagram', () => {
    expect(buildMermaidExportFileName('architecture-guide', 'png')).toBe(
      'architecture-guide-diagram.png'
    )
    expect(buildMermaidExportFileName('아키텍처 v1.2 문서', 'svg')).toBe(
      '아키텍처 v1.2 문서-diagram.svg'
    )
    expect(buildMermaidExportFileName('  ..Guide: <v1>"a/b\\c|d?e*f\u0000\u001f...  ', 'png')).toBe(
      'Guide v1abcdef-diagram.png'
    )
    expect(buildMermaidExportFileName('...  sub.title  ..', 'svg')).toBe(
      'sub.title-diagram.svg'
    )

    // Missing or empty-after-sanitization titles fall back to mermaid-diagram.<ext>
    expect(buildMermaidExportFileName(undefined, 'png')).toBe('mermaid-diagram.png')
    expect(buildMermaidExportFileName(undefined, 'svg')).toBe('mermaid-diagram.svg')
    expect(buildMermaidExportFileName('', 'png')).toBe('mermaid-diagram.png')
    expect(buildMermaidExportFileName('   \t  ', 'svg')).toBe('mermaid-diagram.svg')
    expect(buildMermaidExportFileName('...', 'png')).toBe('mermaid-diagram.png')
    expect(buildMermaidExportFileName('<>:"/\\|?*\u0000\u001f . .', 'svg')).toBe(
      'mermaid-diagram.svg'
    )
  })
})
