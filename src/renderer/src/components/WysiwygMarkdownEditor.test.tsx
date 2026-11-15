import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { CustomCommandConfig } from '@shared/config'
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

  it('closes on space/external URL/Escape, stays mutually exclusive with slash menu, and supports Ctrl+K selection, empty cursor, and existing link unwrap', async () => {
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

    await user.keyboard(' /')
    expect(await screen.findByRole('listbox', { name: '슬래시 명령어 자동완성' })).toBeInTheDocument()

    fireEvent.keyDown(editorEl, { key: 'k', ctrlKey: true })
    expect(await screen.findByRole('listbox', { name: '링크 자동완성' })).toBeInTheDocument()
    expect(
      screen.queryByRole('listbox', { name: '슬래시 명령어 자동완성' })
    ).not.toBeInTheDocument()

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
})
