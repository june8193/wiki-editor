import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildWikiAssetUrl } from '@shared/assets'
import type { DiagramSaveRequest } from '@shared/ipc'
import type { RendererLogPayload } from '@shared/logging'
import type { WorkspaceEntry } from '@shared/workspace'
import { App } from './App'
import { defaultMermaidRenderer } from './editor/mermaidRenderer'
import {
  mockPrototypeScrollIntoView,
  switchPaneEditorMode,
  switchWorkspaceFromView
} from './test/appTestHelpers'
import { mockElementBoundingRect, mountThemeStylesAndRoot } from './test/domLayoutStub'
import {
  appendRawEditorText,
  createInMemoryWikiApi,
  getRawEditorScroller,
  getRawEditorSelection,
  getRawEditorText,
  getRawEditorView,
  setRawEditorSelection,
  setRawEditorText,
  triggerMenuCommand
} from './test/inMemoryWikiHarness'
import { installSvgCanvasStub } from './test/svgCanvasStub'

const mermaidMockState = await vi.hoisted(async () =>
  (await import('./test/appTestHelpers')).createMermaidMockState()
)

vi.mock('mermaid', () => mermaidMockState.module)

describe('Three-mode markdown editor, split mode sync, and table editing', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-theme')
    vi.useRealTimers()
  })

  it('supports Left Raw + Right Preview live sync in split view and lossless Raw <-> WYSIWYG <-> Preview roundtrips', async () => {
    const user = userEvent.setup()
    const initialMd = '# Title\n\n*   kept   spacing\n\n- [x] Done'
    const { api, emitMenuCommand, getFilesSnapshot } = createInMemoryWikiApi(
      { autoSave: false },
      {
        selectedFolder: 'C:\\wiki\\modes',
        workspaces: {
          'C:\\wiki\\modes': {
            'doc.md': initialMd
          }
        }
      }
    )
    window.wikiApi = api

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    await user.click(await screen.findByText('doc.md'))

    const primaryPane = screen.getByTestId('pane-primary')
    fireEvent.contextMenu(within(primaryPane).getByRole('tab', { name: /doc\.md/i }))
    await user.click(
      within(await screen.findByRole('menu', { name: '탭 작업 메뉴' })).getByRole('menuitem', {
        name: '분할 영역에 복제 열기'
      })
    )

    const secondaryPane = screen.getByTestId('pane-secondary')
    await switchPaneEditorMode(user, secondaryPane, 'Preview')

    expect(within(secondaryPane).getByLabelText('마크다운 미리보기')).toBeInTheDocument()
    expect(
      within(secondaryPane).getByRole('heading', { level: 1, name: 'Title' })
    ).toBeInTheDocument()
    expect(within(secondaryPane).getByRole('checkbox')).toBeChecked()

    // Edit Left Raw -> Right Preview reflects edit live via shared DocumentBufferStore
    const primaryEditor = within(primaryPane).getByTestId('document-editor')
    appendRawEditorText(primaryEditor, '\n\nLive Paragraph')

    expect(within(secondaryPane).getByText('Live Paragraph')).toBeInTheDocument()
    expect(within(primaryPane).getByTestId('dirty-indicator')).toBeInTheDocument()
    expect(within(secondaryPane).getByTestId('dirty-indicator')).toBeInTheDocument()

    // Save via Ctrl+S
    fireEvent.keyDown(primaryEditor, { key: 's', ctrlKey: true })
    await waitFor(() => {
      expect(screen.queryByTestId('dirty-indicator')).not.toBeInTheDocument()
    })
    expect(getFilesSnapshot().get('C:/wiki/modes/doc.md')).toContain('Live Paragraph')

    // Roundtrip Raw -> 위지윅 -> Preview -> Split -> Raw without editing must keep buffer clean and formatting intact
    fireEvent.keyDown(within(primaryPane).getByTestId('document-editor'), { key: '2', ctrlKey: true })
    expect(
      within(primaryPane).getByRole('toolbar', { name: '위지윅 서식 툴바' })
    ).toBeInTheDocument()

    fireEvent.keyDown(within(primaryPane).getByTestId('document-editor'), { key: '3', ctrlKey: true })
    expect(within(primaryPane).getByLabelText('마크다운 미리보기')).toBeInTheDocument()

    fireEvent.keyDown(within(primaryPane).getByTestId('document-editor'), {
      key: 'M',
      ctrlKey: true,
      shiftKey: true
    })
    expect(within(primaryPane).getByTestId('split-markdown-preview')).toBeInTheDocument()
    expect(within(primaryPane).queryByTestId('dirty-indicator')).not.toBeInTheDocument()

    fireEvent.keyDown(within(primaryPane).getByTestId('document-editor'), {
      key: 'M',
      ctrlKey: true,
      shiftKey: true
    })
    const roundtrippedRaw = within(primaryPane).getByTestId('document-editor')
    expect(getRawEditorText(roundtrippedRaw)).toContain('*   kept   spacing')
    expect(within(primaryPane).queryByTestId('dirty-indicator')).not.toBeInTheDocument()
  })

  it('supports GFM table insertion and row/column add/delete in both Raw mode and WYSIWYG mode', async () => {
    const user = userEvent.setup()
    const { api, emitMenuCommand, getFilesSnapshot } = createInMemoryWikiApi(
      { autoSave: false },
      {
        selectedFolder: 'C:\\wiki\\tables',
        workspaces: {
          'C:\\wiki\\tables': {
            'raw-table.md': '',
            'wysiwyg-table.md': '# Table Demo\n\n'
          }
        }
      }
    )
    window.wikiApi = api

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    const sidebar = screen.getByLabelText('워크스페이스 탐색기')

    // 1) Raw mode table manipulation via TableMarkdownManipulator toolbar
    await user.click(await within(sidebar).findByText('raw-table.md'))
    const rawToolbar = screen.getByRole('toolbar', { name: 'Raw 표 편집 툴바' })
    await user.click(within(rawToolbar).getByRole('button', { name: '표 삽입' }))

    const rawEditor = screen.getByTestId('document-editor')
    const insertedText = getRawEditorText(rawEditor)
    expect(insertedText).toContain('| 열 1 | 열 2 | 열 3 |')

    const insertedLines = insertedText.split('\n')
    const bodyCellOffset = insertedLines[0].length + 1 + insertedLines[1].length + 1 + 2
    setRawEditorSelection(rawEditor, bodyCellOffset, bodyCellOffset)
    await user.click(within(rawToolbar).getByRole('button', { name: '행 아래 추가' }))
    await user.click(within(rawToolbar).getByRole('button', { name: '열 우 추가' }))

    fireEvent.keyDown(screen.getByTestId('document-editor'), { key: 's', ctrlKey: true })
    await waitFor(() => {
      expect(screen.queryByTestId('dirty-indicator')).not.toBeInTheDocument()
    })
    const savedRawTable = getFilesSnapshot().get('C:/wiki/tables/raw-table.md') ?? ''
    const rawTableLines = savedRawTable
      .trim()
      .split('\n')
      .filter((line) => line.startsWith('|'))
    // Initially 4 lines (header + separator + 2 body rows) -> +1 row = 5 lines, 3 cols -> +1 col = 4 cols
    expect(rawTableLines).toHaveLength(5)
    expect(rawTableLines[0].split('|').slice(1, -1)).toHaveLength(4)

    // 2) WYSIWYG mode table insertion + row/column add/delete
    await user.click(within(sidebar).getByText('wysiwyg-table.md'))
    const primaryPane = screen.getByTestId('pane-primary')
    await switchPaneEditorMode(user, primaryPane, '위지윅')

    const formatToolbar = screen.getByRole('toolbar', { name: '위지윅 서식 툴바' })
    await user.click(within(formatToolbar).getByRole('button', { name: '표 삽입' }))

    const tableToolbar = await screen.findByRole('toolbar', { name: '표 편집 툴바' })
    await user.click(within(tableToolbar).getByRole('button', { name: '행 아래 추가' }))
    await user.click(within(tableToolbar).getByRole('button', { name: '열 우 추가' }))

    const wysiwygEl = screen.getByTestId('document-editor')
    const tableEl = wysiwygEl.querySelector('table')
    expect(tableEl).not.toBeNull()
    expect(tableEl?.querySelectorAll('tr')).toHaveLength(4)
    expect(tableEl?.querySelector('tr')?.querySelectorAll('th, td')).toHaveLength(4)

    await user.click(within(tableToolbar).getByRole('button', { name: '현재 행 삭제' }))
    await user.click(within(tableToolbar).getByRole('button', { name: '현재 열 삭제' }))

    expect(wysiwygEl.querySelectorAll('table tr')).toHaveLength(3)
    expect(wysiwygEl.querySelector('table tr')?.querySelectorAll('th, td')).toHaveLength(3)

    fireEvent.keyDown(wysiwygEl, { key: 's', ctrlKey: true })
    await waitFor(() => {
      expect(screen.queryByTestId('dirty-indicator')).not.toBeInTheDocument()
    })
    expect(getFilesSnapshot().get('C:/wiki/tables/wysiwyg-table.md')).toContain('|')

    await switchPaneEditorMode(user, primaryPane, 'Preview')
    const previewTable = screen.getByTestId('document-editor').querySelector('table')
    expect(previewTable?.querySelectorAll('tr')).toHaveLength(3)
  })

  it('sanitizes XSS payloads in Preview mode and syncs editor theme across Light and Dark modes', async () => {
    const user = userEvent.setup()
    const { api, emitMenuCommand } = createInMemoryWikiApi(
      { theme: 'light', autoSave: false },
      {
        selectedFolder: 'C:\\wiki\\xss',
        workspaces: {
          'C:\\wiki\\xss': {
            'xss.md':
              '# Safe Title\n\n<script>alert(1)</script>\n\n<img src="x" onerror="alert(2)" />\n\n[Bad](javascript:alert(3))\n\n[Good](https://example.com)'
          }
        }
      }
    )
    window.wikiApi = api

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    await user.click(await screen.findByText('xss.md'))

    // Verify theme sync on CodeMirror 6 in Raw mode
    expect(document.querySelector('.cm-editor')?.getAttribute('data-theme-mode')).toBe('light')
    await triggerMenuCommand(emitMenuCommand, 'toggle-theme')
    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute('data-theme', 'dark')
      expect(document.querySelector('.cm-editor')?.getAttribute('data-theme-mode')).toBe('dark')
    })

    // Switch to Preview and verify XSS sanitization
    await switchPaneEditorMode(user, screen.getByTestId('pane-primary'), 'Preview')
    const previewEl = screen.getByTestId('document-editor')
    expect(previewEl.querySelector('script')).toBeNull()
    const imgEl = previewEl.querySelector('img')
    expect(imgEl?.getAttribute('onerror')).toBeNull()
    const badLink = screen.getByText('Bad').closest('a')
    expect(badLink?.getAttribute('href')).toBeNull()
    expect(screen.getByRole('link', { name: 'Good' })).toHaveAttribute(
      'href',
      'https://example.com'
    )
  })
})

