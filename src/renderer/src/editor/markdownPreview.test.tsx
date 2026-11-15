import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WikiApi } from '@shared/ipc'
import { MarkdownPreview } from '../components/MarkdownPreview'
import { installSvgCanvasStub } from '../test/svgCanvasStub'
import { createMermaidRenderer, type MermaidDriver } from './mermaidRenderer'
import { renderMarkdownToReact } from './markdownPreview'

describe('markdownPreview pipeline and XSS sanitization', () => {
  const originalWikiApi = (window as { wikiApi?: WikiApi }).wikiApi

  afterEach(() => {
    if (originalWikiApi === undefined) {
      delete (window as { wikiApi?: WikiApi }).wikiApi
    } else {
      window.wikiApi = originalWikiApi
    }
  })
  it('renders GFM headings, tables, task lists, code blocks, blockquotes, and safe links', () => {
    const md = [
      '# Main Heading',
      '',
      '> Blockquote line',
      '',
      '- [x] Completed task',
      '- [ ] Pending task',
      '',
      '| Feature | Status |',
      '| :--- | ---: |',
      '| Table | Ready |',
      '',
      '```ts',
      'const x = 1',
      '```',
      '',
      'Visit [Docs](https://example.com/docs) or [Mail](mailto:hi@example.com) or [Top](#main-heading).'
    ].join('\n')

    const { container } = render(<div>{renderMarkdownToReact(md)}</div>)

    expect(screen.getByRole('heading', { level: 1, name: 'Main Heading' })).toBeInTheDocument()
    expect(container.querySelector('blockquote')).toHaveTextContent('Blockquote line')

    const checkboxes = container.querySelectorAll('input[type="checkbox"]')
    expect(checkboxes).toHaveLength(2)
    expect((checkboxes[0] as HTMLInputElement).checked).toBe(true)
    expect((checkboxes[1] as HTMLInputElement).checked).toBe(false)

    const table = container.querySelector('table')
    expect(table).not.toBeNull()
    expect(table?.querySelectorAll('th')).toHaveLength(2)
    expect(table?.querySelector('td')).toHaveTextContent('Table')

    const codeBlock = container.querySelector('pre code.language-ts')
    expect(codeBlock).not.toBeNull()
    expect(codeBlock).toHaveTextContent('const x = 1')

    expect(screen.getByRole('link', { name: 'Docs' })).toHaveAttribute(
      'href',
      'https://example.com/docs'
    )
    expect(screen.getByRole('link', { name: 'Mail' })).toHaveAttribute(
      'href',
      'mailto:hi@example.com'
    )
    expect(screen.getByRole('link', { name: 'Top' })).toHaveAttribute('href', '#main-heading')
  })

  it('sanitizes dangerous HTML, script tags, event handlers, iframes, and unsafe URI schemes', () => {
    const maliciousMd = [
      '# Safe Title',
      '',
      '<script>alert("xss")</script>',
      '<iframe src="https://evil.example/embed"></iframe>',
      '<img src="https://example.com/ok.png" onerror="alert(1)" />',
      '<div onclick="alert(2)">Click text</div>',
      '<svg onload="alert(3)"><circle r="10" /></svg>',
      '',
      '[md-js](javascript:alert(1))',
      '<a href="javascript:alert(4)">raw-js</a>',
      '<a href="vbscript:msgbox(5)">vb-link</a>',
      '<a href="data:text/html,<script>alert(6)</script>">data-link</a>'
    ].join('\n')

    const { container } = render(<div>{renderMarkdownToReact(maliciousMd)}</div>)

    expect(screen.getByRole('heading', { level: 1, name: 'Safe Title' })).toBeInTheDocument()
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('iframe')).toBeNull()
    expect(container.querySelector('svg')).toBeNull()

    const img = container.querySelector('img')
    expect(img).not.toBeNull()
    expect(img!.getAttribute('onerror')).toBeNull()
    expect(img!.getAttribute('src')).toBe('https://example.com/ok.png')

    const html = container.innerHTML.toLowerCase()
    expect(html).not.toContain('onerror')
    expect(html).not.toContain('onclick')
    expect(html).not.toContain('onload')
    expect(html).not.toContain('javascript:')
    expect(html).not.toContain('vbscript:')
    expect(html).not.toContain('data:text/html')

    const links = container.querySelectorAll('a')
    for (const link of links) {
      expect(link.getAttribute('href')).toBeNull()
    }
  })

  it('prevents Electron in-window navigation when clicking external links in MarkdownPreview', () => {
    render(<MarkdownPreview content={'[External](https://example.com)'} scrollTop={0} />)
    const link = screen.getByRole('link', { name: 'External' })
    const wasNotPrevented = fireEvent.click(link)
    expect(wasNotPrevented).toBe(false)
  })

  it('renders an empty placeholder when markdown content is whitespace-only', () => {
    render(<MarkdownPreview content={'   \n\t  '} scrollTop={0} />)
    expect(screen.getByText('미리 볼 내용이 없습니다.')).toBeInTheDocument()
  })

  it('restores non-zero scrollTop and notifies onScrollTopChange when scrolled', () => {
    const onScrollTopChange = vi.fn()
    const { rerender } = render(
      <MarkdownPreview
        content={'# Title\n\nParagraph'}
        scrollTop={120}
        onScrollTopChange={onScrollTopChange}
      />
    )

    const preview = screen.getByTestId('document-editor') as HTMLDivElement
    expect(preview.scrollTop).toBe(120)

    rerender(
      <MarkdownPreview
        content={'# Title\n\nParagraph'}
        scrollTop={240}
        onScrollTopChange={onScrollTopChange}
      />
    )
    expect(preview.scrollTop).toBe(240)

    preview.scrollTop = 305
    fireEvent.scroll(preview)
    expect(onScrollTopChange).toHaveBeenCalledWith(305)
  })

  it('renders mermaid code blocks via MermaidDiagram with theme sync and error isolation while still sanitizing raw <svg>', async () => {
    const driver: MermaidDriver = {
      initialize: vi.fn(),
      render: vi.fn(async (_id, text) => {
        if (text.includes('invalid')) {
          throw new Error('Bad mermaid syntax')
        }
        return { svg: '<svg><g><text>Flow OK</text></g></svg>' }
      })
    }
    const renderer = createMermaidRenderer(driver)
    const md = [
      '# Diagram Doc',
      '',
      '```mermaid',
      'graph TD',
      '  A --> B',
      '```',
      '',
      '```mermaid',
      'invalid diagram',
      '```',
      '',
      '<svg onload="alert(1)"><circle r="5" /></svg>'
    ].join('\n')

    const { container, rerender } = render(
      <MarkdownPreview
        content={md}
        scrollTop={0}
        theme="light"
        mermaidRenderer={renderer}
      />
    )

    expect(await screen.findByTestId('mermaid-svg')).toHaveTextContent('Flow OK')
    const diagrams = screen.getAllByTestId('mermaid-diagram')
    expect(diagrams).toHaveLength(2)
    expect(diagrams[0]).toHaveAttribute('data-mermaid-theme', 'default')
    expect(screen.getByRole('alert')).toHaveTextContent('Bad mermaid syntax')
    expect(screen.getByRole('alert')).toHaveTextContent('invalid diagram')
    // Raw HTML <svg onload> outside fenced mermaid block must still be stripped by rehype-sanitize
    const nonActionCircles = Array.from(container.querySelectorAll('circle')).filter(
      (element) => !element.closest('.mermaid-action-bar')
    )
    expect(nonActionCircles).toHaveLength(0)

    rerender(
      <MarkdownPreview
        content={md}
        scrollTop={0}
        theme="dark"
        mermaidRenderer={renderer}
      />
    )
    await act(async () => {
      await Promise.resolve()
    })
    expect(driver.initialize).toHaveBeenLastCalledWith(
      expect.objectContaining({ theme: 'dark' })
    )
    expect(container.querySelector('[data-mermaid-theme="dark"]')).not.toBeNull()
  })

  it('displays dynamic hierarchical heading numbers without double-numbering and scrolls on TOC anchor click or scrollRequest', () => {
    const md = [
      '- [Intro](#intro)',
      '- [Details](#1-details)',
      '',
      '# Intro',
      '## **Sub** Topic',
      '### 1. Details'
    ].join('\n')

    const scrollIntoViewMock = vi.fn()
    const origScrollIntoView = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = scrollIntoViewMock

    try {
      const { container, rerender } = render(
        <MarkdownPreview
          content={md}
          scrollTop={0}
          theme="light"
          showHeadingNumbers
        />
      )

      const h1 = container.querySelector('h1')!
      const h2 = container.querySelector('h2')!
      const h3 = container.querySelector('h3')!
      expect(h1).toHaveTextContent('1. Intro')
      expect(h1).toHaveAttribute('id', 'intro')
      expect(h2).toHaveTextContent('1.1. Sub Topic')
      expect(h3).toHaveTextContent('1.1.1. Details')
      expect(h3.textContent).not.toContain('1.1.1. 1.')

      // Accessible name preserves title without decorative dynamic number prefix
      expect(screen.getByRole('heading', { level: 1, name: 'Intro' })).toBeInTheDocument()

      // Clicking TOC anchor scrolls target heading into view
      fireEvent.click(screen.getByRole('link', { name: 'Intro' }))
      expect(scrollIntoViewMock).toHaveBeenCalledTimes(1)
      expect(scrollIntoViewMock.mock.instances[0]).toBe(h1)

      // Disabling showHeadingNumbers removes dynamic numbers cleanly
      rerender(
        <MarkdownPreview
          content={md}
          scrollTop={0}
          theme="light"
          showHeadingNumbers={false}
          scrollRequest={{ slug: 'sub-topic', index: 1, nonce: 1 }}
        />
      )
      expect(container.querySelector('h1')).toHaveTextContent('Intro')
      expect(container.querySelector('h1')?.textContent).not.toContain('1.')
      expect(container.querySelector('h3')).toHaveTextContent('1. Details')
      expect(scrollIntoViewMock).toHaveBeenCalledTimes(2)
      expect(scrollIntoViewMock.mock.instances[1]).toBe(container.querySelector('h2'))

      // Rerendering with new scrollTop or content and the same scrollRequest object/nonce must NOT re-trigger scrolling
      scrollIntoViewMock.mockClear()
      rerender(
        <MarkdownPreview
          content={`${md}\n\nMore text`}
          scrollTop={120}
          theme="light"
          showHeadingNumbers={false}
          scrollRequest={{ slug: 'sub-topic', index: 1, nonce: 1 }}
        />
      )
      expect(scrollIntoViewMock).not.toHaveBeenCalled()
    } finally {
      Element.prototype.scrollIntoView = origScrollIntoView
    }
  })

  it('annotates top-level markdown blocks (including table wrapper and mermaid block) with 1-based source lines after sanitization without HTML spoofing', () => {
    const driver: MermaidDriver = {
      initialize: vi.fn(),
      render: vi.fn(async () => ({ svg: '<svg><text>Diagram</text></svg>' }))
    }
    const mermaidRenderer = createMermaidRenderer(driver)

    const md = [
      '# Main Heading',
      '',
      'First line of paragraph',
      'Second line of paragraph',
      '',
      '- Item 1',
      '- Item 2',
      '',
      '> Quote line 1',
      '> Quote line 2',
      '',
      '| Col A | Col B |',
      '| ----- | ----- |',
      '| Val 1 | Val 2 |',
      '',
      '```ts',
      'const a = 1',
      '```',
      '',
      '```mermaid',
      'graph TD',
      '  A --> B',
      '```',
      '',
      '<div data-source-line="999" data-source-end-line="1000">Raw Div</div>',
      '',
      'Inline <span data-source-line="888">spoof</span> text',
      '',
      '<div><p data-source-line="777">Nested</p></div>'
    ].join('\n')

    const { container } = render(
      <MarkdownPreview content={md} scrollTop={0} mermaidRenderer={mermaidRenderer} />
    )

    const heading = container.querySelector('h1')
    expect(heading).toHaveAttribute('data-source-line', '1')
    expect(heading).toHaveAttribute('data-source-end-line', '1')

    const paragraphs = container.querySelectorAll('p')
    expect(paragraphs[0]).toHaveAttribute('data-source-line', '3')
    expect(paragraphs[0]).toHaveAttribute('data-source-end-line', '4')

    const list = container.querySelector('ul')
    expect(list).toHaveAttribute('data-source-line', '6')
    expect(list).toHaveAttribute('data-source-end-line', '7')

    const quote = container.querySelector('blockquote')
    expect(quote).toHaveAttribute('data-source-line', '9')
    expect(quote).toHaveAttribute('data-source-end-line', '10')

    const tableWrapper = container.querySelector('.md-table-wrapper')
    expect(tableWrapper).toHaveAttribute('data-source-line', '12')
    expect(tableWrapper).toHaveAttribute('data-source-end-line', '14')
    expect(tableWrapper?.querySelector('table')).not.toHaveAttribute('data-source-line')

    const codePre = container.querySelector('pre')
    expect(codePre).toHaveAttribute('data-source-line', '16')
    expect(codePre).toHaveAttribute('data-source-end-line', '18')

    const mermaidBlock = screen.getByTestId('mermaid-diagram')
    expect(mermaidBlock).toHaveAttribute('data-source-line', '20')
    expect(mermaidBlock).toHaveAttribute('data-source-end-line', '23')

    // Raw HTML spoofed attributes must be stripped by sanitize and replaced/omitted accurately
    expect(container.querySelector('[data-source-line="999"]')).toBeNull()
    expect(container.querySelector('[data-source-end-line="1000"]')).toBeNull()
    expect(container.querySelector('[data-source-line="888"]')).toBeNull()
    expect(container.querySelector('[data-source-line="777"]')).toBeNull()

    const rawDiv = screen.getByText('Raw Div')
    expect(rawDiv).toHaveAttribute('data-source-line', '25')
    expect(rawDiv).toHaveAttribute('data-source-end-line', '25')

    const spoofSpan = screen.getByText('spoof')
    expect(spoofSpan).not.toHaveAttribute('data-source-line')
    expect(spoofSpan.closest('p')).toHaveAttribute('data-source-line', '27')
    expect(spoofSpan.closest('p')).toHaveAttribute('data-source-end-line', '27')

    const nestedP = screen.getByText('Nested')
    expect(nestedP).not.toHaveAttribute('data-source-line')
    expect(nestedP.parentElement).toHaveAttribute('data-source-line', '29')
    expect(nestedP.parentElement).toHaveAttribute('data-source-end-line', '29')
  })

  it('threads documentTitle through MarkdownPreview context to MermaidDiagram save actions and falls back to mermaid-diagram when omitted', async () => {
    const canvasStub = installSvgCanvasStub()

    try {
      const saveFile = vi.fn(async () => ({ canceled: false, filePath: 'C:\\exports\\out' }))
      window.wikiApi = {
        diagram: {
          copyText: vi.fn(async () => {}),
          copyImage: vi.fn(async () => {}),
          saveFile
        }
      } as unknown as WikiApi

      const driver: MermaidDriver = {
        initialize: vi.fn(),
        render: vi.fn(async () => ({
          svg: '<svg viewBox="0 0 100 50"><g><text>Preview</text></g></svg>'
        }))
      }
      const renderer = createMermaidRenderer(driver)
      const md = ['```mermaid', 'graph TD', '  A --> B', '```'].join('\n')

      const { rerender } = render(
        <MarkdownPreview
          content={md}
          scrollTop={0}
          theme="light"
          documentTitle="API: <v2>."
          mermaidRenderer={renderer}
        />
      )

      await screen.findByTestId('mermaid-svg')
      fireEvent.click(screen.getByRole('button', { name: 'PNG 저장' }))
      await waitFor(() => {
        expect(saveFile).toHaveBeenCalledTimes(1)
      })
      expect(saveFile).toHaveBeenLastCalledWith(
        expect.objectContaining({
          format: 'png',
          suggestedName: 'API v2-diagram.png'
        })
      )

      rerender(
        <MarkdownPreview
          content={md}
          scrollTop={0}
          theme="light"
          mermaidRenderer={renderer}
        />
      )
      fireEvent.click(screen.getByRole('button', { name: 'SVG 저장' }))
      await waitFor(() => {
        expect(saveFile).toHaveBeenCalledTimes(2)
      })
      expect(saveFile).toHaveBeenLastCalledWith(
        expect.objectContaining({
          format: 'svg',
          suggestedName: 'mermaid-diagram.svg'
        })
      )
    } finally {
      canvasStub.restore()
    }
  })
})
