import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { MarkdownPreview } from './MarkdownPreview'

describe('MarkdownPreview link navigation', () => {
  it('invokes onLinkNavigate on click for section, relative file, and external links while preventing default navigation', () => {
    const onLinkNavigate = vi.fn()
    const content = [
      '# 개요',
      '',
      '- [섹션 이동](#%EA%B0%9C%EC%9A%94)',
      '- [파일 이동](./sub/target.md#intro)',
      '- [외부 링크](https://example.com)',
      '- [빈 앵커](#)'
    ].join('\n')

    render(<MarkdownPreview content={content} scrollTop={0} onLinkNavigate={onLinkNavigate} />)

    const sectionLink = screen.getByRole('link', { name: '섹션 이동' })
    const sectionClick = fireEvent.click(sectionLink)
    expect(sectionClick).toBe(false)
    expect(onLinkNavigate).toHaveBeenNthCalledWith(1, '#%EA%B0%9C%EC%9A%94')

    const fileLink = screen.getByRole('link', { name: '파일 이동' })
    expect(fireEvent.click(fileLink)).toBe(false)
    expect(onLinkNavigate).toHaveBeenNthCalledWith(2, './sub/target.md#intro')

    const externalLink = screen.getByRole('link', { name: '외부 링크' })
    expect(fireEvent.click(externalLink)).toBe(false)
    expect(onLinkNavigate).toHaveBeenNthCalledWith(3, 'https://example.com')

    const emptyAnchorLink = screen.getByRole('link', { name: '빈 앵커' })
    expect(fireEvent.click(emptyAnchorLink)).toBe(false)
    expect(onLinkNavigate).toHaveBeenNthCalledWith(4, '#')
  })

  it('ignores non-primary clicks for onLinkNavigate while preventing default', () => {
    const onLinkNavigate = vi.fn()
    render(
      <MarkdownPreview
        content="[대상](./target.md)"
        scrollTop={0}
        onLinkNavigate={onLinkNavigate}
      />
    )

    const link = screen.getByRole('link', { name: '대상' })
    expect(fireEvent.click(link, { button: 1 })).toBe(false)
    expect(fireEvent.click(link, { altKey: true })).toBe(false)
    expect(onLinkNavigate).not.toHaveBeenCalled()
  })

  it('keeps standalone same-document anchor scrolling when onLinkNavigate is omitted', () => {
    const scrollIntoView = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      writable: true,
      value: scrollIntoView
    })

    render(
      <MarkdownPreview
        content={'# 첫 섹션\n\n[이동](#첫-섹션)'}
        scrollTop={0}
      />
    )

    fireEvent.click(screen.getByRole('link', { name: '이동' }))
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
  })
})
