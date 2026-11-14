import { describe, expect, it, vi } from 'vitest'
import {
  createMermaidRenderer,
  hashMermaidSource,
  mapThemeToMermaidTheme,
  sanitizeMermaidSvg,
  type MermaidDriver
} from './mermaidRenderer'

describe('mermaidRenderer', () => {
  it('maps app theme to Mermaid theme and caches rendered SVGs by (theme, code)', async () => {
    expect(mapThemeToMermaidTheme('light')).toBe('default')
    expect(mapThemeToMermaidTheme('dark')).toBe('dark')

    const driver: MermaidDriver = {
      initialize: vi.fn(),
      render: vi.fn(async (_id, text) => ({
        svg: `<svg data-code="${text.trim()}"><g><rect width="10" height="10"/></g></svg>`
      }))
    }

    const renderer = createMermaidRenderer(driver)
    const diagram = 'graph TD\n  A --> B'

    const first = await renderer.render(diagram, 'light')
    expect(first).toEqual({
      ok: true,
      svg: expect.stringContaining('<svg'),
      fromCache: false
    })
    expect(driver.initialize).toHaveBeenCalledWith(
      expect.objectContaining({ startOnLoad: false, theme: 'default', securityLevel: 'strict' })
    )
    expect(driver.render).toHaveBeenCalledTimes(1)

    // Identical code with trailing newline / CRLF difference hits cache without re-rendering
    const cachedHit = await renderer.render('graph TD\r\n  A --> B\r\n', 'light')
    expect(cachedHit.ok).toBe(true)
    if (cachedHit.ok) {
      expect(cachedHit.fromCache).toBe(true)
    }
    expect(renderer.getCachedSvg(diagram, 'light')).toContain('<svg')
    expect(driver.render).toHaveBeenCalledTimes(1)

    // Switching to dark theme re-initializes and re-renders for dark theme, keeping light cached
    const darkRender = await renderer.render(diagram, 'dark')
    expect(darkRender.ok).toBe(true)
    if (darkRender.ok) {
      expect(darkRender.fromCache).toBe(false)
    }
    expect(driver.initialize).toHaveBeenLastCalledWith(
      expect.objectContaining({ theme: 'dark' })
    )
    expect(driver.render).toHaveBeenCalledTimes(2)

    // Switching back to light hits cache cleanly
    const lightAgain = await renderer.render(diagram, 'light')
    expect(lightAgain.ok).toBe(true)
    if (lightAgain.ok) {
      expect(lightAgain.fromCache).toBe(true)
    }
    expect(driver.render).toHaveBeenCalledTimes(2)
  })

  it('deduplicates concurrent in-flight renders for identical (theme, code)', async () => {
    let resolveRender!: (val: { svg: string }) => void
    const driver: MermaidDriver = {
      initialize: vi.fn(),
      render: vi.fn(
        () =>
          new Promise<{ svg: string }>((resolve) => {
            resolveRender = resolve
          })
      )
    }
    const renderer = createMermaidRenderer(driver)

    const p1 = renderer.render('flowchart LR\n  A-->B', 'light')
    const p2 = renderer.render('flowchart LR\n  A-->B', 'light')

    resolveRender({ svg: '<svg><path d="M0 0"/></svg>' })
    const [r1, r2] = await Promise.all([p1, p2])

    expect(driver.render).toHaveBeenCalledTimes(1)
    expect(r1.ok).toBe(true)
    expect(r2.ok).toBe(true)
  })

  it('isolates Mermaid parse/render errors without throwing or poisoning the cache', async () => {
    const driver: MermaidDriver = {
      initialize: vi.fn(),
      render: vi.fn(async (_id, text) => {
        if (text.includes('broken')) {
          throw new Error('Syntax error in text')
        }
        return { svg: '<svg><g/></svg>' }
      })
    }

    const renderer = createMermaidRenderer(driver)

    const failed = await renderer.render('broken %%% syntax', 'light')
    expect(failed).toEqual({
      ok: false,
      errorMessage: 'Syntax error in text'
    })
    expect(renderer.getCachedSvg('broken %%% syntax', 'light')).toBeNull()

    const empty = await renderer.render('   \n  ', 'light')
    expect(empty.ok).toBe(false)
    expect(driver.render).toHaveBeenCalledTimes(1)
  })

  it('sanitizes XSS vectors out of rendered Mermaid SVG while preserving legitimate SVG and foreignObject labels', () => {
    const dirtySvg = [
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)">',
      '<style>.node rect { fill: #fff; }</style>',
      '<script>alert("xss")</script>',
      '<iframe src="https://evil.example"></iframe>',
      '<g onclick="alert(2)">',
      '<path d="M0 0 L10 10" />',
      '<foreignObject width="100" height="30"><div xmlns="http://www.w3.org/1999/xhtml" onmouseover="alert(3)">Label</div></foreignObject>',
      '<a href="javascript:alert(4)"><text>BadLink</text></a>',
      '</g>',
      '</svg>'
    ].join('')

    const clean = sanitizeMermaidSvg(dirtySvg)

    expect(clean).toContain('<svg')
    expect(clean).toContain('<style>')
    expect(clean).toContain('<path')
    expect(clean.toLowerCase()).toContain('foreignobject')
    expect(clean).toContain('Label')
    expect(clean).not.toContain('<script')
    expect(clean).not.toContain('<iframe')
    expect(clean.toLowerCase()).not.toContain('onload')
    expect(clean.toLowerCase()).not.toContain('onclick')
    expect(clean.toLowerCase()).not.toContain('onmouseover')
    expect(clean.toLowerCase()).not.toContain('javascript:')
  })

  it('computes distinct hashes for distinct diagram sources and evicts oldest entries at capacity', async () => {
    expect(hashMermaidSource('graph TD; A-->B')).not.toBe(hashMermaidSource('graph TD; A-->C'))

    const driver: MermaidDriver = {
      initialize: vi.fn(),
      render: vi.fn(async (_id, text) => ({ svg: `<svg>${text}</svg>` }))
    }
    const renderer = createMermaidRenderer(driver, { maxCacheEntries: 2 })

    await renderer.render('graph TD; A-->1', 'light')
    await renderer.render('graph TD; A-->2', 'light')
    await renderer.render('graph TD; A-->3', 'light')

    // Entry 1 was evicted when entry 3 was added
    expect(renderer.getCachedSvg('graph TD; A-->1', 'light')).toBeNull()
    expect(renderer.getCachedSvg('graph TD; A-->2', 'light')).not.toBeNull()
    expect(renderer.getCachedSvg('graph TD; A-->3', 'light')).not.toBeNull()
  })
})
