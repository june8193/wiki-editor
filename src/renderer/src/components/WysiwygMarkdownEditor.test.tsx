import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { WikiApi } from '@shared/ipc'
import type { RendererLogPayload } from '@shared/logging'
import type { WorkspaceEntry } from '@shared/workspace'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMermaidRenderer, type MermaidDriver } from '../editor/mermaidRenderer'
import { buildWikiAssetUrl } from '@shared/assets'
import { ImageTransferContext } from '../hooks/useEditorImageTransfer'
import { installSvgCanvasStub } from '../test/svgCanvasStub'
import themeCss from '../styles/theme.css?raw'
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

  it('disables native browser spellcheck on the WYSIWYG editor surface', () => {
    render(
      <WysiwygMarkdownEditor
        content={'# Spellcheck Test\n\nSome identifierLikeText'}
        scrollTop={0}
        onChangeContent={vi.fn()}
      />
    )

    expect(screen.getByTestId('document-editor')).toHaveAttribute('spellcheck', 'false')
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
    const canvasStub = installSvgCanvasStub()

    try {
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
        '축소',
        '배율 초기화',
        '확대',
        '뷰 초기화',
        '이미지 복사',
        '코드 복사',
        'PNG 저장',
        'SVG 저장'
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
      fireEvent.click(validImageBtn)
      await waitFor(() => {
        expect(copyImage).toHaveBeenCalledTimes(1)
        expect(validImageBtn).toHaveTextContent('복사됨')
      })
      expect(canvasStub.calls).toHaveLength(1)
      expect(canvasStub.calls[0]).toMatchObject({
        pixelWidth: 304,
        pixelHeight: 184
      })
      expect(canvasStub.calls[0].decodedSvg).toContain('width="152"')
      expect(canvasStub.calls[0].decodedSvg).toContain('height="92"')
      expect(canvasStub.calls[0].decodedSvg).toContain('fill="#ffffff"')
      expect(copyImage).toHaveBeenLastCalledWith(new Uint8Array([137, 80, 78, 71, 1, 304 & 0xff]))

      // Switch to dark theme and verify failure alert + sanitized log
      rerender(
        <WysiwygMarkdownEditor
          content={markdown}
          scrollTop={0}
          theme="dark"
          mermaidRenderer={mermaidRenderer}
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
      fireEvent.click(validImageBtn)
      await waitFor(() => {
        expect(validBlock.querySelector('.mermaid-action-error')).toHaveTextContent(
          '위지윅 이미지 클립보드 실패'
        )
      })
      const validActionAlert = validBlock.querySelector('.mermaid-action-error')
      expect(validActionAlert).toHaveAttribute('role', 'alert')
      expect(brokenBlock.querySelector('.mermaid-action-error')).toBeNull()
      expect(blankBlock.querySelector('.mermaid-action-error')).toBeNull()
      const imageFailures = entries.filter((e) => e.message === 'Mermaid image copy failed')
      expect(imageFailures).toHaveLength(1)
      expect(imageFailures[0].data).toMatchObject({
        theme: 'dark',
        codeLength: validSource.length,
        byteLength: 6
      })
      expect(JSON.stringify(imageFailures[0])).not.toContain('WYS_IMG_SECRET')

      // Recover and advance 1500ms feedback timer
      failCopyImage = false
      vi.useFakeTimers()
      await act(async () => {
        fireEvent.click(validImageBtn)
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(canvasStub.calls[2].decodedSvg).toContain('fill="#161b22"')
      expect(within(validBlock).queryByRole('alert')).not.toBeInTheDocument()
      expect(validImageBtn).toHaveTextContent('복사됨')

      act(() => {
        vi.advanceTimersByTime(1500)
      })
      expect(validImageBtn).not.toHaveTextContent('복사됨')
      expect(onChangeContent).not.toHaveBeenCalled()
    } finally {
      canvasStub.restore()
    }
  })

  it('supports inline PNG 저장 and SVG 저장 in WYSIWYG with documentTitle context, 1500ms feedback, cancel reset, syntax-error disabling, and sanitized alerts', async () => {
    const canvasStub = installSvgCanvasStub()

    try {
      const entries: RendererLogPayload[] = []
      let nextCanceled = false
      let failSave = false
      const saveFile = vi.fn(async (req: { format: 'png' | 'svg'; suggestedName: string; data: Uint8Array | string }) => {
        if (failSave) {
          throw new Error('위지윅 파일 저장 실패')
        }
        return nextCanceled
          ? { canceled: true }
          : { canceled: false, filePath: `C:\\exports\\${req.suggestedName}` }
      })
      window.wikiApi = {
        diagram: {
          copyText: vi.fn(async () => {}),
          copyImage: vi.fn(async () => {}),
          saveFile
        },
        log: {
          write: vi.fn(async (payload: RendererLogPayload) => {
            entries.push(payload)
          })
        }
      } as unknown as WikiApi

      const driver: MermaidDriver = {
        initialize: vi.fn(),
        render: vi.fn(async (_id, text) => {
          if (text.includes('broken_save')) {
            throw new Error('Syntax error')
          }
          return {
            svg: `<svg viewBox="0 0 120 60" width="100%" style="max-width: 120px;"><g><text>${text.trim()}</text></g></svg>`
          }
        })
      }
      const mermaidRenderer = createMermaidRenderer(driver)
      const onChangeContent = vi.fn()
      const validSource = 'graph TD\n  WYS_SAVE_SECRET --> End'
      const markdown = [
        '```mermaid',
        validSource,
        '```',
        '',
        '```mermaid',
        'graph TD\n  broken_save',
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
          documentTitle="  ..Design: Spec...  "
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

      const validPngBtn = within(validBlock).getByRole('button', { name: 'PNG 저장' })
      const validSvgBtn = within(validBlock).getByRole('button', { name: 'SVG 저장' })
      expect(validPngBtn).toBeEnabled()
      expect(validSvgBtn).toBeEnabled()
      expect(within(brokenBlock).getByRole('button', { name: 'PNG 저장' })).toBeDisabled()
      expect(within(brokenBlock).getByRole('button', { name: 'SVG 저장' })).toBeDisabled()
      expect(within(blankBlock).getByRole('button', { name: 'PNG 저장' })).toBeDisabled()
      expect(within(blankBlock).getByRole('button', { name: 'SVG 저장' })).toBeDisabled()

      // Confirmed PNG save uses sanitized documentTitle
      fireEvent.click(validPngBtn)
      await waitFor(() => {
        expect(saveFile).toHaveBeenCalledTimes(1)
        expect(validPngBtn).toHaveTextContent('저장됨')
      })
      expect(saveFile).toHaveBeenLastCalledWith({
        format: 'png',
        suggestedName: 'Design Spec-diagram.png',
        data: new Uint8Array([137, 80, 78, 71, 1, 304 & 0xff])
      })

      // Switch to dark theme + canceled SVG save -> no feedback or alert
      rerender(
        <WysiwygMarkdownEditor
          content={markdown}
          scrollTop={0}
          theme="dark"
          documentTitle="  ..Design: Spec...  "
          mermaidRenderer={mermaidRenderer}
          onChangeContent={onChangeContent}
        />
      )
      await waitFor(() => {
        expect(within(validBlock).getByTestId('mermaid-diagram')).toHaveAttribute(
          'data-mermaid-theme',
          'dark'
        )
        expect(validSvgBtn).toBeEnabled()
      })

      nextCanceled = true
      fireEvent.click(validSvgBtn)
      await waitFor(() => {
        expect(saveFile).toHaveBeenCalledTimes(2)
      })
      expect(saveFile.mock.calls[1][0]).toMatchObject({
        format: 'svg',
        suggestedName: 'Design Spec-diagram.svg'
      })
      expect(saveFile.mock.calls[1][0].data).toContain('fill="#161b22"')
      expect(validSvgBtn).not.toHaveTextContent('저장됨')
      expect(within(validBlock).queryByRole('alert')).not.toBeInTheDocument()

      // Failure displays inline alert and sanitized error log
      nextCanceled = false
      failSave = true
      fireEvent.click(validSvgBtn)
      await waitFor(() => {
        expect(validBlock.querySelector('.mermaid-action-error')).toHaveTextContent('위지윅 파일 저장 실패')
      })
      const saveErrorLogs = entries.filter((e) => e.message === 'Mermaid SVG save failed')
      expect(saveErrorLogs).toHaveLength(1)
      expect(saveErrorLogs[0].data).toMatchObject({
        format: 'svg',
        theme: 'dark',
        codeLength: validSource.length
      })
      expect(JSON.stringify(saveErrorLogs[0])).not.toContain('WYS_SAVE_SECRET')
      expect(JSON.stringify(saveErrorLogs[0])).not.toContain('<svg')

      // Retry confirmed SVG save with fake timers -> 1500ms 저장됨 feedback
      failSave = false
      vi.useFakeTimers()
      await act(async () => {
        fireEvent.click(validSvgBtn)
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(within(validBlock).queryByRole('alert')).not.toBeInTheDocument()
      expect(validSvgBtn).toHaveTextContent('저장됨')
      act(() => {
        vi.advanceTimersByTime(1500)
      })
      expect(validSvgBtn).not.toHaveTextContent('저장됨')
      expect(onChangeContent).not.toHaveBeenCalled()
    } finally {
      canvasStub.restore()
    }
  })

  it('supports inline zoom, pan, Ctrl+wheel, and bottom height resize in WYSIWYG without mutating markdown', async () => {
    const driver: MermaidDriver = {
      initialize: vi.fn(),
      render: vi.fn(async () => ({
        svg: '<svg viewBox="0 0 100 50"><rect width="100" height="50"/></svg>'
      }))
    }
    const mermaidRenderer = createMermaidRenderer(driver)
    const onChangeContent = vi.fn()
    const markdown = ['```mermaid', 'graph TD\n  WYS_A --> WYS_B', '```'].join('\n')

    render(
      <WysiwygMarkdownEditor
        content={markdown}
        scrollTop={0}
        theme="light"
        mermaidRenderer={mermaidRenderer}
        onChangeContent={onChangeContent}
      />
    )

    const block = await screen.findByTestId('wysiwyg-mermaid-block')
    const viewport = await within(block).findByTestId('mermaid-svg')
    const stage = within(viewport).getByTestId('mermaid-svg-stage')
    const header = block.querySelector('.mermaid-node-header') as HTMLElement
    const handle = within(block).getByTestId('mermaid-resize-handle')

    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      right: 400,
      bottom: 200,
      width: 400,
      height: 200,
      x: 0,
      y: 0,
      toJSON: () => ({})
    })

    // Header inline zoom buttons
    const zoomInBtn = within(header).getByRole('button', { name: '확대' })
    const resetBtn = within(header).getByRole('button', { name: '배율 초기화' })
    fireEvent.click(zoomInBtn)
    expect(resetBtn).toHaveTextContent('125%')
    expect(stage.style.transform).toMatch(/^translate\(0px(?:, 0px)?\) scale\(1\.25\)$/)

    // Ctrl+wheel adjusts zoom by +10% in WYSIWYG preview viewport
    const ctrlWheel = new WheelEvent('wheel', {
      deltaY: -100,
      ctrlKey: true,
      clientX: 200,
      clientY: 100,
      bubbles: true,
      cancelable: true
    })
    act(() => {
      viewport.dispatchEvent(ctrlWheel)
    })
    expect(ctrlWheel.defaultPrevented).toBe(true)
    expect(resetBtn).toHaveTextContent('135%')

    // Pan inside preview viewport
    fireEvent.pointerDown(viewport, { button: 0, clientX: 100, clientY: 100 })
    fireEvent.pointerMove(window, { clientX: 130, clientY: 120 })
    expect(stage.style.transform).toBe('translate(30px, 20px) scale(1.35)')
    fireEvent.pointerUp(window)

    // Bottom handle resize + double click reset
    fireEvent.pointerDown(handle, { button: 0, clientY: 200 })
    fireEvent.pointerMove(window, { clientY: 340 })
    expect(viewport.style.height).toBe('340px')
    fireEvent.pointerUp(window)

    fireEvent.click(resetBtn)
    expect(resetBtn).toHaveTextContent('100%')
    expect(stage.style.transform).toMatch(/^translate\(0px(?:, 0px)?\) scale\(1\)$/)
    expect(viewport.style.height).toBe('340px')

    fireEvent.doubleClick(handle)
    expect(viewport.style.height).toBe('')
    expect(onChangeContent).not.toHaveBeenCalled()
  })

  it('unifies WYSIWYG Mermaid block into a single card without nested borders, applies Contain scaling and live height badge on drag, and supports unified 뷰 초기화 without mutating markdown', async () => {
    const styleEl = document.createElement('style')
    styleEl.textContent = themeCss
    document.head.appendChild(styleEl)

    const OriginalResizeObserver = globalThis.ResizeObserver
    const observerCallbacks: Array<() => void> = []
    globalThis.ResizeObserver = class MockResizeObserver {
      private callback: () => void
      constructor(callback: ResizeObserverCallback) {
        this.callback = () => callback([], this as unknown as ResizeObserver)
        observerCallbacks.push(this.callback)
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    } as unknown as typeof ResizeObserver

    try {
      const driver: MermaidDriver = {
        initialize: vi.fn(),
        render: vi.fn(async () => ({
          svg: '<svg viewBox="0 0 100 50" width="100%" style="max-width: 100px;"><rect width="100" height="50"/></svg>'
        }))
      }
      const mermaidRenderer = createMermaidRenderer(driver)
      const onChangeContent = vi.fn()
      const markdown = ['```mermaid', 'graph LR\n  SingleCard --> Fit', '```'].join('\n')

      render(
        <WysiwygMarkdownEditor
          content={markdown}
          scrollTop={0}
          theme="light"
          mermaidRenderer={mermaidRenderer}
          onChangeContent={onChangeContent}
        />
      )

      const outerCard = await screen.findByTestId('wysiwyg-mermaid-block')
      const embeddedBlock = within(outerCard).getByTestId('mermaid-diagram')
      const viewport = await within(outerCard).findByTestId('mermaid-svg')
      const stage = within(viewport).getByTestId('mermaid-svg-stage')
      const header = outerCard.querySelector('.mermaid-node-header') as HTMLElement
      const handle = within(outerCard).getByTestId('mermaid-resize-handle')

      // Single card structure: outer card has 1px border & 0px padding; inner diagram block has 0px border & 0px margin
      const outerStyle = getComputedStyle(outerCard)
      const embeddedStyle = getComputedStyle(embeddedBlock)
      const headerStyle = getComputedStyle(header)
      expect(outerStyle.borderTopWidth).toBe('1px')
      expect(outerStyle.paddingTop).toBe('0px')
      expect(headerStyle.borderBottomWidth).toBe('1px')
      expect(embeddedBlock).toHaveClass('is-embedded')
      expect(embeddedStyle.borderTopWidth).toBe('0px')
      expect(embeddedStyle.borderBottomWidth).toBe('0px')
      expect(embeddedStyle.marginTop).toBe('0px')
      expect(embeddedStyle.marginBottom).toBe('0px')

      // Viewport has 12px padding (24px horizontal & 24px vertical); 424px outer rect -> 400px availableWidth, 74px auto height
      vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue({
        left: 0,
        top: 0,
        right: 424,
        bottom: 74,
        width: 424,
        height: 74,
        x: 0,
        y: 0,
        toJSON: () => ({})
      })
      act(() => {
        observerCallbacks.forEach((cb) => cb())
      })

      const resetViewBtn = within(header).getByRole('button', { name: '뷰 초기화' })
      const zoomInBtn = within(header).getByRole('button', { name: '확대' })
      const resetZoomBtn = within(header).getByRole('button', { name: '배율 초기화' })
      expect(resetViewBtn).toBeDisabled()

      const svgEl = viewport.querySelector('svg') as SVGSVGElement
      expect(svgEl.style.width).toBe('100px')
      expect(svgEl.style.height).toBe('50px')

      // Drag bottom handle +100px -> height 174px (availableHeight=150px), removes max-width, scales SVG to 300x150, shows badge
      fireEvent.pointerDown(handle, { button: 0, clientY: 74 })
      expect(within(viewport).getByTestId('mermaid-height-badge')).toHaveTextContent('74px')
      fireEvent.pointerMove(window, { clientY: 174 })
      expect(viewport.style.height).toBe('174px')
      expect(within(viewport).getByTestId('mermaid-height-badge')).toHaveTextContent('174px')
      expect(svgEl.style.maxWidth).toBe('')
      expect(svgEl.style.width).toBe('300px')
      expect(svgEl.style.height).toBe('150px')
      fireEvent.pointerUp(window)
      expect(within(viewport).queryByTestId('mermaid-height-badge')).not.toBeInTheDocument()

      // Keyboard ArrowDown (+24px) & ArrowUp (-24px)
      fireEvent.keyDown(handle, { key: 'ArrowDown' })
      expect(viewport.style.height).toBe('198px')
      fireEvent.keyDown(handle, { key: 'ArrowUp' })
      expect(viewport.style.height).toBe('174px')

      // Zoom + pan + unified 뷰 초기화 resets all three without mutating markdown
      fireEvent.click(zoomInBtn)
      expect(resetZoomBtn).toHaveTextContent('125%')
      expect(resetViewBtn).toBeEnabled()

      fireEvent.click(resetViewBtn)
      expect(resetZoomBtn).toHaveTextContent('100%')
      expect(stage.style.transform).toMatch(/^translate\(0px(?:, 0px)?\) scale\(1\)$/)
      expect(viewport.style.height).toBe('')
      expect(svgEl.style.width).toBe('100px')
      expect(svgEl.style.height).toBe('50px')
      expect(resetViewBtn).toBeDisabled()
      expect(onChangeContent).not.toHaveBeenCalled()
    } finally {
      globalThis.ResizeObserver = OriginalResizeObserver
      styleEl.remove()
    }
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

describe('WysiwygMarkdownEditor code block language selector and highlighting', () => {
  const originalWikiApi = (window as { wikiApi?: WikiApi }).wikiApi

  afterEach(() => {
    vi.useRealTimers()
    if (originalWikiApi === undefined) {
      delete (window as { wikiApi?: WikiApi }).wikiApi
    } else {
      window.wikiApi = originalWikiApi
    }
  })

  it('supports preset/custom language selection, keyboard navigation, outside-click dismissal, copy feedback, syntax highlighting, and mermaid conversion', async () => {
    const user = userEvent.setup()
    const copyText = vi.fn(async () => {})
    window.wikiApi = {
      diagram: {
        copyText,
        copyImage: vi.fn(async () => {}),
        saveFile: vi.fn(async () => ({ canceled: true }))
      }
    } as unknown as WikiApi

    const driver: MermaidDriver = {
      initialize: vi.fn(),
      render: vi.fn(async (_id, text) => ({
        svg: `<svg><text>${text.trim()}</text></svg>`
      }))
    }
    const renderer = createMermaidRenderer(driver)
    const onChangeContent = vi.fn()

    const initial = [
      '```c',
      'int main() {',
      '  return 0;',
      '}',
      '```',
      '',
      '```',
      'def greet():',
      '    return "hi"',
      '```',
      '',
      '```bash',
      '   ',
      '```'
    ].join('\n')

    render(
      <WysiwygMarkdownEditor
        content={initial}
        scrollTop={0}
        mermaidRenderer={renderer}
        onChangeContent={onChangeContent}
      />
    )

    const codeBlocks = await screen.findAllByTestId('wysiwyg-code-block')
    expect(codeBlocks).toHaveLength(3)
    expect(onChangeContent).not.toHaveBeenCalled()

    // First block displays 'C' and has live C syntax highlighting; re-selecting 'C' does not emit redundant update
    const firstTrigger = within(codeBlocks[0]).getByRole('button', { name: '코드 블록 언어 선택' })
    expect(firstTrigger).toHaveTextContent('C')
    expect(codeBlocks[0].querySelector('span.tok-type')).toHaveTextContent('int')
    expect(codeBlocks[0].querySelector('span.tok-keyword')).toHaveTextContent('return')

    await user.click(firstTrigger)
    await user.click(
      within(screen.getByRole('listbox', { name: '코드 블록 언어 목록' })).getByRole('option', {
        name: 'C'
      })
    )
    expect(onChangeContent).not.toHaveBeenCalled()

    // Clicking padding inside the popover keeps focus on input so Escape dismisses and restores trigger focus
    await user.click(firstTrigger)
    const popover = document.querySelector('.code-block-language-popover') as HTMLElement
    fireEvent.mouseDown(popover)
    expect(screen.getByRole('listbox', { name: '코드 블록 언어 목록' })).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('listbox', { name: '코드 블록 언어 목록' })).not.toBeInTheDocument()
    expect(firstTrigger).toHaveFocus()

    // Copy button in whitespace-only third block is disabled
    const blankCopyBtn = within(codeBlocks[2]).getByRole('button', { name: '코드 복사' })
    expect(blankCopyBtn).toBeDisabled()

    // Escape on trigger dismisses open popover and keeps focus on trigger
    await user.click(firstTrigger)
    expect(screen.getByRole('listbox', { name: '코드 블록 언어 목록' })).toBeInTheDocument()
    firstTrigger.focus()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('listbox', { name: '코드 블록 언어 목록' })).not.toBeInTheDocument()
    expect(firstTrigger).toHaveFocus()

    // Outside-click inside the same header (clicking copy button) and across code blocks dismisses open popovers
    await user.click(firstTrigger)
    expect(screen.getByRole('listbox', { name: '코드 블록 언어 목록' })).toBeInTheDocument()

    const firstCopyBtn = within(codeBlocks[0]).getByRole('button', { name: '코드 복사' })
    await user.click(firstCopyBtn)
    expect(screen.queryByRole('listbox', { name: '코드 블록 언어 목록' })).not.toBeInTheDocument()

    // Tabbing/moving focus out of the combobox onto a sibling button dismisses open popover
    await user.click(firstTrigger)
    expect(screen.getByRole('listbox', { name: '코드 블록 언어 목록' })).toBeInTheDocument()
    await act(async () => {
      firstCopyBtn.focus()
    })
    expect(screen.queryByRole('listbox', { name: '코드 블록 언어 목록' })).not.toBeInTheDocument()

    // Clicking trigger on second block while first is open closes first and keeps only one listbox open
    await user.click(firstTrigger)
    expect(screen.getAllByRole('listbox', { name: '코드 블록 언어 목록' })).toHaveLength(1)
    const secondTrigger = within(codeBlocks[1]).getByRole('button', { name: '코드 블록 언어 선택' })
    await user.click(secondTrigger)
    expect(screen.getAllByRole('listbox', { name: '코드 블록 언어 목록' })).toHaveLength(1)

    // Keyboard Escape from an option button inside the listbox dismisses popover and restores focus to trigger
    const secondListbox = screen.getByRole('listbox', { name: '코드 블록 언어 목록' })
    const pythonOption = within(secondListbox).getByRole('option', { name: 'Python' })
    pythonOption.focus()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('listbox', { name: '코드 블록 언어 목록' })).not.toBeInTheDocument()
    expect(secondTrigger).toHaveFocus()

    // Second block defaults to 'Plain Text' with no highlight spans
    expect(secondTrigger).toHaveTextContent('Plain Text')
    expect(codeBlocks[1].querySelectorAll('code span')).toHaveLength(0)

    // Open language combobox on second block -> lists 12 presets and supports ArrowDown/ArrowUp + Enter with focus restore
    await user.click(secondTrigger)
    const listbox = screen.getByRole('listbox', { name: '코드 블록 언어 목록' })
    const presetLabels = within(listbox)
      .getAllByRole('option')
      .map((opt) => opt.textContent)
    expect(presetLabels).toEqual([
      'Plain Text',
      'C',
      'C++',
      'Python',
      'JavaScript',
      'TypeScript',
      'JSON',
      'HTML',
      'CSS',
      'YAML',
      'Markdown',
      'Mermaid'
    ])

    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowUp}{Enter}')
    expect(secondTrigger).toHaveTextContent('Plain Text')
    expect(secondTrigger).toHaveFocus()

    // aria-activedescendant tracks highlighted option from input and ArrowDown/ArrowUp also works after Tab-focusing an option button
    await user.click(secondTrigger)
    const activeInput = screen.getByRole('textbox', { name: '언어 검색 또는 직접 입력' })
    expect(activeInput).not.toHaveAttribute('aria-activedescendant')
    await user.keyboard('{ArrowDown}')
    const firstOpt = within(screen.getByRole('listbox', { name: '코드 블록 언어 목록' })).getByRole('option', {
      name: 'Plain Text'
    })
    expect(firstOpt.id).not.toBe('')
    expect(activeInput).toHaveAttribute('aria-activedescendant', firstOpt.id)
    await user.tab()
    expect(firstOpt).toHaveFocus()
    await user.keyboard('{ArrowDown}{Enter}')
    expect(secondTrigger).toHaveTextContent('C')
    expect(secondTrigger).toHaveFocus()

    // Backticks alone do not offer a broken custom option; backticks around custom input are stripped
    await user.click(secondTrigger)
    const backtickInput = screen.getByRole('textbox', { name: '언어 검색 또는 직접 입력' })
    await user.type(backtickInput, '```')
    expect(screen.queryByRole('option', { name: /직접 지정/ })).not.toBeInTheDocument()
    await user.clear(backtickInput)
    await user.type(backtickInput, 'my`lang{Enter}')
    expect(secondTrigger).toHaveTextContent('mylang')
    expect(onChangeContent.mock.calls.at(-1)?.[0]).toContain('```mylang\ndef greet():\n    return "hi"\n```')

    // Selecting 'Python' highlights Python code and emits markdown
    await user.click(secondTrigger)
    await user.click(
      within(screen.getByRole('listbox', { name: '코드 블록 언어 목록' })).getByRole('option', {
        name: 'Python'
      })
    )
    expect(secondTrigger).toHaveTextContent('Python')
    expect(secondTrigger).toHaveFocus()
    expect(codeBlocks[1].querySelector('span.tok-keyword')).toHaveTextContent('def')
    expect(codeBlocks[1].querySelector('span.tok-string')).toHaveTextContent('"hi"')
    expect(onChangeContent.mock.calls.at(-1)?.[0]).toContain('```python\ndef greet():\n    return "hi"\n```')

    // Clicking custom option "직접 지정: tsx" and "직접 지정: scss" preserves exact custom identifiers
    await user.click(secondTrigger)
    const searchInput = screen.getByRole('textbox', { name: '언어 검색 또는 직접 입력' })
    await user.type(searchInput, 'tsx')
    await user.click(
      within(screen.getByRole('listbox', { name: '코드 블록 언어 목록' })).getByRole('option', {
        name: '직접 지정: tsx'
      })
    )
    expect(secondTrigger).toHaveTextContent('TSX')
    expect(onChangeContent.mock.calls.at(-1)?.[0]).toContain('```tsx\ndef greet():\n    return "hi"\n```')

    await user.click(secondTrigger)
    await user.type(screen.getByRole('textbox', { name: '언어 검색 또는 직접 입력' }), 'scss')
    await user.click(
      within(screen.getByRole('listbox', { name: '코드 블록 언어 목록' })).getByRole('option', {
        name: '직접 지정: scss'
      })
    )
    expect(secondTrigger).toHaveTextContent('SCSS')
    expect(onChangeContent.mock.calls.at(-1)?.[0]).toContain('```scss\ndef greet():\n    return "hi"\n```')

    // Resetting tagged first block ('C') back to 'Plain Text' emits bare fence
    await user.click(firstTrigger)
    await user.click(
      within(screen.getByRole('listbox', { name: '코드 블록 언어 목록' })).getByRole('option', {
        name: 'Plain Text'
      })
    )
    expect(firstTrigger).toHaveTextContent('Plain Text')
    expect(onChangeContent.mock.calls.at(-1)?.[0]).toContain('```\nint main() {\n  return 0;\n}\n```')

    // Typing a custom language (bash) + Enter updates fence language, label, and restores trigger focus
    await user.click(secondTrigger)
    await user.type(screen.getByRole('textbox', { name: '언어 검색 또는 직접 입력' }), 'bash{Enter}')
    expect(secondTrigger).toHaveTextContent('Bash')
    expect(secondTrigger).toHaveFocus()
    expect(onChangeContent.mock.calls.at(-1)?.[0]).toContain('```bash\ndef greet():\n    return "hi"\n```')

    // Selecting Mermaid converts code block into WysiwygMermaidBlock and keeps focus on its trigger, and changing back restores code block + focus
    await user.click(secondTrigger)
    await user.click(
      within(screen.getByRole('listbox', { name: '코드 블록 언어 목록' })).getByRole('option', {
        name: 'Mermaid'
      })
    )

    const mermaidBlock = await screen.findByTestId('wysiwyg-mermaid-block')
    expect(screen.getAllByTestId('wysiwyg-code-block')).toHaveLength(2)
    expect(onChangeContent.mock.calls.at(-1)?.[0]).toContain('```mermaid\ndef greet():\n    return "hi"\n```')
    const mermaidTrigger = within(mermaidBlock).getByRole('button', { name: '코드 블록 언어 선택' })
    expect(mermaidTrigger).toHaveFocus()

    await user.click(mermaidTrigger)
    await user.click(
      within(screen.getByRole('listbox', { name: '코드 블록 언어 목록' })).getByRole('option', {
        name: 'Python'
      })
    )
    expect(screen.queryByTestId('wysiwyg-mermaid-block')).not.toBeInTheDocument()
    const restoredBlocks = screen.getAllByTestId('wysiwyg-code-block')
    expect(restoredBlocks).toHaveLength(3)
    expect(within(restoredBlocks[1]).getByRole('button', { name: '코드 블록 언어 선택' })).toHaveFocus()
    expect(onChangeContent.mock.calls.at(-1)?.[0]).toContain('```python\ndef greet():\n    return "hi"\n```')

    // Copy button in WYSIWYG code block copies code, clears stale feedback on failure, supports navigator.clipboard fallback, and resets after 1500ms
    vi.useFakeTimers()
    await act(async () => {
      fireEvent.click(firstCopyBtn)
      await Promise.resolve()
    })
    expect(copyText).toHaveBeenLastCalledWith('int main() {\n  return 0;\n}')
    expect(firstCopyBtn).toHaveTextContent('복사됨')

    copyText.mockRejectedValueOnce(new Error('clipboard unavailable'))
    await act(async () => {
      fireEvent.click(firstCopyBtn)
      await Promise.resolve()
    })
    expect(firstCopyBtn).toHaveTextContent('코드 복사')

    await act(async () => {
      fireEvent.click(firstCopyBtn)
      await Promise.resolve()
    })
    expect(firstCopyBtn).toHaveTextContent('복사됨')
    act(() => {
      vi.advanceTimersByTime(1500)
    })
    expect(firstCopyBtn).toHaveTextContent('코드 복사')

    // Async race guard: slow first copy resolving after a newer failed copy must NOT display stale '복사됨'
    let resolveSlowCopy!: () => void
    copyText.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveSlowCopy = resolve
        })
    )
    fireEvent.click(firstCopyBtn)
    copyText.mockRejectedValueOnce(new Error('second failed'))
    await act(async () => {
      fireEvent.click(firstCopyBtn)
      await Promise.resolve()
    })
    await act(async () => {
      resolveSlowCopy()
      await Promise.resolve()
    })
    expect(firstCopyBtn).toHaveTextContent('코드 복사')
  })

  it('uses navigator.clipboard.writeText fallback when window.wikiApi is unavailable', async () => {
    delete (window as { wikiApi?: WikiApi }).wikiApi
    const writeText = vi.fn(async () => {})
    const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText }
    })

    try {
      render(
        <WysiwygMarkdownEditor
          content={'```python\nprint(1)\n```'}
          scrollTop={0}
          onChangeContent={vi.fn()}
        />
      )

      const block = await screen.findByTestId('wysiwyg-code-block')
      const copyBtn = within(block).getByRole('button', { name: '코드 복사' })
      await act(async () => {
        fireEvent.click(copyBtn)
        await Promise.resolve()
      })
      expect(writeText).toHaveBeenCalledWith('print(1)')
      expect(copyBtn).toHaveTextContent('복사됨')
    } finally {
      if (originalClipboard) {
        Object.defineProperty(navigator, 'clipboard', originalClipboard)
      } else {
        delete (navigator as { clipboard?: Clipboard }).clipboard
      }
    }
  })

  it('uses wikiApi.clipboard.writeText fallback when wikiApi.diagram is unavailable', async () => {
    const writeText = vi.fn(async () => {})
    window.wikiApi = {
      clipboard: { writeText }
    } as unknown as WikiApi

    render(
      <WysiwygMarkdownEditor
        content={'```python\nprint(2)\n```'}
        scrollTop={0}
        onChangeContent={vi.fn()}
      />
    )

    const block = await screen.findByTestId('wysiwyg-code-block')
    const copyBtn = within(block).getByRole('button', { name: '코드 복사' })
    await act(async () => {
      fireEvent.click(copyBtn)
      await Promise.resolve()
    })
    expect(writeText).toHaveBeenCalledWith('print(2)')
    expect(copyBtn).toHaveTextContent('복사됨')
  })

  it('preserves untouched alias/custom/mixed-case Mermaid fences on no-op reselect and supports keyboard Mermaid conversion', async () => {
    const user = userEvent.setup()
    const driver: MermaidDriver = {
      initialize: vi.fn(),
      render: vi.fn(async (_id, text) => ({
        svg: `<svg><text>${text.trim()}</text></svg>`
      }))
    }
    const renderer = createMermaidRenderer(driver)
    const onChangeContent = vi.fn()

    const initial = [
      '```py',
      'print("alias")',
      '```',
      '',
      '```rust',
      'fn main() {}',
      '```',
      '',
      '```Mermaid',
      'graph TD',
      '  A --> B',
      '```'
    ].join('\n')

    render(
      <WysiwygMarkdownEditor
        content={initial}
        scrollTop={0}
        mermaidRenderer={renderer}
        onChangeContent={onChangeContent}
      />
    )

    const codeBlocks = await screen.findAllByTestId('wysiwyg-code-block')
    expect(codeBlocks).toHaveLength(2)
    const mermaidBlock = await screen.findByTestId('wysiwyg-mermaid-block')
    expect(onChangeContent).not.toHaveBeenCalled()

    const pyTrigger = within(codeBlocks[0]).getByRole('button', { name: '코드 블록 언어 선택' })
    const rustTrigger = within(codeBlocks[1]).getByRole('button', { name: '코드 블록 언어 선택' })
    const mermaidTrigger = within(mermaidBlock).getByRole('button', { name: '코드 블록 언어 선택' })

    expect(pyTrigger).toHaveTextContent('Python')
    expect(rustTrigger).toHaveTextContent('Rust')
    expect(mermaidTrigger).toHaveTextContent('Mermaid')

    // Re-selecting already-active options on alias, custom, and mixed-case Mermaid blocks emits no update
    await user.click(pyTrigger)
    await user.click(
      within(screen.getByRole('listbox', { name: '코드 블록 언어 목록' })).getByRole('option', {
        name: 'Python'
      })
    )
    expect(onChangeContent).not.toHaveBeenCalled()

    await user.click(rustTrigger)
    await user.type(screen.getByRole('textbox', { name: '언어 검색 또는 직접 입력' }), 'rust{Enter}')
    expect(onChangeContent).not.toHaveBeenCalled()

    await user.click(mermaidTrigger)
    await user.click(
      within(screen.getByRole('listbox', { name: '코드 블록 언어 목록' })).getByRole('option', {
        name: 'Mermaid'
      })
    )
    expect(onChangeContent).not.toHaveBeenCalled()

    // Converting code block to Mermaid and back via keyboard Enter preserves focus and updates Markdown
    await user.click(pyTrigger)
    await user.type(screen.getByRole('textbox', { name: '언어 검색 또는 직접 입력' }), 'mermaid{Enter}')

    await waitFor(() => {
      expect(screen.getAllByTestId('wysiwyg-mermaid-block')).toHaveLength(2)
    })
    expect(screen.getAllByTestId('wysiwyg-code-block')).toHaveLength(1)
    const convertedMermaidTrigger = within(screen.getAllByTestId('wysiwyg-mermaid-block')[0]).getByRole(
      'button',
      { name: '코드 블록 언어 선택' }
    )
    expect(convertedMermaidTrigger).toHaveFocus()
    expect(onChangeContent.mock.calls.at(-1)?.[0]).toContain('```mermaid\nprint("alias")\n```')

    await user.click(convertedMermaidTrigger)
    await user.type(screen.getByRole('textbox', { name: '언어 검색 또는 직접 입력' }), 'python{Enter}')

    await waitFor(() => {
      expect(screen.getAllByTestId('wysiwyg-mermaid-block')).toHaveLength(1)
    })
    const restoredPyBlocks = screen.getAllByTestId('wysiwyg-code-block')
    expect(restoredPyBlocks).toHaveLength(2)
    expect(
      within(restoredPyBlocks[0]).getByRole('button', { name: '코드 블록 언어 선택' })
    ).toHaveFocus()
    expect(onChangeContent.mock.calls.at(-1)?.[0]).toContain('```python\nprint("alias")\n```')
  })
})