describe('Mermaid rendering, Outline TOC, and hybrid heading auto-numbering', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-theme')
    vi.useRealTimers()
    defaultMermaidRenderer.clearCache()
    mermaidMockState.reset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders mermaid diagrams in Preview and WYSIWYG, syncs theme via cache, isolates syntax errors, and preserves roundtrip', async () => {
    const user = userEvent.setup()
    const diagramDoc = [
      '# Architecture',
      '',
      '```mermaid',
      'flowchart TD',
      '  A[Start] --> B[End]',
      '```',
      '',
      '```mermaid',
      'SYNTAX_ERROR broken node',
      '```'
    ].join('\n')

    const { api, emitMenuCommand } = createInMemoryWikiApi(
      { theme: 'light', showHeadingNumbers: true },
      {
        selectedFolder: 'C:\\wiki\\mermaid',
        workspaces: {
          'C:\\wiki\\mermaid': {
            'diagram.md': diagramDoc
          }
        }
      }
    )
    window.wikiApi = api

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    await user.click(await screen.findByText('diagram.md'))

    // Preview mode renders valid Mermaid SVG and isolates broken block without crashing
    const primaryPane = screen.getByTestId('pane-primary')
    await switchPaneEditorMode(user, primaryPane, 'Preview')

    await waitFor(() => {
      const svgs = screen.getByTestId('document-editor').querySelectorAll('svg[data-mermaid-theme]')
      expect(svgs).toHaveLength(1)
      expect(svgs[0].getAttribute('data-mermaid-theme')).toBe('default')
    })

    const errorAlert = screen.getByRole('alert')
    expect(errorAlert.textContent).toContain('Syntax error in Mermaid graph')
    expect(errorAlert.textContent).toContain('SYNTAX_ERROR broken node')

    // Switch theme Light -> Dark -> Light: Dark re-renders cleanly, Light back hits cache
    const callsAfterInitial = mermaidMockState.render.mock.calls.length
    await triggerMenuCommand(emitMenuCommand, 'toggle-theme')
    await waitFor(() => {
      const svg = screen.getByTestId('document-editor').querySelector('svg[data-mermaid-theme]')
      expect(svg?.getAttribute('data-mermaid-theme')).toBe('dark')
    })

    const callsAfterDark = mermaidMockState.render.mock.calls.length
    expect(callsAfterDark).toBeGreaterThan(callsAfterInitial)

    await triggerMenuCommand(emitMenuCommand, 'toggle-theme')
    await waitFor(() => {
      const svg = screen.getByTestId('document-editor').querySelector('svg[data-mermaid-theme]')
      expect(svg?.getAttribute('data-mermaid-theme')).toBe('default')
    })
    // Valid diagram hit cache on Light return; only the un-cached broken block might retry or wait — ensure valid diagram came from cache without doubling render count
    expect(
      mermaidMockState.render.mock.calls
        .slice(callsAfterDark)
        .filter(([, src]) => !String(src).includes('SYNTAX_ERROR'))
    ).toHaveLength(0)

    // Switch to WYSIWYG: Mermaid NodeView renders both SVG and error isolation
    await switchPaneEditorMode(user, primaryPane, '위지윅')
    await waitFor(() => {
      const blocks = within(screen.getByTestId('document-editor')).getAllByTestId('wysiwyg-mermaid-block')
      expect(blocks).toHaveLength(2)
      expect(blocks[0].querySelector('.mermaid-svg-container svg')?.getAttribute('data-mermaid-theme')).toBe(
        'default'
      )
      expect(within(blocks[1]).getByRole('alert').textContent).toContain('SYNTAX_ERROR broken node')
    })

    // Return to Raw: lossless roundtrip preserves original markdown without dirty flag
    await switchPaneEditorMode(user, primaryPane, 'Raw')
    expect(getRawEditorText(screen.getByTestId('document-editor'))).toBe(diagramDoc)
    expect(screen.queryByTestId('dirty-indicator')).not.toBeInTheDocument()
  })

  it('supports Mermaid action bar code copy, keyboard/hover reveal, WYSIWYG single-header placement, syntax-error/blank handling, and failure alerts across Preview, Split, and WYSIWYG modes', async () => {
    const user = userEvent.setup()
    const validSource = 'graph TD\n  SECRET_APP_FLOW --> ServiceB'
    const brokenSource = 'graph TD\n  SYNTAX_ERROR'
    const docContent = [
      '# Mermaid Copy E2E',
      '',
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

    const logEntries: RendererLogPayload[] = []
    let shouldFailCopy = false
    const copyText = vi.fn(async () => {
      if (shouldFailCopy) {
        throw new Error('App clipboard failure')
      }
    })

    const { api, emitMenuCommand } = createInMemoryWikiApi(
      { theme: 'light' },
      {
        selectedFolder: 'C:\\wiki\\mermaid-copy',
        workspaces: {
          'C:\\wiki\\mermaid-copy': {
            'actions.md': docContent
          }
        },
        diagram: { copyText },
        log: {
          write: vi.fn(async (payload: RendererLogPayload) => {
            logEntries.push(payload)
          })
        }
      }
    )
    window.wikiApi = api

    const { rootEl, cleanup } = mountThemeStylesAndRoot()
    try {
      render(<App />, { container: rootEl })
      await triggerMenuCommand(emitMenuCommand, 'open-folder')
      await user.click(await screen.findByText('actions.md'))

      const primaryPane = screen.getByTestId('pane-primary')

      // 1. Preview mode: floating bar hover/focus reveal, blank disabled, broken syntax copy allowed, multi-block isolation
      await switchPaneEditorMode(user, primaryPane, 'Preview')
      await waitFor(() => {
        expect(screen.getAllByTestId('mermaid-diagram')).toHaveLength(3)
        expect(screen.getByTestId('mermaid-svg')).toBeInTheDocument()
      })

      const previewBlocks = screen.getAllByTestId('mermaid-diagram')
      const previewValidToolbar = within(previewBlocks[0]).getByRole('toolbar', {
        name: 'Mermaid 다이어그램 작업'
      })
      const previewValidCopyBtn = within(previewValidToolbar).getByRole('button', { name: '코드 복사' })
      const previewBrokenCopyBtn = within(previewBlocks[1]).getByRole('button', { name: '코드 복사' })
      const previewBlankCopyBtn = within(previewBlocks[2]).getByRole('button', { name: '코드 복사' })

      expect(previewValidToolbar).toHaveClass('is-floating')
      expect(getComputedStyle(previewValidToolbar).opacity).toBe('0')
      expect(previewBlankCopyBtn).toBeDisabled()

      // Hover & focus reveal floating toolbar in Preview
      await user.hover(previewBlocks[0])
      expect(previewValidToolbar).toHaveClass('is-visible')
      expect(getComputedStyle(previewValidToolbar).opacity).toBe('1')
      await user.unhover(previewBlocks[0])
      expect(getComputedStyle(previewValidToolbar).opacity).toBe('0')

      previewValidCopyBtn.focus()
      expect(previewValidCopyBtn).toHaveFocus()
      expect(getComputedStyle(previewValidToolbar).opacity).toBe('1')

      // Click copy on valid block and broken syntax block -> independent feedback
      await user.click(previewValidCopyBtn)
      expect(copyText).toHaveBeenCalledWith(validSource)
      expect(previewValidCopyBtn).toHaveTextContent('복사됨')
      expect(previewBrokenCopyBtn).not.toHaveTextContent('복사됨')

      await user.hover(previewBlocks[1])
      await user.click(previewBrokenCopyBtn)
      expect(copyText).toHaveBeenLastCalledWith(brokenSource)

      // 2. Split mode: right preview pane renders floating action bar and copies source
      await switchPaneEditorMode(user, primaryPane, 'Split')
      const splitPreview = await screen.findByTestId('split-markdown-preview')
      const splitBlocks = within(splitPreview).getAllByTestId('mermaid-diagram')
      expect(splitBlocks).toHaveLength(3)
      const splitValidToolbar = within(splitBlocks[0]).getByRole('toolbar', {
        name: 'Mermaid 다이어그램 작업'
      })
      expect(splitValidToolbar).toHaveClass('is-floating')
      await user.hover(splitBlocks[0])
      await user.click(within(splitValidToolbar).getByRole('button', { name: '코드 복사' }))
      expect(copyText).toHaveBeenLastCalledWith(validSource)

      // 3. WYSIWYG mode: single integrated header toolbar beside 코드 편집 (zero floating preview toolbar)
      await switchPaneEditorMode(user, primaryPane, '위지윅')
      await waitFor(() => {
        expect(screen.getAllByTestId('wysiwyg-mermaid-block')).toHaveLength(3)
      })
      const wysiwygBlocks = screen.getAllByTestId('wysiwyg-mermaid-block')
      const wysiwygValidHeader = wysiwygBlocks[0].querySelector('.mermaid-node-header') as HTMLElement
      const wysiwygValidPreview = wysiwygBlocks[0].querySelector('.mermaid-node-preview') as HTMLElement
      expect(
        within(wysiwygBlocks[0]).getAllByRole('toolbar', { name: 'Mermaid 다이어그램 작업' })
      ).toHaveLength(1)
      expect(
        within(wysiwygValidHeader).getByRole('toolbar', { name: 'Mermaid 다이어그램 작업' })
      ).toHaveClass('is-inline')
      expect(within(wysiwygValidHeader).getByRole('button', { name: '코드 편집' })).toBeInTheDocument()
      expect(
        within(wysiwygValidPreview).queryByRole('toolbar', { name: 'Mermaid 다이어그램 작업' })
      ).not.toBeInTheDocument()
      expect(within(wysiwygBlocks[2]).getByRole('button', { name: '코드 복사' })).toBeDisabled()

      // Copy failure displays inline role="alert" scoped to that block + sanitized log without raw source
      shouldFailCopy = true
      const wysiwygValidCopyBtn = within(wysiwygValidHeader).getByRole('button', { name: '코드 복사' })
      await user.click(wysiwygValidCopyBtn)
      expect(within(wysiwygBlocks[0]).getByRole('alert')).toHaveTextContent('App clipboard failure')
      const failureLogs = logEntries.filter((entry) => entry.message === 'Mermaid code copy failed')
      expect(failureLogs).toHaveLength(1)
      expect(failureLogs[0]).toMatchObject({
        level: 'error',
        category: 'ui',
        data: { codeLength: validSource.length }
      })
      expect(JSON.stringify(logEntries)).not.toContain('SECRET_APP_FLOW')

      // Retry success with fake timers -> clears alert and reverts check feedback after 1500ms
      shouldFailCopy = false
      vi.useFakeTimers()
      await act(async () => {
        fireEvent.click(wysiwygValidCopyBtn)
        await Promise.resolve()
      })
      expect(within(wysiwygBlocks[0]).queryByRole('alert')).not.toBeInTheDocument()
      expect(wysiwygValidCopyBtn).toHaveTextContent('복사됨')
      act(() => {
        vi.advanceTimersByTime(1500)
      })
      expect(wysiwygValidCopyBtn).not.toHaveTextContent('복사됨')
      vi.useRealTimers()

      // Return to Raw: lossless roundtrip and clean buffer without dirty flag
      await switchPaneEditorMode(user, primaryPane, 'Raw')
      expect(getRawEditorText(screen.getByTestId('document-editor'))).toBe(docContent)
      expect(screen.queryByTestId('dirty-indicator')).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
      cleanup()
    }
  })

  it('supports Mermaid 2x theme-backed PNG clipboard copy across Preview, Split (live edit/error/recovery), and WYSIWYG modes with sanitized failure alerts', async () => {
    const user = userEvent.setup()
    const validSource = 'graph TD\n  SECRET_APP_IMG --> ServiceB'
    const brokenSource = 'graph TD\n  SYNTAX_ERROR'
    const docContent = [
      '# Mermaid Image E2E',
      '',
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

    const logEntries: RendererLogPayload[] = []
    let shouldFailCopyImage = false
    const copiedPngPayloads: Uint8Array[] = []
    const copyImage = vi.fn(async (bytes: Uint8Array) => {
      copiedPngPayloads.push(bytes)
      if (shouldFailCopyImage) {
        throw new Error('App PNG clipboard failed')
      }
    })

    const { api, emitMenuCommand } = createInMemoryWikiApi(
      { theme: 'light' },
      {
        selectedFolder: 'C:\\wiki\\mermaid-image-copy',
        workspaces: {
          'C:\\wiki\\mermaid-image-copy': {
            'diagram-export.md': docContent
          }
        },
        diagram: { copyImage },
        log: {
          write: vi.fn(async (payload: RendererLogPayload) => {
            logEntries.push(payload)
          })
        }
      }
    )
    window.wikiApi = api

    const canvasStub = installSvgCanvasStub()
    const { rootEl, cleanup } = mountThemeStylesAndRoot()
    try {
      render(<App />, { container: rootEl })
      await triggerMenuCommand(emitMenuCommand, 'open-folder')
      await user.click(await screen.findByText('diagram-export.md'))

      const primaryPane = screen.getByTestId('pane-primary')

      // 1. Preview mode: 이미지 복사 first in toolbar, light #ffffff 2x copy, broken/blank disabled
      await switchPaneEditorMode(user, primaryPane, 'Preview')
      await waitFor(() => {
        expect(screen.getAllByTestId('mermaid-diagram')).toHaveLength(3)
        expect(screen.getByTestId('mermaid-svg')).toBeInTheDocument()
      })

      const previewBlocks = screen.getAllByTestId('mermaid-diagram')
      const previewValidToolbar = within(previewBlocks[0]).getByRole('toolbar', {
        name: 'Mermaid 다이어그램 작업'
      })
      expect(
        within(previewValidToolbar)
          .getAllByRole('button')
          .map((button) => button.getAttribute('aria-label'))
      ).toEqual(['축소', '배율 초기화', '확대', '뷰 초기화', '이미지 복사', '코드 복사', 'PNG 저장', 'SVG 저장'])

      const previewValidImageBtn = within(previewValidToolbar).getByRole('button', {
        name: '이미지 복사'
      })
      const previewBrokenImageBtn = within(previewBlocks[1]).getByRole('button', {
        name: '이미지 복사'
      })
      const previewBrokenCodeBtn = within(previewBlocks[1]).getByRole('button', {
        name: '코드 복사'
      })
      const previewBlankImageBtn = within(previewBlocks[2]).getByRole('button', {
        name: '이미지 복사'
      })
      expect(previewValidImageBtn).toBeEnabled()
      expect(previewBrokenImageBtn).toBeDisabled()
      expect(previewBrokenCodeBtn).toBeEnabled()
      expect(previewBlankImageBtn).toBeDisabled()

      await user.hover(previewBlocks[0])
      await user.click(previewValidImageBtn)
      await waitFor(() => {
        expect(copyImage).toHaveBeenCalledTimes(1)
        expect(previewValidImageBtn).toHaveTextContent('복사됨')
      })
      expect(canvasStub.calls).toHaveLength(1)
      expect(canvasStub.calls[0]).toMatchObject({
        pixelWidth: 544,
        pixelHeight: 304
      })
      expect(canvasStub.calls[0].decodedSvg).toContain('width="272"')
      expect(canvasStub.calls[0].decodedSvg).toContain('height="152"')
      expect(canvasStub.calls[0].decodedSvg).toContain('fill="#ffffff"')
      expect(canvasStub.calls[0].decodedSvg).not.toContain('max-width')
      expect(copiedPngPayloads[0]).toEqual(new Uint8Array([137, 80, 78, 71, 1, 544 & 0xff]))

      // Toggle dark theme in Preview -> exports #161b22 dark background PNG
      await triggerMenuCommand(emitMenuCommand, 'toggle-theme')
      await waitFor(() => {
        expect(previewBlocks[0]).toHaveAttribute('data-mermaid-theme', 'dark')
        expect(previewValidImageBtn).toBeEnabled()
      })
      await user.hover(previewBlocks[0])
      await user.click(previewValidImageBtn)
      await waitFor(() => {
        expect(copyImage).toHaveBeenCalledTimes(2)
      })
      expect(canvasStub.calls).toHaveLength(2)
      expect(canvasStub.calls[1]).toMatchObject({
        pixelWidth: 544,
        pixelHeight: 304
      })
      expect(canvasStub.calls[1].decodedSvg).toContain('fill="#161b22"')
      expect(copiedPngPayloads[1]).toEqual(new Uint8Array([137, 80, 78, 71, 2, 544 & 0xff]))

      // Restore light theme for subsequent checks
      await triggerMenuCommand(emitMenuCommand, 'toggle-theme')
      await waitFor(() => {
        expect(previewBlocks[0]).toHaveAttribute('data-mermaid-theme', 'default')
        expect(previewValidImageBtn).toBeEnabled()
      })

      // 2. Split mode: image copy works, live edit to SYNTAX_ERROR disables 이미지 복사 while keeping 코드 복사 enabled, and recovery re-enables
      await switchPaneEditorMode(user, primaryPane, 'Split')
      const splitPreview = await screen.findByTestId('split-markdown-preview')
      await waitFor(() => {
        expect(within(splitPreview).getAllByTestId('mermaid-diagram')).toHaveLength(3)
        expect(
          within(within(splitPreview).getAllByTestId('mermaid-diagram')[0]).getByRole('button', {
            name: '이미지 복사'
          })
        ).toBeEnabled()
      })

      const splitBlocks = within(splitPreview).getAllByTestId('mermaid-diagram')
      const splitImageBtn = within(splitBlocks[0]).getByRole('button', { name: '이미지 복사' })
      const splitCodeBtn = within(splitBlocks[0]).getByRole('button', { name: '코드 복사' })
      await user.hover(splitBlocks[0])
      await user.click(splitImageBtn)
      await waitFor(() => {
        expect(copyImage).toHaveBeenCalledTimes(3)
      })

      const splitRawEditor = document.querySelector('.editor-split-region.is-raw') as HTMLElement
      const brokenLiveDoc = docContent.replace(validSource, 'graph TD\n  SYNTAX_ERROR_LIVE')
      setRawEditorText(splitRawEditor, brokenLiveDoc)

      // Immediately during debounce wait and after syntax error banner appears, 이미지 복사 is disabled while 코드 복사 remains active
      expect(splitImageBtn).toBeDisabled()
      expect(splitCodeBtn).toBeEnabled()
      await waitFor(() => {
        expect(within(splitBlocks[0]).getByText('Mermaid 문법 오류')).toBeInTheDocument()
      })
      expect(splitImageBtn).toBeDisabled()
      expect(splitCodeBtn).toBeEnabled()

      // Recover original valid source -> re-enables 이미지 복사 cleanly without leaving dirty state
      setRawEditorText(splitRawEditor, docContent)
      await waitFor(() => {
        expect(within(splitBlocks[0]).queryByText('Mermaid 문법 오류')).not.toBeInTheDocument()
        expect(splitImageBtn).toBeEnabled()
      })

      // 3. WYSIWYG mode: inline 이미지 복사 before 코드 복사, scoped failure alert, sanitized log, and 1500ms feedback timer
      await switchPaneEditorMode(user, primaryPane, '위지윅')
      await waitFor(() => {
        expect(screen.getAllByTestId('wysiwyg-mermaid-block')).toHaveLength(3)
        expect(
          within(screen.getAllByTestId('wysiwyg-mermaid-block')[0]).getByRole('button', {
            name: '이미지 복사'
          })
        ).toBeEnabled()
      })

      const wysiwygBlocks = screen.getAllByTestId('wysiwyg-mermaid-block')
      const wysiwygValidToolbar = within(wysiwygBlocks[0]).getByRole('toolbar', {
        name: 'Mermaid 다이어그램 작업'
      })
      expect(
        within(wysiwygValidToolbar)
          .getAllByRole('button')
          .map((button) => button.getAttribute('aria-label'))
      ).toEqual(['축소', '배율 초기화', '확대', '뷰 초기화', '이미지 복사', '코드 복사', 'PNG 저장', 'SVG 저장'])
      expect(
        within(wysiwygBlocks[1]).getByRole('button', { name: '이미지 복사' })
      ).toBeDisabled()
      expect(
        within(wysiwygBlocks[2]).getByRole('button', { name: '이미지 복사' })
      ).toBeDisabled()

      const wysiwygValidImageBtn = within(wysiwygValidToolbar).getByRole('button', {
        name: '이미지 복사'
      })

      shouldFailCopyImage = true
      await user.click(wysiwygValidImageBtn)
      await waitFor(() => {
        expect(wysiwygBlocks[0].querySelector('.mermaid-action-error')).toHaveTextContent(
          'App PNG clipboard failed'
        )
      })
      const wysiwygActionAlert = wysiwygBlocks[0].querySelector('.mermaid-action-error')
      expect(wysiwygActionAlert).toHaveAttribute('role', 'alert')
      expect(wysiwygBlocks[1].querySelector('.mermaid-action-error')).toBeNull()
      expect(wysiwygBlocks[2].querySelector('.mermaid-action-error')).toBeNull()

      const imageFailureLogs = logEntries.filter(
        (entry) => entry.message === 'Mermaid image copy failed'
      )
      expect(imageFailureLogs).toHaveLength(1)
      expect(imageFailureLogs[0]).toMatchObject({
        level: 'error',
        category: 'ui',
        data: {
          theme: 'light',
          codeLength: validSource.length,
          byteLength: 6
        }
      })
      expect(typeof (imageFailureLogs[0].data as { svgLength?: unknown }).svgLength).toBe('number')
      expect(JSON.stringify(imageFailureLogs[0])).not.toContain('SECRET_APP_IMG')
      expect(JSON.stringify(imageFailureLogs[0])).not.toContain('<svg')
      expect(JSON.stringify(imageFailureLogs[0])).not.toContain('137')

      shouldFailCopyImage = false
      vi.useFakeTimers()
      await act(async () => {
        fireEvent.click(wysiwygValidImageBtn)
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(wysiwygBlocks[0].querySelector('.mermaid-action-error')).toBeNull()
      expect(wysiwygValidImageBtn).toHaveTextContent('복사됨')
      act(() => {
        vi.advanceTimersByTime(1500)
      })
      expect(wysiwygValidImageBtn).not.toHaveTextContent('복사됨')
      vi.useRealTimers()

      // Return to Raw: lossless roundtrip and clean buffer without dirty flag
      await switchPaneEditorMode(user, primaryPane, 'Raw')
      expect(getRawEditorText(screen.getByTestId('document-editor'))).toBe(docContent)
      expect(screen.queryByTestId('dirty-indicator')).not.toBeInTheDocument()
    } finally {
      canvasStub.restore()
      vi.useRealTimers()
      cleanup()
    }
  })

  it('supports Mermaid PNG and SVG file export with sanitized document title across Preview, Split, and WYSIWYG modes', async () => {
    const user = userEvent.setup()
    const validSource = 'graph TD\n  SECRET_APP_SAVE --> ServiceC'
    const brokenSource = 'graph TD\n  SYNTAX_ERROR'
    const docContent = [
      '# Mermaid Save E2E',
      '',
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

    const logEntries: RendererLogPayload[] = []
    let nextSaveOutcome: 'confirm' | 'cancel' | 'fail' = 'confirm'
    const savedRequests: DiagramSaveRequest[] = []
    const saveFile = vi.fn(async (request: DiagramSaveRequest) => {
      savedRequests.push(request)
      if (nextSaveOutcome === 'fail') {
        throw new Error('App diagram file save failed')
      }
      if (nextSaveOutcome === 'cancel') {
        return { canceled: true }
      }
      return {
        canceled: false,
        filePath: `C:\\exports\\${request.suggestedName}`
      }
    })

    const { api, emitMenuCommand } = createInMemoryWikiApi(
      { theme: 'light' },
      {
        selectedFolder: 'C:\\wiki\\mermaid-file-save',
        workspaces: {
          'C:\\wiki\\mermaid-file-save': {
            '아키텍처<설계>-v1.md': docContent
          }
        },
        diagram: { saveFile },
        log: {
          write: vi.fn(async (payload: RendererLogPayload) => {
            logEntries.push(payload)
          })
        }
      }
    )
    window.wikiApi = api

    const canvasStub = installSvgCanvasStub()
    const { rootEl, cleanup } = mountThemeStylesAndRoot()
    try {
      render(<App />, { container: rootEl })
      await triggerMenuCommand(emitMenuCommand, 'open-folder')
      await user.click(await screen.findByText('아키텍처<설계>-v1.md'))

      const primaryPane = screen.getByTestId('pane-primary')

      // 1. Preview mode: 4 buttons in order, PNG light export, dark SVG export, dialog cancel, disabled states
      await switchPaneEditorMode(user, primaryPane, 'Preview')
      await waitFor(() => {
        expect(screen.getAllByTestId('mermaid-diagram')).toHaveLength(3)
        expect(screen.getByTestId('mermaid-svg')).toBeInTheDocument()
      })

      const previewBlocks = screen.getAllByTestId('mermaid-diagram')
      const previewValidToolbar = within(previewBlocks[0]).getByRole('toolbar', {
        name: 'Mermaid 다이어그램 작업'
      })
      expect(
        within(previewValidToolbar)
          .getAllByRole('button')
          .map((button) => button.getAttribute('aria-label'))
      ).toEqual(['축소', '배율 초기화', '확대', '뷰 초기화', '이미지 복사', '코드 복사', 'PNG 저장', 'SVG 저장'])

      const previewSavePngBtn = within(previewValidToolbar).getByRole('button', {
        name: 'PNG 저장'
      })
      const previewSaveSvgBtn = within(previewValidToolbar).getByRole('button', {
        name: 'SVG 저장'
      })
      expect(previewSavePngBtn).toBeEnabled()
      expect(previewSaveSvgBtn).toBeEnabled()
      expect(within(previewBlocks[1]).getByRole('button', { name: 'PNG 저장' })).toBeDisabled()
      expect(within(previewBlocks[1]).getByRole('button', { name: 'SVG 저장' })).toBeDisabled()
      expect(within(previewBlocks[1]).getByRole('button', { name: '코드 복사' })).toBeEnabled()
      expect(within(previewBlocks[2]).getByRole('button', { name: 'PNG 저장' })).toBeDisabled()
      expect(within(previewBlocks[2]).getByRole('button', { name: 'SVG 저장' })).toBeDisabled()

      await user.hover(previewBlocks[0])
      await user.click(previewSavePngBtn)
      await waitFor(() => {
        expect(saveFile).toHaveBeenCalledTimes(1)
        expect(previewSavePngBtn).toHaveTextContent('저장됨')
      })
      expect(previewSavePngBtn).toHaveAttribute('title', '저장됨')
      expect(savedRequests[0].format).toBe('png')
      expect(savedRequests[0].suggestedName).toBe('아키텍처설계-v1-diagram.png')
      expect(savedRequests[0].data).toEqual(new Uint8Array([137, 80, 78, 71, 1, 544 & 0xff]))
      expect(canvasStub.calls[0]).toMatchObject({ pixelWidth: 544, pixelHeight: 304 })
      expect(canvasStub.calls[0].decodedSvg).toContain('width="272"')
      expect(canvasStub.calls[0].decodedSvg).toContain('height="152"')
      expect(canvasStub.calls[0].decodedSvg).toContain('fill="#ffffff"')

      // Toggle dark theme -> SVG 저장 exports standalone XML SVG with #161b22 background and 16px margin
      await triggerMenuCommand(emitMenuCommand, 'toggle-theme')
      await waitFor(() => {
        expect(previewBlocks[0]).toHaveAttribute('data-mermaid-theme', 'dark')
        expect(previewSaveSvgBtn).toBeEnabled()
      })
      await user.hover(previewBlocks[0])
      await user.click(previewSaveSvgBtn)
      await waitFor(() => {
        expect(saveFile).toHaveBeenCalledTimes(2)
        expect(previewSaveSvgBtn).toHaveTextContent('저장됨')
      })
      expect(savedRequests[1].format).toBe('svg')
      expect(savedRequests[1].suggestedName).toBe('아키텍처설계-v1-diagram.svg')
      const svgText = String(savedRequests[1].data)
      const parsedSvgDoc = new DOMParser().parseFromString(svgText, 'image/svg+xml')
      expect(parsedSvgDoc.querySelector('parsererror')).toBeNull()
      expect(svgText).toContain('xmlns="http://www.w3.org/2000/svg"')
      expect(svgText).toContain('width="272"')
      expect(svgText).toContain('height="152"')
      expect(svgText).toContain('fill="#161b22"')

      // Dialog cancel leaves no saved feedback and no error alert
      await triggerMenuCommand(emitMenuCommand, 'toggle-theme')
      await waitFor(() => {
        expect(previewBlocks[0]).toHaveAttribute('data-mermaid-theme', 'default')
        expect(previewSaveSvgBtn).toBeEnabled()
      })
      nextSaveOutcome = 'cancel'
      await user.click(previewSavePngBtn)
      await waitFor(() => {
        expect(saveFile).toHaveBeenCalledTimes(3)
        expect(previewSavePngBtn).toBeEnabled()
      })
      expect(previewSavePngBtn).not.toHaveTextContent('저장됨')
      expect(previewBlocks[0].querySelector('.mermaid-action-error')).toBeNull()
      nextSaveOutcome = 'confirm'

      // 2. Split mode: PNG/SVG export uses document title, syntax error disables both while keeping 코드 복사 active
      await switchPaneEditorMode(user, primaryPane, 'Split')
      const splitPreview = await screen.findByTestId('split-markdown-preview')
      await waitFor(() => {
        expect(within(splitPreview).getAllByTestId('mermaid-diagram')).toHaveLength(3)
        expect(
          within(within(splitPreview).getAllByTestId('mermaid-diagram')[0]).getByRole('button', {
            name: 'PNG 저장'
          })
        ).toBeEnabled()
      })

      const splitBlocks = within(splitPreview).getAllByTestId('mermaid-diagram')
      const splitSavePngBtn = within(splitBlocks[0]).getByRole('button', { name: 'PNG 저장' })
      const splitSaveSvgBtn = within(splitBlocks[0]).getByRole('button', { name: 'SVG 저장' })
      const splitCodeBtn = within(splitBlocks[0]).getByRole('button', { name: '코드 복사' })
      await user.hover(splitBlocks[0])
      await user.click(splitSaveSvgBtn)
      await waitFor(() => {
        expect(saveFile).toHaveBeenCalledTimes(4)
      })
      expect(savedRequests[3].format).toBe('svg')
      expect(savedRequests[3].suggestedName).toBe('아키텍처설계-v1-diagram.svg')

      const splitRawEditor = document.querySelector('.editor-split-region.is-raw') as HTMLElement
      setRawEditorText(
        splitRawEditor,
        docContent.replace(validSource, 'graph TD\n  SYNTAX_ERROR_LIVE_SAVE')
      )
      expect(splitSavePngBtn).toBeDisabled()
      expect(splitSaveSvgBtn).toBeDisabled()
      expect(splitCodeBtn).toBeEnabled()
      await waitFor(() => {
        expect(within(splitBlocks[0]).getByText('Mermaid 문법 오류')).toBeInTheDocument()
      })
      expect(splitSavePngBtn).toBeDisabled()
      expect(splitSaveSvgBtn).toBeDisabled()
      expect(splitCodeBtn).toBeEnabled()

      setRawEditorText(splitRawEditor, docContent)
      await waitFor(() => {
        expect(within(splitBlocks[0]).queryByText('Mermaid 문법 오류')).not.toBeInTheDocument()
        expect(splitSavePngBtn).toBeEnabled()
        expect(splitSaveSvgBtn).toBeEnabled()
      })

      // 3. WYSIWYG mode: 4 buttons, doc title propagation, failure alert + sanitized logs, and 1500ms timer revert
      await switchPaneEditorMode(user, primaryPane, '위지윅')
      await waitFor(() => {
        expect(screen.getAllByTestId('wysiwyg-mermaid-block')).toHaveLength(3)
        expect(
          within(screen.getAllByTestId('wysiwyg-mermaid-block')[0]).getByRole('button', {
            name: 'SVG 저장'
          })
        ).toBeEnabled()
      })

      const wysiwygBlocks = screen.getAllByTestId('wysiwyg-mermaid-block')
      const wysiwygValidToolbar = within(wysiwygBlocks[0]).getByRole('toolbar', {
        name: 'Mermaid 다이어그램 작업'
      })
      expect(
        within(wysiwygValidToolbar)
          .getAllByRole('button')
          .map((button) => button.getAttribute('aria-label'))
      ).toEqual(['축소', '배율 초기화', '확대', '뷰 초기화', '이미지 복사', '코드 복사', 'PNG 저장', 'SVG 저장'])
      expect(within(wysiwygBlocks[1]).getByRole('button', { name: 'PNG 저장' })).toBeDisabled()
      expect(within(wysiwygBlocks[1]).getByRole('button', { name: 'SVG 저장' })).toBeDisabled()
      expect(within(wysiwygBlocks[2]).getByRole('button', { name: 'PNG 저장' })).toBeDisabled()
      expect(within(wysiwygBlocks[2]).getByRole('button', { name: 'SVG 저장' })).toBeDisabled()

      const wysiwygSavePngBtn = within(wysiwygValidToolbar).getByRole('button', {
        name: 'PNG 저장'
      })
      const wysiwygSaveSvgBtn = within(wysiwygValidToolbar).getByRole('button', {
        name: 'SVG 저장'
      })

      nextSaveOutcome = 'fail'
      await user.click(wysiwygSaveSvgBtn)
      await waitFor(() => {
        expect(wysiwygBlocks[0].querySelector('.mermaid-action-error')).toHaveTextContent(
          'App diagram file save failed'
        )
      })
      const svgSaveAlert = wysiwygBlocks[0].querySelector('.mermaid-action-error')
      expect(svgSaveAlert).toHaveAttribute('role', 'alert')
      expect(wysiwygBlocks[1].querySelector('.mermaid-action-error')).toBeNull()
      expect(wysiwygBlocks[2].querySelector('.mermaid-action-error')).toBeNull()

      await user.click(wysiwygSavePngBtn)
      await waitFor(() => {
        expect(saveFile).toHaveBeenCalledTimes(6)
      })
      expect(savedRequests[4].suggestedName).toBe('아키텍처설계-v1-diagram.svg')
      expect(savedRequests[5].suggestedName).toBe('아키텍처설계-v1-diagram.png')

      const saveFailureLogs = logEntries.filter(
        (entry) =>
          entry.level === 'error' &&
          (entry.message === 'Mermaid SVG save failed' ||
            entry.message === 'Mermaid PNG save failed')
      )
      expect(saveFailureLogs).toHaveLength(2)
      expect(saveFailureLogs[0]).toMatchObject({
        message: 'Mermaid SVG save failed',
        data: {
          format: 'svg',
          theme: 'light',
          codeLength: validSource.length
        }
      })
      expect(typeof (saveFailureLogs[0].data as { svgLength?: unknown }).svgLength).toBe('number')
      expect(saveFailureLogs[1]).toMatchObject({
        message: 'Mermaid PNG save failed',
        data: {
          format: 'png',
          theme: 'light',
          codeLength: validSource.length,
          byteLength: 6
        }
      })
      const serializedFailureData = JSON.stringify(saveFailureLogs.map((entry) => entry.data))
      expect(serializedFailureData).not.toContain('SECRET_APP_SAVE')
      expect(serializedFailureData).not.toContain('아키텍처')
      expect(serializedFailureData).not.toContain('<svg')
      expect(serializedFailureData).not.toContain('137')

      // Recover via PNG save and verify 1500ms '저장됨' indicator revert
      nextSaveOutcome = 'confirm'
      vi.useFakeTimers()
      await act(async () => {
        fireEvent.click(wysiwygSavePngBtn)
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(wysiwygBlocks[0].querySelector('.mermaid-action-error')).toBeNull()
      expect(wysiwygSavePngBtn).toHaveTextContent('저장됨')
      expect(wysiwygSavePngBtn).toHaveAttribute('title', '저장됨')
      act(() => {
        vi.advanceTimersByTime(1500)
      })
      expect(wysiwygSavePngBtn).not.toHaveTextContent('저장됨')
      expect(wysiwygSavePngBtn).toHaveAttribute('title', 'PNG 저장')
      vi.useRealTimers()

      // Return to Raw: lossless roundtrip and clean buffer without dirty flag
      await switchPaneEditorMode(user, primaryPane, 'Raw')
      expect(getRawEditorText(screen.getByTestId('document-editor'))).toBe(docContent)
      expect(screen.queryByTestId('dirty-indicator')).not.toBeInTheDocument()
    } finally {
      canvasStub.restore()
      vi.useRealTimers()
      cleanup()
    }
  })

  it('updates sidebar Outline ignoring code fences, toggles showHeadingNumbers only for Outline with persistence, and scrolls to headings across modes', async () => {
    const user = userEvent.setup()
    const { mock: scrollIntoViewMock, restore } = mockPrototypeScrollIntoView()

    try {
      const guideDoc = [
        '# Intro',
        '',
        '```bash',
        '# Ignored Comment',
        '```',
        '',
        '## Setup',
        '### Step One'
      ].join('\n')

      const { api, emitMenuCommand, getFilesSnapshot } = createInMemoryWikiApi(
        { theme: 'light', showHeadingNumbers: true },
        {
          selectedFolder: 'C:\\wiki\\outline',
          workspaces: {
            'C:\\wiki\\outline': {
              'guide.md': guideDoc
            }
          }
        }
      )
      window.wikiApi = api

      const firstRender = render(<App />)
      await triggerMenuCommand(emitMenuCommand, 'open-folder')
      await user.click(await screen.findByText('guide.md'))

      const rightSidebar = screen.getByRole('complementary', { name: '우측 사이드바' })
      const outline = within(rightSidebar).getByRole('region', { name: '문서 목차 (Outline)' })
      const items = within(within(outline).getByRole('list')).getAllByRole('listitem')
      expect(items).toHaveLength(3)
      expect(items[0].textContent).toContain('1.')
      expect(items[1].textContent).toContain('1.1.')
      expect(items[2].textContent).toContain('1.1.1.')
      expect(outline.textContent).not.toContain('Ignored Comment')

      // Click heading in Outline in Raw mode -> moves cursor to target heading line
      await user.click(within(items[1]).getByRole('button'))
      await waitFor(() => {
        expect(getRawEditorSelection(screen.getByTestId('document-editor')).start).toBe(
          guideDoc.indexOf('## Setup')
        )
      })

      // Preview renders source headings without dynamic numbering even when showHeadingNumbers is true
      const primaryPane = screen.getByTestId('pane-primary')
      await switchPaneEditorMode(user, primaryPane, 'Preview')
      const setupHeading = screen.getByRole('heading', { level: 2, name: 'Setup' })
      expect(setupHeading.textContent).toBe('Setup')

      scrollIntoViewMock.mockClear()
      await user.click(within(items[2]).getByRole('button'))
      expect(scrollIntoViewMock).toHaveBeenCalledTimes(2)
      expect(scrollIntoViewMock).toHaveBeenCalledWith({ block: 'start' })
      expect(scrollIntoViewMock).toHaveBeenCalledWith({ block: 'nearest' })

      // Toggle "목차 번호 표시" off via Outline button -> hides numbers in Outline only without dirtying buffer or re-scrolling
      const outlineToggleBtn = within(outline).getByRole('button', { name: '목차 번호 표시' })
      expect(outlineToggleBtn).toHaveAttribute('aria-pressed', 'true')
      await user.click(outlineToggleBtn)
      expect(outlineToggleBtn).toHaveAttribute('aria-pressed', 'false')
      expect(scrollIntoViewMock).toHaveBeenCalledTimes(2)
      expect(screen.getByRole('heading', { level: 2, name: 'Setup' }).textContent).toBe('Setup')
      expect(within(outline).queryByText('1.1.')).not.toBeInTheDocument()
      expect(screen.queryByTestId('dirty-indicator')).not.toBeInTheDocument()
      expect(getFilesSnapshot().get('C:/wiki/outline/guide.md')).toBe(guideDoc)

      // Verify WYSIWYG mode renders without dynamic numbers and performs one-shot click-to-scroll
      await switchPaneEditorMode(user, primaryPane, '위지윅')
      expect(screen.getByTestId('document-editor').querySelector('.heading-number')).toBeNull()
      scrollIntoViewMock.mockClear()
      const currentItems = within(within(outline).getByRole('list')).getAllByRole('listitem')
      await user.click(within(currentItems[1]).getByRole('button'))
      expect(scrollIntoViewMock).toHaveBeenCalledTimes(2)
      expect(scrollIntoViewMock).toHaveBeenCalledWith({ block: 'start' })
      expect(scrollIntoViewMock).toHaveBeenCalledWith({ block: 'nearest' })

      // SettingsPanel no longer includes "헤딩 자동 넘버링 표시"; outline toggle state persists across restart
      await triggerMenuCommand(emitMenuCommand, 'toggle-settings')
      expect(scrollIntoViewMock).toHaveBeenCalledTimes(2)
      const settingsPanel = screen.getByLabelText('전역 설정 패널')
      expect(
        within(settingsPanel).queryByRole('checkbox', { name: /헤딩 자동 넘버링 표시/i })
      ).not.toBeInTheDocument()
      await user.click(within(settingsPanel).getByRole('button', { name: '닫기' }))

      firstRender.unmount()
      render(<App />)
      await triggerMenuCommand(emitMenuCommand, 'open-folder')
      const reopenedExplorer = await screen.findByLabelText('워크스페이스 탐색기')
      await user.click(await within(reopenedExplorer).findByText('guide.md'))
      const reopenedOutline = within(
        screen.getByRole('complementary', { name: '우측 사이드바' })
      ).getByRole('region', { name: '문서 목차 (Outline)' })
      expect(
        within(reopenedOutline).getByRole('button', { name: '목차 번호 표시' })
      ).toHaveAttribute('aria-pressed', 'false')
      expect(within(reopenedOutline).queryByText('1.1.')).not.toBeInTheDocument()
    } finally {
      restore()
    }
  })

  it('does not render removed TOC insertion or body heading numbering buttons in Outline or editor toolbars', async () => {
    const user = userEvent.setup()
    const { api, emitMenuCommand } = createInMemoryWikiApi(
      { theme: 'light', showHeadingNumbers: true },
      {
        selectedFolder: 'C:\\wiki\\no-toc-actions',
        workspaces: {
          'C:\\wiki\\no-toc-actions': {
            'manual.md': '# Title\n\n## Section'
          }
        }
      }
    )
    window.wikiApi = api

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    await user.click(within(screen.getByLabelText('워크스페이스 탐색기')).getByText('manual.md'))

    const outline = within(
      screen.getByRole('complementary', { name: '우측 사이드바' })
    ).getByRole('region', { name: '문서 목차 (Outline)' })
    expect(
      within(outline).queryByRole('button', { name: '본문에 목차(/toc) 삽입' })
    ).not.toBeInTheDocument()
    expect(
      within(outline).queryByRole('button', { name: '본문 헤딩 번호 쓰기' })
    ).not.toBeInTheDocument()
    expect(
      within(outline).queryByRole('button', { name: '본문 헤딩 번호 제거' })
    ).not.toBeInTheDocument()

    const rawToolbar = screen.getByRole('toolbar', { name: 'Raw 표 편집 툴바' })
    expect(within(rawToolbar).queryByRole('button', { name: '목차 삽입' })).not.toBeInTheDocument()

    await switchPaneEditorMode(user, screen.getByTestId('pane-primary'), '위지윅')
    const wysiwygToolbar = screen.getByRole('toolbar', { name: '위지윅 서식 툴바' })
    expect(
      within(wysiwygToolbar).queryByRole('button', { name: '목차 삽입' })
    ).not.toBeInTheDocument()
  })

  it('does not replay stale outlineScrollRequest after tab switch or global Ctrl+1/Ctrl+3 shortcuts', async () => {
    const { mock: scrollIntoViewMock, restore } = mockPrototypeScrollIntoView()

    try {
      const user = userEvent.setup()
      const { api, emitMenuCommand } = createInMemoryWikiApi(
        { theme: 'light', showHeadingNumbers: false },
        {
          selectedFolder: 'C:\\wiki\\scroll-once',
          workspaces: {
            'C:\\wiki\\scroll-once': {
              'alpha.md': ['# Alpha', '', '## Target Heading', '', 'Body'].join('\n'),
              'beta.md': ['# Beta', '', 'Other'].join('\n')
            }
          }
        }
      )
      window.wikiApi = api

      render(<App />)
      await triggerMenuCommand(emitMenuCommand, 'open-folder')
      const sidebar = screen.getByLabelText('워크스페이스 탐색기')
      await user.click(within(sidebar).getByText('alpha.md'))
      await user.click(within(sidebar).getByText('beta.md'))
      await user.click(screen.getByRole('tab', { name: 'alpha.md' }))

      await switchPaneEditorMode(user, screen.getByTestId('pane-primary'), 'Preview')

      const rightSidebar = screen.getByRole('complementary', { name: '우측 사이드바' })
      const outline = within(rightSidebar).getByRole('region', { name: '문서 목차 (Outline)' })
      await user.click(within(outline).getByRole('button', { name: /Target Heading/i }))
      expect(scrollIntoViewMock).toHaveBeenCalledTimes(2)
      expect(scrollIntoViewMock).toHaveBeenCalledWith({ block: 'start' })
      expect(scrollIntoViewMock).toHaveBeenCalledWith({ block: 'nearest' })

      scrollIntoViewMock.mockClear()
      await user.click(screen.getByRole('tab', { name: 'beta.md' }))
      await user.click(screen.getByRole('tab', { name: 'alpha.md' }))
      expect(scrollIntoViewMock).not.toHaveBeenCalled()

      await user.click(within(outline).getByRole('button', { name: /Target Heading/i }))
      expect(scrollIntoViewMock).toHaveBeenCalledTimes(2)
      expect(scrollIntoViewMock).toHaveBeenCalledWith({ block: 'start' })
      expect(scrollIntoViewMock).toHaveBeenCalledWith({ block: 'nearest' })

      scrollIntoViewMock.mockClear()
      fireEvent.keyDown(window, { key: '1', ctrlKey: true })
      expect(screen.getByRole('button', { name: 'Raw' })).toHaveAttribute('aria-pressed', 'true')
      fireEvent.keyDown(window, { key: '3', ctrlKey: true })
      expect(screen.getByRole('button', { name: 'Preview' })).toHaveAttribute('aria-pressed', 'true')
      expect(scrollIntoViewMock).not.toHaveBeenCalled()
    } finally {
      restore()
    }
  })

  it('renders Document Outline in expanded right sidebar (240px) to the right of PaneWorkspace instead of left sidebar', async () => {
    const { api } = createInMemoryWikiApi({ theme: 'light' })
    window.wikiApi = api

    render(<App />)

    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute('data-theme', 'light')
    })

    const leftSidebar = screen.getByRole('complementary', { name: '왼쪽 사이드바' })
    const paneWorkspace = screen.getByTestId('pane-workspace')
    const rightSidebar = screen.getByRole('complementary', { name: '우측 사이드바' })

    expect(
      leftSidebar.compareDocumentPosition(paneWorkspace) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(
      paneWorkspace.compareDocumentPosition(rightSidebar) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()

    expect(
      within(leftSidebar).queryByRole('region', { name: '문서 목차 (Outline)' })
    ).not.toBeInTheDocument()

    expect(rightSidebar).toHaveStyle({ width: '240px' })
    const outline = within(rightSidebar).getByRole('region', { name: '문서 목차 (Outline)' })
    expect(within(outline).getByText('Outline')).toBeInTheDocument()
    expect(within(outline).getByRole('button', { name: '문서 목차 접기' })).toBeInTheDocument()
    expect(within(outline).getByText('열린 문서 없음')).toBeInTheDocument()
  })

  it('keeps right sidebar mounted with empty-state messages when no document, non-markdown, or headingless document is active', async () => {
    const user = userEvent.setup()
    const { api, emitMenuCommand } = createInMemoryWikiApi(
      { theme: 'light' },
      {
        selectedFolder: 'C:\\wiki\\outline-empty',
        workspaces: {
          'C:\\wiki\\outline-empty': {
            'notes.txt': 'Plain text file',
            'blank.md': 'Just paragraph text without headings',
            'guide.md': '# Guide Heading\n\n## Sub Heading'
          }
        }
      }
    )
    window.wikiApi = api

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')

    const rightSidebar = screen.getByRole('complementary', { name: '우측 사이드바' })
    const explorer = screen.getByLabelText('워크스페이스 탐색기')

    expect(within(rightSidebar).getByText('열린 문서 없음')).toBeInTheDocument()
    expect(within(rightSidebar).getByRole('button', { name: '목차 번호 표시' })).toBeInTheDocument()

    await user.click(await within(explorer).findByText('notes.txt'))
    expect(screen.getByRole('complementary', { name: '우측 사이드바' })).toBe(rightSidebar)
    expect(
      within(rightSidebar).getByText('마크다운 문서에서만 목차를 지원합니다.')
    ).toBeInTheDocument()
    expect(
      within(rightSidebar).queryByRole('button', { name: '본문에 목차(/toc) 삽입' })
    ).not.toBeInTheDocument()
    expect(
      within(rightSidebar).queryByRole('button', { name: '본문 헤딩 번호 쓰기' })
    ).not.toBeInTheDocument()
    expect(
      within(rightSidebar).queryByRole('button', { name: '본문 헤딩 번호 제거' })
    ).not.toBeInTheDocument()

    await user.click(within(explorer).getByText('blank.md'))
    expect(within(rightSidebar).getByText('표시할 헤딩이 없습니다.')).toBeInTheDocument()

    await user.click(within(explorer).getByText('guide.md'))
    const items = within(within(rightSidebar).getByRole('list')).getAllByRole('listitem')
    expect(items).toHaveLength(2)
    expect(items[0].textContent).toContain('Guide Heading')

    await user.click(screen.getByRole('button', { name: 'guide.md 탭 닫기' }))
    await user.click(screen.getByRole('button', { name: 'blank.md 탭 닫기' }))
    await user.click(screen.getByRole('button', { name: 'notes.txt 탭 닫기' }))
    expect(screen.getByRole('complementary', { name: '우측 사이드바' })).toBe(rightSidebar)
    expect(within(rightSidebar).getByText('열린 문서 없음')).toBeInTheDocument()
  })
})

function createDomRect(top: number, height: number, width = 500): DOMRect {
  return {
    top,
    bottom: top + height,
    left: 0,
    right: width,
    width,
    height,
    x: 0,
    y: top,
    toJSON: () => ({})
  } as DOMRect
}

function stubScrollLayout(
  el: HTMLElement,
  getGeometry: () => { scrollTop: number; scrollHeight: number; clientHeight: number; top: number }
): void {
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => getGeometry().scrollTop,
    set: () => undefined
  })
  Object.defineProperty(el, 'scrollHeight', {
    configurable: true,
    get: () => getGeometry().scrollHeight
  })
  Object.defineProperty(el, 'clientHeight', {
    configurable: true,
    get: () => getGeometry().clientHeight
  })
  el.getBoundingClientRect = () => createDomRect(getGeometry().top, getGeometry().clientHeight, 600)
}

function createHeadingRect(top: number): DOMRect {
  return createDomRect(top, 28, 500)
}

function stubHeadingTop(el: HTMLElement, getTop: () => number): void {
  el.getBoundingClientRect = () => createHeadingRect(getTop())
}

function stubPreviewSpyLayout(
  preview: HTMLElement,
  docOffsets: number[],
  getScrollTop: () => number,
  {
    scrollHeight = 1000,
    clientHeight = 400,
    top = 100
  }: { scrollHeight?: number; clientHeight?: number; top?: number } = {}
): HTMLElement[] {
  stubScrollLayout(preview, () => ({
    scrollTop: getScrollTop(),
    scrollHeight,
    clientHeight,
    top
  }))
  const headings = Array.from(preview.querySelectorAll('h1, h2, h3, h4, h5, h6')) as HTMLElement[]
  expect(headings).toHaveLength(docOffsets.length)
  headings.forEach((el, idx) => {
    stubHeadingTop(el, () => top + docOffsets[idx] - getScrollTop())
  })
  return headings
}

describe('Document Outline active heading scroll spy in Preview mode', () => {
  it('tracks Preview scroll position in Document Outline with aria-current="location", auto-scroll, and no redundant updates within the same section', async () => {
    const user = userEvent.setup()
    const { mock: scrollIntoViewMock, restore } = mockPrototypeScrollIntoView()

    try {
      const docContent = [
        'Intro preface before first heading.',
        '',
        '# Overview',
        'Section 1 body',
        '',
        '## Architecture',
        'Section 2 body',
        '',
        '### Details',
        'Section 3 body',
        '',
        '## Summary',
        'Short ending'
      ].join('\n')

      const { api, emitMenuCommand } = createInMemoryWikiApi(
        { theme: 'light', showHeadingNumbers: false },
        {
          selectedFolder: 'C:\\wiki\\outline-spy',
          workspaces: {
            'C:\\wiki\\outline-spy': {
              'guide.md': docContent,
              'plain.md': 'Just text without any headings',
              'notes.json': '{"ok":true}'
            }
          }
        }
      )
      window.wikiApi = api

      render(<App />)
      await triggerMenuCommand(emitMenuCommand, 'open-folder')
      const explorer = await screen.findByLabelText('워크스페이스 탐색기')
      await user.click(await within(explorer).findByText('guide.md'))

      await switchPaneEditorMode(user, screen.getByTestId('pane-primary'), 'Preview')

      const preview = screen.getByLabelText('마크다운 미리보기')
      const outline = screen.getByRole('region', { name: '문서 목차 (Outline)' })
      const outlineButtons = () => within(within(outline).getByRole('list')).getAllByRole('button')

      // Stub layout: container top = 100, clientHeight = 400, scrollHeight = 1000
      let currentScrollTop = 0
      const docOffsets = [160, 340, 560, 880] // distance from document top (before scrollTop subtraction)
      stubPreviewSpyLayout(preview, docOffsets, () => currentScrollTop)

      // 1. Preface before first heading -> no outline item active
      fireEvent.scroll(preview)
      for (const btn of outlineButtons()) {
        expect(btn).not.toHaveAttribute('aria-current')
      }
      expect(scrollIntoViewMock).not.toHaveBeenCalled()

      // 2. Scroll to Overview (heading 0 at relativeTop = 100+160-150-100 = 10 <= 24)
      currentScrollTop = 150
      fireEvent.scroll(preview)
      expect(outlineButtons()[0]).toHaveAttribute('aria-current', 'location')
      expect(outlineButtons()[0]).toHaveClass('is-active')
      expect(outlineButtons()[1]).not.toHaveAttribute('aria-current')
      expect(scrollIntoViewMock).toHaveBeenCalledTimes(1)
      expect(scrollIntoViewMock).toHaveBeenLastCalledWith({ block: 'nearest' })
      expect(scrollIntoViewMock.mock.instances[0]).toBe(outlineButtons()[0])

      // 3. Scroll within Overview section (heading 0 stays active) -> no redundant auto-scroll
      scrollIntoViewMock.mockClear()
      currentScrollTop = 210
      fireEvent.scroll(preview)
      expect(outlineButtons()[0]).toHaveAttribute('aria-current', 'location')
      expect(scrollIntoViewMock).not.toHaveBeenCalled()

      // 4. Scroll to Architecture (heading 1 at relativeTop = 340 - 330 = 10 <= 24)
      currentScrollTop = 330
      fireEvent.scroll(preview)
      expect(outlineButtons()[0]).not.toHaveAttribute('aria-current')
      expect(outlineButtons()[1]).toHaveAttribute('aria-current', 'location')
      expect(scrollIntoViewMock).toHaveBeenCalledTimes(1)
      expect(scrollIntoViewMock.mock.instances[0]).toBe(outlineButtons()[1])

      // 5. Scroll to container bottom (scrollTop = 600, Summary still below baseline at 280) -> Summary active
      currentScrollTop = 600
      fireEvent.scroll(preview)
      expect(outlineButtons()[3]).toHaveAttribute('aria-current', 'location')

      // 6. Opening non-markdown file or markdown without headings clears active heading
      await user.click(within(explorer).getByText('notes.json'))
      expect(within(outline).queryByRole('list')).not.toBeInTheDocument()
      await user.click(within(explorer).getByText('plain.md'))
      expect(within(outline).queryByRole('list')).not.toBeInTheDocument()
    } finally {
      restore()
    }
  })

  it('protects clicked Document Outline heading until user scroll, clears pin on tab/Editor Mode switch, and ignores inactive Split Mode Pane scroll', async () => {
    const user = userEvent.setup()
    const { mock: scrollIntoViewMock, restore } = mockPrototypeScrollIntoView()

    try {
      const guideDoc = [
        'Intro preface before first heading.',
        '',
        '# Overview',
        'Section 1 body',
        '',
        '## Architecture',
        'Section 2 body',
        '',
        '### Details',
        'Section 3 body',
        '',
        '## Summary',
        'Short ending'
      ].join('\n')
      const sideDoc = ['# Side Alpha', 'Alpha body', '', '## Side Beta', 'Beta body'].join('\n')

      const { api, emitMenuCommand } = createInMemoryWikiApi(
        { theme: 'light', showHeadingNumbers: false },
        {
          selectedFolder: 'C:\\wiki\\outline-pin',
          workspaces: {
            'C:\\wiki\\outline-pin': {
              'guide.md': guideDoc,
              'side.md': sideDoc
            }
          }
        }
      )
      window.wikiApi = api

      render(<App />)
      await triggerMenuCommand(emitMenuCommand, 'open-folder')
      const explorer = await screen.findByLabelText('워크스페이스 탐색기')
      await user.click(await within(explorer).findByText('side.md'))
      await user.click(await within(explorer).findByText('guide.md'))

      const primaryPane = screen.getByTestId('pane-primary')
      await switchPaneEditorMode(user, primaryPane, 'Preview')

      let primaryPreview = within(primaryPane).getByLabelText('마크다운 미리보기')
      const outline = screen.getByRole('region', { name: '문서 목차 (Outline)' })
      const outlineButtons = () => within(within(outline).getByRole('list')).getAllByRole('button')

      let currentScrollTop = 150
      const docOffsets = [160, 340, 560, 880]
      stubPreviewSpyLayout(primaryPreview, docOffsets, () => currentScrollTop)
      fireEvent.scroll(primaryPreview)
      expect(outlineButtons()[0]).toHaveAttribute('aria-current', 'location')

      // 1. Clicking short bottom heading ("Summary") pins it immediately and resists programmatic scroll overwrites
      await user.click(outlineButtons()[3])
      expect(outlineButtons()[3]).toHaveAttribute('aria-current', 'location')
      expect(outlineButtons()[3]).toHaveClass('is-active')
      expect(outlineButtons()[0]).not.toHaveAttribute('aria-current')

      // Programmatic scroll fires while stopped before bottom (Architecture at top=10 <= 24, Summary still below baseline)
      currentScrollTop = 330
      fireEvent.scroll(primaryPreview)
      expect(outlineButtons()[3]).toHaveAttribute('aria-current', 'location')
      expect(outlineButtons()[1]).not.toHaveAttribute('aria-current')

      // Non-scroll prose click inside Preview does not arm user-scroll intent
      await user.click(within(primaryPreview).getByText('Section 1 body'))
      fireEvent.scroll(primaryPreview)
      expect(outlineButtons()[3]).toHaveAttribute('aria-current', 'location')
      expect(outlineButtons()[1]).not.toHaveAttribute('aria-current')

      // 2. Actual wheel scroll releases protection and lets scroll spy resume
      scrollIntoViewMock.mockClear()
      fireEvent.wheel(primaryPreview)
      currentScrollTop = 335
      fireEvent.scroll(primaryPreview)
      expect(outlineButtons()[1]).toHaveAttribute('aria-current', 'location')
      expect(outlineButtons()[3]).not.toHaveAttribute('aria-current')
      expect(scrollIntoViewMock).toHaveBeenCalledWith({ block: 'nearest' })
      expect(scrollIntoViewMock.mock.instances).toContain(outlineButtons()[1])

      // 3. Keyboard scroll (PageUp) also releases protection
      await user.click(outlineButtons()[3])
      expect(outlineButtons()[3]).toHaveAttribute('aria-current', 'location')
      fireEvent.keyDown(primaryPreview, { key: 'PageUp' })
      currentScrollTop = 150
      fireEvent.scroll(primaryPreview)
      expect(outlineButtons()[0]).toHaveAttribute('aria-current', 'location')
      expect(outlineButtons()[3]).not.toHaveAttribute('aria-current')

      // 4. Switching tabs clears click protection
      await user.click(outlineButtons()[3])
      expect(outlineButtons()[3]).toHaveAttribute('aria-current', 'location')
      await user.click(within(primaryPane).getByRole('tab', { name: /side\.md/i }))
      await user.click(within(primaryPane).getByRole('tab', { name: /guide\.md/i }))
      primaryPreview = within(primaryPane).getByLabelText('마크다운 미리보기')
      stubPreviewSpyLayout(primaryPreview, docOffsets, () => currentScrollTop)
      expect(outlineButtons()[3]).not.toHaveAttribute('aria-current')
      fireEvent.scroll(primaryPreview)
      expect(outlineButtons()[0]).toHaveAttribute('aria-current', 'location')

      // 5. Switching mode (Ctrl+1 -> Ctrl+3) clears click protection
      await user.click(outlineButtons()[3])
      expect(outlineButtons()[3]).toHaveAttribute('aria-current', 'location')
      fireEvent.keyDown(window, { key: '1', ctrlKey: true })
      fireEvent.keyDown(window, { key: '3', ctrlKey: true })
      primaryPreview = within(primaryPane).getByLabelText('마크다운 미리보기')
      stubPreviewSpyLayout(primaryPreview, docOffsets, () => currentScrollTop)
      expect(outlineButtons()[3]).not.toHaveAttribute('aria-current')
      fireEvent.scroll(primaryPreview)
      expect(outlineButtons()[0]).toHaveAttribute('aria-current', 'location')

      // 6. Scrolling an inactive Split Mode Pane's Preview does not overwrite active Pane's Document Outline highlight
      fireEvent.contextMenu(within(primaryPane).getByRole('tab', { name: /side\.md/i }))
      const tabMenu = await screen.findByRole('menu', { name: '탭 작업 메뉴' })
      await user.click(within(tabMenu).getByRole('menuitem', { name: '분할 영역으로 이동' }))

      const secondaryPane = screen.getByTestId('pane-secondary')
      await switchPaneEditorMode(user, secondaryPane, 'Preview')

      // Keep primaryPane focused on guide.md at Overview (index 0)
      await user.click(within(primaryPane).getByRole('tab', { name: /guide\.md/i }))
      primaryPreview = within(primaryPane).getByLabelText('마크다운 미리보기')
      stubPreviewSpyLayout(primaryPreview, docOffsets, () => currentScrollTop)
      fireEvent.scroll(primaryPreview)
      expect(outlineButtons()[0]).toHaveAttribute('aria-current', 'location')

      // Scroll inactive secondaryPreview to Side Beta (index 1) without activating secondaryPane
      const secondaryPreview = within(secondaryPane).getByLabelText('마크다운 미리보기')
      const secondaryScrollTop = 450
      stubPreviewSpyLayout(secondaryPreview, [60, 460], () => secondaryScrollTop)
      fireEvent.wheel(secondaryPreview)
      fireEvent.scroll(secondaryPreview)

      expect(outlineButtons()).toHaveLength(4)
      expect(outlineButtons()[0]).toHaveAttribute('aria-current', 'location')
      expect(outlineButtons()[1]).not.toHaveAttribute('aria-current')
    } finally {
      restore()
    }
  })
})

describe('Document Outline scroll spy in Raw, 위지윅, Tab/Editor Mode switches, and Split Mode Panes', () => {
  it('tracks scroll, content edits, click pin protection, and user-scroll release in 위지윅 Editor Mode', async () => {
    const user = userEvent.setup()
    const { mock: scrollIntoViewMock, restore } = mockPrototypeScrollIntoView()

    try {
      const docContent = [
        'Intro preface before first heading.',
        '',
        '# Overview',
        'Section 1 body',
        '',
        '## Architecture',
        'Section 2 body',
        '',
        '### Details',
        'Section 3 body',
        '',
        '## Summary',
        'Short ending'
      ].join('\n')

      const { api, emitMenuCommand } = createInMemoryWikiApi(
        { theme: 'light', showHeadingNumbers: false },
        {
          selectedFolder: 'C:\\wiki\\wysiwyg-spy',
          workspaces: {
            'C:\\wiki\\wysiwyg-spy': {
              'guide.md': docContent
            }
          }
        }
      )
      window.wikiApi = api

      render(<App />)
      await triggerMenuCommand(emitMenuCommand, 'open-folder')
      const explorer = await screen.findByLabelText('워크스페이스 탐색기')
      await user.click(await within(explorer).findByText('guide.md'))

      const primaryPane = screen.getByTestId('pane-primary')
      await switchPaneEditorMode(user, primaryPane, '위지윅')

      const scrollContainer = primaryPane.querySelector('.wysiwyg-scroll-container') as HTMLElement
      expect(scrollContainer).toBeTruthy()

      const outline = screen.getByRole('region', { name: '문서 목차 (Outline)' })
      const outlineButtons = () => within(within(outline).getByRole('list')).getAllByRole('button')

      let currentScrollTop = 0
      const headingOffsets = new Map<string, number>([
        ['Overview', 160],
        ['Architecture', 340],
        ['Details', 560],
        ['Summary', 880]
      ])

      stubScrollLayout(scrollContainer, () => ({
        scrollTop: currentScrollTop,
        scrollHeight: 1000,
        clientHeight: 400,
        top: 100
      }))

      const originalRect = HTMLElement.prototype.getBoundingClientRect
      const rectSpy = vi
        .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
        .mockImplementation(function (this: HTMLElement) {
          if (/^H[1-6]$/.test(this.tagName) && scrollContainer.contains(this)) {
            const text = this.textContent?.trim() ?? ''
            const offset = headingOffsets.get(text) ?? 0
            return createHeadingRect(100 + offset - currentScrollTop)
          }
          return originalRect.call(this)
        })

      try {
        // 1. Preface at top -> none active
        fireEvent.scroll(scrollContainer)
        for (const btn of outlineButtons()) {
          expect(btn).not.toHaveAttribute('aria-current')
        }

        // 2. Scroll to Architecture -> index 1 active and auto-scrolled in Document Outline
        scrollIntoViewMock.mockClear()
        currentScrollTop = 320
        fireEvent.scroll(scrollContainer)
        expect(outlineButtons()[1]).toHaveAttribute('aria-current', 'location')
        expect(outlineButtons()[1]).toHaveClass('is-active')
        expect(scrollIntoViewMock).toHaveBeenCalledWith({ block: 'nearest' })

        // 3. Click Summary in Document Outline -> pin protected until explicit user scroll
        await user.click(outlineButtons()[3])
        expect(outlineButtons()[3]).toHaveAttribute('aria-current', 'location')
        currentScrollTop = 330
        fireEvent.scroll(scrollContainer)
        expect(outlineButtons()[3]).toHaveAttribute('aria-current', 'location')

        // User wheel scroll releases pin and tracks active heading cleanly
        fireEvent.wheel(scrollContainer)
        currentScrollTop = 335
        fireEvent.scroll(scrollContainer)
        expect(outlineButtons()[1]).toHaveAttribute('aria-current', 'location')

        // 4. Editing content inserts a new heading above Architecture, recalculating active index
        headingOffsets.set('Intro preface before first heading.', 80)
        const docEl = within(primaryPane).getByTestId('document-editor')
        const firstParagraph = docEl.querySelector('p')!
        const docWithElementFromPoint = document as Document & {
          elementFromPoint?: (x: number, y: number) => Element | null
        }
        const hadOwnElementFromPoint = Object.prototype.hasOwnProperty.call(
          docWithElementFromPoint,
          'elementFromPoint'
        )
        const prevElementFromPoint = docWithElementFromPoint.elementFromPoint
        docWithElementFromPoint.elementFromPoint = () => firstParagraph
        try {
          await user.click(firstParagraph)
        } finally {
          if (hadOwnElementFromPoint) {
            docWithElementFromPoint.elementFromPoint = prevElementFromPoint
          } else {
            Reflect.deleteProperty(docWithElementFromPoint, 'elementFromPoint')
          }
        }
        await user.click(within(primaryPane).getByRole('button', { name: 'H1' }))
        await waitFor(() => {
          expect(outlineButtons()).toHaveLength(5)
        })
        expect(outlineButtons()[2]).toHaveAttribute('aria-current', 'location')
      } finally {
        rectSpy.mockRestore()
      }
    } finally {
      restore()
    }
  })

  it('tracks Raw scroll by 1-based top line (excluding code fences), content edits, click pin protection, and ignores cursor-only moves', async () => {
    const user = userEvent.setup()
    const { mock: scrollIntoViewMock, restore } = mockPrototypeScrollIntoView()

    try {
      const rawDoc = [
        'Preface intro line 1',
        '# Alpha Heading',
        '```bash',
        '# bash comment inside fence',
        'echo ok',
        '```',
        '## Beta Heading',
        'Beta paragraph line 8',
        '### Gamma Heading',
        'Closing line 10'
      ].join('\n')

      const { api, emitMenuCommand } = createInMemoryWikiApi(
        { theme: 'light', showHeadingNumbers: false },
        {
          selectedFolder: 'C:\\wiki\\raw-spy',
          workspaces: {
            'C:\\wiki\\raw-spy': {
              'raw-guide.md': rawDoc
            }
          }
        }
      )
      window.wikiApi = api

      render(<App />)
      await triggerMenuCommand(emitMenuCommand, 'open-folder')
      const explorer = await screen.findByLabelText('워크스페이스 탐색기')
      await user.click(await within(explorer).findByText('raw-guide.md'))

      const primaryPane = screen.getByTestId('pane-primary')
      const scroller = primaryPane.querySelector('.cm-scroller') as HTMLElement
      expect(scroller).toBeTruthy()
      const rawEditorEl = within(primaryPane).getByTestId('document-editor')
      const rawView = getRawEditorView(rawEditorEl)

      let currentScrollTop = 0
      stubScrollLayout(scroller, () => ({
        scrollTop: currentScrollTop,
        scrollHeight: 500,
        clientHeight: 200,
        top: 100
      }))

      const outline = screen.getByRole('region', { name: '문서 목차 (Outline)' })
      const outlineButtons = () => within(within(outline).getByRole('list')).getAllByRole('button')
      expect(outlineButtons()).toHaveLength(3)

      // 1. Preface at scrollTop=0 -> none active
      fireEvent.scroll(scroller)
      for (const btn of outlineButtons()) {
        expect(btn).not.toHaveAttribute('aria-current')
      }

      // 2. Scroll onto fenced `# bash comment` (line 4, scrollTop=42) -> stays on # Alpha Heading (index 0)
      scrollIntoViewMock.mockClear()
      currentScrollTop = 42
      fireEvent.scroll(scroller)
      expect(outlineButtons()[0]).toHaveAttribute('aria-current', 'location')
      expect(outlineButtons()[0]).toHaveClass('is-active')
      expect(scrollIntoViewMock).toHaveBeenCalledWith({ block: 'nearest' })

      // 3. Cursor movement alone without scrolling does NOT shift Document Outline highlight
      const endPos = rawView.state.doc.length
      act(() => {
        rawView.dispatch({ selection: { anchor: endPos } })
      })
      expect(outlineButtons()[0]).toHaveAttribute('aria-current', 'location')
      expect(outlineButtons()[2]).not.toHaveAttribute('aria-current')

      // 4. Click Gamma Heading (index 2) -> pin protected across programmatic scroll; wheel releases pin
      await user.click(outlineButtons()[2])
      expect(outlineButtons()[2]).toHaveAttribute('aria-current', 'location')
      currentScrollTop = 84 // Line 7: Beta Heading
      fireEvent.scroll(scroller)
      expect(outlineButtons()[2]).toHaveAttribute('aria-current', 'location')

      fireEvent.wheel(scroller)
      fireEvent.scroll(scroller)
      expect(outlineButtons()[1]).toHaveAttribute('aria-current', 'location')

      // 5. Scroll to bottom (scrollHeight 500, clientHeight 200, scrollTop 299) -> highlights last heading
      currentScrollTop = 299
      fireEvent.scroll(scroller)
      expect(outlineButtons()[2]).toHaveAttribute('aria-current', 'location')

      // 6. Editing Raw content shifts heading indices at the same scroll position (scrollTop=100, line 8)
      fireEvent.wheel(scroller)
      currentScrollTop = 100
      fireEvent.scroll(scroller)
      expect(outlineButtons()[1]).toHaveAttribute('aria-current', 'location')

      setRawEditorText(rawEditorEl, '# Prepended Top\n' + rawDoc)
      expect(outlineButtons()).toHaveLength(4)
      expect(outlineButtons()[2]).toHaveAttribute('aria-current', 'location')
    } finally {
      restore()
    }
  })

  it('synchronizes Document Outline immediately across Editor Mode switches, same-Pane Tab switches, and Split Mode Pane focus switches', async () => {
    const user = userEvent.setup()
    const { restore } = mockPrototypeScrollIntoView()

    try {
      const alphaDoc = [
        'Alpha preface',
        '# Alpha One',
        'Alpha paragraph',
        '## Alpha Two',
        'Alpha section',
        '### Alpha Three',
        'Alpha ending'
      ].join('\n')
      const betaDoc = [
        'Beta preface',
        '# Beta One',
        'Beta paragraph',
        '## Beta Two',
        'Beta ending'
      ].join('\n')

      const { api, emitMenuCommand } = createInMemoryWikiApi(
        { theme: 'light', showHeadingNumbers: false },
        {
          selectedFolder: 'C:\\wiki\\sync-modes',
          workspaces: {
            'C:\\wiki\\sync-modes': {
              'alpha.md': alphaDoc,
              'beta.md': betaDoc,
              'meta.json': '{"name":"wiki"}'
            }
          }
        }
      )
      window.wikiApi = api

      render(<App />)
      await triggerMenuCommand(emitMenuCommand, 'open-folder')
      const explorer = await screen.findByLabelText('워크스페이스 탐색기')
      await user.click(await within(explorer).findByText('beta.md'))
      await user.click(await within(explorer).findByText('meta.json'))
      await user.click(await within(explorer).findByText('alpha.md'))

      const primaryPane = screen.getByTestId('pane-primary')
      const outline = screen.getByRole('region', { name: '문서 목차 (Outline)' })
      const outlineButtons = () => within(within(outline).getByRole('list')).getAllByRole('button')

      // 1. Raw -> 위지윅 -> Preview Editor Mode switches immediately recalculate active heading
      const rawScroller = primaryPane.querySelector('.cm-scroller') as HTMLElement
      let alphaScrollTop = 42 // Line 4: ## Alpha Two
      stubScrollLayout(rawScroller, () => ({
        scrollTop: alphaScrollTop,
        scrollHeight: 500,
        clientHeight: 200,
        top: 100
      }))
      fireEvent.scroll(rawScroller)
      expect(outlineButtons()[1]).toHaveAttribute('aria-current', 'location')

      // Pin heading 2 then switch Editor Mode to 위지윅 -> pin clears and new mode recalculates
      await user.click(outlineButtons()[2])
      expect(outlineButtons()[2]).toHaveAttribute('aria-current', 'location')

      await switchPaneEditorMode(user, primaryPane, '위지윅')
      const wysiwygContainer = primaryPane.querySelector('.wysiwyg-scroll-container') as HTMLElement
      alphaScrollTop = 0
      stubPreviewSpyLayout(wysiwygContainer, [120, 320, 520], () => alphaScrollTop)
      // Trigger measurement on stubbed WYSIWYG container -> heading 0 active on mode change vs top
      fireEvent.scroll(wysiwygContainer)
      for (const btn of outlineButtons()) {
        expect(btn).not.toHaveAttribute('aria-current')
      }

      // Switch to Preview mode and scroll to Alpha Two (index 1)
      await switchPaneEditorMode(user, primaryPane, 'Preview')
      const primaryPreview = within(primaryPane).getByLabelText('마크다운 미리보기')
      alphaScrollTop = 310
      stubPreviewSpyLayout(primaryPreview, [120, 320, 520], () => alphaScrollTop)
      fireEvent.scroll(primaryPreview)
      expect(outlineButtons()[1]).toHaveAttribute('aria-current', 'location')

      // 2. Same-Pane Tab switch to non-markdown (.json) clears Document Outline, returning restores Alpha Two
      await user.click(within(primaryPane).getByRole('tab', { name: /meta\.json/i }))
      expect(within(outline).queryByRole('list')).not.toBeInTheDocument()

      await user.click(within(primaryPane).getByRole('tab', { name: /alpha\.md/i }))
      const restoredPreview = within(primaryPane).getByLabelText('마크다운 미리보기')
      stubPreviewSpyLayout(restoredPreview, [120, 320, 520], () => alphaScrollTop)
      fireEvent.scroll(restoredPreview)
      expect(outlineButtons()[1]).toHaveAttribute('aria-current', 'location')

      // 3. Split Mode (좌우 분할): move beta.md to Secondary Pane while keeping Primary Pane active
      fireEvent.contextMenu(within(primaryPane).getByRole('tab', { name: /beta\.md/i }))
      const tabMenu = await screen.findByRole('menu', { name: '탭 작업 메뉴' })
      await user.click(within(tabMenu).getByRole('menuitem', { name: '분할 영역으로 이동' }))

      const secondaryPane = screen.getByTestId('pane-secondary')
      // Click back into Primary Pane so Alpha Two remains active
      fireEvent.mouseDown(within(primaryPane).getByLabelText('마크다운 미리보기'))
      expect(outlineButtons()).toHaveLength(3)
      expect(outlineButtons()[1]).toHaveAttribute('aria-current', 'location')

      // Pin Alpha Three in Primary Pane, then scroll INACTIVE Secondary Pane (Raw beta.md) to ## Beta Two
      await user.click(outlineButtons()[2])
      expect(outlineButtons()[2]).toHaveAttribute('aria-current', 'location')

      const secondaryScroller = secondaryPane.querySelector('.cm-scroller') as HTMLElement
      let betaScrollTop = 42 // Line 4: ## Beta Two (index 1)
      stubScrollLayout(secondaryScroller, () => ({
        scrollTop: betaScrollTop,
        scrollHeight: 500,
        clientHeight: 200,
        top: 100
      }))
      fireEvent.wheel(secondaryScroller)
      fireEvent.scroll(secondaryScroller)

      // Active Primary Pane's Document Outline & pin must remain untouched by inactive Pane scroll
      expect(outlineButtons()).toHaveLength(3)
      expect(outlineButtons()[2]).toHaveAttribute('aria-current', 'location')

      // 4. Focusing Secondary Pane immediately syncs Document Outline to Beta Two WITHOUT resetting to null or scrolling
      fireEvent.mouseDown(secondaryScroller)
      expect(outlineButtons()).toHaveLength(2)
      expect(within(outline).getByText('Beta One')).toBeInTheDocument()
      expect(outlineButtons()[1]).toHaveAttribute('aria-current', 'location')
      expect(outlineButtons()[1]).toHaveClass('is-active')

      // 5. Switch Split Mode to vertical (상하 분할) and focus back to Primary Pane -> immediately restores Alpha Two (pin was cleared on focus switch)
      fireEvent.dragStart(within(secondaryPane).getByRole('tab', { name: /beta\.md/i }))
      fireEvent.drop(await screen.findByTestId('split-drop-zone-vertical'))
      expect(screen.getByTestId('pane-workspace')).toHaveAttribute('data-split-mode', 'vertical')
      fireEvent.mouseDown(within(primaryPane).getByLabelText('마크다운 미리보기'))
      expect(outlineButtons()).toHaveLength(3)
      expect(within(outline).getByText('Alpha Two')).toBeInTheDocument()
      expect(outlineButtons()[1]).toHaveAttribute('aria-current', 'location')

      // Verify inactive Secondary Pane can also scroll to top while Primary Pane is focused without affecting Primary Pane
      betaScrollTop = 0
      fireEvent.wheel(secondaryScroller)
      fireEvent.scroll(secondaryScroller)
      expect(outlineButtons()[1]).toHaveAttribute('aria-current', 'location')
    } finally {
      restore()
    }
  })
})

describe('Split editor mode and bidirectional scroll sync', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-theme')
    vi.useRealTimers()
  })

  it('integrates Split mode live preview/Mermaid, per-tab clamped splitter ratio, 2-pane workspace independence, non-markdown lock, and split breadcrumbs', async () => {
    const user = userEvent.setup()
    const entries: RendererLogPayload[] = []
    const alphaInitial = [
      '# SECRET_ALPHA_TITLE',
      '',
      '## Intro',
      '',
      '## Details',
      '',
      '```mermaid',
      'flowchart LR',
      '  Start --> InitialNode',
      '```'
    ].join('\n')

    const { api, emitMenuCommand } = createInMemoryWikiApi(
      { autoSave: false },
      {
        selectedFolder: 'C:/wiki/split-mode',
        workspaces: {
          'C:/wiki/split-mode': {
            'alpha.md': alphaInitial,
            'beta.md': '# SECRET_BETA_TITLE',
            'notes.txt': 'plain text file'
          }
        },
        log: {
          write: (payload) => {
            entries.push(payload)
            return Promise.resolve()
          }
        }
      }
    )
    window.wikiApi = api

    render(<App />)

    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    const explorer = screen.getByLabelText('워크스페이스 탐색기')

    // Non-markdown .txt buffer locks Split button and Ctrl+4 / Ctrl+Shift+M
    await user.click(await within(explorer).findByText('notes.txt'))
    const primaryPane = screen.getByTestId('pane-primary')
    const primaryModeGroup = within(primaryPane).getByRole('group', { name: '에디터 모드 전환' })
    expect(within(primaryModeGroup).getByRole('button', { name: 'Split' })).toBeDisabled()
    fireEvent.keyDown(within(primaryPane).getByTestId('document-editor'), { key: '4', ctrlKey: true })
    fireEvent.keyDown(window, { key: '4', ctrlKey: true })
    expect(within(primaryPane).queryByTestId('split-markdown-preview')).not.toBeInTheDocument()

    // Open alpha.md and switch to Split via Ctrl+4
    await user.click(within(explorer).getByText('alpha.md'))
    fireEvent.keyDown(within(primaryPane).getByTestId('document-editor'), { key: '4', ctrlKey: true })
    const alphaPreview = within(primaryPane).getByTestId('split-markdown-preview')
    const alphaModeGroup = within(primaryPane).getByRole('group', { name: '에디터 모드 전환' })
    expect(within(alphaModeGroup).getByRole('button', { name: 'Split' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    expect(within(primaryPane).getByRole('toolbar', { name: 'Raw 표 편집 툴바' })).toBeInTheDocument()

    // Edit Mermaid diagram & heading in left Raw editor -> live right Preview updates
    const alphaUpdated = alphaInitial
      .replace('SECRET_ALPHA_TITLE', 'SECRET_ALPHA_UPDATED')
      .replace('InitialNode', 'LiveUpdatedNode')
    setRawEditorText(within(primaryPane).getByTestId('document-editor'), alphaUpdated)
    expect(within(alphaPreview).getByRole('heading', { level: 1 }).textContent).toContain(
      'SECRET_ALPHA_UPDATED'
    )
    await waitFor(() => {
      expect(mermaidMockState.render).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('LiveUpdatedNode')
      )
      expect(within(alphaPreview).getByTestId('mermaid-svg')).toBeInTheDocument()
    })

    // Adjust internal split splitter via drag + double-click + ArrowRight, and persist per tab across tab & mode switches
    const alphaSplitter = within(primaryPane).getByRole('separator', { name: '에디터 분할 크기 조절' })
    const alphaContainer = within(primaryPane).getByTestId('editor-split-container')
    mockElementBoundingRect(alphaContainer, { width: 1000, height: 600 })
    fireEvent.mouseDown(alphaSplitter)
    fireEvent.mouseMove(window, { clientX: 600 })
    fireEvent.mouseUp(window)
    expect(alphaSplitter).toHaveAttribute('aria-valuenow', '60')

    fireEvent.doubleClick(alphaSplitter)
    expect(alphaSplitter).toHaveAttribute('aria-valuenow', '50')

    fireEvent.keyDown(alphaSplitter, { key: 'ArrowRight' })
    fireEvent.keyDown(alphaSplitter, { key: 'ArrowRight' })
    fireEvent.keyDown(alphaSplitter, { key: 'ArrowRight' })
    expect(alphaSplitter).toHaveAttribute('aria-valuenow', '65')

    // Switch to beta.md -> back to alpha.md -> toggle Raw -> Split: ratio 65 stays preserved for alpha.md
    await user.click(within(explorer).getByText('beta.md'))
    await user.click(within(primaryPane).getByRole('tab', { name: /alpha\.md/ }))
    expect(
      within(primaryPane).getByRole('separator', { name: '에디터 분할 크기 조절' })
    ).toHaveAttribute('aria-valuenow', '65')

    fireEvent.keyDown(within(primaryPane).getByTestId('document-editor'), { key: '1', ctrlKey: true })
    expect(within(primaryPane).queryByTestId('split-markdown-preview')).not.toBeInTheDocument()
    fireEvent.keyDown(within(primaryPane).getByTestId('document-editor'), { key: '4', ctrlKey: true })
    expect(
      within(primaryPane).getByRole('separator', { name: '에디터 분할 크기 조절' })
    ).toHaveAttribute('aria-valuenow', '65')

    // Workspace 2-pane split + Editor Split mode coexistence & independent splitters
    fireEvent.contextMenu(within(primaryPane).getByRole('tab', { name: /beta\.md/ }))
    await user.click(
      within(await screen.findByRole('menu', { name: '탭 작업 메뉴' })).getByRole('menuitem', {
        name: '분할 영역에 복제 열기'
      })
    )
    const secondaryPane = screen.getByTestId('pane-secondary')
    await switchPaneEditorMode(user, secondaryPane, 'Split')
    const secondarySplitter = within(secondaryPane).getByRole('separator', {
      name: '에디터 분할 크기 조절'
    })
    expect(secondarySplitter).toHaveAttribute('aria-valuenow', '50')
    fireEvent.keyDown(secondarySplitter, { key: 'ArrowLeft' })
    fireEvent.keyDown(secondarySplitter, { key: 'ArrowLeft' })
    expect(secondarySplitter).toHaveAttribute('aria-valuenow', '40')

    // Primary editor splitter & workspace splitter remain completely independent
    expect(
      within(primaryPane).getByRole('separator', { name: '에디터 분할 크기 조절' })
    ).toHaveAttribute('aria-valuenow', '65')
    expect(screen.getByRole('separator', { name: '화면 분할 크기 조절' })).toHaveAttribute(
      'aria-valuenow',
      '50'
    )

    // Breadcrumb logs include 'split' transitions with zero content leakage
    const modeChanges = entries.filter(
      (entry) => entry.category === 'ui' && entry.message === 'Editor mode changed'
    )
    expect(modeChanges.map((entry) => ({ from: entry.data?.from, to: entry.data?.to }))).toEqual([
      { from: 'raw', to: 'split' },
      { from: 'split', to: 'raw' },
      { from: 'raw', to: 'split' },
      { from: 'raw', to: 'split' }
    ])
    const serialized = JSON.stringify(entries)
    expect(serialized).not.toContain('SECRET_ALPHA')
    expect(serialized).not.toContain('SECRET_BETA')
  })

  it('synchronizes Split mode scroll bidirectionally with PaneTabStore persistence and jumps both Raw and Preview on Outline click', async () => {
    const user = userEvent.setup()
    const { mock: scrollIntoViewMock, restore } = mockPrototypeScrollIntoView()

    try {
      const mermaidBlock = [
        '```mermaid',
        'flowchart LR',
        '  A --> B',
        '  B --> C',
        '  C --> D',
        '  D --> E',
        '  E --> F',
        '```'
      ]
      const listItems = Array.from({ length: 40 }, (_, i) => `- Item ${i + 1}`)
      const docContent = [
        '# Overview',
        '',
        ...mermaidBlock, // lines 3..10
        '',
        '## Architecture', // line 12
        '',
        ...listItems // lines 14..53
      ].join('\n')

      const { api, emitMenuCommand } = createInMemoryWikiApi(
        { autoSave: false, showHeadingNumbers: false },
        {
          selectedFolder: 'C:/wiki/split-scroll',
          workspaces: {
            'C:/wiki/split-scroll': {
              'diagram-doc.md': docContent
            }
          }
        }
      )
      window.wikiApi = api

      render(<App />)
      await triggerMenuCommand(emitMenuCommand, 'open-folder')
      await user.click(await within(screen.getByLabelText('워크스페이스 탐색기')).findByText('diagram-doc.md'))

      // Switch to Split mode via Ctrl+4
      fireEvent.keyDown(screen.getByTestId('document-editor'), { key: '4', ctrlKey: true })
      const previewRegion = screen.getByTestId('split-markdown-preview')
      await waitFor(() => {
        expect(within(previewRegion).getByTestId('mermaid-svg')).toBeInTheDocument()
      })

      // Verify post-sanitize top-level source line annotations
      const h1El = previewRegion.querySelector('h1[data-source-line="1"]') as HTMLElement
      const mermaidEl = within(previewRegion).getByTestId('mermaid-diagram')
      const h2El = previewRegion.querySelector('h2[data-source-line="12"]') as HTMLElement
      const ulEl = previewRegion.querySelector('ul[data-source-line="14"]') as HTMLElement
      expect(mermaidEl).toHaveAttribute('data-source-line', '3')
      expect(mermaidEl).toHaveAttribute('data-source-end-line', '10')
      expect(ulEl).toHaveAttribute('data-source-end-line', '53')

      const rawEditorEl = screen.getByTestId('document-editor')
      const cmView = getRawEditorView(rawEditorEl)
      const rawScroller = getRawEditorScroller(rawEditorEl)

      Object.defineProperty(rawScroller, 'clientHeight', { configurable: true, value: 200 })
      Object.defineProperty(rawScroller, 'scrollHeight', {
        configurable: true,
        get: () => cmView.contentHeight
      })
      Object.defineProperty(previewRegion, 'clientHeight', { configurable: true, value: 200 })
      Object.defineProperty(previewRegion, 'scrollHeight', { configurable: true, value: 1480 })
      mockElementBoundingRect(previewRegion, { width: 500, height: 200 })

      const mockRect = (el: HTMLElement, docTop: number, height: number) => {
        el.getBoundingClientRect = () =>
          createDomRect(docTop - previewRegion.scrollTop, height, 500)
      }
      mockRect(h1El, 0, 40)
      mockRect(mermaidEl, 60, 560)
      mockRect(h2El, 640, 40)
      mockRect(ulEl, 700, 780)

      // 1. Raw -> Preview interpolation inside Mermaid block (line 7 = 50% of [3, 11] => 60 + 0.5*560 = 340)
      const line7Top = cmView.documentPadding.top + cmView.lineBlockAt(cmView.state.doc.line(7).from).top
      rawScroller.scrollTop = line7Top
      fireEvent.scroll(rawScroller)
      expect(previewRegion.scrollTop).toBeCloseTo(340, 5)

      // Echo scroll on Preview does not ping-pong back to Raw
      fireEvent.scroll(previewRegion)
      expect(rawScroller.scrollTop).toBe(line7Top)

      // 2. Preview -> Raw interpolation in list (50% of [14, 54] => line 34, 700 + 0.5*780 = 1090)
      previewRegion.scrollTop = 1090
      fireEvent.scroll(previewRegion)
      const expectedLine34Top =
        cmView.documentPadding.top + cmView.lineBlockAt(cmView.state.doc.line(34).from).top
      expect(rawScroller.scrollTop).toBeCloseTo(expectedLine34Top, 5)

      // Switching Split -> Raw restores synced scrollTop persisted in PaneTabStore
      fireEvent.keyDown(rawEditorEl, { key: '1', ctrlKey: true })
      const rawOnlyEditor = screen.getByTestId('document-editor')
      expect(getRawEditorScroller(rawOnlyEditor).scrollTop).toBeCloseTo(expectedLine34Top, 5)

      // Switch back to Split and test Outline heading jump scrolls both Raw and Preview
      fireEvent.keyDown(rawOnlyEditor, { key: '4', ctrlKey: true })
      scrollIntoViewMock.mockClear()

      const outline = screen.getByRole('region', { name: '문서 목차 (Outline)' })
      const archBtn = within(outline).getByRole('button', { name: /Architecture/ })
      await user.click(archBtn)

      await waitFor(() => {
        expect(getRawEditorSelection(screen.getByTestId('document-editor')).start).toBe(
          docContent.indexOf('## Architecture')
        )
        expect(scrollIntoViewMock).toHaveBeenCalledWith({ block: 'start' })
        expect(archBtn).toHaveAttribute('aria-current', 'location')
      })
      const jumpedPreview = screen.getByTestId('split-markdown-preview')
      const jumpedArchHeading = within(jumpedPreview).getByRole('heading', { level: 2, name: 'Architecture' })
      expect(scrollIntoViewMock.mock.instances).toContain(jumpedArchHeading)
    } finally {
      restore()
    }
  })

  it('renders relative workspace images across WYSIWYG, Preview, and Split with responsive CSS and zero wiki-asset leak on disk', async () => {
    const user = userEvent.setup()
    const docContent = [
      '# ![Logo](./assets/logo%20(1).png) Guide',
      '',
      '![Diagram](../shared/arch.svg)',
      '',
      '![Remote](https://example.com/hero.png)'
    ].join('\n')

    const { api, emitMenuCommand } = createInMemoryWikiApi(
      { autoSave: false, showHeadingNumbers: false },
      {
        selectedFolder: 'C:/wiki/image-vault',
        workspaces: {
          'C:/wiki/image-vault': {
            'docs/guide.md': docContent,
            'docs/assets/logo (1).png': 'png-bytes',
            'shared/arch.svg': '<svg></svg>'
          }
        }
      }
    )
    window.wikiApi = api

    const { rootEl, cleanup } = mountThemeStylesAndRoot()
    try {
      render(<App />, { container: rootEl })
      await triggerMenuCommand(emitMenuCommand, 'open-folder')

      const explorer = screen.getByLabelText('워크스페이스 탐색기')
      await user.click(await within(explorer).findByText('docs'))
      await user.click(await within(explorer).findByText('guide.md'))

      const expectedLogoUrl = buildWikiAssetUrl('C:/wiki/image-vault/docs/assets/logo (1).png')
      const expectedArchUrl = buildWikiAssetUrl('C:/wiki/image-vault/shared/arch.svg')

      // Outline preserves alt text cleanly without '.png)' leakage
      const outline = screen.getByRole('region', { name: '문서 목차 (Outline)' })
      expect(within(outline).getByRole('button', { name: /Logo Guide/ })).toBeInTheDocument()

      // Switch to WYSIWYG (Ctrl+2)
      fireEvent.keyDown(screen.getByTestId('document-editor'), { key: '2', ctrlKey: true })
      await waitFor(() => {
        expect(screen.getByRole('img', { name: 'Logo' })).toHaveAttribute('src', expectedLogoUrl)
      })

      const wysiwygDiagram = screen.getByRole('img', { name: 'Diagram' })
      expect(wysiwygDiagram).toHaveAttribute('src', expectedArchUrl)
      expect(wysiwygDiagram).toHaveAttribute('data-markdown-src', '../shared/arch.svg')
      expect(wysiwygDiagram.hasAttribute('width')).toBe(false)
      expect(wysiwygDiagram.hasAttribute('height')).toBe(false)
      expect(screen.getByRole('img', { name: 'Remote' })).toHaveAttribute(
        'src',
        'https://example.com/hero.png'
      )
      const wysiwygLogoStyle = window.getComputedStyle(screen.getByRole('img', { name: 'Logo' }))
      expect(wysiwygLogoStyle.maxWidth).toBe('100%')
      expect(wysiwygLogoStyle.height).toBe('auto')

      // Switch to Preview (Ctrl+3)
      fireEvent.keyDown(screen.getByTestId('document-editor'), { key: '3', ctrlKey: true })
      const previewLogo = await screen.findByRole('img', { name: 'Logo' })
      expect(previewLogo).toHaveAttribute('src', expectedLogoUrl)
      expect(screen.getByRole('img', { name: 'Diagram' })).toHaveAttribute('src', expectedArchUrl)
      expect(screen.getByRole('img', { name: 'Remote' })).toHaveAttribute(
        'src',
        'https://example.com/hero.png'
      )
      const previewLogoStyle = window.getComputedStyle(previewLogo)
      expect(previewLogoStyle.maxWidth).toBe('100%')
      expect(previewLogoStyle.height).toBe('auto')

      // Switch to Split (Ctrl+4)
      fireEvent.keyDown(screen.getByTestId('document-editor'), { key: '4', ctrlKey: true })
      const splitPreview = await screen.findByTestId('split-markdown-preview')
      const splitLogo = within(splitPreview).getByRole('img', { name: 'Logo' })
      expect(splitLogo).toHaveAttribute('src', expectedLogoUrl)
      const splitLogoStyle = window.getComputedStyle(splitLogo)
      expect(splitLogoStyle.maxWidth).toBe('100%')
      expect(splitLogoStyle.height).toBe('auto')
      expect(screen.getByTestId('document-editor').textContent).toContain('./assets/logo%20(1).png')
      expect(screen.getByTestId('document-editor').textContent).not.toContain('wiki-asset:')

      // Switch back to Raw (Ctrl+1) and verify saved file content never leaks wiki-asset:
      fireEvent.keyDown(screen.getByTestId('document-editor'), { key: '1', ctrlKey: true })
      const rawContent = screen.getByTestId('document-editor').textContent ?? ''
      expect(rawContent).not.toContain('wiki-asset:')
      expect(await api.workspace.readFile('C:/wiki/image-vault/docs/guide.md')).toBe(docContent)
    } finally {
      cleanup()
    }
  })

  it('ingests clipboard pastes and FolderTree/OS drops end-to-end across Raw, WYSIWYG, and Split while blocking window navigation and surfacing Error Banner failures', async () => {
    const pathMap = new Map<string, string>([['os-shot.png', 'D:/outside/os-shot.png']])
    const { api, emitMenuCommand, getFilesSnapshot } = createInMemoryWikiApi(
      { autoSave: false },
      {
        selectedFolder: 'C:/wiki/img-app',
        workspaces: {
          'C:/wiki/img-app': {
            'docs/guide.md': '# Guide\n\n',
            'shared/arch (1).png': '<binary:arch>',
            'docs/notes.txt': 'plain note'
          }
        },
        getPathForFile: (file) => pathMap.get(file.name) ?? ''
      }
    )
    const ingestSpy = vi.spyOn(api.workspace, 'ingestImage')
    window.wikiApi = api

    const user = userEvent.setup()
    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')

    const explorer = screen.getByLabelText('워크스페이스 탐색기')
    const docsTreeItem = await within(explorer).findByRole('treeitem', { name: 'docs' })
    await user.click(within(docsTreeItem).getByText('docs'))
    const guideItem = await within(explorer).findByRole('treeitem', { name: 'guide.md' })
    await user.click(within(guideItem).getByText('guide.md'))

    // Open shared directory to expose FolderTree image item
    const sharedTreeItem = await within(explorer).findByRole('treeitem', { name: 'shared' })
    await user.click(within(sharedTreeItem).getByText('shared'))
    const archTreeItem = await within(explorer).findByRole('treeitem', { name: 'arch (1).png' })
    expect(archTreeItem).toHaveAttribute('draggable', 'true')
    expect(guideItem).toHaveAttribute('draggable', 'true')

    // 1. FolderTree drag -> drop onto Raw editor references ../shared/arch%20%281%29.png without copying to assets/
    const dragTransferStore = new Map<string, string>()
    fireEvent.dragStart(archTreeItem, {
      dataTransfer: {
        effectAllowed: 'none',
        setData: (type: string, value: string) => {
          dragTransferStore.set(type, value)
        }
      }
    })
    // PaneWorkspace split drop zones stay inactive during FolderTree image drag
    expect(screen.queryByTestId('split-drop-zone-horizontal')).not.toBeInTheDocument()
    expect(screen.queryByTestId('split-drop-zone-vertical')).not.toBeInTheDocument()

    const rawEditor = await screen.findByTestId('document-editor')
    fireEvent.drop(rawEditor, {
      dataTransfer: {
        types: [...dragTransferStore.keys()],
        files: [],
        getData: (type: string) => dragTransferStore.get(type) ?? ''
      }
    })
    fireEvent.dragEnd(archTreeItem)

    await waitFor(() => {
      expect(getRawEditorText(rawEditor)).toContain('![arch (1)](../shared/arch%20%281%29.png)')
    })
    expect(getFilesSnapshot().has('C:/wiki/img-app/docs/assets/arch (1).png')).toBe(false)

    // 2. Clipboard bitmap paste in Raw mode saves under docs/assets/ and preserves normal text+bitmap paste
    const clipFile = new File([new Uint8Array([1, 2, 3])], 'image.png', { type: 'image/png' })
    fireEvent.paste(rawEditor, {
      clipboardData: {
        types: ['Files'],
        files: [clipFile],
        items: [],
        getData: () => ''
      }
    })

    await waitFor(() => {
      expect(getRawEditorText(rawEditor)).toContain(
        '![guide-20260402-090507](./assets/guide-20260402-090507.png)'
      )
    })
    expect(getFilesSnapshot().has('C:/wiki/img-app/docs/assets/guide-20260402-090507.png')).toBe(
      true
    )

    const callsAfterClip = ingestSpy.mock.calls.length
    fireEvent.paste(rawEditor, {
      clipboardData: {
        types: ['text/plain', 'Files'],
        files: [clipFile],
        items: [],
        getData: (type: string) => (type === 'text/plain' ? 'a\tb\tc' : '')
      }
    })
    expect(ingestSpy).toHaveBeenCalledTimes(callsAfterClip)

    // 3. Switch to 위지윅 (Ctrl+2) and drop multi-file OS Explorer payload (path + bytes fallback)
    fireEvent.keyDown(rawEditor, { key: '2', ctrlKey: true })
    const wysiwygEditor = await screen.findByRole('textbox', { name: '위지윅 문서 에디터' })
    const osShot = new File([new Uint8Array([4, 5])], 'os-shot.png', { type: 'image/png' })
    const byteShot = new File([new Uint8Array([6, 7])], 'bytes-shot.webp', { type: 'image/webp' })
    fireEvent.drop(wysiwygEditor, {
      dataTransfer: {
        types: ['Files'],
        files: [osShot, byteShot],
        getData: () => ''
      }
    })

    await waitFor(() => {
      expect(screen.getByRole('img', { name: 'os-shot' })).toHaveAttribute(
        'src',
        buildWikiAssetUrl('C:/wiki/img-app/docs/assets/os-shot.png')
      )
      expect(screen.getByRole('img', { name: 'bytes-shot' })).toHaveAttribute(
        'src',
        buildWikiAssetUrl('C:/wiki/img-app/docs/assets/bytes-shot.webp')
      )
    })

    // 4. Switch to Split (Ctrl+4) and verify immediate Preview render & zero wiki-asset: leak
    fireEvent.keyDown(wysiwygEditor, { key: '4', ctrlKey: true })
    const splitPreview = await screen.findByTestId('split-markdown-preview')
    expect(within(splitPreview).getByRole('img', { name: 'os-shot' })).toHaveAttribute(
      'src',
      buildWikiAssetUrl('C:/wiki/img-app/docs/assets/os-shot.png')
    )
    const splitRawEditor = screen.getByTestId('document-editor')
    expect(getRawEditorText(splitRawEditor)).not.toContain('wiki-asset:')

    // Split left Raw editor falls back to ImageTransferContext.draggingWorkspaceImagePaths when getData() is empty
    appendRawEditorText(splitRawEditor, '\n\n')
    const splitIngestsBefore = ingestSpy.mock.calls.length
    fireEvent.dragStart(archTreeItem, {
      dataTransfer: {
        effectAllowed: 'none',
        setData: () => undefined
      }
    })
    fireEvent.drop(splitRawEditor, {
      dataTransfer: {
        types: ['application/x-wiki-workspace-image'],
        files: [],
        getData: () => ''
      }
    })
    fireEvent.dragEnd(archTreeItem)
    await waitFor(() => {
      expect(ingestSpy).toHaveBeenCalledTimes(splitIngestsBefore + 1)
      expect(within(splitPreview).getAllByRole('img', { name: 'arch (1)' })).toHaveLength(2)
    })

    // 5. Window-level drop outside editors prevents accidental Electron file navigation
    const outerDropEvent = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(outerDropEvent, 'dataTransfer', {
      value: { types: ['Files'], files: [osShot], getData: () => '' }
    })
    explorer.dispatchEvent(outerDropEvent)
    expect(outerDropEvent.defaultPrevented).toBe(true)

    // 6. Config/non-markdown buffer disables clipboard image ingestion
    await triggerMenuCommand(emitMenuCommand, 'toggle-settings')
    await user.click(await screen.findByRole('button', { name: /설정 파일 직접 열기/i }))
    await waitFor(() => {
      expect(screen.getByTestId('document-editor')).toHaveAttribute('data-language', 'json')
    })
    const callsBeforeConfigPaste = ingestSpy.mock.calls.length
    fireEvent.paste(screen.getByTestId('document-editor'), {
      clipboardData: {
        types: ['Files'],
        files: [clipFile],
        items: [],
        getData: () => ''
      }
    })
    expect(ingestSpy).toHaveBeenCalledTimes(callsBeforeConfigPaste)

    // 7. Ingestion failure surfaces via Error Banner (role="alert")
    const guideTab = screen.getByRole('tab', { name: /guide\.md/i })
    await user.click(guideTab)
    ingestSpy.mockRejectedValueOnce(new Error('디스크 공간 부족'))
    fireEvent.paste(await screen.findByTestId('document-editor'), {
      clipboardData: {
        types: ['Files'],
        files: [clipFile],
        items: [],
        getData: () => ''
      }
    })

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/이미지 삽입에 실패했습니다.*디스크 공간 부족/)
    })
  })
})

