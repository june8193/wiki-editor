import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { EditorView } from '@codemirror/view'
import { describe, expect, it, vi } from 'vitest'
import type { DocumentBuffer } from '@shared/documentBuffer'
import { DEFAULT_SEARCH_MATCH_OPTIONS, type DocumentSearchJumpRequest } from '@shared/search'
import { createMermaidRenderer, type MermaidDriver } from '../editor/mermaidRenderer'
import {
  collectPreviewSourceBlocks,
  computePreviewScrollTopFromRaw,
  createCodeMirrorRawScrollGeometry
} from '../editor/splitScrollSync'
import type { DocumentTabItem, EditorMode } from '../stores/PaneTabStore'
import { DocumentEditor } from './DocumentEditor'

function createDoc(overrides: Partial<DocumentBuffer> = {}): DocumentBuffer {
  return {
    key: 'c:/wiki/doc.md',
    kind: 'workspace',
    path: 'C:/wiki/doc.md',
    name: 'doc.md',
    content: 'Alpha beta alpha\nSecond line gamma\nThird line alpha',
    savedContent: 'Alpha beta alpha\nSecond line gamma\nThird line alpha',
    isDirty: false,
    version: 1,
    isSaving: false,
    contentKind: 'text',
    ...overrides
  }
}

function createTab(mode: EditorMode = 'raw', splitPreviewRatio = 0.5): DocumentTabItem {
  return {
    id: 'tab-1',
    kind: 'document',
    bufferKey: 'c:/wiki/doc.md',
    mode,
    cursor: { selectionStart: 0, selectionEnd: 0 },
    scrollTop: 0,
    splitPreviewRatio
  }
}

function createJumpRequest(
  overrides: Partial<DocumentSearchJumpRequest> = {}
): DocumentSearchJumpRequest {
  return {
    paneId: 'primary',
    tabId: 'tab-1',
    query: 'alpha',
    options: { ...DEFAULT_SEARCH_MATCH_OPTIONS },
    lineNumber: 1,
    columnStart: 0,
    columnEnd: 5,
    nonce: 1,
    ...overrides
  }
}

function createLineTokenJumpRequest(
  mdLines: readonly string[],
  lineNumber: number,
  token: string,
  nonce: number,
  occurrence = 0
): DocumentSearchJumpRequest {
  const lineText = mdLines[lineNumber - 1]
  let from = 0
  for (let i = 0; i <= occurrence; i++) {
    const idx = lineText.indexOf(token, from)
    if (idx === -1) throw new Error(`Missing ${token} on line ${lineNumber}`)
    if (i === occurrence) {
      return createJumpRequest({
        query: token,
        lineNumber,
        columnStart: idx,
        columnEnd: idx + token.length,
        nonce
      })
    }
    from = idx + token.length
  }
  throw new Error(`Missing ${token} occurrence ${occurrence} on line ${lineNumber}`)
}

function createStubMermaidRenderer() {
  const driver: MermaidDriver = {
    initialize: vi.fn(),
    render: vi.fn(async () => ({
      svg: '<svg data-testid="rendered-mermaid-svg"><text>MermaidDiagram</text></svg>'
    }))
  }
  return createMermaidRenderer(driver)
}