describe('WysiwygMarkdownEditor local image rendering and path sync', () => {
  it('renders local relative images with wiki-asset URLs, updates live DOM on documentPath change, and roundtrips without wiki-asset leak', async () => {
    const onChangeContent = vi.fn()
    const markdown = [
      '![local](./assets/pic.png)',
      '',
      '![parent](../shared/diagram.svg)',
      '',
      '![external](https://example.com/banner.png)'
    ].join('\n')

    const { container, rerender } = render(
      <WysiwygMarkdownEditor
        content={markdown}
        scrollTop={0}
        documentPath="C:\\vault\\docs\\guide\\intro.md"
        onChangeContent={onChangeContent}
      />
    )

    await waitFor(() => {
      expect(screen.getByRole('img', { name: 'local' })).toHaveAttribute(
        'src',
        buildWikiAssetUrl('C:\\vault\\docs\\guide\\assets\\pic.png')
      )
    })

    const localImg = screen.getByRole('img', { name: 'local' })
    expect(localImg).toHaveAttribute('data-markdown-src', './assets/pic.png')
    expect(screen.getByRole('img', { name: 'parent' })).toHaveAttribute(
      'src',
      buildWikiAssetUrl('C:\\vault\\docs\\shared\\diagram.svg')
    )
    expect(screen.getByRole('img', { name: 'external' })).toHaveAttribute(
      'src',
      'https://example.com/banner.png'
    )

    // Rename / path update while mounted refreshes image URLs without modifying markdown content
    rerender(
      <WysiwygMarkdownEditor
        content={markdown}
        scrollTop={0}
        documentPath="C:\\vault\\notes\\renamed.md"
        onChangeContent={onChangeContent}
      />
    )

    await waitFor(() => {
      expect(screen.getByRole('img', { name: 'local' })).toHaveAttribute(
        'src',
        buildWikiAssetUrl('C:\\vault\\notes\\assets\\pic.png')
      )
    })
    expect(onChangeContent).not.toHaveBeenCalled()

    // Ensure no width/height attributes are injected and no raw wiki-asset leaks in DOM data-markdown-src
    expect(localImg.hasAttribute('width')).toBe(false)
    expect(localImg.hasAttribute('height')).toBe(false)
    const renderedImgs = container.querySelectorAll('img:not(.ProseMirror-separator)')
    expect(renderedImgs).toHaveLength(3)
  })

  it('pastes clipboard image bitmaps, ignores bitmap+text pastes, inserts ordered multi-file drops, and reports ingestion errors', async () => {
    const onChangeContent = vi.fn()
    const onReportError = vi.fn()
    const ingestImage = vi.fn(async (input) => {
      if (input.source.kind === 'clipboard') {
        return {
          markdownPath: './assets/guide-20260402-090507.png',
          altText: 'guide-20260402-090507',
          savedPath: 'C:\\vault\\docs\\assets\\guide-20260402-090507.png'
        }
      }
      if (input.source.kind === 'filePath') {
        return {
          markdownPath: './assets/first%20%281%29.png',
          altText: 'first (1)',
          savedPath: input.source.filePath
        }
      }
      return {
        markdownPath: `./assets/${encodeURIComponent(input.source.fileName)}`,
        altText: input.source.fileName.replace(/\.[^.]+$/, ''),
        savedPath: `C:\\vault\\docs\\assets\\${input.source.fileName}`
      }
    })
    const getPathForFile = vi.fn((file: File) =>
      file.name === 'first (1).png' ? 'C:\\external\\first (1).png' : ''
    )

    render(
      <ImageTransferContext.Provider
        value={{
          reportImageError: onReportError,
          ingestImage,
          getPathForFile
        }}
      >
        <WysiwygMarkdownEditor
          content={'# Guide\n\n'}
          scrollTop={0}
          documentPath="C:\\vault\\docs\\guide.md"
          onChangeContent={onChangeContent}
        />
      </ImageTransferContext.Provider>
    )

    const editorEl = screen.getByRole('textbox', { name: '위지윅 문서 에디터' })

    // 1. Clipboard paste with empty text/plain and image/png item
    const clipFile = new File([new Uint8Array([1, 2, 3])], 'image.png', { type: 'image/png' })
    fireEvent.paste(editorEl, {
      clipboardData: {
        types: ['Files'],
        files: [clipFile],
        items: [],
        getData: () => ''
      }
    })

    await waitFor(() => {
      expect(ingestImage).toHaveBeenCalledTimes(1)
    })
    await waitFor(() => {
      expect(screen.getByRole('img', { name: 'guide-20260402-090507' })).toHaveAttribute(
        'src',
        buildWikiAssetUrl('C:\\vault\\docs\\assets\\guide-20260402-090507.png')
      )
    })

    // 2. Paste containing text/plain + image bitmap stays normal paste (does NOT invoke ingestImage)
    fireEvent.paste(editorEl, {
      clipboardData: {
        types: ['text/plain', 'Files'],
        files: [clipFile],
        items: [],
        getData: (type: string) => (type === 'text/plain' ? 'cellA\tcellB' : '')
      }
    })
    expect(ingestImage).toHaveBeenCalledTimes(1)

    // 3. Multi-file drop preserves exact order (filePath + fileBytes fallback)
    const firstFile = new File([new Uint8Array([4, 5])], 'first (1).png', { type: 'image/png' })
    const secondFile = new File([new Uint8Array([6, 7])], 'second.webp', { type: 'image/webp' })
    fireEvent.drop(editorEl, {
      dataTransfer: {
        types: ['Files'],
        files: [firstFile, secondFile],
        getData: () => ''
      }
    })

    await waitFor(() => {
      expect(ingestImage).toHaveBeenCalledTimes(3)
    })
    await waitFor(() => {
      expect(screen.getByRole('img', { name: 'first (1)' })).toBeInTheDocument()
      expect(screen.getByRole('img', { name: 'second' })).toBeInTheDocument()
    })
    const latestMarkdown = onChangeContent.mock.calls.at(-1)?.[0] as string
    expect(latestMarkdown).not.toContain('wiki-asset:')
    expect(latestMarkdown.indexOf('./assets/first%20%281%29.png')).toBeLessThan(
      latestMarkdown.indexOf('./assets/second.webp')
    )

    // 4. Tab drag is ignored (defaultPrevented stays false) while unsupported file drop blocks navigation without ingesting
    const tabDragEvent = new Event('dragover', { bubbles: true, cancelable: true }) as unknown as DragEvent
    Object.defineProperty(tabDragEvent, 'dataTransfer', {
      value: { types: ['application/x-wiki-tab'], files: [], getData: () => 'tab-1' }
    })
    editorEl.dispatchEvent(tabDragEvent)
    expect(tabDragEvent.defaultPrevented).toBe(false)

    const txtFile = new File([new Uint8Array([9])], 'notes.txt', { type: 'text/plain' })
    const nonImageDrop = new Event('drop', { bubbles: true, cancelable: true }) as unknown as DragEvent
    Object.defineProperty(nonImageDrop, 'dataTransfer', {
      value: { types: ['Files'], files: [txtFile], getData: () => '' }
    })
    editorEl.dispatchEvent(nonImageDrop)
    expect(nonImageDrop.defaultPrevented).toBe(true)
    expect(ingestImage).toHaveBeenCalledTimes(3)

    // 5. Ingestion error surfaces via onReportError
    ingestImage.mockRejectedValueOnce(new Error('disk full'))
    fireEvent.paste(editorEl, {
      clipboardData: {
        types: ['Files'],
        files: [clipFile],
        items: [],
        getData: () => ''
      }
    })
    await waitFor(() => {
      expect(onReportError).toHaveBeenCalledWith('이미지 삽입에 실패했습니다.', expect.any(Error))
    })
  })
})