describe('Link autocomplete menu & Ctrl+K integration', () => {
  it('supports Raw and WYSIWYG body/table section links, priority matching, [`symbol`] code mark, pipe escaping, and matches TOC/Preview slugs', async () => {
    const user = userEvent.setup()
    const initialMd = [
      '# 1.1. 개요',
      '',
      '## `buildTree`',
      '',
      '## A | B 표기',
      '',
      '| 함수 | 설명 |',
      '| --- | --- |',
      '| target |  |',
      '',
      '본문 '
    ].join('\n')

    const { api, emitMenuCommand } = createInMemoryWikiApi(
      { autoSave: false },
      {
        selectedFolder: 'C:/wiki',
        workspaces: {
          'C:/wiki': {
            'api.md': initialMd
          }
        }
      }
    )
    window.wikiApi = api

    render(<App />)

    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    const explorer = screen.getByLabelText('워크스페이스 탐색기')
    await user.click(await within(explorer).findByText('api.md'))

    const rawEl = await screen.findByTestId('document-editor')
    const rawView = getRawEditorView(rawEl)

    // 1) Raw 요약 테이블 셀 내 [함수명]( 우선순위 추천 + 완성
    const cellInsertAt = rawView.state.doc.toString().indexOf('| target |  |') + '| target | '.length
    act(() => {
      rawView.dispatch({
        changes: { from: cellInsertAt, to: cellInsertAt, insert: '[buildTree](' },
        selection: { anchor: cellInsertAt + '[buildTree]('.length }
      })
    })

    const rawListbox = await screen.findByRole('listbox', { name: '링크 자동완성' })
    expect(within(rawListbox).getAllByRole('option')[0]).toHaveTextContent('buildTree')
    fireEvent.keyDown(rawEl, { key: 'Enter' })

    expect(getRawEditorText(rawEl)).toContain('| target | [buildTree](#buildtree) |')

    // 2) Raw 테이블 셀 내 []( 자동 채움 + | -> \| 이스케이프
    const afterTableText = getRawEditorText(rawEl)
    const pipeTargetAt = afterTableText.indexOf('[buildTree](#buildtree)')
    act(() => {
      rawView.dispatch({
        changes: { from: pipeTargetAt, to: pipeTargetAt + '[buildTree](#buildtree)'.length, insert: '[](' },
        selection: { anchor: pipeTargetAt + 3 }
      })
    })
    const rawTableListbox = await screen.findByRole('listbox', { name: '링크 자동완성' })
    await user.click(within(rawTableListbox).getByRole('option', { name: /A \| B 표기/ }))
    expect(getRawEditorText(rawEl)).toContain('| target | [A \\| B 표기](#a-b-표기) |')

    // 3) Raw 본문 [`심볼`]( 완성
    const bodyEnd = getRawEditorText(rawEl).length
    act(() => {
      rawView.dispatch({
        changes: { from: bodyEnd, to: bodyEnd, insert: '[`buildTree`](' },
        selection: { anchor: bodyEnd + '[`buildTree`]('.length }
      })
    })
    await screen.findByRole('listbox', { name: '링크 자동완성' })
    fireEvent.keyDown(rawEl, { key: 'Tab' })
    expect(getRawEditorText(rawEl)).toContain('본문 [`buildTree`](#buildtree)')

    // 4) 위지윅 모드로 전환하여 본문/테이블 []( 자동 채움 및 후속 입력 링크 마크 이탈 확인
    const primaryPane = screen.getByTestId('pane-primary')
    await switchPaneEditorMode(user, primaryPane, '위지윅')
    const wysiwygEl = await screen.findByTestId('document-editor')
    const tableCellP = wysiwygEl.querySelectorAll('td p')[1]
    wysiwygEl.focus()
    const range = document.createRange()
    range.selectNodeContents(tableCellP)
    range.collapse(false)
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))

    await user.keyboard(' [[](')
    const wysiwygListbox = await screen.findByRole('listbox', { name: '링크 자동완성' })
    expect(within(wysiwygListbox).getAllByRole('option')[0]).toHaveTextContent('개요')
    fireEvent.keyDown(wysiwygEl, { key: 'Enter' })

    await user.keyboard(' 이후')
    expect(wysiwygEl.querySelector('td a[href="#11-개요"]')).toHaveTextContent('개요')

    // 5) Preview 헤딩 id / 문서 목차와 동일한 슬러그 일치 검증
    await switchPaneEditorMode(user, primaryPane, 'Preview')
    await waitFor(() => {
      expect(document.getElementById('11-개요')).not.toBeNull()
      expect(document.getElementById('buildtree')).not.toBeNull()
      expect(document.getElementById('a-b-표기')).not.toBeNull()
    })
    const tocRegion = screen.getByRole('complementary', { name: '우측 사이드바' })
    expect(within(tocRegion).getByRole('button', { name: /개요/ })).toBeInTheDocument()
  })

  it('handles Ctrl+K wrapping/unwrapping, modal/dialog blocking, and config.json exclusion', async () => {
    const user = userEvent.setup()
    const md = '# 개요\n\n단일선택 대상\n\n[기존](#개요) 끝'
    const { api, emitMenuCommand } = createInMemoryWikiApi(
      { theme: 'light', autoSave: false },
      {
        selectedFolder: 'C:/wiki',
        workspaces: {
          'C:/wiki': {
            'guide.md': md,
            'notes.txt': 'plain text'
          }
        }
      }
    )
    window.wikiApi = api

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    const explorer = screen.getByLabelText('워크스페이스 탐색기')
    await user.click(await within(explorer).findByText('guide.md'))

    const rawEl = await screen.findByTestId('document-editor')
    const selStart = md.indexOf('단일선택')
    setRawEditorSelection(rawEl, selStart, selStart + '단일선택'.length)
    fireEvent.keyDown(rawEl, { key: 'k', ctrlKey: true })

    expect(await screen.findByRole('listbox', { name: '링크 자동완성' })).toBeInTheDocument()
    expect(getRawEditorText(rawEl)).toContain('[단일선택](')
    fireEvent.keyDown(rawEl, { key: 'Escape' })

    // 위지윅에서 기존 링크 내부 커서 Ctrl+K -> 언랩 및 메뉴 오픈
    await switchPaneEditorMode(user, screen.getByTestId('pane-primary'), '위지윅')
    const wysiwygEl = await screen.findByTestId('document-editor')
    const existingAnchor = wysiwygEl.querySelector('a[href="#개요"]')!
    wysiwygEl.focus()
    const range = document.createRange()
    range.setStart(existingAnchor.firstChild!, 1)
    range.setEnd(existingAnchor.firstChild!, 1)
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))

    fireEvent.keyDown(wysiwygEl, { key: 'k', ctrlKey: true })
    expect(await screen.findByRole('listbox', { name: '링크 자동완성' })).toBeInTheDocument()
    expect(wysiwygEl.textContent).toContain('[기존](')
    fireEvent.keyDown(wysiwygEl, { key: 'Escape' })

    // 전역 설정 패널 모달 열림 중 Ctrl+K 무효
    await triggerMenuCommand(emitMenuCommand, 'toggle-settings')
    const settingsDialog = await screen.findByRole('dialog', { name: '전역 설정 패널' })
    fireEvent.keyDown(wysiwygEl, { key: 'k', ctrlKey: true })
    expect(screen.queryByRole('listbox', { name: '링크 자동완성' })).not.toBeInTheDocument()

    // config.json 직접 열기 -> 비마크다운 문서에서는 링크 자동완성/Ctrl+K 비활성
    await user.click(within(settingsDialog).getByRole('button', { name: /설정 파일 직접 열기/i }))
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: '전역 설정 패널' })).not.toBeInTheDocument()
    })
    const configEditor = await screen.findByTestId('document-editor')
    fireEvent.keyDown(configEditor, { key: 'k', ctrlKey: true })
    expect(screen.queryByRole('listbox', { name: '링크 자동완성' })).not.toBeInTheDocument()

    // .txt 비마크다운 문서에서도 [텍스트]( 및 Ctrl+K 비활성
    await user.click(await within(explorer).findByText('notes.txt'))
    const txtEditor = await screen.findByTestId('document-editor')
    const txtView = getRawEditorView(txtEditor)
    act(() => {
      txtView.dispatch({ changes: { from: 10, to: 10, insert: ' [a](' }, selection: { anchor: 15 } })
    })
    expect(screen.queryByRole('listbox', { name: '링크 자동완성' })).not.toBeInTheDocument()
    fireEvent.keyDown(txtEditor, { key: 'k', ctrlKey: true })
    expect(screen.queryByRole('listbox', { name: '링크 자동완성' })).not.toBeInTheDocument()

    // 마크다운 문서(guide.md) 탭 복귀 후 dirty 탭 닫기 확인 다이얼로그 열림 중 Ctrl+K 무효
    await user.click(screen.getByRole('tab', { name: /guide\.md/ }))
    const activeMdEditor = await screen.findByTestId('document-editor')
    await user.click(screen.getByRole('button', { name: 'guide.md 탭 닫기' }))
    const confirmDialog = await screen.findByRole('alertdialog')
    expect(confirmDialog).toBeInTheDocument()
    fireEvent.keyDown(activeMdEditor, { key: 'k', ctrlKey: true })
    expect(screen.queryByRole('listbox', { name: '링크 자동완성' })).not.toBeInTheDocument()
  })

  it('surfaces nested workspace markdown files in Raw and WYSIWYG link autocomplete without expanding collapsed folders, excluding active doc and encoding relative hrefs', async () => {
    const user = userEvent.setup()
    const { api, emitMenuCommand, readDirCalls } = createInMemoryWikiApi(
      { theme: 'light', autoSave: false },
      {
        selectedFolder: 'C:/wiki',
        workspaces: {
          'C:/wiki': {
            'docs/active.md': '# 현재 개요\n\n',
            'docs/sub/api (1).md': '# API 1',
            'guides/setup.markdown': '# Setup',
            'notes.txt': 'ignored',
            '.git/secret.md': 'ignored'
          }
        }
      }
    )
    window.wikiApi = api

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    const explorer = screen.getByLabelText('워크스페이스 탐색기')

    expect(readDirCalls).toEqual(['C:/wiki'])
    await user.click(await within(explorer).findByText('docs'))
    await user.click(await within(explorer).findByText('active.md'))

    const rawEl = await screen.findByTestId('document-editor')
    appendRawEditorText(rawEl, '[](')

    const listbox = await screen.findByRole('listbox', { name: '링크 자동완성' })
    expect(within(listbox).queryByText('active.md')).not.toBeInTheDocument()
    expect(within(listbox).queryByText('notes.txt')).not.toBeInTheDocument()
    expect(within(listbox).queryByText('secret.md')).not.toBeInTheDocument()
    expect(within(listbox).getByText('docs/sub/api (1).md')).toBeInTheDocument()
    expect(within(listbox).getByText('guides/setup.markdown')).toBeInTheDocument()

    // Collapsed folders ('docs/sub', 'guides') must NOT be expanded via readDir
    expect(readDirCalls).toEqual(['C:/wiki', 'C:/wiki/docs'])

    appendRawEditorText(rawEl, './')
    await waitFor(() => {
      const updated = screen.getByRole('listbox', { name: '링크 자동완성' })
      expect(within(updated).queryByText('guides/setup.markdown')).not.toBeInTheDocument()
      expect(within(updated).getByText('docs/sub/api (1).md')).toBeInTheDocument()
    })
    await user.click(within(screen.getByRole('listbox', { name: '링크 자동완성' })).getByRole('option'))
    expect(getRawEditorText(rawEl)).toContain('[api (1)](./sub/api%20%281%29.md)')

    // Switch to 위지윅 and insert a parent-relative ../ link
    const primaryPane = screen.getByTestId('pane-primary')
    await switchPaneEditorMode(user, primaryPane, '위지윅')
    const wysiwygEl = await screen.findByTestId('document-editor')
    expect(wysiwygEl.querySelector('a[href="./sub/api%20%281%29.md"]')).not.toBeNull()

    const paragraphs = wysiwygEl.querySelectorAll('p')
    const lastP = paragraphs[paragraphs.length - 1]!
    const range = document.createRange()
    range.selectNodeContents(lastP)
    range.collapse(false)
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(range)
    wysiwygEl.focus()
    document.dispatchEvent(new Event('selectionchange'))

    await user.keyboard(' [[셋업](../')
    const wListbox = await screen.findByRole('listbox', { name: '링크 자동완성' })
    expect(within(wListbox).queryByText('docs/sub/api (1).md')).not.toBeInTheDocument()
    await user.click(within(wListbox).getByRole('option', { name: /setup\.markdown/ }))

    await switchPaneEditorMode(user, primaryPane, 'Raw')
    expect(getRawEditorText(await screen.findByTestId('document-editor'))).toContain(
      '[셋업](../guides/setup.markdown)'
    )
    expect(readDirCalls).toEqual(['C:/wiki', 'C:/wiki/docs'])
  })

  it('keeps workspace file link candidates synchronized across file creation, collapsed folder rename, file deletion, and workspace:changed events', async () => {
    const user = userEvent.setup()
    const { api, emitMenuCommand, emitWorkspaceChange } = createInMemoryWikiApi(
      { theme: 'light', autoSave: false },
      {
        selectedFolder: 'C:/wiki',
        workspaces: {
          'C:/wiki': {
            'root.md': '# Root\n\n',
            'guides/start.md': '# Start',
            'guides/extra.md': '# Extra'
          }
        }
      }
    )
    window.wikiApi = api

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    const sidebar = screen.getByLabelText('왼쪽 사이드바')
    const explorer = screen.getByLabelText('워크스페이스 탐색기')

    await user.click(await within(explorer).findByText('root.md'))
    await screen.findByTestId('document-editor')

    // Create a new file via Explorer -> synced into autocomplete
    await user.click(within(sidebar).getByRole('button', { name: /새 파일/i }))
    await user.type(await within(sidebar).findByLabelText('새 파일 이름'), 'draft.md{Enter}')
    await waitFor(() => {
      expect(within(explorer).getByText('draft.md')).toBeInTheDocument()
    })

    // Return to root.md tab so root.md is active
    await user.click(screen.getByRole('tab', { name: /root\.md/ }))
    const rootRawEl = await screen.findByTestId('document-editor')
    appendRawEditorText(rootRawEl, '[](')
    const afterCreateMenu = await screen.findByRole('listbox', { name: '링크 자동완성' })
    expect(within(afterCreateMenu).getByRole('option', { name: /draft\.md/ })).toBeInTheDocument()
    expect(within(afterCreateMenu).getByText('guides/start.md')).toBeInTheDocument()
    fireEvent.keyDown(rootRawEl, { key: 'Escape' })

    // Rename collapsed folder 'guides' -> 'manuals' via F2
    const guidesItem = within(sidebar).getByRole('treeitem', { name: 'guides' })
    guidesItem.focus()
    fireEvent.keyDown(guidesItem, { key: 'F2' })
    const renameInput = await within(sidebar).findByLabelText('새 이름 입력')
    await user.clear(renameInput)
    await user.type(renameInput, 'manuals{Enter}')
    await waitFor(() => {
      expect(within(explorer).getByText('manuals')).toBeInTheDocument()
    })

    fireEvent.keyDown(rootRawEl, { key: 'k', ctrlKey: true })
    const afterRenameMenu = await screen.findByRole('listbox', { name: '링크 자동완성' })
    expect(within(afterRenameMenu).queryByText('guides/start.md')).not.toBeInTheDocument()
    expect(within(afterRenameMenu).getByText('manuals/start.md')).toBeInTheDocument()
    expect(within(afterRenameMenu).getByText('manuals/extra.md')).toBeInTheDocument()
    fireEvent.keyDown(rootRawEl, { key: 'Escape' })

    // Expand 'manuals' and delete 'extra.md' -> removed from autocomplete
    await user.click(within(explorer).getByText('manuals'))
    const extraEl = await within(explorer).findByText('extra.md')
    fireEvent.contextMenu(extraEl)
    await user.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: /삭제/i }))
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: /삭제 확인/i }))
    await waitFor(() => {
      expect(within(explorer).queryByText('extra.md')).not.toBeInTheDocument()
    })

    // Open menu then simulate external file creation + workspace:changed while menu is open
    fireEvent.keyDown(rootRawEl, { key: 'k', ctrlKey: true })
    const beforeWatchMenu = await screen.findByRole('listbox', { name: '링크 자동완성' })
    expect(within(beforeWatchMenu).queryByText('manuals/extra.md')).not.toBeInTheDocument()

    await api.workspace.createEntry('C:/wiki', 'watched-doc.md', 'file', '# Watch')
    act(() => {
      emitWorkspaceChange({
        rootPath: 'C:/wiki',
        eventType: 'rename',
        relativePath: 'watched-doc.md'
      })
    })

    await waitFor(() => {
      const refreshedMenu = screen.getByRole('listbox', { name: '링크 자동완성' })
      expect(within(refreshedMenu).getByRole('option', { name: /watched-doc\.md/ })).toBeInTheDocument()
    })
  })

  it('completes workspace switching even when a concurrent workspace:changed refresh arrives while initial markdown files are loading', async () => {
    const user = userEvent.setup()
    const { api, emitMenuCommand, emitWorkspaceChange } = createInMemoryWikiApi(
      { theme: 'light', autoSave: false },
      {
        selectedFolder: 'C:/wiki-a',
        workspaces: {
          'C:/wiki-a': {
            'alpha.md': '# Alpha\n\n'
          },
          'C:/wiki-b': {
            'beta.md': '# Beta\n\n',
            'nested/target.md': '# Target'
          }
        }
      }
    )

    const baseListMarkdownFiles = api.workspace.listMarkdownFiles.bind(api.workspace)
    let resolveDelayedList!: (entries: WorkspaceEntry[]) => void
    const delayedListPromise = new Promise<WorkspaceEntry[]>((resolve) => {
      resolveDelayedList = resolve
    })
    let listCallCount = 0
    vi.spyOn(api.workspace, 'listMarkdownFiles').mockImplementation(async () => {
      listCallCount += 1
      if (listCallCount === 2) {
        return await delayedListPromise
      }
      if (listCallCount === 3) {
        return [
          {
            name: 'alpha.md',
            path: 'C:/wiki-a/alpha.md',
            relativePath: 'alpha.md',
            kind: 'file'
          }
        ]
      }
      return await baseListMarkdownFiles()
    })
    vi.spyOn(api.workspace, 'selectFolder')
      .mockResolvedValueOnce('C:/wiki-a')
      .mockResolvedValueOnce('C:/wiki-b')
    window.wikiApi = api

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    const explorer = screen.getByLabelText('워크스페이스 탐색기')
    await user.click(await within(explorer).findByText('alpha.md'))
    await screen.findByTestId('document-editor')

    act(() => {
      emitMenuCommand('open-folder')
    })
    await waitFor(() => {
      expect(listCallCount).toBe(2)
    })

    // Fire a stale workspace:changed event from C:/wiki-a while openWorkspace is awaiting listMarkdownFiles()
    act(() => {
      emitWorkspaceChange({
        rootPath: 'C:/wiki-a',
        eventType: 'rename',
        relativePath: 'alpha.md'
      })
    })
    await waitFor(() => {
      expect(listCallCount).toBe(3)
    })

    const wikiBEntries = await baseListMarkdownFiles()
    await act(async () => {
      resolveDelayedList(wikiBEntries)
    })

    expect(await within(explorer).findByText('beta.md')).toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: /alpha\.md/ })).not.toBeInTheDocument()
    await user.click(within(explorer).getByText('beta.md'))
    const rawEl = await screen.findByTestId('document-editor')
    appendRawEditorText(rawEl, '[](')

    const listbox = await screen.findByRole('listbox', { name: '링크 자동완성' })
    expect(within(listbox).queryAllByText('alpha.md')).toHaveLength(0)
    expect(within(listbox).getByText('nested/target.md')).toBeInTheDocument()
  })
})

