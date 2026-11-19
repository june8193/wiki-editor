import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { EditorView } from '@codemirror/view'
import { describe, expect, it, vi } from 'vitest'
import type { DocumentBuffer } from '@shared/documentBuffer'
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

describe('DocumentEditor In-Document Find Bar (<DocumentEditor />)', () => {
  it('toggles Find Bar via Editor Header button, handles Ctrl+F single-line selection auto-fill, Esc/close button, and disables/suppresses on image tabs', async () => {
    const user = userEvent.setup()
    const doc = createDoc()

    const { rerender } = render(
      <DocumentEditor
        document={doc}
        tab={createTab('raw')}
        theme="light"
        autoSave={false}
        onChangeContent={vi.fn()}
        onSave={vi.fn()}
        onUpdateViewState={vi.fn()}
      />
    )

    const findHeaderBtn = screen.getByRole('button', { name: '문서 내 찾기' })
    expect(findHeaderBtn).toHaveAttribute('title', '문서 내 찾기 (Ctrl+F)')
    expect(findHeaderBtn).toBeEnabled()
    expect(findHeaderBtn).toHaveAttribute('aria-pressed', 'false')
    expect(screen.queryByRole('region', { name: '문서 내 찾기 바' })).not.toBeInTheDocument()

    // Click header button -> opens floating Find Bar and focuses input
    await user.click(findHeaderBtn)
    expect(findHeaderBtn).toHaveAttribute('aria-pressed', 'true')
    const findBar = screen.getByRole('region', { name: '문서 내 찾기 바' })
    const findInput = within(findBar).getByRole('textbox', {
      name: '문서 내 검색어 입력'
    }) as HTMLInputElement
    expect(findInput).toHaveFocus()

    // Click header button again -> closes Find Bar
    await user.click(findHeaderBtn)
    expect(screen.queryByRole('region', { name: '문서 내 찾기 바' })).not.toBeInTheDocument()
    expect(findHeaderBtn).toHaveAttribute('aria-pressed', 'false')

    // Ctrl+F with single-line selection in Raw editor auto-fills query and focuses/selects input
    const editorEl = screen.getByTestId('document-editor')
    const cmView = EditorView.findFromDOM(editorEl)!
    const betaStart = doc.content.indexOf('beta')
    act(() => {
      cmView.dispatch({ selection: { anchor: betaStart, head: betaStart + 4 } })
    })

    fireEvent.keyDown(editorEl, { key: 'f', ctrlKey: true })
    const openedBar = screen.getByRole('region', { name: '문서 내 찾기 바' })
    const openedInput = within(openedBar).getByRole('textbox', {
      name: '문서 내 검색어 입력'
    }) as HTMLInputElement
    expect(openedInput.value).toBe('beta')
    expect(openedInput).toHaveFocus()
    expect(openedInput.selectionStart).toBe(0)
    expect(openedInput.selectionEnd).toBe('beta'.length)

    // Ctrl+F while focused inside Find Bar focuses/selects typed query without overwriting from stale Raw selection
    await user.clear(openedInput)
    await user.type(openedInput, 'alpha')
    expect(cmView.state.doc.sliceString(cmView.state.selection.main.from, cmView.state.selection.main.to)).toBe('beta')
    fireEvent.keyDown(openedInput, { key: 'f', ctrlKey: true })
    expect(openedInput.value).toBe('alpha')
    expect(openedInput).toHaveFocus()
    expect(openedInput.selectionStart).toBe(0)
    expect(openedInput.selectionEnd).toBe('alpha'.length)

    // Restore 'beta' before verifying multi-line Raw selection does NOT overwrite query
    await user.clear(openedInput)
    await user.type(openedInput, 'beta')

    // Ctrl+F with multi-line selection does NOT overwrite query; focuses & selects existing input text
    const multiStart = doc.content.indexOf('alpha\n')
    const multiEnd = doc.content.indexOf('gamma')
    act(() => {
      cmView.dispatch({ selection: { anchor: multiStart, head: multiEnd } })
    })
    fireEvent.keyDown(editorEl, { key: 'f', ctrlKey: true })
    expect(openedInput.value).toBe('beta')
    expect(openedInput).toHaveFocus()
    expect(openedInput.selectionStart).toBe(0)
    expect(openedInput.selectionEnd).toBe('beta'.length)

    // Esc inside Find Bar closes it and returns focus to editor
    fireEvent.keyDown(openedInput, { key: 'Escape' })
    expect(screen.queryByRole('region', { name: '문서 내 찾기 바' })).not.toBeInTheDocument()

    // Reopen via Ctrl+F without selection preserves existing query and closes on close button
    act(() => {
      cmView.dispatch({ selection: { anchor: 0 } })
    })
    fireEvent.keyDown(editorEl, { key: 'f', metaKey: true })
    const reopenedBar = screen.getByRole('region', { name: '문서 내 찾기 바' })
    const reopenedInput = within(reopenedBar).getByRole('textbox', {
      name: '문서 내 검색어 입력'
    }) as HTMLInputElement
    expect(reopenedInput.value).toBe('beta')
    await user.click(within(reopenedBar).getByRole('button', { name: '찾기 바 닫기' }))
    expect(screen.queryByRole('region', { name: '문서 내 찾기 바' })).not.toBeInTheDocument()

    // On image preview tab: button disabled, Find Bar hidden, Ctrl+F suppressed
    const imageDoc = createDoc({
      key: 'c:/wiki/diagram.png',
      path: 'C:/wiki/diagram.png',
      name: 'diagram.png',
      content: '',
      savedContent: '',
      contentKind: 'image'
    })
    rerender(
      <DocumentEditor
        document={imageDoc}
        tab={{ ...createTab('raw'), bufferKey: imageDoc.key }}
        theme="light"
        autoSave={false}
        onChangeContent={vi.fn()}
        onSave={vi.fn()}
        onUpdateViewState={vi.fn()}
      />
    )
    expect(screen.getByRole('button', { name: '문서 내 찾기' })).toBeDisabled()
    expect(screen.queryByRole('region', { name: '문서 내 찾기 바' })).not.toBeInTheDocument()
    const documentEditorEl = screen.getByRole('region', { name: '문서 편집 영역' })
    const ctrlFEvent = new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true })
    documentEditorEl.dispatchEvent(ctrlFEvent)
    expect(ctrlFEvent.defaultPrevented).toBe(true)
    expect(screen.queryByRole('region', { name: '문서 내 찾기 바' })).not.toBeInTheDocument()

    // When modal is open (isShortcutDisabled), Ctrl+F is suppressed on text doc too
    rerender(
      <DocumentEditor
        document={doc}
        tab={createTab('raw')}
        theme="light"
        autoSave={false}
        isShortcutDisabled
        onChangeContent={vi.fn()}
        onSave={vi.fn()}
        onUpdateViewState={vi.fn()}
      />
    )
    fireEvent.keyDown(screen.getByTestId('document-editor'), { key: 'f', ctrlKey: true })
    expect(screen.queryByRole('region', { name: '문서 내 찾기 바' })).not.toBeInTheDocument()
  })

  it('highlights matches in Raw mode (Markdown, CRLF, JSON), supports Aa/ab/.* options, inline regex error, cyclic navigation, live edits, and clears on close', async () => {
    const user = userEvent.setup()
    let doc = createDoc({
      content: 'Alpha beta alpha\n한글 검색 및 검색어\nFinal alpha line\nitem-42 item-99',
      savedContent: 'Alpha beta alpha\n한글 검색 및 검색어\nFinal alpha line\nitem-42 item-99'
    })

    const renderEditor = (targetDoc: DocumentBuffer) => (
      <DocumentEditor
        document={targetDoc}
        tab={{ ...createTab('raw'), bufferKey: targetDoc.key }}
        theme="light"
        autoSave={false}
        onChangeContent={(nextContent) => {
          doc = { ...doc, content: nextContent, isDirty: true }
          rerender(renderEditor(doc))
        }}
        onSave={vi.fn()}
        onUpdateViewState={vi.fn()}
      />
    )

    const { container, rerender } = render(renderEditor(doc))

    await user.click(screen.getByRole('button', { name: '문서 내 찾기' }))
    const findBar = screen.getByRole('region', { name: '문서 내 찾기 바' })
    const findInput = within(findBar).getByRole('textbox', { name: '문서 내 검색어 입력' })
    const caseBtn = within(findBar).getByRole('button', { name: /대소문자 구분/ })
    const wholeWordBtn = within(findBar).getByRole('button', { name: /단어 단위/ })
    const regexBtn = within(findBar).getByRole('button', { name: /정규식/ })
    const prevBtn = within(findBar).getByRole('button', { name: '이전 일치' })
    const nextBtn = within(findBar).getByRole('button', { name: '다음 일치' })

    // 1. Default case-insensitive partial search: 'alpha' -> 3 matches, 1 active
    await user.type(findInput, 'alpha')
    expect(within(findBar).getByText('1 / 3')).toBeInTheDocument()
    const allAlphaMarks = container.querySelectorAll('.cm-search-match')
    const activeAlphaMarks = container.querySelectorAll('.cm-search-match-active')
    expect(allAlphaMarks).toHaveLength(3)
    expect(activeAlphaMarks).toHaveLength(1)
    expect(activeAlphaMarks[0].textContent).toBe('Alpha')

    // 2. Cyclic navigation via Enter, F3, Next button, Shift+Enter, Shift+F3, Prev button
    fireEvent.keyDown(findInput, { key: 'Enter' })
    expect(within(findBar).getByText('2 / 3')).toBeInTheDocument()
    expect(container.querySelector('.cm-search-match-active')?.textContent).toBe('alpha')
    expect(container.querySelectorAll('.cm-search-match')[1]).toHaveClass('cm-search-match-active')

    fireEvent.keyDown(findInput, { key: 'F3' })
    expect(within(findBar).getByText('3 / 3')).toBeInTheDocument()
    expect(container.querySelectorAll('.cm-search-match')[2]).toHaveClass('cm-search-match-active')

    await user.click(nextBtn)
    expect(within(findBar).getByText('1 / 3')).toBeInTheDocument()
    expect(container.querySelectorAll('.cm-search-match')[0]).toHaveClass('cm-search-match-active')

    fireEvent.keyDown(findInput, { key: 'Enter', shiftKey: true })
    expect(within(findBar).getByText('3 / 3')).toBeInTheDocument()
    expect(container.querySelectorAll('.cm-search-match')[2]).toHaveClass('cm-search-match-active')

    // F3 / Shift+F3 also works when focus is back in the Raw editor, while Enter in Raw editor still inserts newline
    const rawEditorEl = screen.getByTestId('document-editor')
    fireEvent.keyDown(rawEditorEl, { key: 'F3', shiftKey: true })
    expect(within(findBar).getByText('2 / 3')).toBeInTheDocument()
    await user.click(prevBtn)
    expect(within(findBar).getByText('1 / 3')).toBeInTheDocument()

    // 3. Toggle Aa (case-sensitive) -> only lowercase 'alpha' (2 matches)
    await user.click(caseBtn)
    expect(within(findBar).getByText('1 / 2')).toBeInTheDocument()
    expect(container.querySelectorAll('.cm-search-match')).toHaveLength(2)

    // 4. Disable Aa, search '검색' with ab (whole-word) -> matches '검색' only, not '검색어'
    await user.click(caseBtn)
    await user.clear(findInput)
    await user.type(findInput, '검색')
    expect(within(findBar).getByText('1 / 2')).toBeInTheDocument()

    await user.click(wholeWordBtn)
    expect(within(findBar).getByText('1 / 1')).toBeInTheDocument()
    expect(container.querySelectorAll('.cm-search-match')).toHaveLength(1)
    expect(container.querySelector('.cm-search-match')?.textContent).toBe('검색')

    // 5. Disable ab, enable .* (regex) -> matches item-\d+, handles empty-matching '^' safely, shows inline error on invalid regex
    await user.click(wholeWordBtn)
    await user.click(regexBtn)
    await user.clear(findInput)
    await user.type(findInput, 'item-\\d+')
    expect(within(findBar).getByText('1 / 2')).toBeInTheDocument()
    expect(
      Array.from(container.querySelectorAll('.cm-search-match')).map((el) => el.textContent)
    ).toEqual(['item-42', 'item-99'])

    await user.clear(findInput)
    await user.type(findInput, '^')
    expect(within(findBar).getByText('1 / 4')).toBeInTheDocument()
    fireEvent.keyDown(findInput, { key: 'Enter' })
    expect(within(findBar).getByText('2 / 4')).toBeInTheDocument()

    fireEvent.change(findInput, { target: { value: '[unclosed' } })
    expect(within(findBar).getByRole('alert')).toHaveTextContent(/정규식/)
    expect(container.querySelectorAll('.cm-search-match')).toHaveLength(0)
    expect(prevBtn).toBeDisabled()
    expect(nextBtn).toBeDisabled()

    // 6. No results state
    await user.click(regexBtn)
    await user.clear(findInput)
    await user.type(findInput, 'nonexistent-token')
    expect(within(findBar).getByText('결과 없음')).toBeInTheDocument()
    expect(prevBtn).toBeDisabled()
    expect(nextBtn).toBeDisabled()

    // 7. Live document edit updates matches and count in real time
    await user.clear(findInput)
    await user.type(findInput, 'alpha')
    expect(within(findBar).getByText('1 / 3')).toBeInTheDocument()
    const cmView = EditorView.findFromDOM(rawEditorEl)!
    act(() => {
      const end = cmView.state.doc.length
      cmView.dispatch({ changes: { from: end, to: end, insert: '\nalpha extra' } })
    })
    expect(within(findBar).getByText('1 / 4')).toBeInTheDocument()
    expect(container.querySelectorAll('.cm-search-match')).toHaveLength(4)

    // Editing in Raw editor with Enter does NOT hijack newline insertion
    act(() => {
      cmView.dispatch({ selection: { anchor: 0 } })
    })
    rawEditorEl.focus()
    await user.keyboard('{Enter}')
    expect(doc.content.startsWith('\n')).toBe(true)

    // 8. CRLF line-ending document offsets match exact spans without off-by-1 shift
    const crlfDoc = createDoc({
      key: 'c:/wiki/crlf.md',
      path: 'C:/wiki/crlf.md',
      name: 'crlf.md',
      content: 'First\r\nSecond hit\r\nThird hit',
      savedContent: 'First\r\nSecond hit\r\nThird hit'
    })
    rerender(renderEditor(crlfDoc))
    await user.clear(findInput)
    await user.type(findInput, 'hit')
    expect(within(findBar).getByText('1 / 2')).toBeInTheDocument()
    expect(
      Array.from(container.querySelectorAll('.cm-search-match')).map((el) => el.textContent)
    ).toEqual(['hit', 'hit'])

    // 9. Non-markdown config.json Raw mode searches and highlights cleanly
    const configDoc = createDoc({
      key: 'c:/config.json',
      kind: 'config',
      path: 'C:/config.json',
      name: 'config.json',
      content: '{\n  "theme": "light",\n  "autoSave": false\n}',
      savedContent: '{\n  "theme": "light",\n  "autoSave": false\n}'
    })
    rerender(renderEditor(configDoc))
    await user.clear(findInput)
    await user.type(findInput, 'light')
    expect(within(findBar).getByText('1 / 1')).toBeInTheDocument()
    expect(container.querySelector('.cm-search-match')?.textContent).toBe('light')

    // 10. Closing Find Bar clears all CodeMirror match decorations
    await user.click(within(findBar).getByRole('button', { name: '찾기 바 닫기' }))
    expect(screen.queryByRole('region', { name: '문서 내 찾기 바' })).not.toBeInTheDocument()
    expect(container.querySelectorAll('.cm-search-match')).toHaveLength(0)
  })

  it('centers the Raw scroll area on the active match when navigating and avoids scroll jump on document edits', async () => {
    const user = userEvent.setup()
    const lines = Array.from({ length: 60 }, (_, idx) =>
      idx === 1 || idx === 49 ? `Line ${idx + 1} TargetMatch` : `Line ${idx + 1} filler`
    )
    let doc = createDoc({
      content: lines.join('\n'),
      savedContent: lines.join('\n')
    })

    const { container, rerender } = render(
      <DocumentEditor
        document={doc}
        tab={createTab('raw')}
        theme="light"
        autoSave={false}
        onChangeContent={(nextContent) => {
          doc = { ...doc, content: nextContent, isDirty: true }
        }}
        onSave={vi.fn()}
        onUpdateViewState={vi.fn()}
      />
    )

    const rawScroller = container.querySelector('.cm-scroller') as HTMLElement
    const cmView = EditorView.findFromDOM(rawScroller)!
    Object.defineProperty(rawScroller, 'clientHeight', { configurable: true, value: 140 })
    Object.defineProperty(rawScroller, 'scrollHeight', {
      configurable: true,
      get: () => cmView.contentHeight
    })

    await user.click(screen.getByRole('button', { name: '문서 내 찾기' }))
    const findBar = screen.getByRole('region', { name: '문서 내 찾기 바' })
    const findInput = within(findBar).getByRole('textbox', { name: '문서 내 검색어 입력' })

    await user.type(findInput, 'TargetMatch')
    expect(within(findBar).getByText('1 / 2')).toBeInTheDocument()

    // Navigate to 2nd match on line 50 -> scrolls Raw editor to center line 50
    fireEvent.keyDown(findInput, { key: 'Enter' })
    expect(within(findBar).getByText('2 / 2')).toBeInTheDocument()

    const line50Offset = doc.content.indexOf('Line 50 TargetMatch')
    const line50Block = cmView.lineBlockAt(line50Offset)
    const maxScroll = Math.max(0, cmView.contentHeight - 140)
    const expectedLine50Top = Math.max(
      0,
      Math.min(maxScroll, cmView.documentPadding.top + line50Block.top + line50Block.height / 2 - 70)
    )
    expect(rawScroller.scrollTop).toBeCloseTo(expectedLine50Top, 1)

    // Editing content while scrolled elsewhere must NOT yank scrollTop back to active match
    rawScroller.scrollTop = 20
    const updated = doc.content + '\nLine 61 edited'
    doc = { ...doc, content: updated, isDirty: true }
    rerender(
      <DocumentEditor
        document={doc}
        tab={createTab('raw')}
        theme="light"
        autoSave={false}
        onChangeContent={vi.fn()}
        onSave={vi.fn()}
        onUpdateViewState={vi.fn()}
      />
    )
    expect(rawScroller.scrollTop).toBe(20)
  })

  it('searches by left Raw editor in Split mode, line-syncs right Preview on active match navigation, and preserves Find Bar across Raw <-> Split switches', async () => {
    const user = userEvent.setup()
    const listLines = Array.from({ length: 110 }, (_, i) =>
      i === 0 || i === 85 ? `- SplitTarget item ${i + 1}` : `- Plain item ${i + 1}`
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

    const { container, rerender } = render(
      <DocumentEditor
        document={doc}
        tab={tab}
        theme="light"
        autoSave={false}
        onChangeContent={vi.fn()}
        onSave={vi.fn()}
        onUpdateViewState={(patch) => {
          tab = { ...tab, ...patch }
        }}
      />
    )

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
    const h1 = previewRegion.querySelector('h1[data-source-line="1"]') as HTMLElement
    const codeBlock = previewRegion.querySelector('[data-source-line="3"]') as HTMLElement
    const ulEl = previewRegion.querySelector('ul[data-source-line="12"]') as HTMLElement
    mockBlockRect(h1, 0, 40)
    mockBlockRect(codeBlock, 60, 400)
    mockBlockRect(ulEl, 480, 920)

    await user.click(screen.getByRole('button', { name: '문서 내 찾기' }))
    const findBar = screen.getByRole('region', { name: '문서 내 찾기 바' })
    const findInput = within(findBar).getByRole('textbox', { name: '문서 내 검색어 입력' })

    await user.type(findInput, 'SplitTarget')
    expect(within(findBar).getByText('1 / 2')).toBeInTheDocument()
    expect(container.querySelector('.cm-search-match-active')?.textContent).toBe('SplitTarget')

    // Step to 2nd match (line 97) -> Raw scrolls and Preview syncs using [data-source-line] geometry
    fireEvent.keyDown(findInput, { key: 'Enter' })
    expect(within(findBar).getByText('2 / 2')).toBeInTheDocument()
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

    // Switch Split -> Raw preserves Find Bar, query, active match index, and Raw decorations
    await user.click(
      within(screen.getByRole('group', { name: '에디터 모드 전환' })).getByRole('button', {
        name: 'Raw'
      })
    )
    rerender(
      <DocumentEditor
        document={doc}
        tab={tab}
        theme="light"
        autoSave={false}
        onChangeContent={vi.fn()}
        onSave={vi.fn()}
        onUpdateViewState={(patch) => {
          tab = { ...tab, ...patch }
        }}
      />
    )
    const keptBar = screen.getByRole('region', { name: '문서 내 찾기 바' })
    const keptInput = within(keptBar).getByRole('textbox', {
      name: '문서 내 검색어 입력'
    }) as HTMLInputElement
    expect(keptInput.value).toBe('SplitTarget')
    expect(within(keptBar).getByText('2 / 2')).toBeInTheDocument()
    const firstRawMatch = container.querySelector('.cm-search-match')
    expect(firstRawMatch).not.toBeNull()
    expect(firstRawMatch).not.toHaveClass('cm-search-match-active')

    // Wrapping forward from 2 / 2 lands on 1 / 2 and activates the first match in Raw mode
    fireEvent.keyDown(keptInput, { key: 'Enter' })
    expect(within(keptBar).getByText('1 / 2')).toBeInTheDocument()
    expect(container.querySelector('.cm-search-match-active')?.textContent).toBe('SplitTarget')
  })

  it('highlights matches across headings, paragraphs, marks, lists, tables, and code blocks in 위지윅 mode, supports options/scroll/live edits without polluting content, and clears on close', async () => {
    const user = userEvent.setup()
    const scrollIntoViewMock = vi.fn()
    const origScrollIntoView = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = scrollIntoViewMock

    try {
      const initialMd = [
        '# Alpha Heading',
        '',
        'Alpha **bold** and [alpha link](https://alpha.example.com) and **world**wide Hello **world**',
        '',
        '- list alpha item',
        '- [ ] task Alpha item',
        '',
        '| Header Alpha | Notes |',
        '| --- | --- |',
        '| Cell alpha | 검색 및 검색어 |',
        '',
        '```ts',
        'const alphaCode = "item-42"',
        'const betaCode = "item-99"',
        '```'
      ].join('\n')

      let doc = createDoc({
        content: initialMd,
        savedContent: initialMd
      })
      const onChangeContent = vi.fn((nextContent: string) => {
        doc = { ...doc, content: nextContent, isDirty: true }
        rerender(renderWysiwyg(doc))
      })

      const renderWysiwyg = (targetDoc: DocumentBuffer) => (
        <DocumentEditor
          document={targetDoc}
          tab={{ ...createTab('wysiwyg'), bufferKey: targetDoc.key }}
          theme="light"
          autoSave={false}
          onChangeContent={onChangeContent}
          onSave={vi.fn()}
          onUpdateViewState={vi.fn()}
        />
      )

      const { container, rerender } = render(renderWysiwyg(doc))
      const editorEl = screen.getByTestId('document-editor')

      await user.click(screen.getByRole('button', { name: '문서 내 찾기' }))
      const findBar = screen.getByRole('region', { name: '문서 내 찾기 바' })
      const findInput = within(findBar).getByRole('textbox', { name: '문서 내 검색어 입력' })
      const caseBtn = within(findBar).getByRole('button', { name: /대소문자 구분/ })
      const wholeWordBtn = within(findBar).getByRole('button', { name: /단어 단위/ })
      const regexBtn = within(findBar).getByRole('button', { name: /정규식/ })
      const nextBtn = within(findBar).getByRole('button', { name: '다음 일치' })
      const prevBtn = within(findBar).getByRole('button', { name: '이전 일치' })

      // 1. Case-insensitive partial search across heading, paragraph, link text (not URL), list, task, table, code block
      await user.type(findInput, 'alpha')
      expect(within(findBar).getByText('1 / 8')).toBeInTheDocument()
      expect(container.querySelectorAll('.pm-search-match')).toHaveLength(8)
      const firstActive = container.querySelector('.pm-search-match-active')
      expect(firstActive?.textContent).toBe('Alpha')
      expect(firstActive?.closest('h1')).not.toBeNull()
      expect(onChangeContent).not.toHaveBeenCalled()
      expect(doc.isDirty).toBe(false)

      // Active match scrolled into view on search activation
      expect(scrollIntoViewMock).toHaveBeenCalled()
      expect(scrollIntoViewMock).toHaveBeenLastCalledWith({ block: 'center' })
      expect(scrollIntoViewMock.mock.instances[scrollIntoViewMock.mock.instances.length - 1]).toBe(
        firstActive
      )

      // 2. Cyclic navigation via Enter, F3, Next/Prev buttons updates active highlight and scrolls
      scrollIntoViewMock.mockClear()
      fireEvent.keyDown(findInput, { key: 'Enter' })
      expect(within(findBar).getByText('2 / 8')).toBeInTheDocument()
      const secondActive = container.querySelector('.pm-search-match-active')
      expect(container.querySelectorAll('.pm-search-match')[1]).toBe(secondActive)
      expect(scrollIntoViewMock).toHaveBeenCalledTimes(1)
      expect(scrollIntoViewMock.mock.instances[0]).toBe(secondActive)

      fireEvent.keyDown(editorEl, { key: 'F3' })
      expect(within(findBar).getByText('3 / 8')).toBeInTheDocument()
      expect(container.querySelector('.pm-search-match-active')?.closest('a')).not.toBeNull()

      await user.click(prevBtn)
      expect(within(findBar).getByText('2 / 8')).toBeInTheDocument()
      fireEvent.keyDown(findInput, { key: 'Enter', shiftKey: true })
      expect(within(findBar).getByText('1 / 8')).toBeInTheDocument()
      fireEvent.keyDown(findInput, { key: 'Enter', shiftKey: true })
      expect(within(findBar).getByText('8 / 8')).toBeInTheDocument()
      expect(container.querySelector('.pm-search-match-active')?.closest('code')).not.toBeNull()
      await user.click(nextBtn)
      expect(within(findBar).getByText('1 / 8')).toBeInTheDocument()

      // 3. Aa (case-sensitive) -> only 'Alpha' (Heading, Paragraph, Task, Table Header) = 4
      await user.click(caseBtn)
      expect(within(findBar).getByText('1 / 4')).toBeInTheDocument()
      expect(container.querySelectorAll('.pm-search-match')).toHaveLength(4)

      // 4. Cross-mark matching ("Hello world" across **bold**) and ab (whole-word)
      await user.click(caseBtn)
      await user.clear(findInput)
      await user.type(findInput, 'Hello world')
      expect(within(findBar).getByText('1 / 1')).toBeInTheDocument()

      await user.clear(findInput)
      await user.type(findInput, 'world')
      expect(within(findBar).getByText('1 / 2')).toBeInTheDocument()
      await user.click(wholeWordBtn)
      // '**world**wide' must NOT match whole-word 'world'; only 'Hello **world**' matches
      expect(within(findBar).getByText('1 / 1')).toBeInTheDocument()

      await user.clear(findInput)
      await user.type(findInput, '검색')
      expect(within(findBar).getByText('1 / 1')).toBeInTheDocument()
      expect(container.querySelector('.pm-search-match')?.textContent).toBe('검색')

      // 5. .* (regex) + empty-match '^' + inline invalid regex error
      await user.click(wholeWordBtn)
      await user.click(regexBtn)
      await user.clear(findInput)
      await user.type(findInput, 'item-\\d+')
      expect(within(findBar).getByText('1 / 2')).toBeInTheDocument()
      expect(
        Array.from(container.querySelectorAll('.pm-search-match')).map((el) => el.textContent)
      ).toEqual(['item-42', 'item-99'])

      await user.clear(findInput)
      await user.type(findInput, '^')
      expect(within(findBar).getByText(/1 \/ \d+/)).toBeInTheDocument()

      fireEvent.change(findInput, { target: { value: '[unclosed' } })
      expect(within(findBar).getByRole('alert')).toHaveTextContent(/정규식/)
      expect(container.querySelectorAll('.pm-search-match')).toHaveLength(0)

      // 6. Searching and navigating never dirtied document
      expect(onChangeContent).not.toHaveBeenCalled()

      // 7. Live document edit updates matches and decorations without jumping scroll
      await user.click(regexBtn)
      await user.clear(findInput)
      await user.type(findInput, 'alpha')
      expect(within(findBar).getByText('1 / 8')).toBeInTheDocument()

      scrollIntoViewMock.mockClear()
      const firstParagraph = editorEl.querySelector('p')!
      const range = document.createRange()
      range.selectNodeContents(firstParagraph)
      range.collapse(false)
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
      editorEl.focus()
      document.dispatchEvent(new Event('selectionchange'))
      await user.keyboard(' alpha')

      expect(within(findBar).getByText('1 / 9')).toBeInTheDocument()
      expect(container.querySelectorAll('.pm-search-match')).toHaveLength(9)
      expect(scrollIntoViewMock).not.toHaveBeenCalled()

      // 8. Esc closes Find Bar, clears decorations, and returns focus to WYSIWYG editor
      fireEvent.keyDown(findInput, { key: 'Escape' })
      expect(screen.queryByRole('region', { name: '문서 내 찾기 바' })).not.toBeInTheDocument()
      expect(container.querySelectorAll('.pm-search-match')).toHaveLength(0)
      expect(editorEl).toHaveFocus()
    } finally {
      Element.prototype.scrollIntoView = origScrollIntoView
    }
  })

  it('highlights rendered markdown DOM text in Preview mode across blocks/code tokens, supports options/scroll, excludes placeholder, and clears on close', async () => {
    const user = userEvent.setup()
    const scrollIntoViewMock = vi.fn()
    const origScrollIntoView = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = scrollIntoViewMock

    try {
      const md = [
        '# Alpha Heading',
        '',
        'Alpha **bold** and [alpha link](https://alpha.example.com) and **world**wide Hello **world**',
        '',
        '- list alpha item',
        '- [x] task Alpha item',
        '',
        '| Header Alpha | Notes |',
        '| --- | --- |',
        '| Cell alpha | 검색 및 검색어 |',
        '',
        '```ts',
        'const alphaCode = "item-42"',
        'const betaCode = "item-99"',
        '```'
      ].join('\n')

      const doc = createDoc({ content: md, savedContent: md })
      const { container, rerender } = render(
        <DocumentEditor
          document={doc}
          tab={createTab('preview')}
          theme="light"
          autoSave={false}
          onChangeContent={vi.fn()}
          onSave={vi.fn()}
          onUpdateViewState={vi.fn()}
        />
      )

      const previewEl = screen.getByTestId('document-editor')
      await user.click(screen.getByRole('button', { name: '문서 내 찾기' }))
      const findBar = screen.getByRole('region', { name: '문서 내 찾기 바' })
      const findInput = within(findBar).getByRole('textbox', { name: '문서 내 검색어 입력' })
      const caseBtn = within(findBar).getByRole('button', { name: /대소문자 구분/ })
      const wholeWordBtn = within(findBar).getByRole('button', { name: /단어 단위/ })
      const regexBtn = within(findBar).getByRole('button', { name: /정규식/ })
      const prevBtn = within(findBar).getByRole('button', { name: '이전 일치' })
      const nextBtn = within(findBar).getByRole('button', { name: '다음 일치' })

      // 1. Default search across rendered blocks & code body (excluding link URL)
      await user.type(findInput, 'alpha')
      expect(within(findBar).getByText('1 / 8')).toBeInTheDocument()
      expect(container.querySelectorAll('.preview-search-match')).toHaveLength(8)
      const firstActive = container.querySelector('.preview-search-match-active')
      expect(firstActive?.textContent).toBe('Alpha')
      expect(firstActive?.closest('h1')).not.toBeNull()
      expect(scrollIntoViewMock).toHaveBeenCalledWith({ block: 'center' })
      expect(scrollIntoViewMock.mock.instances[scrollIntoViewMock.mock.instances.length - 1]).toBe(
        firstActive
      )

      // 2. Cyclic navigation & active scroll
      scrollIntoViewMock.mockClear()
      fireEvent.keyDown(findInput, { key: 'Enter' })
      expect(within(findBar).getByText('2 / 8')).toBeInTheDocument()
      const secondActive = container.querySelector('.preview-search-match-active')
      expect(container.querySelectorAll('.preview-search-match')[1]).toBe(secondActive)
      expect(scrollIntoViewMock).toHaveBeenCalledTimes(1)
      expect(scrollIntoViewMock.mock.instances[0]).toBe(secondActive)

      fireEvent.keyDown(previewEl, { key: 'F3', shiftKey: true })
      expect(within(findBar).getByText('1 / 8')).toBeInTheDocument()
      await user.click(prevBtn)
      expect(within(findBar).getByText('8 / 8')).toBeInTheDocument()
      expect(container.querySelector('.preview-search-match-active')?.closest('code')).not.toBeNull()
      await user.click(nextBtn)
      expect(within(findBar).getByText('1 / 8')).toBeInTheDocument()

      // 3. Cross-token match inside syntax-highlighted code block ("const alphaCode") counts as 1 logical match
      await user.clear(findInput)
      await user.type(findInput, 'const alphaCode')
      expect(within(findBar).getByText('1 / 1')).toBeInTheDocument()
      expect(
        Array.from(container.querySelectorAll('.preview-search-match'))
          .map((el) => el.textContent)
          .join('')
      ).toBe('const alphaCode')

      // 4. Cross-mark match ("Hello world") & ab whole-word boundary across inline marks & Korean text
      await user.clear(findInput)
      await user.type(findInput, 'Hello world')
      expect(within(findBar).getByText('1 / 1')).toBeInTheDocument()

      await user.clear(findInput)
      await user.type(findInput, 'world')
      expect(within(findBar).getByText('1 / 2')).toBeInTheDocument()
      await user.click(wholeWordBtn)
      expect(within(findBar).getByText('1 / 1')).toBeInTheDocument()

      await user.clear(findInput)
      await user.type(findInput, '검색')
      expect(within(findBar).getByText('1 / 1')).toBeInTheDocument()

      // 5. Aa (case-sensitive)
      await user.click(wholeWordBtn)
      await user.click(caseBtn)
      await user.clear(findInput)
      await user.type(findInput, 'Alpha')
      expect(within(findBar).getByText('1 / 4')).toBeInTheDocument()

      // 6. .* (regex) + empty match '^' + invalid regex alert
      await user.click(caseBtn)
      await user.click(regexBtn)
      await user.clear(findInput)
      await user.type(findInput, 'item-\\d+')
      expect(within(findBar).getByText('1 / 2')).toBeInTheDocument()
      expect(
        Array.from(container.querySelectorAll('.preview-search-match')).map((el) => el.textContent)
      ).toEqual(['item-42', 'item-99'])

      await user.clear(findInput)
      await user.type(findInput, '^')
      expect(within(findBar).getByText(/1 \/ \d+/)).toBeInTheDocument()

      fireEvent.change(findInput, { target: { value: '[bad' } })
      expect(within(findBar).getByRole('alert')).toHaveTextContent(/정규식/)
      expect(container.querySelectorAll('.preview-search-match')).toHaveLength(0)

      // 7. Empty Preview placeholder text ("미리 볼 내용이 없습니다.") is NOT searched,
      // while invalid regex still surfaces inline alert consistently across modes
      await user.click(regexBtn)
      await user.clear(findInput)
      await user.type(findInput, '미리')
      const emptyDoc = createDoc({ content: '   ', savedContent: '   ' })
      rerender(
        <DocumentEditor
          document={emptyDoc}
          tab={createTab('preview')}
          theme="light"
          autoSave={false}
          onChangeContent={vi.fn()}
          onSave={vi.fn()}
          onUpdateViewState={vi.fn()}
        />
      )
      expect(screen.getByText('미리 볼 내용이 없습니다.')).toBeInTheDocument()
      expect(within(findBar).getByText('결과 없음')).toBeInTheDocument()
      expect(container.querySelectorAll('.preview-search-match')).toHaveLength(0)

      await user.click(regexBtn)
      fireEvent.change(findInput, { target: { value: '[unclosed' } })
      expect(within(findBar).getByRole('alert')).toHaveTextContent(/정규식/)
      await user.click(regexBtn)

      // 8. Esc closes Find Bar and returns focus to Preview container
      rerender(
        <DocumentEditor
          document={doc}
          tab={createTab('preview')}
          theme="light"
          autoSave={false}
          onChangeContent={vi.fn()}
          onSave={vi.fn()}
          onUpdateViewState={vi.fn()}
        />
      )
      await user.clear(findInput)
      await user.type(findInput, 'alpha')
      expect(container.querySelectorAll('.preview-search-match')).toHaveLength(8)
      fireEvent.keyDown(findInput, { key: 'Escape' })
      expect(screen.queryByRole('region', { name: '문서 내 찾기 바' })).not.toBeInTheDocument()
      expect(container.querySelectorAll('.preview-search-match')).toHaveLength(0)
      expect(screen.getByTestId('document-editor')).toHaveFocus()
    } finally {
      Element.prototype.scrollIntoView = origScrollIntoView
    }
  })

  it('excludes code block header controls and Mermaid SVG/action chrome from search matches in both Preview and 위지윅 modes', async () => {
    const user = userEvent.setup()
    const driver: MermaidDriver = {
      initialize: vi.fn(),
      render: vi.fn(async () => ({
        svg: '<svg data-testid="rendered-mermaid-svg"><text>MermaidSvgLabel</text></svg>'
      }))
    }
    const mermaidRenderer = createMermaidRenderer(driver)
    const md = [
      '# Diagram Doc',
      '',
      'Visible body text',
      '',
      '```ts',
      'const visibleCode = 42',
      '```',
      '',
      '```mermaid',
      'graph TD',
      '  NodeAlpha --> NodeBeta',
      '```'
    ].join('\n')
    const doc = createDoc({ content: md, savedContent: md })

    const renderWithMode = (mode: EditorMode) => (
      <DocumentEditor
        document={doc}
        tab={createTab(mode)}
        theme="light"
        autoSave={false}
        mermaidRenderer={mermaidRenderer}
        onChangeContent={vi.fn()}
        onSave={vi.fn()}
        onUpdateViewState={vi.fn()}
      />
    )

    const { container, rerender } = render(renderWithMode('preview'))
    expect(await screen.findByTestId('mermaid-svg')).toHaveTextContent('MermaidSvgLabel')

    await user.click(screen.getByRole('button', { name: '문서 내 찾기' }))
    const findBar = screen.getByRole('region', { name: '문서 내 찾기 바' })
    const findInput = within(findBar).getByRole('textbox', { name: '문서 내 검색어 입력' })

    for (const chromeToken of ['TypeScript', '코드 복사', '100%', 'MermaidSvgLabel', 'NodeAlpha']) {
      fireEvent.change(findInput, { target: { value: chromeToken } })
      expect(within(findBar).getByText('결과 없음')).toBeInTheDocument()
      expect(container.querySelectorAll('.preview-search-match')).toHaveLength(0)
    }

    // Mermaid diagram stays mounted and real body/code text still matches
    fireEvent.change(findInput, { target: { value: 'visible' } })
    expect(within(findBar).getByText('1 / 2')).toBeInTheDocument()
    expect(screen.getByTestId('mermaid-svg')).toHaveTextContent('MermaidSvgLabel')

    // Verify same exclusion in 위지윅 mode (including toolbar, code header, Mermaid header/SVG/hidden source)
    rerender(renderWithMode('wysiwyg'))
    expect(await screen.findByTestId('mermaid-svg')).toHaveTextContent('MermaidSvgLabel')

    const wysiwygFindBar = screen.getByRole('region', { name: '문서 내 찾기 바' })
    const wysiwygInput = within(wysiwygFindBar).getByRole('textbox', {
      name: '문서 내 검색어 입력'
    })

    for (const chromeToken of [
      'TypeScript',
      '코드 복사',
      '100%',
      'MermaidSvgLabel',
      'NodeAlpha',
      '코드 편집',
      '표 삽입'
    ]) {
      fireEvent.change(wysiwygInput, { target: { value: chromeToken } })
      expect(within(wysiwygFindBar).getByText('결과 없음')).toBeInTheDocument()
      expect(container.querySelectorAll('.pm-search-match')).toHaveLength(0)
    }

    fireEvent.change(wysiwygInput, { target: { value: 'visible' } })
    expect(within(wysiwygFindBar).getByText('1 / 2')).toBeInTheDocument()
  })

  it('simultaneously highlights right Preview matches in Split mode while left Raw drives navigation and syncs live edits', async () => {
    const user = userEvent.setup()
    const driver: MermaidDriver = {
      initialize: vi.fn(),
      render: vi.fn(async () => ({
        svg: '<svg><text>MermaidTarget</text></svg>'
      }))
    }
    const mermaidRenderer = createMermaidRenderer(driver)
    const initialMd = [
      '# Split Alpha',
      '',
      'Link [alpha text](https://alpha.example.com) and exact word only',
      '',
      '```ts',
      'const alphaVar = 1',
      '```',
      '',
      '```mermaid',
      'graph TD',
      '  AlphaNode --> BetaNode',
      '```'
    ].join('\n')

    let doc = createDoc({ content: initialMd, savedContent: initialMd })
    const renderSplit = (targetDoc: DocumentBuffer) => (
      <DocumentEditor
        document={targetDoc}
        tab={{ ...createTab('split', 0.5), bufferKey: targetDoc.key }}
        theme="light"
        autoSave={false}
        mermaidRenderer={mermaidRenderer}
        onChangeContent={(nextContent) => {
          doc = { ...doc, content: nextContent, isDirty: true }
          rerender(renderSplit(doc))
        }}
        onSave={vi.fn()}
        onUpdateViewState={vi.fn()}
      />
    )

    const { container, rerender } = render(renderSplit(doc))
    expect(await screen.findByTestId('mermaid-svg')).toHaveTextContent('MermaidTarget')

    await user.click(screen.getByRole('button', { name: '문서 내 찾기' }))
    const findBar = screen.getByRole('region', { name: '문서 내 찾기 바' })
    const findInput = within(findBar).getByRole('textbox', { name: '문서 내 검색어 입력' })
    const rawRegion = container.querySelector('.editor-split-region.is-raw') as HTMLElement
    const previewRegion = screen.getByTestId('split-markdown-preview')

    // Raw drives count (5 occurrences in raw markdown incl. URL & mermaid source),
    // while right Preview simultaneously highlights the 3 visible Preview occurrences (excluding URL & Mermaid)
    await user.type(findInput, 'alpha')
    expect(within(findBar).getByText('1 / 5')).toBeInTheDocument()
    expect(rawRegion.querySelectorAll('.cm-search-match')).toHaveLength(5)
    expect(rawRegion.querySelectorAll('.cm-search-match-active')).toHaveLength(1)
    expect(previewRegion.querySelectorAll('.preview-search-match')).toHaveLength(3)
    expect(previewRegion.querySelectorAll('.preview-search-match-active')).toHaveLength(0)

    // Toggling Aa updates both Raw and right Preview simultaneously (3 lowercase raw, 2 lowercase preview)
    await user.click(within(findBar).getByRole('button', { name: /대소문자 구분/ }))
    expect(within(findBar).getByText('1 / 3')).toBeInTheDocument()
    expect(rawRegion.querySelectorAll('.cm-search-match')).toHaveLength(3)
    expect(previewRegion.querySelectorAll('.preview-search-match')).toHaveLength(2)

    // Live edit in left Raw editor updates right Preview highlights simultaneously
    await user.click(within(findBar).getByRole('button', { name: /대소문자 구분/ }))
    const cmView = EditorView.findFromDOM(rawRegion.querySelector('[data-testid="document-editor"]')!)!
    act(() => {
      const end = cmView.state.doc.length
      cmView.dispatch({ changes: { from: end, to: end, insert: '\nExtra alpha line' } })
    })
    expect(within(findBar).getByText('1 / 6')).toBeInTheDocument()
    expect(previewRegion.querySelectorAll('.preview-search-match')).toHaveLength(4)

    // Closing Find Bar clears highlights on both sides
    fireEvent.keyDown(findInput, { key: 'Escape' })
    expect(rawRegion.querySelectorAll('.cm-search-match')).toHaveLength(0)
    expect(previewRegion.querySelectorAll('.preview-search-match')).toHaveLength(0)
  })

  it('auto-fills Find Bar from single-line selections and ignores multi-line, multi-block, and chrome selections on Ctrl+F in 위지윅 and Preview modes', async () => {
    const user = userEvent.setup()
    const md = [
      '# Heading Title',
      '',
      'First **bold word** line',
      '',
      'Second paragraph',
      '',
      '```ts',
      'const firstLine = 1',
      'const secondLine = 2',
      '```'
    ].join('\n')
    const doc = createDoc({ content: md, savedContent: md })

    const { rerender } = render(
      <DocumentEditor
        document={doc}
        tab={createTab('wysiwyg')}
        theme="light"
        autoSave={false}
        onChangeContent={vi.fn()}
        onSave={vi.fn()}
        onUpdateViewState={vi.fn()}
      />
    )

    // 1. 위지윅 single-line selection via DOM selection -> Ctrl+F auto-fills
    const wysiwygEl = screen.getByTestId('document-editor')
    const strongEl = wysiwygEl.querySelector('strong')!
    const singleRange = document.createRange()
    singleRange.selectNodeContents(strongEl)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(singleRange)
    document.dispatchEvent(new Event('selectionchange'))

    fireEvent.keyDown(wysiwygEl, { key: 'f', ctrlKey: true })
    const wysiwygBar = screen.getByRole('region', { name: '문서 내 찾기 바' })
    const wysiwygInput = within(wysiwygBar).getByRole('textbox', {
      name: '문서 내 검색어 입력'
    }) as HTMLInputElement
    expect(wysiwygInput.value).toBe('bold word')
    expect(wysiwygInput).toHaveFocus()

    // Multi-block selection across two paragraphs in 위지윅 must NOT overwrite existing query
    const paragraphs = wysiwygEl.querySelectorAll('p')
    const crossBlockRange = document.createRange()
    crossBlockRange.setStart(paragraphs[0].firstChild!, 0)
    crossBlockRange.setEnd(paragraphs[1].firstChild!, 6)
    selection.removeAllRanges()
    selection.addRange(crossBlockRange)
    document.dispatchEvent(new Event('selectionchange'))

    fireEvent.keyDown(wysiwygEl, { key: 'f', ctrlKey: true })
    expect(wysiwygInput.value).toBe('bold word')

    // Multi-line selection inside code block must NOT overwrite query
    const codeBlock = await screen.findByTestId('wysiwyg-code-block')
    const codeEl = codeBlock.querySelector('pre code')!
    const multiLineCodeRange = document.createRange()
    multiLineCodeRange.selectNodeContents(codeEl)
    selection.removeAllRanges()
    selection.addRange(multiLineCodeRange)
    document.dispatchEvent(new Event('selectionchange'))

    fireEvent.keyDown(wysiwygEl, { key: 'f', ctrlKey: true })
    expect(wysiwygInput.value).toBe('bold word')

    // Dragging selection inside WYSIWYG code block header while a prior ProseMirror paragraph selection exists
    // must NOT leak the stale ProseMirror selection on Ctrl+F
    const priorParagraphRange = document.createRange()
    priorParagraphRange.selectNodeContents(paragraphs[1].firstChild!)
    selection.removeAllRanges()
    selection.addRange(priorParagraphRange)
    wysiwygEl.focus()
    fireEvent.mouseUp(paragraphs[1])
    document.dispatchEvent(new Event('selectionchange'))

    const wysiwygCopyBtn = codeBlock.querySelector('.code-block-copy-btn')!
    const headerChromeRange = document.createRange()
    headerChromeRange.selectNodeContents(wysiwygCopyBtn)
    selection.removeAllRanges()
    selection.addRange(headerChromeRange)

    fireEvent.keyDown(wysiwygEl, { key: 'f', ctrlKey: true })
    expect(wysiwygInput.value).toBe('bold word')

    await user.click(within(wysiwygBar).getByRole('button', { name: '찾기 바 닫기' }))

    // 2. Preview single-line selection -> Ctrl+F auto-fills, multi-block and chrome ignored
    rerender(
      <DocumentEditor
        document={doc}
        tab={createTab('preview')}
        theme="light"
        autoSave={false}
        onChangeContent={vi.fn()}
        onSave={vi.fn()}
        onUpdateViewState={vi.fn()}
      />
    )
    const previewEl = screen.getByTestId('document-editor')
    const previewParagraphs = previewEl.querySelectorAll('p')
    const previewSingleRange = document.createRange()
    previewSingleRange.setStart(previewParagraphs[0].firstChild!, 0)
    previewSingleRange.setEnd(previewParagraphs[0].querySelector('strong')!.firstChild!, 4)
    selection.removeAllRanges()
    selection.addRange(previewSingleRange)

    fireEvent.keyDown(previewEl, { key: 'f', ctrlKey: true })
    const previewBar = screen.getByRole('region', { name: '문서 내 찾기 바' })
    const previewInput = within(previewBar).getByRole('textbox', {
      name: '문서 내 검색어 입력'
    }) as HTMLInputElement
    expect(previewInput.value).toBe('First bold')
    expect(previewInput).toHaveFocus()

    // Selection inside code block header ('코드 복사' / language label) must NOT overwrite query
    const copyBtn = previewEl.querySelector('.code-block-copy-btn')!
    const chromeRange = document.createRange()
    chromeRange.selectNodeContents(copyBtn)
    selection.removeAllRanges()
    selection.addRange(chromeRange)

    fireEvent.keyDown(previewEl, { key: 'f', ctrlKey: true })
    expect(previewInput.value).toBe('First bold')

    // Cross-block selection across <p> elements in Preview must NOT overwrite query
    const previewCrossRange = document.createRange()
    previewCrossRange.setStart(previewParagraphs[0].firstChild!, 0)
    previewCrossRange.setEnd(previewParagraphs[1].firstChild!, 6)
    selection.removeAllRanges()
    selection.addRange(previewCrossRange)

    fireEvent.keyDown(previewEl, { key: 'f', ctrlKey: true })
    expect(previewInput.value).toBe('First bold')
    selection.removeAllRanges()
  })

  it('preserves Find Bar state, query, options, and active match across Raw <-> 위지윅 <-> Preview <-> Split switches without polluting markdown', async () => {
    const user = userEvent.setup()
    const md = [
      '# Target Heading',
      '',
      'See [link](https://target.example.com) and final target word'
    ].join('\n')
    const doc = createDoc({ content: md, savedContent: md })
    let tab = createTab('raw', 0.5)
    const onChangeContent = vi.fn()

    const renderEditor = () => (
      <DocumentEditor
        document={doc}
        tab={tab}
        theme="light"
        autoSave={false}
        onChangeContent={onChangeContent}
        onSave={vi.fn()}
        onUpdateViewState={(patch) => {
          tab = { ...tab, ...patch }
          rerender(renderEditor())
        }}
      />
    )

    const { container, rerender } = render(renderEditor())
    const modeGroup = () => screen.getByRole('group', { name: '에디터 모드 전환' })

    // 1. Start in Raw mode, open Find Bar, search 'target', toggle whole-word (ab), advance to 2 / 3
    await user.click(screen.getByRole('button', { name: '문서 내 찾기' }))
    const findBar = () => screen.getByRole('region', { name: '문서 내 찾기 바' })
    const findInput = () =>
      within(findBar()).getByRole('textbox', { name: '문서 내 검색어 입력' }) as HTMLInputElement

    await user.type(findInput(), 'target')
    await user.click(within(findBar()).getByRole('button', { name: /단어 단위/ }))
    expect(within(findBar()).getByText('1 / 3')).toBeInTheDocument()
    fireEvent.keyDown(findInput(), { key: 'Enter' })
    expect(within(findBar()).getByText('2 / 3')).toBeInTheDocument()

    // 2. Switch Raw -> 위지윅: preserves query & ab, clamps into 2 rendered matches ('2 / 2')
    await user.click(within(modeGroup()).getByRole('button', { name: '위지윅' }))
    expect(findInput().value).toBe('target')
    expect(within(findBar()).getByRole('button', { name: /단어 단위/ })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    expect(within(findBar()).getByText('2 / 2')).toBeInTheDocument()
    expect(container.querySelectorAll('.pm-search-match')).toHaveLength(2)
    expect(container.querySelectorAll('.pm-search-match')[1]).toHaveClass('pm-search-match-active')

    // 3. Switch 위지윅 -> Preview: preserves query & ab, highlights 2 Preview matches ('2 / 2')
    await user.click(within(modeGroup()).getByRole('button', { name: 'Preview' }))
    expect(findInput().value).toBe('target')
    expect(within(findBar()).getByRole('button', { name: /단어 단위/ })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    expect(within(findBar()).getByText('2 / 2')).toBeInTheDocument()
    expect(container.querySelectorAll('.preview-search-match')).toHaveLength(2)
    expect(container.querySelectorAll('.preview-search-match')[1]).toHaveClass(
      'preview-search-match-active'
    )

    // 4. Switch Preview -> Split: Raw drives '2 / 3', right Preview simultaneously highlights 2 matches
    await user.click(within(modeGroup()).getByRole('button', { name: 'Split' }))
    expect(findInput().value).toBe('target')
    expect(within(findBar()).getByText('2 / 3')).toBeInTheDocument()
    expect(container.querySelectorAll('.cm-search-match')).toHaveLength(3)
    expect(
      screen.getByTestId('split-markdown-preview').querySelectorAll('.preview-search-match')
    ).toHaveLength(2)

    // 5. Switch Split -> Raw: preserves '2 / 3' and never mutated markdown
    await user.click(within(modeGroup()).getByRole('button', { name: 'Raw' }))
    expect(findInput().value).toBe('target')
    expect(within(findBar()).getByText('2 / 3')).toBeInTheDocument()
    expect(onChangeContent).not.toHaveBeenCalled()
  })
})
