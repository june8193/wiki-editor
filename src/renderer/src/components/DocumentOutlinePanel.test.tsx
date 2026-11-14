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
      />
    )

    expect(screen.getByRole('button', { name: '본문에 목차(/toc) 삽입' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '본문 헤딩 번호 쓰기' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '본문 헤딩 번호 제거' })).toBeDisabled()
    expect(screen.getByText('마크다운 문서에서만 목차를 지원합니다.')).toBeInTheDocument()
  })

  it('supports collapsing and expanding the outline body', async () => {
    const user = userEvent.setup()
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
      />
    )

    const collapseBtn = screen.getByRole('button', { name: /Outline/i })
    expect(collapseBtn).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('list')).toBeInTheDocument()

    await user.click(collapseBtn)
    expect(collapseBtn).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('list')).not.toBeInTheDocument()

    await user.click(collapseBtn)
    expect(collapseBtn).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('list')).toBeInTheDocument()
  })
})