describe('Markdown link navigation and missing target banner', () => {
  it('navigates same-doc sections across Preview/Raw/WYSIWYG modes, ignores external URLs, and opens relative links with optional #slug in clicked split pane', async () => {
    const user = userEvent.setup()
    const { api, emitMenuCommand } = createInMemoryWikiApi(
      { theme: 'light', autoSave: false, showHeadingNumbers: false },
      {
        selectedFolder: 'C:/wiki-nav',
        workspaces: {
          'C:/wiki-nav': {
            'docs/current.md': [
              '# 개요',
              '',
              '- [세부 이동](#%EC%84%B8%EB%B6%80-%ED%95%AD%EB%AA%A9)',
              '- [외부](https://example.com)',
              '- [메일](mailto:wiki@example.com)',
              '- [가이드](../sub/guide%20%281%29.md#%EC%84%A4%EC%A0%95)',
              '- [형제](./sibling.md)',
              '- [Raw 이동](./raw-target.md)',
              '- [위지윅 이동](./wysiwyg-target.md)',
              '- [상하 이동](./vertical-target.md)',
              '',
              '본문 첫 줄',
              '',
              '## 세부 항목',
              '',
              '세부 본문'
            ].join('\n'),
            'docs/sibling.md': '# 형제 문서\n\n[현재 복귀](./current.md#개요)',
            'docs/raw-target.md': '# Raw 대상\n\n본문',
            'docs/wysiwyg-target.md': '# 위지윅 대상\n\n본문',
            'docs/vertical-target.md': '# 상하 분할 대상\n\n본문',
            'sub/guide (1).md': '# 가이드 시작\n\n안내 본문\n\n## 설정\n\n설정 값'
          }
        }
      }
    )
    const readFileSpy = vi.spyOn(api.workspace, 'readFile')
    const { mock: scrollIntoViewMock, restore } = mockPrototypeScrollIntoView()
    const getHeadingScrollTargets = (): HTMLElement[] =>
      scrollIntoViewMock.mock.calls.flatMap((args, idx) =>
        (args[0] as ScrollIntoViewOptions | undefined)?.block === 'start'
          ? [scrollIntoViewMock.mock.instances[idx] as HTMLElement]
          : []
      )

    try {
      window.wikiApi = api
      render(<App />)

      await triggerMenuCommand(emitMenuCommand, 'open-folder')
      const explorer = screen.getByLabelText('워크스페이스 탐색기')
      await user.click(await within(explorer).findByText('docs'))
      await user.click(await within(explorer).findByText('current.md'))

      const primaryPane = screen.getByTestId('pane-primary')
      expect(within(primaryPane).getByRole('tab', { name: /current\.md/i })).toBeInTheDocument()

      // 1) Preview normal click: same-doc percent-encoded Korean #slug + external links no-op
      await switchPaneEditorMode(user, primaryPane, 'Preview')
      scrollIntoViewMock.mockClear()
      fireEvent.click(within(primaryPane).getByRole('link', { name: '세부 이동' }))
      expect(getHeadingScrollTargets()).toHaveLength(1)
      expect(getHeadingScrollTargets()[0].id).toBe('세부-항목')
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()

      const readCallsBeforeExternal = readFileSpy.mock.calls.length
      expect(fireEvent.click(within(primaryPane).getByRole('link', { name: '외부' }))).toBe(false)
      expect(fireEvent.click(within(primaryPane).getByRole('link', { name: '메일' }))).toBe(false)
      expect(readFileSpy).toHaveBeenCalledTimes(readCallsBeforeExternal)
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()

      // 2) Raw mode: normal click does not jump, Ctrl+click jumps cursor to heading line
      await switchPaneEditorMode(user, primaryPane, 'Raw')
      const rawCmContent = within(primaryPane).getByTestId('document-editor') as HTMLElement
      const rawView = getRawEditorView(rawCmContent)
      const headingOffset = rawView.state.doc.toString().indexOf('## 세부 항목')
      const sectionSpan = Array.from(rawCmContent.querySelectorAll('span')).find((el) =>
        el.textContent?.includes('#%EC%84%B8%EB%B6%80-%ED%95%AD%EB%AA%A9')
      )!
      const externalSpan = Array.from(rawCmContent.querySelectorAll('span')).find((el) =>
        el.textContent?.includes('https://example.com')
      )!

      fireEvent.click(sectionSpan)
      expect(rawView.state.selection.main.head).not.toBe(headingOffset)

      fireEvent.click(sectionSpan, { ctrlKey: true })
      await waitFor(() => {
        expect(rawView.state.selection.main.head).toBe(headingOffset)
      })
      fireEvent.click(externalSpan, { ctrlKey: true })
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()

      const rawRelSpan = Array.from(rawCmContent.querySelectorAll('span')).find((el) =>
        el.textContent?.includes('./raw-target.md')
      )!
      fireEvent.click(rawRelSpan, { ctrlKey: true })
      const rawTargetTab = await within(primaryPane).findByRole('tab', { name: /raw-target\.md/i })
      expect(rawTargetTab).toHaveAttribute('aria-selected', 'true')
      await user.click(within(primaryPane).getByRole('tab', { name: /current\.md/i }))

      // 3) WYSIWYG mode: Alt+click does not jump, plain click and Meta+click scroll heading, plain click opens relative file
      await switchPaneEditorMode(user, primaryPane, '위지윅')
      scrollIntoViewMock.mockClear()
      const wysiwygEl = within(primaryPane).getByTestId('document-editor')
      const wysiwygSectionLink = Array.from(wysiwygEl.querySelectorAll('a')).find(
        (a) => a.getAttribute('href') === '#%EC%84%B8%EB%B6%80-%ED%95%AD%EB%AA%A9'
      )!
      expect(fireEvent.click(wysiwygSectionLink, { altKey: true })).toBe(false)
      expect(scrollIntoViewMock).not.toHaveBeenCalled()

      expect(fireEvent.click(wysiwygSectionLink)).toBe(false)
      await waitFor(() => {
        expect(getHeadingScrollTargets()).toHaveLength(1)
      })
      expect(getHeadingScrollTargets()[0].textContent).toContain('세부 항목')

      scrollIntoViewMock.mockClear()
      expect(fireEvent.click(wysiwygSectionLink, { metaKey: true })).toBe(false)
      await waitFor(() => {
        expect(getHeadingScrollTargets()).toHaveLength(1)
      })
      expect(getHeadingScrollTargets()[0].textContent).toContain('세부 항목')

      const wysiwygRelLink = Array.from(wysiwygEl.querySelectorAll('a')).find(
        (a) => a.getAttribute('href') === './wysiwyg-target.md'
      )!
      expect(fireEvent.click(wysiwygRelLink)).toBe(false)
      const wysiwygTargetTab = await within(primaryPane).findByRole('tab', {
        name: /wysiwyg-target\.md/i
      })
      expect(wysiwygTargetTab).toHaveAttribute('aria-selected', 'true')
      await user.click(within(primaryPane).getByRole('tab', { name: /current\.md/i }))

      // 4) Preview relative file link with percent encoding + #slug opens tab and jumps to target heading
      await switchPaneEditorMode(user, primaryPane, 'Preview')
      await user.click(within(primaryPane).getByRole('link', { name: '가이드' }))
      const guideTab = await within(primaryPane).findByRole('tab', { name: /guide \(1\)\.md/i })
      expect(guideTab).toHaveAttribute('aria-selected', 'true')
      await waitFor(() => {
        const targetCm = within(primaryPane).getByTestId('document-editor') as HTMLElement
        const targetView = getRawEditorView(targetCm)
        expect(targetView.state.selection.main.head).toBe(
          targetView.state.doc.toString().indexOf('## 설정')
        )
      })

      // 5) Split mode: relative click in secondary pane opens/activates tab ONLY in secondary pane
      fireEvent.contextMenu(within(primaryPane).getByRole('tab', { name: /current\.md/i }))
      const tabMenu = await screen.findByRole('menu', { name: '탭 작업 메뉴' })
      await user.click(within(tabMenu).getByRole('menuitem', { name: '분할 영역에 복제 열기' }))

      const secondaryPane = screen.getByTestId('pane-secondary')
      await switchPaneEditorMode(user, secondaryPane, 'Preview')
      await user.click(within(secondaryPane).getByRole('link', { name: '형제' }))

      const siblingTab = await within(secondaryPane).findByRole('tab', { name: /sibling\.md/i })
      expect(siblingTab).toHaveAttribute('aria-selected', 'true')
      expect(within(primaryPane).queryByRole('tab', { name: /sibling\.md/i })).not.toBeInTheDocument()
      expect(within(secondaryPane).getAllByRole('tab')).toHaveLength(2)

      // Activating already-open current.md tab in secondary pane via ./current.md#개요 keeps tab count at 2 and scrolls
      await switchPaneEditorMode(user, secondaryPane, 'Preview')
      scrollIntoViewMock.mockClear()
      await user.click(within(secondaryPane).getByRole('link', { name: '현재 복귀' }))
      await waitFor(() => {
        expect(within(secondaryPane).getByRole('tab', { name: /current\.md/i })).toHaveAttribute(
          'aria-selected',
          'true'
        )
      })
      expect(within(secondaryPane).getAllByRole('tab')).toHaveLength(2)
      await waitFor(() => {
        expect(getHeadingScrollTargets()).toHaveLength(1)
      })
      expect(getHeadingScrollTargets()[0].id).toBe('개요')

      // Switch to vertical split mode and open relative link inside the clicked secondary vertical pane
      fireEvent.dragStart(within(secondaryPane).getByRole('tab', { name: /sibling\.md/i }))
      fireEvent.drop(await screen.findByTestId('split-drop-zone-vertical'))
      expect(screen.getByTestId('pane-workspace')).toHaveAttribute('data-split-mode', 'vertical')

      await user.click(within(secondaryPane).getByRole('tab', { name: /current\.md/i }))
      await switchPaneEditorMode(user, secondaryPane, 'Preview')
      await user.click(within(secondaryPane).getByRole('link', { name: '상하 이동' }))

      const verticalTargetTab = await within(secondaryPane).findByRole('tab', {
        name: /vertical-target\.md/i
      })
      expect(verticalTargetTab).toHaveAttribute('aria-selected', 'true')
      expect(
        within(primaryPane).queryByRole('tab', { name: /vertical-target\.md/i })
      ).not.toBeInTheDocument()
    } finally {
      restore()
    }
  })

  it('displays error banner without creating files for missing targets or workspace escapes, and opens target file even when its #slug is missing', async () => {
    const user = userEvent.setup()
    const { api, emitMenuCommand, getFilesSnapshot } = createInMemoryWikiApi(
      { theme: 'light', autoSave: false },
      {
        selectedFolder: 'C:/wiki-broken',
        workspaces: {
          'C:/wiki-broken': {
            'docs/index.md': [
              '# 인덱스',
              '',
              '- [없는 섹션](#no-such-heading)',
              '- [없는 파일](./missing.md)',
              '- [루트 밖](../../outside.md)',
              '- [비마크다운 파일](./diagram.png)',
              '- [파일은 있음](./target.md#missing-sec)'
            ].join('\n'),
            'docs/target.md': '# 존재하는 제목\n\n내용',
            'docs/diagram.png': 'PNGDATA'
          }
        }
      }
    )
    const createEntrySpy = vi.spyOn(api.workspace, 'createEntry')
    const readFileSpy = vi.spyOn(api.workspace, 'readFile')
    window.wikiApi = api

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    const explorer = screen.getByLabelText('워크스페이스 탐색기')
    await user.click(await within(explorer).findByText('docs'))
    await user.click(await within(explorer).findByText('index.md'))

    const initialSnapshot = getFilesSnapshot()
    const primaryPane = screen.getByTestId('pane-primary')
    await switchPaneEditorMode(user, primaryPane, 'Preview')

    // 1) Missing #slug in current document
    await user.click(within(primaryPane).getByRole('link', { name: '없는 섹션' }))
    const missingHeadingAlert = await screen.findByRole('alert')
    expect(missingHeadingAlert).toHaveTextContent(/찾을 수 없습니다/)

    // 2) Missing relative markdown file
    await user.click(within(primaryPane).getByRole('link', { name: '없는 파일' }))
    const missingFileAlert = await screen.findByRole('alert')
    expect(missingFileAlert).toHaveTextContent(/찾을 수 없습니다/)
    expect(getFilesSnapshot()).toEqual(initialSnapshot)
    expect(createEntrySpy).not.toHaveBeenCalled()
    expect(within(primaryPane).getByRole('tab', { name: /index\.md/i })).toHaveAttribute(
      'aria-selected',
      'true'
    )

    // 3) Path outside workspace root
    const readCallsBeforeEscape = readFileSpy.mock.calls.length
    await user.click(within(primaryPane).getByRole('link', { name: '루트 밖' }))
    const outsideAlert = await screen.findByRole('alert')
    expect(outsideAlert).toHaveTextContent(/워크스페이스 루트 밖/)
    expect(readFileSpy).toHaveBeenCalledTimes(readCallsBeforeEscape)
    expect(getFilesSnapshot()).toEqual(initialSnapshot)
    expect(createEntrySpy).not.toHaveBeenCalled()

    // 3b) Non-markdown relative file link is rejected without reading the file or creating entries
    const readCallsBeforeNonMd = readFileSpy.mock.calls.length
    await user.click(within(primaryPane).getByRole('link', { name: '비마크다운 파일' }))
    const nonMdAlert = await screen.findByRole('alert')
    expect(nonMdAlert).toHaveTextContent(/마크다운 문서만|지원하지 않는/)
    expect(readFileSpy).toHaveBeenCalledTimes(readCallsBeforeNonMd)
    expect(getFilesSnapshot()).toEqual(initialSnapshot)
    expect(createEntrySpy).not.toHaveBeenCalled()
    expect(within(primaryPane).getByRole('tab', { name: /index\.md/i })).toHaveAttribute(
      'aria-selected',
      'true'
    )

    // 4) Existing target file + missing #slug opens target tab AND shows error banner
    await user.click(within(primaryPane).getByRole('link', { name: '파일은 있음' }))
    const targetTab = await within(primaryPane).findByRole('tab', { name: /target\.md/i })
    expect(targetTab).toHaveAttribute('aria-selected', 'true')
    const missingTargetSlugAlert = await screen.findByRole('alert')
    expect(missingTargetSlugAlert).toHaveTextContent(/missing-sec/)
    expect(getFilesSnapshot()).toEqual(initialSnapshot)
  })
})

