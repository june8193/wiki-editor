import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ManualModal } from './ManualModal'

const SAMPLE_MANUAL = `# Wiki Editor 사용자 매뉴얼

> 플랫폼 안내

## 단축키 모음

### 앱 · 탐색

| 단축키 | 동작 |
| --- | --- |
| Ctrl+O | 폴더 열기 |

## Mermaid 다이어그램

다이어그램을 Ctrl+휠로 확대할 수 있습니다.
`

describe('ManualModal', () => {
  it('renders dialog, left TOC items, and markdown preview content', () => {
    render(<ManualModal content={SAMPLE_MANUAL} theme="light" onClose={vi.fn()} />)

    const dialog = screen.getByRole('dialog', { name: '사용자 매뉴얼' })
    expect(dialog).toBeInTheDocument()

    const tocNav = screen.getByRole('navigation', { name: '매뉴얼 목차' })
    expect(tocNav).toHaveTextContent('단축키 모음')
    expect(tocNav).toHaveTextContent('앱 · 탐색')
    expect(tocNav).toHaveTextContent('Mermaid 다이어그램')

    const preview = screen.getByTestId('manual-markdown-preview')
    expect(preview).toHaveTextContent('Ctrl+O')
    expect(preview).toHaveTextContent('Mermaid 다이어그램')
  })

  it('scrolls to the matching heading when a TOC item is clicked', () => {
    render(<ManualModal content={SAMPLE_MANUAL} theme="light" onClose={vi.fn()} />)

    const preview = screen.getByTestId('manual-markdown-preview')
    const mermaidHeading = preview.querySelector('h2#mermaid-다이어그램')
    expect(mermaidHeading).not.toBeNull()

    const scrollIntoViewMock = vi.fn()
    ;(mermaidHeading as HTMLElement).scrollIntoView = scrollIntoViewMock

    fireEvent.click(screen.getByRole('button', { name: 'Mermaid 다이어그램' }))

    expect(scrollIntoViewMock).toHaveBeenCalledTimes(1)
  })

  it('filters sections, highlights matches, and clears search', () => {
    render(<ManualModal content={SAMPLE_MANUAL} theme="light" onClose={vi.fn()} />)

    const searchInput = screen.getByRole('searchbox', { name: '매뉴얼 검색' })
    fireEvent.change(searchInput, { target: { value: 'Mermaid' } })

    const tocNav = screen.getByRole('navigation', { name: '매뉴얼 목차' })
    expect(tocNav).toHaveTextContent('Mermaid 다이어그램')
    expect(tocNav).not.toHaveTextContent('단축키 모음')
    expect(screen.getByText('1 / 2개 섹션')).toBeInTheDocument()

    const preview = screen.getByTestId('manual-markdown-preview')
    expect(preview.querySelectorAll('mark[data-search-match-index]').length).toBeGreaterThan(0)

    fireEvent.change(searchInput, { target: { value: '없는키워드xyz' } })
    expect(screen.getByText('일치하는 매뉴얼 항목이 없습니다.')).toBeInTheDocument()
    expect(screen.getByText('0 / 2개 섹션')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '검색어 지우기' }))
    expect(searchInput).toHaveValue('')
    expect(screen.getByRole('navigation', { name: '매뉴얼 목차' })).toHaveTextContent('단축키 모음')
  })

  it('closes on close button click or Escape unless isDismissDisabled is true', () => {
    const onClose = vi.fn()
    const { rerender } = render(
      <ManualModal content={SAMPLE_MANUAL} theme="light" onClose={onClose} />
    )

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: '닫기' }))
    expect(onClose).toHaveBeenCalledTimes(2)

    rerender(
      <ManualModal content={SAMPLE_MANUAL} theme="light" isDismissDisabled onClose={onClose} />
    )
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})
