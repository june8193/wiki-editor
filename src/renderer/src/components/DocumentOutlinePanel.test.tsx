import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { DocumentOutlinePanel } from './DocumentOutlinePanel'

describe('DocumentOutlinePanel', () => {
  const sampleMarkdown = [
    '# Overview',
    '',
    '```bash',
    '# Not a heading comment',
    '```',
    '',
    '## Architecture',
    '### Mermaid Cache',
    '## **Summary**'
  ].join('\n')

  it('renders hierarchical headings excluding code fences and toggles dynamic numbering', async () => {
    const user = userEvent.setup()
    const onToggleHeadingNumbers = vi.fn()
    const onSelectHeading = vi.fn()

    const { rerender } = render(
      <DocumentOutlinePanel
        documentName="note.md"
        content={sampleMarkdown}
        isMarkdownDocument
        showHeadingNumbers
        onToggleHeadingNumbers={onToggleHeadingNumbers}
        onSelectHeading={onSelectHeading}
        onInsertToc={vi.fn()}
        onApplyHeadingNumbers={vi.fn()}
        onStripHeadingNumbers={vi.fn()}
        onCollapse={vi.fn()}
      />
    )

    const outline = screen.getByRole('region', { name: '문서 목차 (Outline)' })
    const list = within(outline).getByRole('list')
    const items = within(list).getAllByRole('listitem')
    expect(items).toHaveLength(4)

    expect(items[0].textContent).toContain('1.')
    expect(items[0].textContent).toContain('Overview')
    expect(items[1].textContent).toContain('1.1.')
    expect(items[1].textContent).toContain('Architecture')
    expect(items[2].textContent).toContain('1.1.1.')
    expect(items[2].textContent).toContain('Mermaid Cache')
    expect(items[3].textContent).toContain('1.2.')
    expect(items[3].textContent).toContain('Summary')
    expect(list.textContent).not.toContain('Not a heading comment')

    // Indentation reflects hierarchy depth
    expect((items[0] as HTMLElement).style.paddingLeft).toBe('0px')
    expect((items[1] as HTMLElement).style.paddingLeft).toBe('12px')
    expect((items[2] as HTMLElement).style.paddingLeft).toBe('24px')

    // Click item calls onSelectHeading with parsed heading and index
    await user.click(within(items[2]).getByRole('button'))
    expect(onSelectHeading).toHaveBeenCalledTimes(1)
    expect(onSelectHeading.mock.calls[0][0]).toMatchObject({
      line: 8,
      level: 3,
      number: '1.1.1.',
      title: 'Mermaid Cache',
      slug: 'mermaid-cache'
    })
    expect(onSelectHeading.mock.calls[0][1]).toBe(2)

    // Toggle heading numbers callback
    await user.click(within(outline).getByRole('button', { name: '헤딩 번호 표시' }))
    expect(onToggleHeadingNumbers).toHaveBeenCalledTimes(1)

    // Turning showHeadingNumbers off hides dynamic numbers
    rerender(
      <DocumentOutlinePanel
        documentName="note.md"
        content={sampleMarkdown}
        isMarkdownDocument
        showHeadingNumbers={false}
        onToggleHeadingNumbers={onToggleHeadingNumbers}
        onSelectHeading={onSelectHeading}
        onInsertToc={vi.fn()}
        onApplyHeadingNumbers={vi.fn()}
        onStripHeadingNumbers={vi.fn()}
        onCollapse={vi.fn()}
      />
    )
    expect(within(list).queryByText('1.1.1.')).not.toBeInTheDocument()
    expect(within(list).getByText('Mermaid Cache')).toBeInTheDocument()
  })

  it('invokes explicit TOC and heading numbering mutation callbacks and disables them on non-markdown files', async () => {
    const user = userEvent.setup()
    const onInsertToc = vi.fn()
    const onApplyHeadingNumbers = vi.fn()
    const onStripHeadingNumbers = vi.fn()

    const { rerender } = render(
      <DocumentOutlinePanel
        documentName="note.md"
        content={sampleMarkdown}
        isMarkdownDocument
        showHeadingNumbers
        onToggleHeadingNumbers={vi.fn()}
        onSelectHeading={vi.fn()}
        onInsertToc={onInsertToc}
        onApplyHeadingNumbers={onApplyHeadingNumbers}
        onStripHeadingNumbers={onStripHeadingNumbers}
        onCollapse={vi.fn()}
      />
    )

    await user.click(screen.getByRole('button', { name: '본문에 목차(/toc) 삽입' }))
    await user.click(screen.getByRole('button', { name: '본문 헤딩 번호 쓰기' }))
    await user.click(screen.getByRole('button', { name: '본문 헤딩 번호 제거' }))

    expect(onInsertToc).toHaveBeenCalledTimes(1)
    expect(onApplyHeadingNumbers).toHaveBeenCalledTimes(1)
    expect(onStripHeadingNumbers).toHaveBeenCalledTimes(1)

    // Non-markdown document disables explicit markdown actions
    rerender(
      <DocumentOutlinePanel
        documentName="config.json"
        content='{"theme":"dark"}'
        isMarkdownDocument={false}
        showHeadingNumbers
        onToggleHeadingNumbers={vi.fn()}
        onSelectHeading={vi.fn()}
        onInsertToc={onInsertToc}
        onApplyHeadingNumbers={onApplyHeadingNumbers}
        onStripHeadingNumbers={onStripHeadingNumbers}
        onCollapse={vi.fn()}
      />
    )

    expect(screen.getByRole('button', { name: '본문에 목차(/toc) 삽입' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '본문 헤딩 번호 쓰기' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '본문 헤딩 번호 제거' })).toBeDisabled()
    expect(screen.getByText('마크다운 문서에서만 목차를 지원합니다.')).toBeInTheDocument()
  })

  it('always renders the outline body without internal collapse and delegates collapsing via header button', async () => {
    const user = userEvent.setup()
    const onCollapse = vi.fn()
    render(
      <DocumentOutlinePanel
        documentName="note.md"
        content={'# First'}
        isMarkdownDocument
        showHeadingNumbers
        onToggleHeadingNumbers={vi.fn()}
        onSelectHeading={vi.fn()}
        onInsertToc={vi.fn()}
        onApplyHeadingNumbers={vi.fn()}
        onStripHeadingNumbers={vi.fn()}
        onCollapse={onCollapse}
      />
    )

    expect(screen.queryByRole('button', { name: /Outline/i })).not.toBeInTheDocument()
    expect(screen.getByText('Outline')).toBeInTheDocument()
    expect(screen.getByRole('list')).toBeInTheDocument()

    const collapseBtn = screen.getByRole('button', { name: '문서 목차 접기' })
    expect(collapseBtn).toHaveAttribute('title', '문서 목차 접기')
    await user.click(collapseBtn)

    expect(onCollapse).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('list')).toBeInTheDocument()
  })

  it('highlights only the active heading with aria-current="location" and scrolls it into view with nearest block alignment', () => {
    const scrollIntoViewMock = vi.fn()
    const origScrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      'scrollIntoView'
    )
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      writable: true,
      value: scrollIntoViewMock
    })

    try {
      const baseProps = {
        documentName: 'note.md',
        content: sampleMarkdown,
        isMarkdownDocument: true,
        showHeadingNumbers: true,
        onToggleHeadingNumbers: vi.fn(),
        onSelectHeading: vi.fn(),
        onInsertToc: vi.fn(),
        onApplyHeadingNumbers: vi.fn(),
        onStripHeadingNumbers: vi.fn(),
        onCollapse: vi.fn()
      }

      const { rerender } = render(<DocumentOutlinePanel {...baseProps} activeHeadingIndex={null} />)

      const getButtons = () => within(screen.getByRole('list')).getAllByRole('button')
      for (const btn of getButtons()) {
        expect(btn).not.toHaveAttribute('aria-current')
        expect(btn).not.toHaveClass('is-active')
      }
      expect(scrollIntoViewMock).not.toHaveBeenCalled()

      // Activate heading index 1 -> highlights button 1 and calls scrollIntoView({ block: 'nearest' })
      rerender(<DocumentOutlinePanel {...baseProps} activeHeadingIndex={1} />)
      let buttons = getButtons()
      expect(buttons[0]).not.toHaveAttribute('aria-current')
      expect(buttons[1]).toHaveAttribute('aria-current', 'location')
      expect(buttons[1]).toHaveClass('is-active')
      expect(buttons[2]).not.toHaveAttribute('aria-current')
      expect(buttons[3]).not.toHaveAttribute('aria-current')
      expect(scrollIntoViewMock).toHaveBeenCalledTimes(1)
      expect(scrollIntoViewMock).toHaveBeenLastCalledWith({ block: 'nearest' })
      expect(scrollIntoViewMock.mock.instances[0]).toBe(buttons[1])

      // Toggling showHeadingNumbers without changing activeHeadingIndex keeps highlight and does not re-scroll
      scrollIntoViewMock.mockClear()
      rerender(
        <DocumentOutlinePanel {...baseProps} showHeadingNumbers={false} activeHeadingIndex={1} />
      )
      buttons = getButtons()
      expect(buttons[1]).toHaveAttribute('aria-current', 'location')
      expect(scrollIntoViewMock).not.toHaveBeenCalled()

      // Moving activeHeadingIndex to 3 scrolls button 3 into view
      rerender(
        <DocumentOutlinePanel {...baseProps} showHeadingNumbers={false} activeHeadingIndex={3} />
      )
      buttons = getButtons()
      expect(buttons[1]).not.toHaveAttribute('aria-current')
      expect(buttons[1]).not.toHaveClass('is-active')
      expect(buttons[3]).toHaveAttribute('aria-current', 'location')
      expect(buttons[3]).toHaveClass('is-active')
      expect(scrollIntoViewMock).toHaveBeenCalledTimes(1)
      expect(scrollIntoViewMock).toHaveBeenLastCalledWith({ block: 'nearest' })
      expect(scrollIntoViewMock.mock.instances[0]).toBe(buttons[3])

      // Preface (null), out-of-range, non-markdown, no headings, and missing document clear active item without scrolling
      scrollIntoViewMock.mockClear()
      rerender(<DocumentOutlinePanel {...baseProps} activeHeadingIndex={null} />)
      for (const btn of getButtons()) {
        expect(btn).not.toHaveAttribute('aria-current')
        expect(btn).not.toHaveClass('is-active')
      }
      rerender(<DocumentOutlinePanel {...baseProps} activeHeadingIndex={99} />)
      for (const btn of getButtons()) {
        expect(btn).not.toHaveAttribute('aria-current')
      }
      rerender(<DocumentOutlinePanel {...baseProps} content="Plain paragraph only" activeHeadingIndex={0} />)
      expect(screen.queryByRole('list')).not.toBeInTheDocument()
      rerender(<DocumentOutlinePanel {...baseProps} isMarkdownDocument={false} activeHeadingIndex={0} />)
      expect(screen.queryByRole('list')).not.toBeInTheDocument()
      rerender(<DocumentOutlinePanel {...baseProps} documentName={null} activeHeadingIndex={0} />)
      expect(screen.queryByRole('list')).not.toBeInTheDocument()
      expect(scrollIntoViewMock).not.toHaveBeenCalled()

      // Environment without scrollIntoView method skips auto-scroll safely
      delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView
      rerender(<DocumentOutlinePanel {...baseProps} activeHeadingIndex={2} />)
      expect(getButtons()[2]).toHaveAttribute('aria-current', 'location')
    } finally {
      if (origScrollIntoViewDescriptor) {
        Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', origScrollIntoViewDescriptor)
      } else {
        delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView
      }
    }
  })
})
