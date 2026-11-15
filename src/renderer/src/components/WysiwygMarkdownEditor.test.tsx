import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { WorkspaceEntry } from '@shared/workspace'
import { describe, expect, it, vi } from 'vitest'
import { createMermaidRenderer, type MermaidDriver } from '../editor/mermaidRenderer'
import { WysiwygMarkdownEditor } from './WysiwygMarkdownEditor'

function placeCaretInProseMirror(editorEl: HTMLElement, targetEl: Element): void {
  const range = document.createRange()
  range.selectNodeContents(targetEl)
  range.collapse(false)
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
  editorEl.focus()
  document.dispatchEvent(new Event('selectionchange'))
}

describe('WysiwygMarkdownEditor', () => {
  it('mounts without firing onChangeContent on unchanged markdown and syncs external updates cleanly', () => {
    const onChangeContent = vi.fn()
    const initial = '# Keep Exact\n\n*   preserved spacing'

    const { rerender } = render(
      <WysiwygMarkdownEditor
        content={initial}
        scrollTop={0}
        onChangeContent={onChangeContent}
      />
    )

    expect(screen.getByTestId('document-editor')).toBeInTheDocument()
    expect(onChangeContent).not.toHaveBeenCalled()

    // External update from another Split View pane updates view without echoing onChangeContent
    rerender(
      <WysiwygMarkdownEditor
        content={'# Updated From Raw'}
        scrollTop={0}
        onChangeContent={onChangeContent}
      />
    )

    expect(screen.getByTestId('document-editor')).toHaveTextContent('Updated From Raw')
    expect(onChangeContent).not.toHaveBeenCalled()
  })

  it('provides formatting toolbar actions and contextual table toolbar for row/column operations', async () => {
    const user = userEvent.setup()
    const onChangeContent = vi.fn()

    render(
      <WysiwygMarkdownEditor
        content={'# Heading\n\nParagraph text'}
        scrollTop={0}
        onChangeContent={onChangeContent}
      />
    )

    // Contextual table toolbar is hidden when cursor is outside a table
    expect(screen.queryByRole('toolbar', { name: '표 편집 툴바' })).not.toBeInTheDocument()

    // Main formatting toolbar actions exist
    const mainToolbar = screen.getByRole('toolbar', { name: '위지윅 서식 툴바' })
    expect(within(mainToolbar).getByRole('button', { name: 'H1' })).toBeInTheDocument()
    expect(within(mainToolbar).getByRole('button', { name: 'H2' })).toBeInTheDocument()
    expect(within(mainToolbar).getByRole('button', { name: 'H3' })).toBeInTheDocument()
    expect(within(mainToolbar).getByRole('button', { name: '굵게' })).toBeInTheDocument()
    expect(within(mainToolbar).getByRole('button', { name: '기울임' })).toBeInTheDocument()
    expect(within(mainToolbar).getByRole('button', { name: '인라인 코드' })).toBeInTheDocument()
    expect(within(mainToolbar).getByRole('button', { name: '코드 블록' })).toBeInTheDocument()
    expect(within(mainToolbar).getByRole('button', { name: '글머리 목록' })).toBeInTheDocument()
    expect(within(mainToolbar).getByRole('button', { name: '번호 목록' })).toBeInTheDocument()
    expect(within(mainToolbar).getByRole('button', { name: '체크리스트' })).toBeInTheDocument()
    expect(within(mainToolbar).getByRole('button', { name: '인용' })).toBeInTheDocument()

    // Insert a table -> emits markdown table and reveals contextual table toolbar
    await user.click(within(mainToolbar).getByRole('button', { name: '표 삽입' }))
    expect(onChangeContent).toHaveBeenCalled()
    const afterInsert = onChangeContent.mock.calls[onChangeContent.mock.calls.length - 1][0] as string
    expect(afterInsert).toContain('|')
    expect(afterInsert).toContain('---')

    const tableToolbar = await screen.findByRole('toolbar', { name: '표 편집 툴바' })
    const rowCountBefore = screen.getByTestId('document-editor').querySelectorAll('tr').length
    const colCountBefore = screen
      .getByTestId('document-editor')
      .querySelectorAll('tr')[0]
      .querySelectorAll('th, td').length

    // Add row below and column right
    await user.click(within(tableToolbar).getByRole('button', { name: '행 아래 추가' }))
    await user.click(within(tableToolbar).getByRole('button', { name: '열 우 추가' }))

    expect(screen.getByTestId('document-editor').querySelectorAll('tr').length).toBe(
      rowCountBefore + 1
    )
    expect(
      screen
        .getByTestId('document-editor')
        .querySelectorAll('tr')[0]
        .querySelectorAll('th, td').length
    ).toBe(colCountBefore + 1)

    // Also verify 행 위 추가, 열 좌 추가, 현재 행 삭제, 현재 열 삭제, 표 삭제 buttons exist and work
    await user.click(within(tableToolbar).getByRole('button', { name: '행 위 추가' }))
    expect(screen.getByTestId('document-editor').querySelectorAll('tr').length).toBe(
      rowCountBefore + 2
    )

    await user.click(within(tableToolbar).getByRole('button', { name: '현재 행 삭제' }))
    expect(screen.getByTestId('document-editor').querySelectorAll('tr').length).toBe(
      rowCountBefore + 1
    )

    await user.click(within(tableToolbar).getByRole('button', { name: '열 좌 추가' }))
    await user.click(within(tableToolbar).getByRole('button', { name: '현재 열 삭제' }))
    expect(
      screen
        .getByTestId('document-editor')
        .querySelectorAll('tr')[0]
        .querySelectorAll('th, td').length
    ).toBe(colCountBefore + 1)

    await user.click(within(tableToolbar).getByRole('button', { name: '표 삭제' }))
    expect(screen.getByTestId('document-editor').querySelector('table')).toBeNull()
    expect(screen.queryByRole('toolbar', { name: '표 편집 툴바' })).not.toBeInTheDocument()
  })

  it('prevents Electron window navigation when clicking links inside WYSIWYG content', () => {
    render(
      <WysiwygMarkdownEditor
        content={'[Click me](https://example.com)'}
        scrollTop={0}
        onChangeContent={vi.fn()}
      />
    )
    const link = screen.getByTestId('document-editor').querySelector('a')
    expect(link).not.toBeNull()
    const notPrevented = fireEvent.click(link!)
    expect(notPrevented).toBe(false)
  })

  it('sanitizes XSS payloads via rehype-sanitize, supports cell context menu, and emits once on header row delete', async () => {
    const user = userEvent.setup()
    const onChangeContent = vi.fn()

    render(
      <WysiwygMarkdownEditor
        content={[
          '# Safe',
          '',
          '<script>alert(1)</script>',
          '',
          '<img src="x" onerror="alert(2)" />',
          '',
          '[Bad](javascript:alert(3))',
          '',
          '| H1 | H2 |',
          '| --- | --- |',
          '| R1 | R2 |',
          '| R3 | R4 |'
        ].join('\n')}
        scrollTop={0}
        onChangeContent={onChangeContent}
      />
    )

    const editorEl = screen.getByTestId('document-editor')
    expect(editorEl.querySelector('script')).toBeNull()
    expect(editorEl.innerHTML).not.toContain('onerror')
    expect(editorEl.innerHTML).not.toContain('javascript:')
    expect(onChangeContent).not.toHaveBeenCalled()

    // Right-click inside header cell opens contextual table menu and deletes header row in a single emit
    const headerCell = editorEl.querySelector('th')!
    fireEvent.contextMenu(headerCell, { clientX: 40, clientY: 60 })
    const cellMenu = await screen.findByRole('menu', { name: '표 셀 작업 메뉴' })
    await user.click(within(cellMenu).getByRole('menuitem', { name: '현재 행 삭제' }))

    expect(onChangeContent).toHaveBeenCalledTimes(1)
    const updatedMd = onChangeContent.mock.calls[0][0] as string
    expect(updatedMd).toMatch(/\|\s*R1\s*\|\s*R2\s*\|/)
    expect(updatedMd).toMatch(/\|\s*-+\s*\|\s*-+\s*\|/)
    expect(updatedMd).not.toContain('H1')
  })

  it('preserves a single header row when adding a row above a header cell via context menu', async () => {
    const user = userEvent.setup()
    const onChangeContent = vi.fn()

    render(
      <WysiwygMarkdownEditor
        content={['| H1 | H2 |', '| --- | --- |', '| R1 | R2 |'].join('\n')}
        scrollTop={0}
        onChangeContent={onChangeContent}
      />
    )

    const editorEl = screen.getByTestId('document-editor')
    const headerCell = editorEl.querySelector('th')!
    fireEvent.contextMenu(headerCell, { clientX: 30, clientY: 50 })
    const cellMenu = await screen.findByRole('menu', { name: '표 셀 작업 메뉴' })
    await user.click(within(cellMenu).getByRole('menuitem', { name: '행 위 추가' }))

    expect(editorEl.querySelectorAll('th')).toHaveLength(2)
    expect(editorEl.querySelectorAll('tr')).toHaveLength(3)
    expect(editorEl.querySelectorAll('td')).toHaveLength(4)
    expect(onChangeContent).toHaveBeenCalledTimes(1)
    const updatedLines = (onChangeContent.mock.calls[0][0] as string).trim().split('\n')
    expect(updatedLines).toHaveLength(4)
    expect(updatedLines[0]).toMatch(/\|\s*H1\s*\|\s*H2\s*\|/)
    expect(updatedLines[2]).toMatch(/\|\s*\|\s*\|/)
    expect(updatedLines[3]).toMatch(/\|\s*R1\s*\|\s*R2\s*\|/)
  })

  it('restores non-zero scrollTop and notifies onScrollTopChange when scrolled', () => {
    const onScrollTopChange = vi.fn()
    const { container, rerender } = render(
      <WysiwygMarkdownEditor
        content={'# Top\n\nParagraph'}
        scrollTop={145}
        onChangeContent={vi.fn()}
        onScrollTopChange={onScrollTopChange}
      />
    )

    const scroller = container.querySelector('.wysiwyg-scroll-container') as HTMLDivElement
    expect(scroller).not.toBeNull()
    expect(scroller.scrollTop).toBe(145)

    rerender(
      <WysiwygMarkdownEditor
        content={'# Top\n\nParagraph'}
        scrollTop={260}
        onChangeContent={vi.fn()}
        onScrollTopChange={onScrollTopChange}
      />
    )
    expect(scroller.scrollTop).toBe(260)

    scroller.scrollTop = 310
    fireEvent.scroll(scroller)
    expect(onScrollTopChange).toHaveBeenCalledWith(310)
  })

  it('renders mermaid blocks with theme sync, source toggle, and lossless markdown roundtrip', async () => {
    const user = userEvent.setup()
    const onChangeContent = vi.fn()
    const driver: MermaidDriver = {
      initialize: vi.fn(),
      render: vi.fn(async (_id, text) => {
        if (text.includes('broken')) {
          throw new Error('Mermaid WYSIWYG error')
        }
        return { svg: `<svg><text>${text.trim()}</text></svg>` }
      })
    }
    const renderer = createMermaidRenderer(driver)
    const md = [
      '# Architecture',
      '',
      '```mermaid',
      'graph TD',
      '  A --> B',
      '```'
    ].join('\n')

    const { rerender } = render(
      <WysiwygMarkdownEditor
        content={md}
        scrollTop={0}
        theme="light"
        mermaidRenderer={renderer}
        onChangeContent={onChangeContent}
      />
    )

    expect(await screen.findByTestId('mermaid-svg')).toHaveTextContent('A --> B')
    expect(screen.getByTestId('mermaid-diagram')).toHaveAttribute('data-mermaid-theme', 'default')
    expect(onChangeContent).not.toHaveBeenCalled()

    // Toggle theme to dark -> updates Mermaid diagram without mutating markdown
    rerender(
      <WysiwygMarkdownEditor
        content={md}
        scrollTop={0}
        theme="dark"
        mermaidRenderer={renderer}
        onChangeContent={onChangeContent}
      />
    )
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.getByTestId('mermaid-diagram')).toHaveAttribute('data-mermaid-theme', 'dark')
    expect(onChangeContent).not.toHaveBeenCalled()

    // Clicking 코드 편집 toggles the embedded code source block
    const mermaidBlock = screen.getByTestId('wysiwyg-mermaid-block')
    const editCodeBtn = within(mermaidBlock).getByRole('button', { name: '코드 편집' })
    await user.click(editCodeBtn)
    expect(within(mermaidBlock).getByRole('button', { name: '코드 숨기기' })).toBeInTheDocument()
  })

  it('renders plain headings without dynamic heading decorations or TOC toolbar button, and scrolls once per scrollRequest', () => {
    const onChangeContent = vi.fn()
    const scrollIntoViewMock = vi.fn()
    const origScrollIntoView = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = scrollIntoViewMock

    try {
      const md = ['# Intro', '', '## Details', '', '### 1. Explicit'].join('\n')
      const { rerender } = render(
        <WysiwygMarkdownEditor
          content={md}
          scrollTop={0}
          onChangeContent={onChangeContent}
        />
      )

      const editorEl = screen.getByTestId('document-editor')
      const h1 = editorEl.querySelector('h1')!
      const h2 = editorEl.querySelector('h2')!
      const h3 = editorEl.querySelector('h3')!
      expect(editorEl.querySelector('.heading-number')).toBeNull()
      expect(editorEl.querySelector('.heading-number-suppressed')).toBeNull()
      expect(h1).toHaveTextContent('Intro')
      expect(h2).toHaveTextContent('Details')
      expect(h3).toHaveTextContent('1. Explicit')
      expect(onChangeContent).not.toHaveBeenCalled()

      const formatToolbar = screen.getByRole('toolbar', { name: '위지윅 서식 툴바' })
      expect(within(formatToolbar).queryByRole('button', { name: '목차 삽입' })).not.toBeInTheDocument()

      // Trigger scrollRequest to H2
      rerender(
        <WysiwygMarkdownEditor
          content={md}
          scrollTop={0}
          scrollRequest={{ index: 1, nonce: 1 }}
          onChangeContent={onChangeContent}
        />
      )
      expect(onChangeContent).not.toHaveBeenCalled()
      expect(scrollIntoViewMock).toHaveBeenCalledTimes(1)
      expect(scrollIntoViewMock.mock.instances[0]).toBe(h2)

      // Rerendering with unchanged nonce (e.g. new scrollTop/content) must NOT re-trigger scrolling
      scrollIntoViewMock.mockClear()
      rerender(
        <WysiwygMarkdownEditor
          content={md}
          scrollTop={80}
          scrollRequest={{ index: 1, nonce: 1 }}
          onChangeContent={onChangeContent}
        />
      )
      expect(scrollIntoViewMock).not.toHaveBeenCalled()
    } finally {
      Element.prototype.scrollIntoView = origScrollIntoView
    }
  })

  it('keeps /fun and /toc literal in WYSIWYG paragraphs without opening slash autocomplete or inserting TOC', async () => {
    const user = userEvent.setup()
    let latestMd = '# DocTitle\n\n'
    const onChangeContent = vi.fn((next: string) => {
      latestMd = next
    })

    render(
      <WysiwygMarkdownEditor
        content={latestMd}
        scrollTop={0}
        onChangeContent={onChangeContent}
      />
    )

    const editorEl = screen.getByTestId('document-editor')
    const paragraphs = editorEl.querySelectorAll('p')
    const targetP = paragraphs[paragraphs.length - 1]
    placeCaretInProseMirror(editorEl, targetP)

    await user.keyboard('/fun')
    expect(screen.queryByRole('listbox', { name: '슬래시 명령어 자동완성' })).not.toBeInTheDocument()

    await user.keyboard('{Enter}/toc{Enter}')
    expect(screen.queryByRole('listbox', { name: '슬래시 명령어 자동완성' })).not.toBeInTheDocument()
    expect(latestMd).toContain('/fun')
    expect(latestMd).toContain('/toc')
    expect(latestMd).not.toContain('<!-- toc -->')
  })

  it('reports active heading on mount, user scroll, content update, click-to-scroll pin reset, and isActive activation', async () => {
    const onActiveHeadingChange = vi.fn()
    const content = '# First\n\nIntro body\n\n## Second\n\nMiddle body\n\n### Third\n\nEnd body'

    const scrollTopSpy = { current: 0 }
    const headingTops = new Map<string, number>([
      ['First', 16],
      ['Second', 260],
      ['Third', 620]
    ])

    const { container, rerender } = render(
      <WysiwygMarkdownEditor
        content={content}
        scrollTop={0}
        isActive={false}
        onChangeContent={vi.fn()}
        onActiveHeadingChange={onActiveHeadingChange}
      />
    )

    const scrollContainer = container.querySelector('.wysiwyg-scroll-container') as HTMLElement
    expect(scrollContainer).toBeTruthy()
    Object.defineProperties(scrollContainer, {
      clientHeight: { value: 400, configurable: true },
      scrollHeight: { value: 1200, configurable: true },
      scrollTop: {
        get: () => scrollTopSpy.current,
        set: (val: number) => {
          scrollTopSpy.current = val
        },
        configurable: true
      }
    })
    const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect
    const rectSpy = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        if (this === scrollContainer) {
          return {
            top: 0,
            left: 0,
            right: 600,
            bottom: 400,
            width: 600,
            height: 400,
            x: 0,
            y: 0,
            toJSON: () => ({})
          } as DOMRect
        }
        if (/^H[1-6]$/.test(this.tagName) && scrollContainer.contains(this)) {
          const text = this.textContent?.trim() ?? ''
          const top = (headingTops.get(text) ?? 0) - scrollTopSpy.current
          return {
            top,
            left: 0,
            right: 600,
            bottom: top + 28,
            width: 600,
            height: 28,
            x: 0,
            y: top,
            toJSON: () => ({})
          } as DOMRect
        }
        return originalGetBoundingClientRect.call(this)
      })

    try {
      onActiveHeadingChange.mockClear()

      // Becoming active immediately measures current scroll position
      rerender(
        <WysiwygMarkdownEditor
          content={content}
          scrollTop={0}
          isActive
          onChangeContent={vi.fn()}
          onActiveHeadingChange={onActiveHeadingChange}
        />
      )
      expect(onActiveHeadingChange).toHaveBeenLastCalledWith({
        headingIndex: 0,
        isUserScroll: false
      })

      // User wheel + scroll across heading 2 boundary (topOffset <= 24px -> 260 - 240 = 20px)
      onActiveHeadingChange.mockClear()
      fireEvent.wheel(scrollContainer)
      scrollTopSpy.current = 240
      fireEvent.scroll(scrollContainer)
      expect(onActiveHeadingChange).toHaveBeenLastCalledWith({
        headingIndex: 1,
        isUserScroll: true
      })

      // Scroll to bottom -> selects last heading (index 2)
      onActiveHeadingChange.mockClear()
      fireEvent.wheel(scrollContainer)
      scrollTopSpy.current = 799
      fireEvent.scroll(scrollContainer)
      expect(onActiveHeadingChange).toHaveBeenLastCalledWith({
        headingIndex: 2,
        isUserScroll: true
      })

      // Programmatic scrollRequest clears previously armed user scroll intent
      onActiveHeadingChange.mockClear()
      fireEvent.wheel(scrollContainer)
      const targetHeading = Array.from(scrollContainer.querySelectorAll('h1, h2, h3'))[0]
      targetHeading.scrollIntoView = vi.fn(() => {
        scrollTopSpy.current = 0
        fireEvent.scroll(scrollContainer)
      })
      rerender(
        <WysiwygMarkdownEditor
          content={content}
          scrollTop={0}
          isActive
          scrollRequest={{ index: 0, nonce: 1 }}
          onChangeContent={vi.fn()}
          onActiveHeadingChange={onActiveHeadingChange}
        />
      )
      expect(targetHeading.scrollIntoView).toHaveBeenCalledWith({ block: 'start' })
      expect(onActiveHeadingChange).toHaveBeenCalledWith({
        headingIndex: 0,
        isUserScroll: false
      })

      // Content update immediately recalculates active heading without needing another scroll event
      scrollTopSpy.current = 240
      onActiveHeadingChange.mockClear()
      const editedContent = '# Zero\n\n# First\n\nIntro body\n\n## Second\n\nMiddle body\n\n### Third\n\nEnd body'
      headingTops.set('Zero', -120)
      rerender(
        <WysiwygMarkdownEditor
          content={editedContent}
          scrollTop={240}
          isActive
          onChangeContent={vi.fn()}
          onActiveHeadingChange={onActiveHeadingChange}
        />
      )
      expect(onActiveHeadingChange).toHaveBeenLastCalledWith({
        headingIndex: 2,
        isUserScroll: false
      })
    } finally {
      rectSpy.mockRestore()
    }
  })

  it('targets matching ATX heading on click-to-scroll even when empty, blockquote, Setext, or image-alt headings precede it', async () => {
    const markdown = [
      'Setext Heading',
      '===',
      '',
      '# ![Logo](https://example.com/logo.png) Alpha',
      '',
      '# ',
      '',
      '> # Quoted Heading',
      '',
      '## Beta'
    ].join('\n')

    const { container, rerender } = render(
      <WysiwygMarkdownEditor
        content={markdown}
        scrollTop={0}
        isActive
        onChangeContent={vi.fn()}
      />
    )

    const scrollContainer = container.querySelector('.wysiwyg-scroll-container') as HTMLElement
    const betaHeading = Array.from(scrollContainer.querySelectorAll('h2')).find(
      (el) => el.textContent?.trim() === 'Beta'
    )
    expect(betaHeading).toBeTruthy()
    const scrollIntoViewMock = vi.fn()
    betaHeading!.scrollIntoView = scrollIntoViewMock

    const alphaHeading = Array.from(scrollContainer.querySelectorAll('h1')).find((el) =>
      el.textContent?.includes('Alpha')
    )
    expect(alphaHeading).toBeTruthy()
    const alphaScrollMock = vi.fn()
    alphaHeading!.scrollIntoView = alphaScrollMock

    // Index 0 in parsed outline is `# ![Logo](...) Alpha` (inline img alt must match title)
    rerender(
      <WysiwygMarkdownEditor
        content={markdown}
        scrollTop={0}
        isActive
        scrollRequest={{ index: 0, nonce: 1 }}
        onChangeContent={vi.fn()}
      />
    )
    expect(alphaScrollMock).toHaveBeenCalledWith({ block: 'start' })

    // Index 1 in parsed outline is `## Beta` (empty `# `, blockquote, and Setext headings are omitted)
    rerender(
      <WysiwygMarkdownEditor
        content={markdown}
        scrollTop={0}
        isActive
        scrollRequest={{ index: 1, nonce: 2 }}
        onChangeContent={vi.fn()}
      />
    )

    expect(scrollIntoViewMock).toHaveBeenCalledWith({ block: 'start' })
  })
})