describe('Mermaid tab-session height persistence and workspaceState exclusion', () => {
  beforeEach(() => {
    defaultMermaidRenderer.clearCache()
    mermaidMockState.reset()
  })

  it('preserves per-tab 0-based Mermaid heights across mode switches, tab switches, and live Split edits, clears on reset, and excludes them from dirty state and workspace-state.json', async () => {
    const user = userEvent.setup()
    const duplicateCode = 'graph TD\n  A --> B'
    const docAContent = [
      '# Doc A',
      '',
      '```ts',
      'const value = 42',
      '```',
      '',
      '```mermaid',
      duplicateCode,
      '```',
      '',
      '```mermaid',
      duplicateCode,
      '```'
    ].join('\n')
    const docBContent = ['# Doc B', '', '```mermaid', 'graph TD\n  X --> Y', '```'].join('\n')

    const { api, getFilesSnapshot } = createInMemoryWikiApi(
      {
        autoSave: false,
        recentWorkspaces: ['C:/wiki/alpha', 'C:/wiki/beta']
      },
      {
        workspaces: {
          'C:\\wiki\\alpha': {
            'doc-a.md': docAContent,
            'doc-b.md': docBContent
          },
          'C:\\wiki\\beta': {
            'beta.md': '# Beta'
          }
        }
      }
    )
    const saveWorkspaceStateSpy = vi.spyOn(api.workspaceState!, 'save')
    window.wikiApi = api

    render(<App />)
    const explorer = await screen.findByLabelText('워크스페이스 탐색기')
    await user.click(await within(explorer).findByText('doc-a.md'))
    await user.click(within(explorer).getByText('doc-b.md'))
    await user.click(screen.getByRole('tab', { name: /doc-a\.md/ }))

    const primaryPane = screen.getByTestId('pane-primary')
    await switchPaneEditorMode(user, primaryPane, '위지윅')
    await waitFor(() => {
      expect(within(primaryPane).getAllByTestId('wysiwyg-mermaid-block')).toHaveLength(2)
      expect(within(primaryPane).getAllByTestId('mermaid-svg')).toHaveLength(2)
    })

    const wysViewports = within(primaryPane).getAllByTestId('mermaid-svg')
    const wysHandles = within(primaryPane).getAllByTestId('mermaid-resize-handle')
    mockElementBoundingRect(wysViewports[0], { width: 400, height: 180 })
    mockElementBoundingRect(wysViewports[1], { width: 400, height: 180 })

    // 1. Resize identical-code blocks independently in 위지윅 without dirtying buffer or triggering workspaceState.save
    saveWorkspaceStateSpy.mockClear()
    fireEvent.pointerDown(wysHandles[0], { button: 0, clientY: 180 })
    fireEvent.pointerMove(window, { clientY: 260 })
    fireEvent.pointerUp(window)

    fireEvent.pointerDown(wysHandles[1], { button: 0, clientY: 180 })
    fireEvent.pointerMove(window, { clientY: 420 })
    fireEvent.pointerUp(window)

    expect(wysViewports[0].style.height).toBe('260px')
    expect(wysViewports[1].style.height).toBe('420px')
    expect(screen.queryByTestId('dirty-indicator')).not.toBeInTheDocument()
    expect(getFilesSnapshot().get('C:/wiki/alpha/doc-a.md')).toBe(docAContent)

    // 2. Switch 위지윅 -> Preview -> Split and verify both heights stay 260px and 420px
    await switchPaneEditorMode(user, primaryPane, 'Preview')
    await waitFor(() => {
      expect(within(primaryPane).getAllByTestId('mermaid-svg')).toHaveLength(2)
    })
    expect(within(primaryPane).getAllByTestId('mermaid-svg')[0].style.height).toBe('260px')
    expect(within(primaryPane).getAllByTestId('mermaid-svg')[1].style.height).toBe('420px')

    await switchPaneEditorMode(user, primaryPane, 'Split')
    const splitPreview = await within(primaryPane).findByTestId('split-markdown-preview')
    await waitFor(() => {
      expect(within(splitPreview).getAllByTestId('mermaid-svg')).toHaveLength(2)
    })
    expect(within(splitPreview).getAllByTestId('mermaid-svg')[0].style.height).toBe('260px')
    expect(within(splitPreview).getAllByTestId('mermaid-svg')[1].style.height).toBe('420px')

    // 3. Live edit first Mermaid block in Split Raw editor -> heights stay 260px and 420px, then save cleanly
    const splitRawEditor = primaryPane.querySelector('.editor-split-region.is-raw') as HTMLElement
    const editedDocA = docAContent.replace(duplicateCode, 'graph TD\n  A --> LIVE_SPLIT')
    setRawEditorText(splitRawEditor, editedDocA)
    await waitFor(() => {
      expect(mermaidMockState.render).toHaveBeenCalledWith(
        expect.any(String),
        'graph TD\n  A --> LIVE_SPLIT'
      )
      expect(within(splitPreview).getAllByTestId('mermaid-svg')[0].querySelector('svg')).not.toBeNull()
    })
    expect(within(splitPreview).getAllByTestId('mermaid-svg')[0].style.height).toBe('260px')
    expect(within(splitPreview).getAllByTestId('mermaid-svg')[1].style.height).toBe('420px')

    await user.click(within(primaryPane).getByRole('button', { name: '저장' }))
    await waitFor(() => {
      expect(screen.queryByTestId('dirty-indicator')).not.toBeInTheDocument()
    })

    // 4. Switch to doc-b.md, resize its diagram independently, then switch back to doc-a.md
    await user.click(screen.getByRole('tab', { name: /doc-b\.md/ }))
    await switchPaneEditorMode(user, primaryPane, 'Preview')
    await waitFor(() => {
      expect(within(primaryPane).getByTestId('mermaid-svg')).toBeInTheDocument()
    })
    const docBViewport = within(primaryPane).getByTestId('mermaid-svg')
    const docBHandle = within(primaryPane).getByTestId('mermaid-resize-handle')
    mockElementBoundingRect(docBViewport, { width: 400, height: 180 })

    fireEvent.pointerDown(docBHandle, { button: 0, clientY: 180 })
    fireEvent.pointerMove(window, { clientY: 310 })
    fireEvent.pointerUp(window)
    expect(docBViewport.style.height).toBe('310px')
    expect(screen.queryByTestId('dirty-indicator')).not.toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: /doc-a\.md/ }))
    const restoredSplitPreview = await within(primaryPane).findByTestId('split-markdown-preview')
    await waitFor(() => {
      expect(within(restoredSplitPreview).getAllByTestId('mermaid-svg')).toHaveLength(2)
    })
    expect(within(restoredSplitPreview).getAllByTestId('mermaid-svg')[0].style.height).toBe('260px')
    expect(within(restoredSplitPreview).getAllByTestId('mermaid-svg')[1].style.height).toBe('420px')

    // 5. Reset doc-a.md block 0 by handle double-click and block 1 by 뷰 초기화
    const docABlocks = within(restoredSplitPreview).getAllByTestId('mermaid-diagram')
    fireEvent.doubleClick(within(docABlocks[0]).getByTestId('mermaid-resize-handle'))
    expect(within(restoredSplitPreview).getAllByTestId('mermaid-svg')[0].style.height).toBe('')
    expect(within(restoredSplitPreview).getAllByTestId('mermaid-svg')[1].style.height).toBe('420px')

    await user.hover(docABlocks[1])
    await user.click(within(docABlocks[1]).getByRole('button', { name: '뷰 초기화' }))
    expect(within(restoredSplitPreview).getAllByTestId('mermaid-svg')[1].style.height).toBe('')

    await switchPaneEditorMode(user, primaryPane, '위지윅')
    await waitFor(() => {
      expect(within(primaryPane).getAllByTestId('mermaid-svg')).toHaveLength(2)
    })
    expect(within(primaryPane).getAllByTestId('mermaid-svg')[0].style.height).toBe('')
    expect(within(primaryPane).getAllByTestId('mermaid-svg')[1].style.height).toBe('')

    // Switch to doc-b.md -> still 310px; wait for any mode debounce, then clear spy & resize doc-b.md to 390px
    await user.click(screen.getByRole('tab', { name: /doc-b\.md/ }))
    await waitFor(() => {
      expect(within(primaryPane).getByTestId('mermaid-svg').style.height).toBe('310px')
    })

    // 6. Height-only change does NOT trigger workspaceState.save, and switching workspace flushes layout without mermaidHeights
    await new Promise((resolve) => setTimeout(resolve, 300))
    saveWorkspaceStateSpy.mockClear()

    const docBHandleReloaded = within(primaryPane).getByTestId('mermaid-resize-handle')
    fireEvent.pointerDown(docBHandleReloaded, { button: 0, clientY: 310 })
    fireEvent.pointerMove(window, { clientY: 390 })
    fireEvent.pointerUp(window)
    expect(within(primaryPane).getByTestId('mermaid-svg').style.height).toBe('390px')
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(saveWorkspaceStateSpy).not.toHaveBeenCalled()

    await switchWorkspaceFromView(user, /^beta$/i)
    await waitFor(() => {
      expect(
        within(screen.getByLabelText('워크스페이스 탐색기')).getByText('beta.md')
      ).toBeInTheDocument()
    })

    const savedAlpha = await api.workspaceState!.get('C:/wiki/alpha')
    expect(savedAlpha).not.toBeNull()
    expect(JSON.stringify(savedAlpha)).not.toContain('mermaidHeights')
    expect(savedAlpha!.layout.panes.primary.tabs.map((tab) => tab.path)).toEqual([
      'C:\\wiki\\alpha\\doc-a.md',
      'C:\\wiki\\alpha\\doc-b.md'
    ])

    // Reopening alpha restores doc-b.md with auto height (proving in-memory-only session lifecycle)
    await switchWorkspaceFromView(user, /^alpha$/i)
    await waitFor(() => {
      expect(within(screen.getByTestId('pane-primary')).getByTestId('mermaid-svg')).toBeInTheDocument()
    })
    expect(within(screen.getByTestId('pane-primary')).getByTestId('mermaid-svg').style.height).toBe('')
  }, 15_000)
})