describe('DocumentEditor Workspace Search Jump (<DocumentEditor />)', () => {
  it('moves cursor/selection, applies temporary jump highlight distinct from Find Bar, scrolls in Raw mode, handles CRLF/zero-length spans, and clears on edit, mode switch, tab switch, or new jump', async () => {
    const user = userEvent.setup()
    const lines = Array.from({ length: 60 }, (_, idx) =>
      idx === 0
        ? 'Header line'
        : idx === 49
          ? 'Line 50 alpha one and alpha two'
          : `Line ${idx + 1} filler`
    )
    const initialContent = lines.join('\r\n')
    let doc = createDoc({ content: initialContent, savedContent: initialContent })
    let tab = createTab('raw')
    let currentJump: DocumentSearchJumpRequest | null = null

    const renderRaw = () => (
      <DocumentEditor
        document={doc}
        tab={tab}
        theme="light"
        autoSave={false}
        searchJumpRequest={currentJump}
        onChangeContent={(nextContent) => {
          doc = { ...doc, content: nextContent, isDirty: true }
          currentJump = null
          rerender(renderRaw())
        }}
        onSave={vi.fn()}
        onUpdateViewState={(patch) => {
          if (patch.mode && patch.mode !== tab.mode) {
            currentJump = null
          }
          tab = { ...tab, ...patch }
          rerender(renderRaw())
        }}
      />
    )

    const { container, rerender } = render(renderRaw())
    const editorEl = screen.getByTestId('document-editor')
    const rawScroller = container.querySelector('.cm-scroller') as HTMLElement
    const cmView = EditorView.findFromDOM(rawScroller)!
    Object.defineProperty(rawScroller, 'clientHeight', { configurable: true, value: 140 })
    Object.defineProperty(rawScroller, 'scrollHeight', {
      configurable: true,
      get: () => cmView.contentHeight
    })

    // 1. Jump to 2nd 'alpha' on line 50 without opening Find Bar
    const line50Text = 'Line 50 alpha one and alpha two'
    const secondColStart = line50Text.lastIndexOf('alpha')
    const secondColEnd = secondColStart + 'alpha'.length
    currentJump = createJumpRequest({
      query: 'alpha',
      lineNumber: 50,
      columnStart: secondColStart,
      columnEnd: secondColEnd,
      nonce: 1
    })
    rerender(renderRaw())

    expect(screen.queryByRole('region', { name: '문서 내 찾기 바' })).not.toBeInTheDocument()
    const expectedLine50Offset = cmView.state.doc.line(50).from
    expect(Number(editorEl.getAttribute('data-selection-start'))).toBe(
      expectedLine50Offset + secondColStart
    )
    expect(Number(editorEl.getAttribute('data-selection-end'))).toBe(
      expectedLine50Offset + secondColEnd
    )
    expect(container.querySelectorAll('.cm-search-jump-highlight')).toHaveLength(1)
    expect(container.querySelector('.cm-search-jump-highlight')?.textContent).toBe('alpha')
    expect(container.querySelectorAll('.cm-search-match')).toHaveLength(0)

    const line50Block = cmView.lineBlockAt(expectedLine50Offset + secondColStart)
    const maxScroll = Math.max(0, cmView.contentHeight - 140)
    const expectedTop = Math.max(
      0,
      Math.min(maxScroll, cmView.documentPadding.top + line50Block.top + line50Block.height / 2 - 70)
    )
    expect(rawScroller.scrollTop).toBeCloseTo(expectedTop, 1)

    // 2. Existing open Find Bar stays open with its own query while jump highlight stays distinct
    await user.click(screen.getByRole('button', { name: '문서 내 찾기' }))
    const findBar = screen.getByRole('region', { name: '문서 내 찾기 바' })
    await user.type(within(findBar).getByRole('textbox', { name: '문서 내 검색어 입력' }), 'Header')
    expect(within(findBar).getByText('1 / 1')).toBeInTheDocument()
    expect(container.querySelectorAll('.cm-search-match')).toHaveLength(1)

    // New jump request replaces previous jump highlight without overwriting Find Bar query
    const firstColStart = line50Text.indexOf('alpha')
    currentJump = createJumpRequest({
      query: 'alpha',
      lineNumber: 50,
      columnStart: firstColStart,
      columnEnd: firstColStart + 'alpha'.length,
      nonce: 2
    })
    rerender(renderRaw())
    expect(Number(editorEl.getAttribute('data-selection-start'))).toBe(
      expectedLine50Offset + firstColStart
    )
    expect(container.querySelectorAll('.cm-search-jump-highlight')).toHaveLength(1)
    expect(within(findBar).getByText('1 / 1')).toBeInTheDocument()

    // 3. Next user edit clears temporary jump highlight while preserving Find Bar
    act(() => {
      cmView.dispatch({ changes: { from: 0, to: 0, insert: 'Edited ' } })
    })
    expect(container.querySelectorAll('.cm-search-jump-highlight')).toHaveLength(0)
    expect(container.querySelectorAll('.cm-search-match')).toHaveLength(1)

    // 4. Zero-length regex jump ('^') moves cursor cleanly without crashing
    currentJump = createJumpRequest({
      query: '^',
      options: { ...DEFAULT_SEARCH_MATCH_OPTIONS, useRegex: true },
      lineNumber: 1,
      columnStart: 0,
      columnEnd: 0,
      nonce: 3
    })
    rerender(renderRaw())
    expect(Number(editorEl.getAttribute('data-selection-start'))).toBe(0)
    expect(Number(editorEl.getAttribute('data-selection-end'))).toBe(0)

    // 5. Mode switch clears temporary jump highlight (even if switched back)
    currentJump = createJumpRequest({
      query: 'filler',
      lineNumber: 2,
      columnStart: 7,
      columnEnd: 13,
      nonce: 4
    })
    rerender(renderRaw())
    expect(container.querySelectorAll('.cm-search-jump-highlight')).toHaveLength(1)

    await user.click(
      within(screen.getByRole('group', { name: '에디터 모드 전환' })).getByRole('button', {
        name: 'Preview'
      })
    )
    expect(container.querySelectorAll('.preview-search-jump-highlight')).toHaveLength(0)

    await user.click(
      within(screen.getByRole('group', { name: '에디터 모드 전환' })).getByRole('button', {
        name: 'Raw'
      })
    )
    expect(container.querySelectorAll('.cm-search-jump-highlight')).toHaveLength(0)

    // 6. Tab switch clears temporary jump highlight
    currentJump = createJumpRequest({
      query: 'filler',
      lineNumber: 2,
      columnStart: 7,
      columnEnd: 13,
      nonce: 5
    })
    rerender(renderRaw())
    expect(container.querySelectorAll('.cm-search-jump-highlight')).toHaveLength(1)

    tab = { ...createTab('raw'), id: 'tab-2' }
    rerender(renderRaw())
    expect(container.querySelectorAll('.cm-search-jump-highlight')).toHaveLength(0)
  })

  it('jumps to exact Raw column, highlights both sides, and line-syncs right Preview in Split mode', async () => {
    const listLines = Array.from({ length: 110 }, (_, i) =>
      i === 85 ? `- SplitJumpTarget item ${i + 1}` : `- Plain item ${i + 1}`
    )
    const mdLines = [
      '# Split Heading',
      '',
      '```ts',
      'const first = 1',
      'const second = 2',
      'const third = 3',
      'const fourth = 4',
      'const fifth = 5',
      'const sixth = 6',
      '```',
      '',
      ...listLines
    ]
    const fullContent = mdLines.join('\n')
    const doc = createDoc({ content: fullContent, savedContent: fullContent })
    let tab = createTab('split', 0.5)
    let currentJump: DocumentSearchJumpRequest | null = null

    const renderSplit = () => (
      <DocumentEditor
        document={doc}
        tab={tab}
        theme="light"
        autoSave={false}
        searchJumpRequest={currentJump}
        onChangeContent={vi.fn()}
        onSave={vi.fn()}
        onUpdateViewState={(patch) => {
          tab = { ...tab, ...patch }
        }}
      />
    )

    const { container, rerender } = render(renderSplit())
    const rawRegion = container.querySelector('.editor-split-region.is-raw') as HTMLElement
    const rawEditorEl = within(rawRegion).getByTestId('document-editor')
    const rawScroller = container.querySelector('.cm-scroller') as HTMLElement
    const previewRegion = screen.getByTestId('split-markdown-preview') as HTMLElement
    const cmView = EditorView.findFromDOM(rawScroller)!

    Object.defineProperty(rawScroller, 'clientHeight', { configurable: true, value: 240 })
    Object.defineProperty(rawScroller, 'scrollHeight', {
      configurable: true,
      get: () => cmView.contentHeight
    })
    Object.defineProperty(previewRegion, 'clientHeight', { configurable: true, value: 240 })
    Object.defineProperty(previewRegion, 'scrollHeight', { configurable: true, value: 1400 })
    previewRegion.getBoundingClientRect = () =>
      ({ top: 0, left: 0, right: 500, bottom: 240, width: 500, height: 240, x: 0, y: 0, toJSON: () => ({}) })

    const mockBlockRect = (el: HTMLElement, docTop: number, height: number): void => {
      el.getBoundingClientRect = () => {
        const y = docTop - previewRegion.scrollTop
        return { top: y, left: 0, right: 500, bottom: y + height, width: 500, height, x: 0, y, toJSON: () => ({}) }
      }
    }
    mockBlockRect(previewRegion.querySelector('h1[data-source-line="1"]') as HTMLElement, 0, 40)
    mockBlockRect(previewRegion.querySelector('[data-source-line="3"]') as HTMLElement, 60, 400)
    mockBlockRect(previewRegion.querySelector('ul[data-source-line="12"]') as HTMLElement, 480, 920)

    const targetLineNumber = 12 + 85 // line 97
    const targetLineText = mdLines[targetLineNumber - 1]
    const colStart = targetLineText.indexOf('SplitJumpTarget')
    const colEnd = colStart + 'SplitJumpTarget'.length

    currentJump = createJumpRequest({
      query: 'SplitJumpTarget',
      lineNumber: targetLineNumber,
      columnStart: colStart,
      columnEnd: colEnd,
      nonce: 1
    })
    rerender(renderSplit())

    expect(screen.queryByRole('region', { name: '문서 내 찾기 바' })).not.toBeInTheDocument()
    const line97Start = cmView.state.doc.line(targetLineNumber).from
    expect(Number(rawEditorEl.getAttribute('data-selection-start'))).toBe(line97Start + colStart)
    expect(Number(rawEditorEl.getAttribute('data-selection-end'))).toBe(line97Start + colEnd)
    expect(rawRegion.querySelectorAll('.cm-search-jump-highlight')).toHaveLength(1)
    expect(rawRegion.querySelector('.cm-search-jump-highlight')?.textContent).toBe('SplitJumpTarget')
    expect(previewRegion.querySelectorAll('.preview-search-jump-highlight')).toHaveLength(1)
    expect(previewRegion.querySelector('.preview-search-jump-highlight')?.textContent).toBe(
      'SplitJumpTarget'
    )

    expect(rawScroller.scrollTop).toBeGreaterThan(100)
    const expectedPreviewTop = computePreviewScrollTopFromRaw(
      createCodeMirrorRawScrollGeometry(cmView),
      {
        scrollTop: previewRegion.scrollTop,
        clientHeight: previewRegion.clientHeight,
        scrollHeight: previewRegion.scrollHeight,
        blocks: collectPreviewSourceBlocks(previewRegion),
        totalLines: cmView.state.doc.lines
      }
    )
    expect(expectedPreviewTop).not.toBeNull()
    expect(previewRegion.scrollTop).toBeCloseTo(expectedPreviewTop!, 2)
    expect(previewRegion.scrollTop).toBeGreaterThan(200)
  })

  it('highlights rendered Preview matches accurately across markdown constructs, coexists with Find Bar, and clears on mode/tab/new jump', async () => {
    const scrollIntoViewSpy = vi.fn()
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView
    HTMLElement.prototype.scrollIntoView = scrollIntoViewSpy

    try {
      const mdLines = [
        '## Title Heading targetWord', // line 1
        '',
        'Paragraph with **boldMark** and `codeToken` and targetWord once and targetWord twice.', // line 3
        '',
        'Visit [Docs Label](https://example.com/secret-url-token) for info.', // line 5
        '',
        '- Bullet first item', // line 7
        '- Bullet item with listToken inside', // line 8
        '',
        '| ColA | ColB |', // line 10
        '|---|---|', // line 11
        '| cellOne | cellTarget |', // line 12
        '',
        '```ts', // line 14
        'const insideCode = "codeLineTarget"', // line 15
        '```' // line 16
      ]
      const content = mdLines.join('\n')
      const doc = createDoc({ content, savedContent: content })
      let tab = createTab('preview')
      let currentJump: DocumentSearchJumpRequest | null = null

      const renderPreview = () => (
        <DocumentEditor
          document={doc}
          tab={tab}
          theme="light"
          autoSave={false}
          searchJumpRequest={currentJump}
          onChangeContent={vi.fn()}
          onSave={vi.fn()}
          onUpdateViewState={(patch) => {
            if (patch.mode && patch.mode !== tab.mode) {
              currentJump = null
            }
            tab = { ...tab, ...patch }
            rerender(renderPreview())
          }}
        />
      )

      const { container, rerender } = render(renderPreview())
      const preview = screen.getByLabelText('마크다운 미리보기')

      const jumpToToken = (lineNumber: number, token: string, occurrence = 0, nonce = 1) => {
        currentJump = createLineTokenJumpRequest(mdLines, lineNumber, token, nonce, occurrence)
        scrollIntoViewSpy.mockClear()
        rerender(renderPreview())
      }

      // 1. Heading rendered text match
      jumpToToken(1, 'targetWord', 0, 1)
      let marks = Array.from(preview.querySelectorAll('.preview-search-jump-highlight'))
      expect(marks).toHaveLength(1)
      expect(marks[0].textContent).toBe('targetWord')
      expect(marks[0].closest('h2[data-source-line="1"]')).not.toBeNull()
      expect(scrollIntoViewSpy).toHaveBeenCalled()
      expect(scrollIntoViewSpy.mock.instances[0]).toBe(marks[0])

      // 2. Second occurrence on line 3 (distinguished from heading & first occurrence)
      jumpToToken(3, 'targetWord', 1, 2)
      marks = Array.from(preview.querySelectorAll('.preview-search-jump-highlight'))
      expect(marks).toHaveLength(1)
      expect(marks[0].closest('p[data-source-line="3"]')).not.toBeNull()
      const pText = marks[0].closest('p')?.textContent ?? ''
      const beforeSecond = pText.indexOf('targetWord', pText.indexOf('targetWord') + 1)
      expect(beforeSecond).toBeGreaterThan(-1)
      expect(marks[0].previousSibling?.textContent?.endsWith('targetWord once and ')).toBe(true)

      // 3. Bold, inlineCode, list, table, code block
      jumpToToken(3, 'boldMark', 0, 3)
      marks = Array.from(preview.querySelectorAll('.preview-search-jump-highlight'))
      expect(marks).toHaveLength(1)
      expect(marks[0].closest('strong')).not.toBeNull()

      jumpToToken(3, 'codeToken', 0, 4)
      marks = Array.from(preview.querySelectorAll('.preview-search-jump-highlight'))
      expect(marks).toHaveLength(1)
      expect(marks[0].closest('code')).not.toBeNull()

      jumpToToken(8, 'listToken', 0, 5)
      marks = Array.from(preview.querySelectorAll('.preview-search-jump-highlight'))
      expect(marks).toHaveLength(1)
      expect(marks[0].closest('li')).not.toBeNull()

      jumpToToken(12, 'cellTarget', 0, 6)
      marks = Array.from(preview.querySelectorAll('.preview-search-jump-highlight'))
      expect(marks).toHaveLength(1)
      expect(marks[0].closest('td')).not.toBeNull()

      jumpToToken(15, 'codeLineTarget', 0, 7)
      marks = Array.from(preview.querySelectorAll('.preview-search-jump-highlight'))
      expect(marks).toHaveLength(1)
      expect(marks[0].closest('[data-source-line="14"]')).not.toBeNull()

      // 4. Coexists with Find Bar highlights
      fireEvent.click(screen.getByRole('button', { name: '문서 내 찾기' }))
      const findBar = await screen.findByRole('region', { name: '문서 내 찾기 바' })
      const findInput = within(findBar).getByRole('textbox', { name: '문서 내 검색어 입력' })
      fireEvent.change(findInput, { target: { value: 'targetWord' } })
      await waitFor(() => {
        expect(preview.querySelectorAll('.preview-search-match').length).toBeGreaterThanOrEqual(3)
      })
      jumpToToken(3, 'boldMark', 0, 8)
      expect(preview.querySelectorAll('.preview-search-match').length).toBeGreaterThanOrEqual(3)
      expect(preview.querySelectorAll('.preview-search-jump-highlight')).toHaveLength(1)
      expect(preview.querySelector('.preview-search-jump-highlight')?.textContent).toBe('boldMark')
      fireEvent.click(screen.getByRole('button', { name: '문서 내 찾기' }))

      // 5. Mode switch clears Preview jump highlight
      jumpToToken(1, 'targetWord', 0, 9)
      expect(preview.querySelectorAll('.preview-search-jump-highlight')).toHaveLength(1)
      fireEvent.click(
        within(screen.getByRole('group', { name: '에디터 모드 전환' })).getByRole('button', {
          name: 'Raw'
        })
      )
      expect(container.querySelectorAll('.cm-search-jump-highlight')).toHaveLength(0)
      fireEvent.click(
        within(screen.getByRole('group', { name: '에디터 모드 전환' })).getByRole('button', {
          name: 'Preview'
        })
      )
      expect(
        screen.getByLabelText('마크다운 미리보기').querySelectorAll('.preview-search-jump-highlight')
      ).toHaveLength(0)

      // 6. Tab switch clears Preview jump highlight
      jumpToToken(1, 'targetWord', 0, 10)
      expect(
        screen.getByLabelText('마크다운 미리보기').querySelectorAll('.preview-search-jump-highlight')
      ).toHaveLength(1)
      tab = { ...createTab('preview'), id: 'tab-2' }
      rerender(renderPreview())
      expect(
        screen.getByLabelText('마크다운 미리보기').querySelectorAll('.preview-search-jump-highlight')
      ).toHaveLength(0)
    } finally {
      HTMLElement.prototype.scrollIntoView = originalScrollIntoView
    }
  })

  it('safely falls back to closest Preview block scroll for non-rendered syntax, Mermaid, comments, and definitions', () => {
    const scrollIntoViewSpy = vi.fn()
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView
    HTMLElement.prototype.scrollIntoView = scrollIntoViewSpy

    try {
      const mdLines = [
        '## Title Heading targetWord', // line 1
        '',
        'Paragraph with **boldMark** inside.', // line 3
        '',
        'Visit [Docs Label](https://example.com/secret-url-token) for info.', // line 5
        '',
        '| ColA | ColB |', // line 7
        '|---|---|', // line 8
        '| cellOne | cellTarget |', // line 9
        '',
        '```ts', // line 11
        'const insideCode = "codeLineTarget"', // line 12
        '```', // line 13
        '',
        '```mermaid', // line 15
        'graph TD', // line 16
        'A[AlphaNode] --> B[BetaNode]', // line 17
        '```', // line 18
        '',
        '<!-- hiddenCommentToken -->', // line 20
        '[hiddenRef]: https://ref-only.example/path', // line 21
        '',
        'Trailing rendered paragraph' // line 23
      ]
      const content = mdLines.join('\n')
      const doc = createDoc({ content, savedContent: content })
      const tab = createTab('preview')
      const mermaidRenderer = createStubMermaidRenderer()
      let currentJump: DocumentSearchJumpRequest | null = null

      const renderPreview = () => (
        <DocumentEditor
          document={doc}
          tab={tab}
          theme="light"
          autoSave={false}
          mermaidRenderer={mermaidRenderer}
          searchJumpRequest={currentJump}
          onChangeContent={vi.fn()}
          onSave={vi.fn()}
          onUpdateViewState={vi.fn()}
        />
      )

      const { rerender } = render(renderPreview())
      const preview = screen.getByLabelText('마크다운 미리보기')

      const jumpToToken = (lineNumber: number, token: string, nonce: number) => {
        currentJump = createLineTokenJumpRequest(mdLines, lineNumber, token, nonce)
        scrollIntoViewSpy.mockClear()
        rerender(renderPreview())
      }

      jumpToToken(1, '##', 1)
      expect(preview.querySelectorAll('.preview-search-jump-highlight')).toHaveLength(0)
      expect(scrollIntoViewSpy.mock.instances[0]).toBe(preview.querySelector('h2[data-source-line="1"]'))

      jumpToToken(3, '**', 2)
      expect(preview.querySelectorAll('.preview-search-jump-highlight')).toHaveLength(0)
      expect(scrollIntoViewSpy.mock.instances[0]).toBe(preview.querySelector('p[data-source-line="3"]'))

      jumpToToken(5, 'secret-url-token', 3)
      expect(preview.querySelectorAll('.preview-search-jump-highlight')).toHaveLength(0)
      expect(scrollIntoViewSpy.mock.instances[0]).toBe(preview.querySelector('p[data-source-line="5"]'))

      jumpToToken(8, '|---|', 4)
      expect(preview.querySelectorAll('.preview-search-jump-highlight')).toHaveLength(0)
      expect(scrollIntoViewSpy.mock.instances[0]).toBe(
        preview.querySelector('[data-source-line="7"]')
      )

      jumpToToken(11, '```ts', 5)
      expect(preview.querySelectorAll('.preview-search-jump-highlight')).toHaveLength(0)
      expect(scrollIntoViewSpy.mock.instances[0]).toBe(
        preview.querySelector('[data-source-line="11"]')
      )

      jumpToToken(16, 'graph', 6)
      expect(preview.querySelectorAll('.preview-search-jump-highlight')).toHaveLength(0)
      expect(scrollIntoViewSpy.mock.instances[0]).toBe(
        preview.querySelector('[data-source-line="15"]')
      )

      jumpToToken(20, 'hiddenCommentToken', 7)
      expect(preview.querySelectorAll('.preview-search-jump-highlight')).toHaveLength(0)
      expect(scrollIntoViewSpy).toHaveBeenCalled()

      jumpToToken(21, 'ref-only.example', 8)
      expect(preview.querySelectorAll('.preview-search-jump-highlight')).toHaveLength(0)
      expect(scrollIntoViewSpy.mock.instances[0]).toBe(
        preview.querySelector('p[data-source-line="23"]')
      )
    } finally {
      HTMLElement.prototype.scrollIntoView = originalScrollIntoView
    }
  })

  it('highlights rendered 위지윅 matches accurately across markdown constructs without mutating content', () => {
    const scrollIntoViewSpy = vi.fn()
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView
    HTMLElement.prototype.scrollIntoView = scrollIntoViewSpy

    try {
      const mdLines = [
        '## Wysiwyg Heading targetWord', // line 1
        '',
        'Paragraph with **boldMark** and `codeToken` and targetWord once and targetWord twice.', // line 3
        '',
        '- Bullet first item', // line 5
        '- Bullet item with listToken inside', // line 6
        '',
        '- [x] Task item with taskToken inside', // line 8
        '',
        '| ColA | ColB |', // line 10
        '|---|---|', // line 11
        '| cellOne | cellTarget |', // line 12
        '',
        '```ts', // line 14
        'const insideCode = "codeLineTarget"', // line 15
        '```' // line 16
      ]
      const content = mdLines.join('\n')
      const doc = createDoc({ content, savedContent: content })
      const tab = createTab('wysiwyg')
      let currentJump: DocumentSearchJumpRequest | null = null
      const onChangeSpy = vi.fn()

      const renderWysiwyg = () => (
        <DocumentEditor
          document={doc}
          tab={tab}
          theme="light"
          autoSave={false}
          searchJumpRequest={currentJump}
          onChangeContent={onChangeSpy}
          onSave={vi.fn()}
          onUpdateViewState={vi.fn()}
        />
      )

      const { rerender } = render(renderWysiwyg())
      const wysiwygSurface = screen.getByLabelText('위지윅 문서 에디터')

      const jumpToToken = (lineNumber: number, token: string, occurrence = 0, nonce = 1) => {
        currentJump = createLineTokenJumpRequest(mdLines, lineNumber, token, nonce, occurrence)
        scrollIntoViewSpy.mockClear()
        rerender(renderWysiwyg())
      }

      jumpToToken(1, 'targetWord', 0, 1)
      let marks = Array.from(wysiwygSurface.querySelectorAll('.pm-search-jump-highlight'))
      expect(marks).toHaveLength(1)
      expect(marks[0].textContent).toBe('targetWord')
      expect(marks[0].closest('h2')).not.toBeNull()
      expect(scrollIntoViewSpy).toHaveBeenCalled()

      jumpToToken(3, 'targetWord', 1, 2)
      marks = Array.from(wysiwygSurface.querySelectorAll('.pm-search-jump-highlight'))
      expect(marks).toHaveLength(1)
      expect(marks[0].closest('p')).not.toBeNull()
      expect(marks[0].previousSibling?.textContent?.endsWith('targetWord once and ')).toBe(true)

      jumpToToken(3, 'boldMark', 0, 3)
      marks = Array.from(wysiwygSurface.querySelectorAll('.pm-search-jump-highlight'))
      expect(marks).toHaveLength(1)
      expect(marks[0].closest('strong')).not.toBeNull()

      jumpToToken(3, 'codeToken', 0, 4)
      marks = Array.from(wysiwygSurface.querySelectorAll('.pm-search-jump-highlight'))
      expect(marks).toHaveLength(1)
      expect(marks[0].closest('code')).not.toBeNull()

      jumpToToken(6, 'listToken', 0, 5)
      marks = Array.from(wysiwygSurface.querySelectorAll('.pm-search-jump-highlight'))
      expect(marks).toHaveLength(1)
      expect(marks[0].closest('li')).not.toBeNull()

      jumpToToken(8, 'taskToken', 0, 6)
      marks = Array.from(wysiwygSurface.querySelectorAll('.pm-search-jump-highlight'))
      expect(marks).toHaveLength(1)
      expect(marks[0].closest('li')).not.toBeNull()

      jumpToToken(12, 'cellTarget', 0, 7)
      marks = Array.from(wysiwygSurface.querySelectorAll('.pm-search-jump-highlight'))
      expect(marks).toHaveLength(1)
      expect(marks[0].closest('td')).not.toBeNull()

      jumpToToken(15, 'codeLineTarget', 0, 8)
      marks = Array.from(wysiwygSurface.querySelectorAll('.pm-search-jump-highlight'))
      expect(marks).toHaveLength(1)
      expect(marks[0].closest('.node-codeBlock, pre')).not.toBeNull()
      expect(onChangeSpy).not.toHaveBeenCalled()
    } finally {
      HTMLElement.prototype.scrollIntoView = originalScrollIntoView
    }
  })

  it('coexists with Find Bar in 위지윅 mode and clears jump highlight on mode switch or tab switch', async () => {
    const scrollIntoViewSpy = vi.fn()
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView
    HTMLElement.prototype.scrollIntoView = scrollIntoViewSpy

    try {
      const content = '## Heading targetWord\n\nParagraph with **boldMark** and targetWord inside.'
      const doc = createDoc({ content, savedContent: content })
      let tab = createTab('wysiwyg')
      let currentJump: DocumentSearchJumpRequest | null = null

      const renderWysiwyg = () => (
        <DocumentEditor
          document={doc}
          tab={tab}
          theme="light"
          autoSave={false}
          searchJumpRequest={currentJump}
          onChangeContent={vi.fn()}
          onSave={vi.fn()}
          onUpdateViewState={(patch) => {
            if (patch.mode && patch.mode !== tab.mode) {
              currentJump = null
            }
            tab = { ...tab, ...patch }
            rerender(renderWysiwyg())
          }}
        />
      )

      const { container, rerender } = render(renderWysiwyg())
      const wysiwygSurface = screen.getByLabelText('위지윅 문서 에디터')

      fireEvent.click(screen.getByRole('button', { name: '문서 내 찾기' }))
      const findBar = await screen.findByRole('region', { name: '문서 내 찾기 바' })
      const findInput = within(findBar).getByRole('textbox', { name: '문서 내 검색어 입력' })
      fireEvent.change(findInput, { target: { value: 'targetWord' } })
      await waitFor(() => {
        expect(wysiwygSurface.querySelectorAll('.pm-search-match').length).toBeGreaterThanOrEqual(
          2
        )
      })

      const boldIdx = 'Paragraph with **boldMark** and targetWord inside.'.indexOf('boldMark')
      currentJump = createJumpRequest({
        query: 'boldMark',
        lineNumber: 3,
        columnStart: boldIdx,
        columnEnd: boldIdx + 'boldMark'.length,
        nonce: 1
      })
      rerender(renderWysiwyg())
      expect(wysiwygSurface.querySelectorAll('.pm-search-match').length).toBeGreaterThanOrEqual(2)
      expect(wysiwygSurface.querySelectorAll('.pm-search-jump-highlight')).toHaveLength(1)
      expect(wysiwygSurface.querySelector('.pm-search-jump-highlight')?.textContent).toBe('boldMark')
      fireEvent.click(screen.getByRole('button', { name: '문서 내 찾기' }))

      // Mode switch clears 위지윅 jump highlight
      fireEvent.click(
        within(screen.getByRole('group', { name: '에디터 모드 전환' })).getByRole('button', {
          name: 'Raw'
        })
      )
      expect(container.querySelectorAll('.cm-search-jump-highlight')).toHaveLength(0)
      fireEvent.click(
        within(screen.getByRole('group', { name: '에디터 모드 전환' })).getByRole('button', {
          name: '위지윅'
        })
      )
      expect(
        screen.getByLabelText('위지윅 문서 에디터').querySelectorAll('.pm-search-jump-highlight')
      ).toHaveLength(0)

      // Tab switch clears 위지윅 jump highlight
      currentJump = createJumpRequest({
        query: 'boldMark',
        lineNumber: 3,
        columnStart: boldIdx,
        columnEnd: boldIdx + 'boldMark'.length,
        nonce: 2
      })
      rerender(renderWysiwyg())
      expect(
        screen.getByLabelText('위지윅 문서 에디터').querySelectorAll('.pm-search-jump-highlight')
      ).toHaveLength(1)
      tab = { ...createTab('wysiwyg'), id: 'tab-2' }
      rerender(renderWysiwyg())
      expect(
        screen.getByLabelText('위지윅 문서 에디터').querySelectorAll('.pm-search-jump-highlight')
      ).toHaveLength(0)
    } finally {
      HTMLElement.prototype.scrollIntoView = originalScrollIntoView
    }
  })

  it('safely falls back to closest rendered 위지윅 block scroll for non-rendered markdown syntax, Mermaid, comments, and definitions', () => {
    const scrollIntoViewSpy = vi.fn()
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView
    HTMLElement.prototype.scrollIntoView = scrollIntoViewSpy

    try {
      const mdLines = [
        '## Wysiwyg Heading targetWord', // line 1
        '',
        'Paragraph with **boldMark** inside.', // line 3
        '',
        'Visit [Docs Label](https://example.com/secret-url-token) for info.', // line 5
        '',
        '| ColA | ColB |', // line 7
        '|---|---|', // line 8
        '| cellOne | cellTarget |', // line 9
        '',
        '```ts', // line 11
        'const insideCode = "codeLineTarget"', // line 12
        '```', // line 13
        '',
        '```mermaid', // line 15
        'graph TD', // line 16
        'A[AlphaNode] --> B[BetaNode]', // line 17
        '```', // line 18
        '',
        '<!-- hiddenCommentToken -->', // line 20
        '[hiddenRef]: https://ref-only.example/path', // line 21
        '',
        'Trailing rendered paragraph' // line 23
      ]
      const content = mdLines.join('\n')
      const doc = createDoc({ content, savedContent: content })
      const tab = createTab('wysiwyg')
      const mermaidRenderer = createStubMermaidRenderer()
      let currentJump: DocumentSearchJumpRequest | null = null

      const renderWysiwyg = () => (
        <DocumentEditor
          document={doc}
          tab={tab}
          theme="light"
          autoSave={false}
          mermaidRenderer={mermaidRenderer}
          searchJumpRequest={currentJump}
          onChangeContent={vi.fn()}
          onSave={vi.fn()}
          onUpdateViewState={vi.fn()}
        />
      )

      const { rerender } = render(renderWysiwyg())
      const wysiwygSurface = screen.getByLabelText('위지윅 문서 에디터')

      const jumpToToken = (lineNumber: number, token: string, nonce: number) => {
        currentJump = createLineTokenJumpRequest(mdLines, lineNumber, token, nonce)
        scrollIntoViewSpy.mockClear()
        rerender(renderWysiwyg())
      }

      jumpToToken(1, '##', 1)
      expect(wysiwygSurface.querySelectorAll('.pm-search-jump-highlight')).toHaveLength(0)
      expect(
        (scrollIntoViewSpy.mock.instances[0] as Element).closest('h2') ??
          scrollIntoViewSpy.mock.instances[0]
      ).toBe(wysiwygSurface.querySelector('h2'))

      jumpToToken(3, '**', 2)
      expect(wysiwygSurface.querySelectorAll('.pm-search-jump-highlight')).toHaveLength(0)
      expect(scrollIntoViewSpy.mock.instances[0]).toBe(
        Array.from(wysiwygSurface.querySelectorAll('.ProseMirror > p')).find((el) =>
          el.textContent?.includes('boldMark')
        )
      )

      jumpToToken(5, 'secret-url-token', 3)
      expect(wysiwygSurface.querySelectorAll('.pm-search-jump-highlight')).toHaveLength(0)
      expect(scrollIntoViewSpy.mock.instances[0]).toBe(
        Array.from(wysiwygSurface.querySelectorAll('.ProseMirror > p')).find((el) =>
          el.textContent?.includes('Docs Label')
        )
      )

      jumpToToken(8, '|---|', 4)
      expect(wysiwygSurface.querySelectorAll('.pm-search-jump-highlight')).toHaveLength(0)
      const scrolledTableTarget = scrollIntoViewSpy.mock.instances[0] as HTMLElement
      expect(
        scrolledTableTarget.tagName === 'TABLE' ||
          scrolledTableTarget.querySelector('table') !== null ||
          scrolledTableTarget.closest('table') !== null
      ).toBe(true)

      jumpToToken(11, '```ts', 5)
      expect(wysiwygSurface.querySelectorAll('.pm-search-jump-highlight')).toHaveLength(0)
      const scrolledCodeTarget = scrollIntoViewSpy.mock.instances[0] as HTMLElement
      expect(
        scrolledCodeTarget.classList.contains('node-codeBlock') ||
          scrolledCodeTarget.querySelector('.node-codeBlock, pre') !== null ||
          scrolledCodeTarget.tagName === 'PRE'
      ).toBe(true)

      jumpToToken(16, 'graph', 6)
      expect(wysiwygSurface.querySelectorAll('.pm-search-jump-highlight')).toHaveLength(0)
      expect(scrollIntoViewSpy).toHaveBeenCalled()

      jumpToToken(20, 'hiddenCommentToken', 7)
      expect(wysiwygSurface.querySelectorAll('.pm-search-jump-highlight')).toHaveLength(0)
      expect(scrollIntoViewSpy).toHaveBeenCalled()

      jumpToToken(21, 'ref-only.example', 8)
      expect(wysiwygSurface.querySelectorAll('.pm-search-jump-highlight')).toHaveLength(0)
      expect(scrollIntoViewSpy.mock.instances[0]).toBe(
        Array.from(wysiwygSurface.querySelectorAll('.ProseMirror > p')).find((el) =>
          el.textContent?.includes('Trailing rendered paragraph')
        )
      )
    } finally {
      HTMLElement.prototype.scrollIntoView = originalScrollIntoView
    }
  })

  it('highlights line-anchored regex matches inside multi-line paragraphs across Preview and 위지윅 modes', () => {
    const scrollIntoViewSpy = vi.fn()
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView
    HTMLElement.prototype.scrollIntoView = scrollIntoViewSpy

    try {
      const content = 'LineTwoAnchorToken\nLineTwoAnchorToken'
      const doc = createDoc({ content, savedContent: content })
      let currentJump = createJumpRequest({
        query: '^LineTwoAnchorToken',
        options: { ...DEFAULT_SEARCH_MATCH_OPTIONS, useRegex: true },
        lineNumber: 2,
        columnStart: 0,
        columnEnd: 'LineTwoAnchorToken'.length,
        nonce: 1
      })

      const { unmount } = render(
        <DocumentEditor
          document={doc}
          tab={createTab('preview')}
          theme="light"
          autoSave={false}
          searchJumpRequest={currentJump}
          onChangeContent={vi.fn()}
          onSave={vi.fn()}
          onUpdateViewState={vi.fn()}
        />
      )
      const previewMarks = screen
        .getByLabelText('마크다운 미리보기')
        .querySelectorAll('.preview-search-jump-highlight')
      expect(previewMarks).toHaveLength(1)
      expect(previewMarks[0].textContent).toBe('LineTwoAnchorToken')
      expect(previewMarks[0].previousSibling?.textContent).toBe('LineTwoAnchorToken\n')
      unmount()

      currentJump = { ...currentJump, nonce: 2 }
      render(
        <DocumentEditor
          document={doc}
          tab={createTab('wysiwyg')}
          theme="light"
          autoSave={false}
          searchJumpRequest={currentJump}
          onChangeContent={vi.fn()}
          onSave={vi.fn()}
          onUpdateViewState={vi.fn()}
        />
      )
      const wysiwygMarks = screen
        .getByLabelText('위지윅 문서 에디터')
        .querySelectorAll('.pm-search-jump-highlight')
      expect(wysiwygMarks).toHaveLength(1)
      expect(wysiwygMarks[0].textContent).toBe('LineTwoAnchorToken')
      expect(wysiwygMarks[0].previousSibling?.textContent?.startsWith('LineTwoAnchorToken')).toBe(
        true
      )
    } finally {
      HTMLElement.prototype.scrollIntoView = originalScrollIntoView
    }
  })

  it('jumps accurately to body lines across all 4 modes and safely handles frontmatter line jumps, syntax errors, and unclosed blocks', async () => {
    const user = userEvent.setup()
    const scrollIntoViewSpy = vi.fn()
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView
    HTMLElement.prototype.scrollIntoView = scrollIntoViewSpy

    try {
      const mdLines = [
        '---',
        'title: FrontmatterSharedToken note',
        '# yamlHeadingLikeComment JumpOnlyYaml',
        'tags: [alpha, beta]',
        '---',
        '# FrontmatterSharedToken Body Heading',
        '',
        'First paragraph mentions JumpBodyToken clearly.',
        '',
        '```ts',
        'const codeMatch = "JumpCodeToken"',
        '```',
        '- List with JumpListToken item'
      ]
      const md = mdLines.join('\n')
      let doc = createDoc({ content: md, savedContent: md })
      let tab = createTab('raw', 0.5)
      let currentJump: DocumentSearchJumpRequest | null = null

      const renderEditor = () => (
        <DocumentEditor
          document={doc}
          tab={tab}
          theme="light"
          autoSave={false}
          searchJumpRequest={currentJump}
          onChangeContent={vi.fn()}
          onSave={vi.fn()}
          onUpdateViewState={(patch) => {
            tab = { ...tab, ...patch }
            rerender(renderEditor())
          }}
        />
      )

      const { container, rerender } = render(renderEditor())
      const modeGroup = () => screen.getByRole('group', { name: '에디터 모드 전환' })

      // 1. Raw: frontmatter line jump (line 2) -> selects exact YAML column & applies cm jump highlight
      currentJump = createLineTokenJumpRequest(mdLines, 2, 'FrontmatterSharedToken', 1)
      rerender(renderEditor())
      expect(container.querySelector('.cm-search-jump-highlight')?.textContent).toBe(
        'FrontmatterSharedToken'
      )
      const rawEl = screen.getByTestId('document-editor')
      const expectedYamlColStart = md.indexOf('FrontmatterSharedToken')
      expect(Number(rawEl.getAttribute('data-selection-start'))).toBe(expectedYamlColStart)

      // Raw: body line jump (line 8) -> exact body column
      currentJump = createLineTokenJumpRequest(mdLines, 8, 'JumpBodyToken', 2)
      rerender(renderEditor())
      expect(container.querySelector('.cm-search-jump-highlight')?.textContent).toBe('JumpBodyToken')
      expect(Number(rawEl.getAttribute('data-selection-start'))).toBe(md.indexOf('JumpBodyToken'))

      // 2. Split: body jump highlights both Raw & right Preview accurately; YAML jump highlights Raw ONLY (0 in Preview)
      await user.click(within(modeGroup()).getByRole('button', { name: 'Split' }))
      const splitPreview = () => screen.getByTestId('split-markdown-preview')

      currentJump = createLineTokenJumpRequest(mdLines, 11, 'JumpCodeToken', 3)
      scrollIntoViewSpy.mockClear()
      rerender(renderEditor())
      expect(container.querySelector('.cm-search-jump-highlight')?.textContent).toBe('JumpCodeToken')
      expect(splitPreview().querySelector('.preview-search-jump-highlight')?.textContent).toBe(
        'JumpCodeToken'
      )
      expect(splitPreview().querySelector('[data-source-line="10"]')).not.toBeNull()

      // Jump inside frontmatter while in Split -> Raw jumps to line 3, right Preview has 0 jump highlights (and syncs toward top when geometry exists)
      const splitRawScroller = container.querySelector('.cm-scroller') as HTMLElement
      Object.defineProperty(splitRawScroller, 'clientHeight', { configurable: true, value: 200 })
      Object.defineProperty(splitRawScroller, 'scrollHeight', { configurable: true, value: 800 })
      Object.defineProperty(splitPreview(), 'clientHeight', { configurable: true, value: 200 })
      Object.defineProperty(splitPreview(), 'scrollHeight', { configurable: true, value: 800 })
      splitPreview().scrollTop = 240
      currentJump = createLineTokenJumpRequest(mdLines, 3, 'JumpOnlyYaml', 4)
      scrollIntoViewSpy.mockClear()
      rerender(renderEditor())
      expect(container.querySelector('.cm-search-jump-highlight')?.textContent).toBe('JumpOnlyYaml')
      expect(splitPreview().querySelectorAll('.preview-search-jump-highlight')).toHaveLength(0)
      expect(splitPreview().scrollTop).toBeLessThan(240)

      // 3. Preview: body jump (even when token also appears in YAML!) highlights body heading; frontmatter jump resets top cleanly
      await user.click(within(modeGroup()).getByRole('button', { name: 'Preview' }))
      const previewEl = () => screen.getByLabelText('마크다운 미리보기')

      currentJump = createLineTokenJumpRequest(mdLines, 6, 'FrontmatterSharedToken', 5)
      scrollIntoViewSpy.mockClear()
      rerender(renderEditor())
      const previewHeadingMarks = previewEl().querySelectorAll('.preview-search-jump-highlight')
      expect(previewHeadingMarks).toHaveLength(1)
      expect(previewHeadingMarks[0].closest('h1[data-source-line="6"]')).not.toBeNull()
      expect(scrollIntoViewSpy).toHaveBeenCalled()

      currentJump = createLineTokenJumpRequest(mdLines, 13, 'JumpListToken', 6)
      scrollIntoViewSpy.mockClear()
      rerender(renderEditor())
      const previewListMarks = previewEl().querySelectorAll('.preview-search-jump-highlight')
      expect(previewListMarks).toHaveLength(1)
      expect(previewListMarks[0].closest('li')).not.toBeNull()

      // Jump to frontmatter line 2 containing token that ALSO appears in body -> must NOT highlight body, resets scrollTop = 0
      previewEl().scrollTop = 180
      currentJump = createLineTokenJumpRequest(mdLines, 2, 'FrontmatterSharedToken', 7)
      scrollIntoViewSpy.mockClear()
      rerender(renderEditor())
      expect(previewEl().querySelectorAll('.preview-search-jump-highlight')).toHaveLength(0)
      expect(previewEl().scrollTop).toBe(0)

      // 4. 위지윅: body jump highlights body blocks accurately; frontmatter jump resets scrollTop = 0 with 0 highlights
      await user.click(within(modeGroup()).getByRole('button', { name: '위지윅' }))
      const wysiwygSurface = () => screen.getByLabelText('위지윅 문서 에디터')
      const wysiwygScroller = () => container.querySelector('.wysiwyg-scroll-container') as HTMLElement

      currentJump = createLineTokenJumpRequest(mdLines, 6, 'FrontmatterSharedToken', 8)
      scrollIntoViewSpy.mockClear()
      rerender(renderEditor())
      const wysiwygHeadingMarks = wysiwygSurface().querySelectorAll('.pm-search-jump-highlight')
      expect(wysiwygHeadingMarks).toHaveLength(1)
      expect(wysiwygHeadingMarks[0].closest('h1')).not.toBeNull()
      expect(scrollIntoViewSpy).toHaveBeenCalled()

      currentJump = createLineTokenJumpRequest(mdLines, 8, 'JumpBodyToken', 9)
      scrollIntoViewSpy.mockClear()
      rerender(renderEditor())
      expect(wysiwygSurface().querySelector('.pm-search-jump-highlight')?.textContent).toBe(
        'JumpBodyToken'
      )

      // Jump to frontmatter line 2 with shared token in 위지윅 -> 0 highlights, scrollTop = 0
      wysiwygScroller().scrollTop = 160
      currentJump = createLineTokenJumpRequest(mdLines, 2, 'FrontmatterSharedToken', 10)
      scrollIntoViewSpy.mockClear()
      rerender(renderEditor())
      expect(wysiwygSurface().querySelectorAll('.pm-search-jump-highlight')).toHaveLength(0)
      expect(wysiwygScroller().scrollTop).toBe(0)

      // 5. Frontmatter-only doc + closed YAML syntax error + unclosed '---' safety checks
      const fmOnlyLines = ['---', 'yamlOnlyJump: SecretVal', '---', '']
      doc = createDoc({ content: fmOnlyLines.join('\n'), savedContent: fmOnlyLines.join('\n') })
      wysiwygScroller().scrollTop = 90
      currentJump = createLineTokenJumpRequest(fmOnlyLines, 2, 'SecretVal', 11)
      rerender(renderEditor())
      expect(wysiwygSurface().querySelectorAll('.pm-search-jump-highlight')).toHaveLength(0)
      expect(wysiwygScroller().scrollTop).toBe(0)

      await user.click(within(modeGroup()).getByRole('button', { name: 'Preview' }))
      previewEl().scrollTop = 75
      currentJump = createLineTokenJumpRequest(fmOnlyLines, 2, 'SecretVal', 12)
      rerender(renderEditor())
      expect(previewEl().querySelectorAll('.preview-search-jump-highlight')).toHaveLength(0)
      expect(previewEl().scrollTop).toBe(0)

      const syntaxErrLines = ['---', 'broken: [', '---', 'Recovered BodyJumpToken']
      doc = createDoc({ content: syntaxErrLines.join('\n'), savedContent: syntaxErrLines.join('\n') })
      currentJump = createLineTokenJumpRequest(syntaxErrLines, 4, 'BodyJumpToken', 13)
      rerender(renderEditor())
      expect(previewEl().querySelector('.preview-search-jump-highlight')?.textContent).toBe(
        'BodyJumpToken'
      )

      const unclosedLines = ['---', 'unclosedKey: UnclosedJumpToken', 'Paragraph text']
      doc = createDoc({ content: unclosedLines.join('\n'), savedContent: unclosedLines.join('\n') })
      currentJump = createLineTokenJumpRequest(unclosedLines, 2, 'UnclosedJumpToken', 14)
      rerender(renderEditor())
      expect(previewEl().querySelector('.preview-search-jump-highlight')?.textContent).toBe(
        'UnclosedJumpToken'
      )
    } finally {
      HTMLElement.prototype.scrollIntoView = originalScrollIntoView
    }
  })
})