describe('WysiwygMarkdownEditor link autocomplete & Ctrl+K', () => {
  it('opens link autocomplete on [label](, prioritizes matching headings, preserves [`symbol`] code mark, escapes link mark on subsequent typing, and works inside table cells', async () => {
    const user = userEvent.setup()
    const onChangeContent = vi.fn()
    const md = [
      '# 1.1. 개요',
      '',
      '## API 가이드',
      '',
      '### `parseMarkdownHeadings`',
      '',
      '| 항목 | 링크 |',
      '| --- | --- |',
      '| cell | empty |',
      '',
      '본문 '
    ].join('\n')

    render(
      <WysiwygMarkdownEditor
        content={md}
        scrollTop={0}
        onChangeContent={onChangeContent}
      />
    )

    const editorEl = screen.getByTestId('document-editor')
    const lastParagraph = Array.from(editorEl.querySelectorAll('p')).find((p) =>
      p.textContent?.includes('본문')
    )!
    editorEl.focus()
    placeCaretInProseMirror(editorEl, lastParagraph)

    await user.keyboard('[[API](')
    const listbox = await screen.findByRole('listbox', { name: '링크 자동완성' })
    expect(within(listbox).getAllByRole('option')[0]).toHaveTextContent('API 가이드')

    fireEvent.keyDown(editorEl, { key: 'Enter' })
    await waitFor(() => {
      expect(screen.queryByRole('listbox', { name: '링크 자동완성' })).not.toBeInTheDocument()
    })

    await user.keyboard(' 계속')
    expect(onChangeContent.mock.calls.at(-1)?.[0]).toContain('[API](#api-가이드) 계속')

    await user.keyboard(' [[`parseMarkdownHeadings`](')
    const codeListbox = await screen.findByRole('listbox', { name: '링크 자동완성' })
    expect(within(codeListbox).getAllByRole('option')[0]).toHaveTextContent('parseMarkdownHeadings')
    fireEvent.keyDown(editorEl, { key: 'Tab' })
    await user.keyboard(' 다음')
    expect(onChangeContent.mock.calls.at(-1)?.[0]).toContain(
      '[`parseMarkdownHeadings`](#parsemarkdownheadings) 다음'
    )

    const emptyCell = Array.from(editorEl.querySelectorAll('td p')).find((p) =>
      p.textContent?.includes('empty')
    )!
    placeCaretInProseMirror(editorEl, emptyCell)
    await user.keyboard(' [[](')
    const tableListbox = await screen.findByRole('listbox', { name: '링크 자동완성' })
    const apiOption = within(tableListbox).getByRole('option', { name: /API 가이드/ })
    fireEvent.mouseEnter(apiOption)
    expect(apiOption).toHaveAttribute('aria-selected', 'true')
    await user.click(within(tableListbox).getByRole('option', { name: /개요/ }))
    await waitFor(() => {
      expect(onChangeContent.mock.calls.at(-1)?.[0]).toContain('[개요](#11-개요)')
    })
  })

  it('closes on space/external URL/Escape, and supports Ctrl+K selection, empty cursor, and existing link unwrap', async () => {
    const user = userEvent.setup()
    const onChangeContent = vi.fn()
    const md = '# 개요\n\n선택 텍스트 [기존](#개요) 끝'

    const { rerender } = render(
      <WysiwygMarkdownEditor
        content={md}
        scrollTop={0}
        onChangeContent={onChangeContent}
      />
    )

    const editorEl = screen.getByTestId('document-editor')
    const targetP = Array.from(editorEl.querySelectorAll('p')).find((p) =>
      p.textContent?.includes('끝')
    )!
    editorEl.focus()
    placeCaretInProseMirror(editorEl, targetP)

    fireEvent.keyDown(editorEl, { key: 'k', ctrlKey: true })
    expect(await screen.findByRole('listbox', { name: '링크 자동완성' })).toBeInTheDocument()

    await user.keyboard('https:')
    expect(screen.queryByRole('listbox', { name: '링크 자동완성' })).not.toBeInTheDocument()

    const existingLink = editorEl.querySelector('a')!
    const textNode = existingLink.firstChild!
    const range = document.createRange()
    range.setStart(textNode, 1)
    range.setEnd(textNode, 1)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    editorEl.focus()
    document.dispatchEvent(new Event('selectionchange'))

    fireEvent.keyDown(editorEl, { key: 'k', metaKey: true })
    const unwrapListbox = await screen.findByRole('listbox', { name: '링크 자동완성' })
    expect(within(unwrapListbox).getAllByRole('option')[0]).toHaveTextContent('개요')
    expect(editorEl.textContent).toContain('[기존](')

    fireEvent.keyDown(editorEl, { key: 'Escape' })
    expect(screen.queryByRole('listbox', { name: '링크 자동완성' })).not.toBeInTheDocument()

    rerender(
      <WysiwygMarkdownEditor
        content={md}
        scrollTop={0}
        isShortcutDisabled
        onChangeContent={onChangeContent}
      />
    )
    placeCaretInProseMirror(editorEl, targetP)
    fireEvent.keyDown(editorEl, { key: 'k', ctrlKey: true })
    expect(screen.queryByRole('listbox', { name: '링크 자동완성' })).not.toBeInTheDocument()
  })

  it('위지윅 모드에서 워크스페이스 파일 후보를 표시하고 상대 경로 마크다운 링크를 삽입한다', async () => {
    const user = userEvent.setup()
    const onChangeContent = vi.fn()
    const files: WorkspaceEntry[] = [
      {
        name: 'current.md',
        path: 'C:\\wiki\\docs\\current.md',
        relativePath: 'docs/current.md',
        kind: 'file'
      },
      {
        name: 'guide (1).md',
        path: 'C:\\wiki\\other\\guide (1).md',
        relativePath: 'other/guide (1).md',
        kind: 'file'
      }
    ]

    render(
      <WysiwygMarkdownEditor
        content={'# 현재\n\n본문'}
        scrollTop={0}
        workspaceMarkdownFiles={files}
        activeFilePath="C:\\wiki\\docs\\current.md"
        onChangeContent={onChangeContent}
      />
    )

    const editorEl = screen.getByTestId('document-editor')
    const targetP = Array.from(editorEl.querySelectorAll('p')).find((p) =>
      p.textContent?.includes('본문')
    )!
    placeCaretInProseMirror(editorEl, targetP)

    await user.keyboard(' [[](../')
    const listbox = await screen.findByRole('listbox', { name: '링크 자동완성' })
    expect(within(listbox).queryByText('current.md')).not.toBeInTheDocument()
    const guideOption = within(listbox).getByRole('option', { name: /guide \(1\)\.md/ })
    expect(guideOption).toHaveTextContent('other/guide (1).md')

    await user.click(guideOption)
    await waitFor(() => {
      expect(onChangeContent.mock.calls.at(-1)?.[0]).toContain(
        '[guide (1)](../other/guide%20%281%29.md)'
      )
    })
  })

  it('triggers onLinkNavigate in WYSIWYG mode only on Ctrl/Meta+click while preserving normal click and blocking browser navigation', () => {
    const onLinkNavigate = vi.fn()
    render(
      <WysiwygMarkdownEditor
        content={[
          'See [섹션](#%EA%B0%9C%EC%9A%94), [`parseSym`](#parsesym), [문서](./other.md#top), and [웹](https://example.com).'
        ].join('\n')}
        scrollTop={0}
        onChangeContent={vi.fn()}
        onLinkNavigate={onLinkNavigate}
      />
    )

    const editorEl = screen.getByTestId('document-editor')
    const anchors = Array.from(editorEl.querySelectorAll('a'))
    expect(anchors.length).toBeGreaterThanOrEqual(4)

    const sectionAnchor = anchors.find((a) => a.getAttribute('href') === '#%EA%B0%9C%EC%9A%94')!
    const symCode = anchors
      .find((a) => a.getAttribute('href') === '#parsesym')!
      .querySelector('code')!
    const fileAnchor = anchors.find((a) => a.getAttribute('href') === './other.md#top')!
    const externalAnchor = anchors.find((a) => a.getAttribute('href') === 'https://example.com')!

    // Normal click only prevents browser navigation and does not trigger onLinkNavigate
    expect(fireEvent.click(sectionAnchor)).toBe(false)
    expect(fireEvent.click(fileAnchor)).toBe(false)
    expect(fireEvent.click(externalAnchor)).toBe(false)
    expect(fireEvent.click(fileAnchor, { ctrlKey: true, altKey: true })).toBe(false)
    expect(onLinkNavigate).not.toHaveBeenCalled()

    // Ctrl+click and Meta+click (including clicking child <code> inside <a>) trigger onLinkNavigate
    expect(fireEvent.click(sectionAnchor, { ctrlKey: true })).toBe(false)
    expect(onLinkNavigate).toHaveBeenNthCalledWith(1, '#%EA%B0%9C%EC%9A%94')

    expect(fireEvent.click(symCode, { metaKey: true })).toBe(false)
    expect(onLinkNavigate).toHaveBeenNthCalledWith(2, '#parsesym')

    expect(fireEvent.click(fileAnchor, { ctrlKey: true })).toBe(false)
    expect(onLinkNavigate).toHaveBeenNthCalledWith(3, './other.md#top')

    expect(fireEvent.click(externalAnchor, { ctrlKey: true })).toBe(false)
    expect(onLinkNavigate).toHaveBeenNthCalledWith(4, 'https://example.com')
  })
})
