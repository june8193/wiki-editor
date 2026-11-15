import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { CustomCommandConfig } from '@shared/config'
import type { WikiApi } from '@shared/ipc'
import type { RendererLogPayload } from '@shared/logging'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DiagramPngRasterAdapter, DiagramSvgRasterRequest } from '../editor/mermaidExport'
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
  const originalWikiApi = (window as { wikiApi?: WikiApi }).wikiApi

  afterEach(() => {
    vi.useRealTimers()
    if (originalWikiApi === undefined) {
      delete (window as { wikiApi?: WikiApi }).wikiApi
    } else {
      window.wikiApi = originalWikiApi
    }
  })

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

  it('renders dynamic heading numbers via decorations without mutating markdown, scrolls on scrollRequest, and inserts /toc', async () => {
    const user = userEvent.setup()
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
          showHeadingNumbers
          onChangeContent={onChangeContent}
        />
      )

      const editorEl = screen.getByTestId('document-editor')
      const h1 = editorEl.querySelector('h1')!
      const h2 = editorEl.querySelector('h2')!
      const h3 = editorEl.querySelector('h3')!
      expect(h1.querySelector('.heading-number')).toHaveTextContent('1.')
      expect(h2.querySelector('.heading-number')).toHaveTextContent('1.1.')
      // Stale explicit prefix "1. " under H1->H2 is visually suppressed and replaced with hierarchical "1.1.1."
      expect(h3.querySelector('.heading-number')).toHaveTextContent('1.1.1.')
      expect(h3.querySelector('.heading-number-suppressed')).toHaveTextContent('1.')
      expect(onChangeContent).not.toHaveBeenCalled()

      // Toggle off dynamic heading numbers + trigger scrollRequest to H2
      rerender(
        <WysiwygMarkdownEditor
          content={md}
          scrollTop={0}
          showHeadingNumbers={false}
          scrollRequest={{ index: 1, nonce: 1 }}
          onChangeContent={onChangeContent}
        />
      )
      expect(editorEl.querySelector('.heading-number')).toBeNull()
      expect(editorEl.querySelector('.heading-number-suppressed')).toBeNull()
      expect(onChangeContent).not.toHaveBeenCalled()
      expect(scrollIntoViewMock).toHaveBeenCalledTimes(1)
      expect(scrollIntoViewMock.mock.instances[0]).toBe(h2)

      // Rerendering with unchanged nonce (e.g. new scrollTop/content) must NOT re-trigger scrolling
      scrollIntoViewMock.mockClear()
      rerender(
        <WysiwygMarkdownEditor
          content={md}
          scrollTop={80}
          showHeadingNumbers={false}
          scrollRequest={{ index: 1, nonce: 1 }}
          onChangeContent={onChangeContent}
        />
      )
      expect(scrollIntoViewMock).not.toHaveBeenCalled()

      // Toolbar "목차 삽입" button inserts generated TOC links
      const formatToolbar = screen.getByRole('toolbar', { name: '위지윅 서식 툴바' })
      await user.click(within(formatToolbar).getByRole('button', { name: '목차 삽입' }))
      expect(onChangeContent).toHaveBeenCalledTimes(1)
      const withToc = onChangeContent.mock.calls[0][0] as string
      expect(withToc).toContain('<!-- toc -->')
      expect(withToc).toContain('- [Intro](#intro)')
    } finally {
      Element.prototype.scrollIntoView = origScrollIntoView
    }
  })

  it('suppresses stale explicit numeric prefix when a heading starts with inline bold formatting', () => {
    const { container } = render(
      <WysiwygMarkdownEditor
        content={'# Intro\n\n## 1. **Bold** Title'}
        scrollTop={0}
        theme="light"
        showHeadingNumbers={true}
        onChangeContent={vi.fn()}
      />
    )

    const numberBadges = Array.from(container.querySelectorAll('.heading-number')).map(
      (el) => el.textContent
    )
    expect(numberBadges).toEqual(['1. ', '1.1. '])

    const headings = container.querySelectorAll('.ProseMirror h2')
    expect(headings).toHaveLength(1)
    const suppressed = headings[0]?.querySelector('.heading-number-suppressed')
    expect(suppressed?.textContent).toBe('1. ')
  })

  it('opens slash autocomplete on /, supports keyboard navigation & click, places cursor at {{cursor}}, and supports /toc', async () => {
    const user = userEvent.setup()
    const commands: CustomCommandConfig[] = [
      {
        trigger: 'function',
        label: 'Function 문서',
        description: '함수 템플릿',
        template: '### Function: {{cursor}}()\nTitle: {{title}}'
      },
      {
        trigger: 'struct',
        label: 'Struct 정의',
        description: '구조체 템플릿',
        template: '### Struct: {{cursor}}'
      },
      {
        trigger: 'func-async',
        label: 'Async Function',
        description: '비동기 함수',
        template: 'async function {{cursor}}() {}'
      },
      {
        trigger: 'toc',
        label: '목차 (TOC)',
        template: '<!-- toc -->\n<!-- /toc -->'
      }
    ]
    let latestMd = '# DocTitle\n\n'
    const onChangeContent = vi.fn((next: string) => {
      latestMd = next
    })

    render(
      <WysiwygMarkdownEditor
        content={latestMd}
        scrollTop={0}
        customCommands={commands}
        documentTitle="api-spec"
        onChangeContent={onChangeContent}
      />
    )

    const editorEl = screen.getByTestId('document-editor')
    const paragraphs = editorEl.querySelectorAll('p')
    const targetP = paragraphs[paragraphs.length - 1]
    placeCaretInProseMirror(editorEl, targetP)
    await user.keyboard('/fun')

    const listbox = await screen.findByRole('listbox', { name: '슬래시 명령어 자동완성' })
    expect(within(listbox).getByRole('option', { name: /\/function/ })).toBeInTheDocument()
    expect(within(listbox).getByRole('option', { name: /\/func-async/ })).toBeInTheDocument()
    expect(within(listbox).queryByRole('option', { name: /\/struct/ })).not.toBeInTheDocument()

    fireEvent.keyDown(editorEl, { key: 'ArrowDown' })
    expect(within(listbox).getByRole('option', { name: /\/func-async/ })).toHaveAttribute(
      'aria-selected',
      'true'
    )
    fireEvent.keyDown(editorEl, { key: 'ArrowUp' })
    expect(within(listbox).getByRole('option', { name: /\/function/ })).toHaveAttribute(
      'aria-selected',
      'true'
    )

    fireEvent.keyDown(editorEl, { key: 'Enter' })
    await waitFor(() => {
      expect(screen.queryByRole('listbox', { name: '슬래시 명령어 자동완성' })).not.toBeInTheDocument()
    })

    expect(latestMd).toContain('### Function: ()')
    expect(latestMd).toContain('Title: api-spec')
    expect(latestMd).not.toContain('/fun')

    // Subsequent typing lands at {{cursor}} right before ()
    await user.keyboard('buildTree')
    await waitFor(() => {
      expect(latestMd).toContain('### Function: buildTree()')
    })

    // Escape dismisses, and mouse click inserts /toc
    await user.keyboard('{Enter}/to')
    await screen.findByRole('listbox', { name: '슬래시 명령어 자동완성' })
    fireEvent.keyDown(editorEl, { key: 'Escape' })
    expect(screen.queryByRole('listbox', { name: '슬래시 명령어 자동완성' })).not.toBeInTheDocument()

    await user.keyboard('{Backspace}')
    const tocListbox2 = await screen.findByRole('listbox', { name: '슬래시 명령어 자동완성' })
    await user.click(within(tocListbox2).getByRole('option', { name: /\/toc/ }))
    await waitFor(() => {
      expect(latestMd).toContain('<!-- toc -->')
      expect(latestMd).toContain('- [DocTitle](#doctitle)')
      expect(latestMd).toContain('<!-- /toc -->')
    })
  })

  it('does not open slash popup inside code blocks or after URLs in WYSIWYG mode', async () => {
    const user = userEvent.setup()
    render(
      <WysiwygMarkdownEditor
        content={'```ts\nconst a = 1\n```\n\nhttps:/'}
        scrollTop={0}
        onChangeContent={vi.fn()}
      />
    )

    const editorEl = screen.getByTestId('document-editor')
    const codeTextEl = await within(editorEl).findByText(/const a = 1/)
    placeCaretInProseMirror(editorEl, codeTextEl)
    await user.keyboard('\n/fun')
    expect(screen.queryByRole('listbox', { name: '슬래시 명령어 자동완성' })).not.toBeInTheDocument()

    const urlParagraph = Array.from(editorEl.querySelectorAll('p')).find((p) =>
      p.textContent?.includes('https:/')
    )!
    placeCaretInProseMirror(editorEl, urlParagraph)
    await user.keyboard('/')
    expect(screen.queryByRole('listbox', { name: '슬래시 명령어 자동완성' })).not.toBeInTheDocument()
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

  it('integrates a single action bar in mermaid-node-header without duplicating a floating bar in preview, handles syntax errors, blanks, failures, and 1500ms feedback without mutating markdown', async () => {
    const entries: RendererLogPayload[] = []
    let shouldFail = false
    const copyText = vi.fn(async () => {
      if (shouldFail) {
        throw new Error('위지윅 클립보드 복사 실패')
      }
    })
    window.wikiApi = {
      diagram: { copyText },
      log: {
        write: vi.fn(async (payload: RendererLogPayload) => {
          entries.push(payload)
        })
      }
    } as unknown as WikiApi

    const driver: MermaidDriver = {
      initialize: vi.fn(),
      render: vi.fn(async (_id, text) => {
        if (text.includes('broken_wysiwyg')) {
          throw new Error('Parse error')
        }
        return { svg: `<svg><text>${text.trim()}</text></svg>` }
      })
    }
    const mermaidRenderer = createMermaidRenderer(driver)
    const onChangeContent = vi.fn()
    const validSource = 'graph TD\n  SECRET_WYS --> NodeB'
    const brokenSource = 'graph TD\n  broken_wysiwyg'

    const markdown = [
      '```mermaid',
      validSource,
      '```',
      '',
      '```mermaid',
      brokenSource,
      '```',
      '',
      '```mermaid',
      '   ',
      '```'
    ].join('\n')

    render(
      <WysiwygMarkdownEditor
        content={markdown}
        scrollTop={0}
        theme="light"
        mermaidRenderer={mermaidRenderer}
        onChangeContent={onChangeContent}
      />
    )

    await waitFor(() => {
      expect(screen.getAllByTestId('wysiwyg-mermaid-block')).toHaveLength(3)
      expect(screen.getByTestId('mermaid-svg')).toBeInTheDocument()
    })

    const blocks = screen.getAllByTestId('wysiwyg-mermaid-block')
    const validBlock = blocks[0]
    const brokenBlock = blocks[1]
    const blankBlock = blocks[2]

    // Each WYSIWYG Mermaid block has exactly ONE action toolbar in .mermaid-node-header and ZERO inside .mermaid-node-preview
    const header = validBlock.querySelector('.mermaid-node-header') as HTMLElement
    const preview = validBlock.querySelector('.mermaid-node-preview') as HTMLElement
    expect(within(validBlock).getAllByRole('toolbar', { name: 'Mermaid 다이어그램 작업' })).toHaveLength(1)
    expect(within(header).getByRole('toolbar', { name: 'Mermaid 다이어그램 작업' })).toHaveClass('is-inline')
    expect(within(header).getByRole('button', { name: '코드 복사' })).toBeInTheDocument()
    expect(within(header).getByRole('button', { name: '코드 편집' })).toBeInTheDocument()
    expect(within(preview).queryByRole('toolbar', { name: 'Mermaid 다이어그램 작업' })).not.toBeInTheDocument()

    // Blank block has disabled copy button
    const blankCopyBtn = within(blankBlock).getByRole('button', { name: '코드 복사' })
    expect(blankCopyBtn).toBeDisabled()
    fireEvent.click(blankCopyBtn)
    expect(copyText).not.toHaveBeenCalled()

    // Broken block retains syntax error alert and still allows copying raw broken source
    await within(brokenBlock).findByText('Mermaid 다이어그램 문법 오류')
    const brokenCopyBtn = within(brokenBlock).getByRole('button', { name: '코드 복사' })
    expect(brokenCopyBtn).toBeEnabled()
    await act(async () => {
      fireEvent.click(brokenCopyBtn)
      await Promise.resolve()
    })
    expect(copyText).toHaveBeenCalledWith(brokenSource)

    // Failure on valid block shows inline alert inside validBlock + sanitized log (no raw source)
    shouldFail = true
    const validCopyBtn = within(validBlock).getByRole('button', { name: '코드 복사' })
    await act(async () => {
      fireEvent.click(validCopyBtn)
      await Promise.resolve()
    })
    expect(within(validBlock).getByRole('alert')).toHaveTextContent('위지윅 클립보드 복사 실패')
    const copyFailureEntries = entries.filter(
      (entry) => entry.message === 'Mermaid code copy failed'
    )
    expect(copyFailureEntries).toHaveLength(1)
    expect(copyFailureEntries[0]).toMatchObject({
      level: 'error',
      category: 'ui',
      message: 'Mermaid code copy failed',
      data: { codeLength: validSource.length }
    })
    expect(JSON.stringify(entries)).not.toContain('SECRET_WYS')

    // Retry success with fake timers -> clears alert and displays 1500ms check feedback
    shouldFail = false
    vi.useFakeTimers()
    await act(async () => {
      fireEvent.click(validCopyBtn)
      await Promise.resolve()
    })
    expect(copyText).toHaveBeenLastCalledWith(validSource)
    expect(within(validBlock).queryByRole('alert')).not.toBeInTheDocument()
    expect(validCopyBtn).toHaveTextContent('복사됨')
    expect(validCopyBtn).toHaveClass('is-copied')

    act(() => {
      vi.advanceTimersByTime(1500)
    })
    expect(validCopyBtn).not.toHaveTextContent('복사됨')
    expect(onChangeContent).not.toHaveBeenCalled()
  })

  it('supports inline 이미지 복사 in WYSIWYG light/dark themes with 1500ms feedback, syntax-error disabling, sanitized failure alerts, and zero markdown mutation', async () => {
    const entries: RendererLogPayload[] = []
    let failCopyImage = false
    const copyImage = vi.fn(async () => {
      if (failCopyImage) {
        throw new Error('위지윅 이미지 클립보드 실패')
      }
    })
    window.wikiApi = {
      diagram: { copyText: vi.fn(async () => {}), copyImage },
      log: {
        write: vi.fn(async (payload: RendererLogPayload) => {
          entries.push(payload)
        })
      }
    } as unknown as WikiApi

    const rasterRequests: DiagramSvgRasterRequest[] = []
    const pngBytes = new Uint8Array([137, 80, 78, 71, 77])
    const rasterAdapter: DiagramPngRasterAdapter = vi.fn(async (req) => {
      rasterRequests.push(req)
      return pngBytes
    })

    const driver: MermaidDriver = {
      initialize: vi.fn(),
      render: vi.fn(async (_id, text) => {
        if (text.includes('broken_img')) {
          throw new Error('Syntax error')
        }
        return {
          svg: `<svg viewBox="0 0 120 60" width="100%" style="max-width: 120px;"><g><text>${text.trim()}</text></g></svg>`
        }
      })
    }
    const mermaidRenderer = createMermaidRenderer(driver)
    const onChangeContent = vi.fn()
    const validSource = 'graph TD\n  WYS_IMG_SECRET --> Out'
    const brokenSource = 'graph TD\n  broken_img'
    const markdown = [
      '```mermaid',
      validSource,
      '```',
      '',
      '```mermaid',
      brokenSource,
      '```',
      '',
      '```mermaid',
      '   ',
      '```'
    ].join('\n')

    const { rerender } = render(
      <WysiwygMarkdownEditor
        content={markdown}
        scrollTop={0}
        theme="light"
        mermaidRenderer={mermaidRenderer}
        mermaidRasterAdapter={rasterAdapter}
        onChangeContent={onChangeContent}
      />
    )

    await waitFor(() => {
      expect(screen.getAllByTestId('wysiwyg-mermaid-block')).toHaveLength(3)
      expect(screen.getByTestId('mermaid-svg')).toBeInTheDocument()
    })

    const blocks = screen.getAllByTestId('wysiwyg-mermaid-block')
    const validBlock = blocks[0]
    const brokenBlock = blocks[1]
    const blankBlock = blocks[2]

    const toolbar = within(validBlock).getByRole('toolbar', { name: 'Mermaid 다이어그램 작업' })
    expect(within(toolbar).getAllByRole('button').map((btn) => btn.getAttribute('aria-label'))).toEqual([
      '이미지 복사',
      '코드 복사'
    ])

    const validImageBtn = within(validBlock).getByRole('button', { name: '이미지 복사' })
    const brokenImageBtn = within(brokenBlock).getByRole('button', { name: '이미지 복사' })
    const brokenCodeBtn = within(brokenBlock).getByRole('button', { name: '코드 복사' })
    const blankImageBtn = within(blankBlock).getByRole('button', { name: '이미지 복사' })

    expect(validImageBtn).toBeEnabled()
    expect(brokenImageBtn).toBeDisabled()
    expect(brokenCodeBtn).toBeEnabled()
    expect(blankImageBtn).toBeDisabled()

    // Light theme PNG copy
    await act(async () => {
      fireEvent.click(validImageBtn)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(rasterRequests).toHaveLength(1)
    expect(rasterRequests[0]).toMatchObject({
      pixelWidth: 304,
      pixelHeight: 184
    })
    const decodedWysiwygLightSvg = decodeURIComponent(
      rasterRequests[0].svgDataUri.replace('data:image/svg+xml;charset=utf-8,', '')
    )
    expect(decodedWysiwygLightSvg).toContain('width="152"')
    expect(decodedWysiwygLightSvg).toContain('height="92"')
    expect(decodedWysiwygLightSvg).toContain('fill="#ffffff"')
    expect(copyImage).toHaveBeenCalledWith(pngBytes)
    expect(validImageBtn).toHaveTextContent('복사됨')

    // Switch to dark theme and copy PNG
    rerender(
      <WysiwygMarkdownEditor
        content={markdown}
        scrollTop={0}
        theme="dark"
        mermaidRenderer={mermaidRenderer}
        mermaidRasterAdapter={rasterAdapter}
        onChangeContent={onChangeContent}
      />
    )
    await waitFor(() => {
      expect(within(validBlock).getByTestId('mermaid-diagram')).toHaveAttribute(
        'data-mermaid-theme',
        'dark'
      )
      expect(within(validBlock).getByRole('button', { name: '이미지 복사' })).toBeEnabled()
    })

    failCopyImage = true
    await act(async () => {
      fireEvent.click(validImageBtn)
      await Promise.resolve()
      await Promise.resolve()
    })
    const validActionAlert = validBlock.querySelector('.mermaid-action-error')
    expect(validActionAlert).toHaveAttribute('role', 'alert')
    expect(validActionAlert).toHaveTextContent('위지윅 이미지 클립보드 실패')
    expect(brokenBlock.querySelector('.mermaid-action-error')).toBeNull()
    expect(blankBlock.querySelector('.mermaid-action-error')).toBeNull()
    const imageFailures = entries.filter((e) => e.message === 'Mermaid image copy failed')
    expect(imageFailures).toHaveLength(1)
    expect(imageFailures[0].data).toMatchObject({
      theme: 'dark',
      codeLength: validSource.length,
      byteLength: pngBytes.byteLength
    })
    expect(JSON.stringify(imageFailures[0])).not.toContain('WYS_IMG_SECRET')

    // Recover and advance 1500ms feedback timer
    failCopyImage = false
    vi.useFakeTimers()
    await act(async () => {
      fireEvent.click(validImageBtn)
      await vi.advanceTimersByTimeAsync(0)
    })
    const decodedWysiwygDarkSvg = decodeURIComponent(
      rasterRequests[2].svgDataUri.replace('data:image/svg+xml;charset=utf-8,', '')
    )
    expect(decodedWysiwygDarkSvg).toContain('fill="#161b22"')
    expect(within(validBlock).queryByRole('alert')).not.toBeInTheDocument()
    expect(validImageBtn).toHaveTextContent('복사됨')

    act(() => {
      vi.advanceTimersByTime(1500)
    })
    expect(validImageBtn).not.toHaveTextContent('복사됨')
    expect(onChangeContent).not.toHaveBeenCalled()
  })
})
