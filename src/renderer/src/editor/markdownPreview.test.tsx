import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { MarkdownPreview } from '../components/MarkdownPreview'
import { renderMarkdownToReact } from './markdownPreview'

describe('markdownPreview pipeline and XSS sanitization', () => {
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
    if (img) {
      expect(img.getAttribute('onerror')).toBeNull()
      expect(img.getAttribute('src')).toBe('https://example.com/ok.png')
    }

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
})
