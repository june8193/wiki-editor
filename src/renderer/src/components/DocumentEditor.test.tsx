import { EditorView } from '@codemirror/view'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { createMermaidRenderer, type MermaidDriver } from '../editor/mermaidRenderer'
import { DocumentEditor } from './DocumentEditor'
import type { DocumentBuffer } from '../stores/DocumentBufferStore'
import type { EditorMode, TabItem } from '../stores/PaneTabStore'

function createDoc(overrides: Partial<DocumentBuffer> = {}): DocumentBuffer {
  return {
    key: 'c:/wiki/doc.md',
    kind: 'workspace',
    path: 'C:/wiki/doc.md',
    name: 'doc.md',
    content: '# Heading\n\n*   exact   spacing',
    savedContent: '# Heading\n\n*   exact   spacing',
    isDirty: false,
    version: 1,
    isSaving: false,
    ...overrides
  }
}

function createTab(mode: EditorMode = 'raw', splitPreviewRatio = 0.5): TabItem {
  return {
    id: 'tab-1',
    bufferKey: 'c:/wiki/doc.md',
    mode,
    cursor: { selectionStart: 0, selectionEnd: 0 },
    scrollTop: 0,
    splitPreviewRatio
  }
}

describe('DocumentEditor 4-mode switcher & roundtrip', () => {
  it('switches between Raw, 위지윅, Preview, and Split via top mode switcher and Ctrl+1/2/3/4/Shift+M without corrupting unchanged markdown', async () => {
    const user = userEvent.setup()
    let mode: EditorMode = 'raw'
    const doc = createDoc()
    const onChangeContent = vi.fn()
    const onUpdateViewState = vi.fn((patch: { mode?: EditorMode }) => {
      if (patch.mode) {
        mode = patch.mode
      }
    })

    const { rerender } = render(
      <DocumentEditor
        document={doc}
        tab={createTab(mode)}
        theme="light"
        autoSave={false}
        onChangeContent={onChangeContent}
        onSave={vi.fn()}
        onUpdateViewState={onUpdateViewState}
      />
    )

    const modeGroup = screen.getByRole('group', { name: '에디터 모드 전환' })
    const modeButtons = within(modeGroup).getAllByRole('button')
    expect(modeButtons.map((button) => button.textContent?.trim())).toEqual([
      'Raw',
      '위지윅',
      'Preview',
      'Split'
    ])
    expect(within(modeGroup).getByRole('button', { name: 'Split' })).toHaveAttribute(
      'title',
      'Split 모드 (Ctrl+4, 순환 Ctrl+Shift+M)'
    )
    expect(within(modeGroup).getByRole('button', { name: 'Raw' })).toHaveAttribute('aria-pressed', 'true')

    // Switch to 위지윅 via button
    await user.click(within(modeGroup).getByRole('button', { name: '위지윅' }))
    expect(onUpdateViewState).toHaveBeenLastCalledWith({ mode: 'wysiwyg' })

    rerender(
      <DocumentEditor
        document={doc}
        tab={createTab(mode)}
        theme="light"
        autoSave={false}
        onChangeContent={onChangeContent}
        onSave={vi.fn()}
        onUpdateViewState={onUpdateViewState}
      />
    )
    expect(screen.getByRole('toolbar', { name: '위지윅 서식 툴바' })).toBeInTheDocument()

    // Switch to Preview via Ctrl+3
    fireEvent.keyDown(screen.getByTestId('document-editor'), { key: '3', ctrlKey: true })
    expect(onUpdateViewState).toHaveBeenLastCalledWith({ mode: 'preview' })

    rerender(
      <DocumentEditor
        document={doc}
        tab={createTab(mode)}
        theme="light"
        autoSave={false}
        onChangeContent={onChangeContent}
        onSave={vi.fn()}
        onUpdateViewState={onUpdateViewState}
      />
    )
    expect(screen.getByLabelText('마크다운 미리보기')).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1, name: 'Heading' })).toBeInTheDocument()

    // Cycle from Preview to Split via Ctrl+Shift+M
    fireEvent.keyDown(screen.getByTestId('document-editor'), {
      key: 'M',
      ctrlKey: true,
      shiftKey: true
    })
    expect(onUpdateViewState).toHaveBeenLastCalledWith({ mode: 'split' })

    rerender(
      <DocumentEditor
        document={doc}
        tab={createTab(mode)}
        theme="light"
        autoSave={false}
        onChangeContent={onChangeContent}
        onSave={vi.fn()}
        onUpdateViewState={onUpdateViewState}
      />
    )
    expect(within(modeGroup).getByRole('button', { name: 'Split' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )

    // Cycle from Split back to Raw via Ctrl+Shift+M
    fireEvent.keyDown(screen.getByTestId('document-editor'), {
      key: 'M',
      ctrlKey: true,
      shiftKey: true
    })
    expect(onUpdateViewState).toHaveBeenLastCalledWith({ mode: 'raw' })

    rerender(
      <DocumentEditor
        document={doc}
        tab={createTab(mode)}
        theme="light"
        autoSave={false}
        onChangeContent={onChangeContent}
        onSave={vi.fn()}
        onUpdateViewState={onUpdateViewState}
      />
    )

    // Switch directly to Split via Ctrl+4 and back to Raw via button
    fireEvent.keyDown(screen.getByTestId('document-editor'), { key: '4', ctrlKey: true })
    expect(onUpdateViewState).toHaveBeenLastCalledWith({ mode: 'split' })

    rerender(
      <DocumentEditor
        document={doc}
        tab={createTab(mode)}
        theme="light"
        autoSave={false}
        onChangeContent={onChangeContent}
        onSave={vi.fn()}
        onUpdateViewState={onUpdateViewState}
      />
    )
    await user.click(within(modeGroup).getByRole('button', { name: 'Raw' }))
    expect(onUpdateViewState).toHaveBeenLastCalledWith({ mode: 'raw' })

    rerender(
      <DocumentEditor
        document={doc}
        tab={createTab(mode)}
        theme="light"
        autoSave={false}
        onChangeContent={onChangeContent}
        onSave={vi.fn()}
        onUpdateViewState={onUpdateViewState}
      />
    )

    // Unchanged document preserved byte-for-byte with zero onChangeContent calls
    expect(onChangeContent).not.toHaveBeenCalled()
    expect(screen.getByTestId('document-editor').textContent).toContain('*   exact   spacing')
  })

  it('keeps config.json and plain .txt buffers locked to Raw mode and respects isShortcutDisabled', () => {
    const onUpdateViewState = vi.fn()
    const configDoc = createDoc({
      key: 'c:/config.json',
      kind: 'config',
      path: 'C:/config.json',
      name: 'config.json',
      content: '{"theme":"light"}',
      savedContent: '{"theme":"light"}'
    })

    const { rerender } = render(
      <DocumentEditor
        document={configDoc}
        tab={{ ...createTab('raw'), bufferKey: 'c:/config.json' }}
        theme="light"
        autoSave={false}
        onChangeContent={vi.fn()}
        onSave={vi.fn()}
        onUpdateViewState={onUpdateViewState}
      />
    )

    const modeGroup = screen.getByRole('group', { name: '에디터 모드 전환' })
    expect(within(modeGroup).getByRole('button', { name: '위지윅' })).toBeDisabled()
    expect(within(modeGroup).getByRole('button', { name: 'Preview' })).toBeDisabled()
    expect(within(modeGroup).getByRole('button', { name: 'Split' })).toBeDisabled()

    fireEvent.keyDown(screen.getByTestId('document-editor'), { key: '2', ctrlKey: true })
    fireEvent.keyDown(screen.getByTestId('document-editor'), { key: '4', ctrlKey: true })
    fireEvent.keyDown(screen.getByTestId('document-editor'), {
      key: 'M',
      ctrlKey: true,
      shiftKey: true
    })
    expect(onUpdateViewState).not.toHaveBeenCalled()

    // Non-markdown .txt buffer also locks Split/Preview/WYSIWYG to Raw even if tab.mode was 'split'
    const txtDoc = createDoc({
      key: 'c:/wiki/notes.txt',
      kind: 'workspace',
      path: 'C:/wiki/notes.txt',
      name: 'notes.txt',
      content: 'plain text notes',
      savedContent: 'plain text notes'
    })
    rerender(
      <DocumentEditor
        document={txtDoc}
        tab={{ ...createTab('split'), bufferKey: 'c:/wiki/notes.txt' }}
        theme="light"
        autoSave={false}
        onChangeContent={vi.fn()}
        onSave={vi.fn()}
        onUpdateViewState={onUpdateViewState}
      />
    )
    expect(within(modeGroup).getByRole('button', { name: 'Split' })).toBeDisabled()
    expect(screen.queryByTestId('split-markdown-preview')).not.toBeInTheDocument()
    fireEvent.keyDown(screen.getByTestId('document-editor'), { key: '4', ctrlKey: true })
    expect(onUpdateViewState).not.toHaveBeenCalled()

    // When modal is open (isShortcutDisabled), markdown shortcuts are ignored too
    rerender(
      <DocumentEditor
        document={createDoc()}
        tab={createTab('raw')}
        theme="light"
        autoSave={false}
        isShortcutDisabled
        onChangeContent={vi.fn()}
        onSave={vi.fn()}
        onUpdateViewState={onUpdateViewState}
      />
    )
    fireEvent.keyDown(screen.getByTestId('document-editor'), { key: '3', ctrlKey: true })
    fireEvent.keyDown(screen.getByTestId('document-editor'), { key: '4', ctrlKey: true })
    expect(onUpdateViewState).not.toHaveBeenCalled()
  })

  it('threads showHeadingNumbers, mermaidRenderer, and scrollRequest cleanly while roundtripping mermaid blocks', async () => {
    const user = userEvent.setup()
    let mode: EditorMode = 'raw'
    const mermaidDoc = createDoc({
      content: '# Arch\n\n## Flow\n\n```mermaid\nflowchart LR\n  A --> B\n```',
      savedContent: '# Arch\n\n## Flow\n\n```mermaid\nflowchart LR\n  A --> B\n```'
    })
    const onChangeContent = vi.fn()
    const onUpdateViewState = vi.fn((patch: { mode?: EditorMode }) => {
      if (patch.mode) mode = patch.mode
    })
    const driver: MermaidDriver = {
      initialize: vi.fn(),
      render: vi.fn(async (_id, text) => ({ svg: `<svg data-src="${text.trim()}"></svg>` }))
    }
    const mermaidRenderer = createMermaidRenderer(driver)

    const { rerender } = render(
      <DocumentEditor
        document={mermaidDoc}
        tab={createTab(mode)}
        theme="light"
        autoSave={false}
        showHeadingNumbers
        mermaidRenderer={mermaidRenderer}
        onChangeContent={onChangeContent}
        onSave={vi.fn()}
        onUpdateViewState={onUpdateViewState}
      />
    )

    const modeGroup = screen.getByRole('group', { name: '에디터 모드 전환' })
    await user.click(within(modeGroup).getByRole('button', { name: '위지윅' }))

    rerender(
      <DocumentEditor
        document={mermaidDoc}
        tab={createTab(mode)}
        theme="light"
        autoSave={false}
        showHeadingNumbers
        mermaidRenderer={mermaidRenderer}
        onChangeContent={onChangeContent}
        onSave={vi.fn()}
        onUpdateViewState={onUpdateViewState}
      />
    )
    await waitFor(() => {
      expect(screen.getByTestId('wysiwyg-mermaid-block').querySelector('svg')).not.toBeNull()
    })

    await user.click(within(modeGroup).getByRole('button', { name: 'Preview' }))
    rerender(
      <DocumentEditor
        document={mermaidDoc}
        tab={createTab(mode)}
        theme="light"
        autoSave={false}
        showHeadingNumbers={false}
        mermaidRenderer={mermaidRenderer}
        onChangeContent={onChangeContent}
        onSave={vi.fn()}
        onUpdateViewState={onUpdateViewState}
      />
    )
    expect(screen.getByRole('heading', { level: 2, name: 'Flow' }).textContent).toBe('Flow')

    await user.click(within(modeGroup).getByRole('button', { name: 'Raw' }))
    rerender(
      <DocumentEditor
        document={mermaidDoc}
        tab={createTab(mode)}
        theme="light"
        autoSave={false}
        showHeadingNumbers={false}
        mermaidRenderer={mermaidRenderer}
        scrollRequest={{
          paneId: 'primary',
          tabId: 'tab-1',
          mode: 'raw',
          line: 3,
          slug: 'flow',
          index: 1,
          nonce: 1
        }}
        onChangeContent={onChangeContent}
        onSave={vi.fn()}
        onUpdateViewState={onUpdateViewState}
      />
    )

    await waitFor(() => {
      expect(screen.getByTestId('document-editor').getAttribute('data-selection-start')).toBe(
        String(mermaidDoc.content.indexOf('## Flow'))
      )
    })
    expect(onChangeContent).not.toHaveBeenCalled()
    expect(screen.getByTestId('document-editor').textContent).toContain('flowchart LR')
  })

  it('renders Raw editor (toolbar, slash menu, syntax highlighting) and live Preview (markdown + debounced Mermaid) side by side in Split mode', async () => {
    const user = userEvent.setup()
    let latestTab: TabItem = {
      ...createTab('split'),
      cursor: { selectionStart: 0, selectionEnd: 0 },
      scrollTop: 120
    }
    const initialContent = '# Arch\n\n```mermaid\nflowchart LR\n  A --> B\n```\n'
    let doc = createDoc({
      content: initialContent,
      savedContent: initialContent
    })

    const driver: MermaidDriver = {
      initialize: vi.fn(),
      render: vi.fn(async (_id, text) => ({ svg: `<svg><text>${text.trim()}</text></svg>` }))
    }
    const mermaidRenderer = createMermaidRenderer(driver)
    const onUpdateViewState = vi.fn((patch: Partial<TabItem>) => {
      latestTab = { ...latestTab, ...patch }
    })

    const { container, rerender } = render(
      <DocumentEditor
        document={doc}
        tab={latestTab}
        theme="light"
        autoSave={false}
        showHeadingNumbers
        mermaidRenderer={mermaidRenderer}
        onChangeContent={(nextContent) => {
          doc = { ...doc, content: nextContent, isDirty: nextContent !== doc.savedContent }
          rerender(
            <DocumentEditor
              document={doc}
              tab={latestTab}
              theme="light"
              autoSave={false}
              showHeadingNumbers
              mermaidRenderer={mermaidRenderer}
              onChangeContent={vi.fn()}
              onSave={vi.fn()}
              onUpdateViewState={onUpdateViewState}
            />
          )
        }}
        onSave={vi.fn()}
        onUpdateViewState={onUpdateViewState}
      />
    )

    // Left: Raw editor with syntax highlighting & Raw table toolbar
    const rawEditor = screen.getByTestId('document-editor')
    expect(rawEditor).toHaveAttribute('contenteditable', 'true')
    expect(container.querySelector('.cm-line span')).not.toBeNull()
    expect(screen.getByRole('toolbar', { name: 'Raw 표 편집 툴바' })).toBeInTheDocument()

    // Right: Preview region with unique testId, heading numbers, and initial Mermaid SVG
    const previewRegion = screen.getByTestId('split-markdown-preview')
    expect(previewRegion).toHaveAttribute('aria-label', '마크다운 미리보기')
    expect(within(previewRegion).getByRole('heading', { level: 1 }).textContent).toContain('1. Arch')
    await waitFor(() => {
      expect(within(previewRegion).getByTestId('mermaid-svg').textContent).toContain('A --> B')
    })

    // Scrolling the right preview in Ticket 01 must not clobber Raw tab.scrollTop
    onUpdateViewState.mockClear()
    fireEvent.scroll(previewRegion, { target: { scrollTop: 300 } })
    expect(onUpdateViewState).not.toHaveBeenCalledWith(expect.objectContaining({ scrollTop: 300 }))

    // Editing markdown & Mermaid source on the left updates right Preview + debounced Mermaid SVG
    const renderSplit = (nextDoc: DocumentBuffer, nextTab: TabItem): void => {
      const handleContent = (nextContent: string): void => {
        doc = { ...doc, content: nextContent, isDirty: nextContent !== doc.savedContent }
        renderSplit(doc, latestTab)
      }
      rerender(
        <DocumentEditor
          document={nextDoc}
          tab={nextTab}
          theme="light"
          autoSave={false}
          showHeadingNumbers
          mermaidRenderer={mermaidRenderer}
          onChangeContent={handleContent}
          onSave={vi.fn()}
          onUpdateViewState={(patch) => {
            onUpdateViewState(patch)
            renderSplit(doc, latestTab)
          }}
        />
      )
    }

    const updatedContent = '# Arch Updated\n\n```mermaid\nflowchart LR\n  A --> C\n```\n'
    doc = { ...doc, content: updatedContent, isDirty: true }
    renderSplit(doc, {
      ...latestTab,
      cursor: { selectionStart: updatedContent.length, selectionEnd: updatedContent.length }
    })

    expect(within(previewRegion).getByRole('heading', { level: 1 }).textContent).toContain(
      '1. Arch Updated'
    )
    await waitFor(() => {
      expect(within(previewRegion).getByTestId('mermaid-svg').textContent).toContain('A --> C')
    })

    // Typing '/' at end of Raw editor opens Slash command menu in Split mode
    rawEditor.focus()
    await user.keyboard('/')
    expect(screen.getByRole('listbox', { name: '슬래시 명령어 자동완성' })).toBeInTheDocument()
  })

  it('resizes split regions via splitter mouse drag, ArrowLeft/ArrowRight keys (0.15~0.85 clamp), and double-click reset to 0.5', () => {
    let tab = createTab('split', 0.5)
    const doc = createDoc({ content: '# Left\n\nRight', savedContent: '# Left\n\nRight' })
    const onUpdateViewState = vi.fn((patch: Partial<TabItem>) => {
      tab = { ...tab, ...patch }
    })

    const { rerender } = render(
      <DocumentEditor
        document={doc}
        tab={tab}
        theme="light"
        autoSave={false}
        onChangeContent={vi.fn()}
        onSave={vi.fn()}
        onUpdateViewState={onUpdateViewState}
      />
    )

    const separator = screen.getByRole('separator', { name: '에디터 분할 크기 조절' })
    expect(separator).toHaveAttribute('aria-orientation', 'vertical')
    expect(separator).toHaveAttribute('aria-valuemin', '15')
    expect(separator).toHaveAttribute('aria-valuemax', '85')
    expect(separator).toHaveAttribute('aria-valuenow', '50')

    const splitContainer = screen.getByTestId('editor-split-container')
    const regions = splitContainer.querySelectorAll('.editor-split-region')
    expect(regions).toHaveLength(2)
    expect((regions[0] as HTMLElement).style.flex).toBe('0.5 1 0%')
    expect((regions[1] as HTMLElement).style.flex).toBe('0.5 1 0%')

    vi.spyOn(splitContainer, 'getBoundingClientRect').mockReturnValue({
      x: 100,
      y: 0,
      left: 100,
      top: 0,
      right: 1100,
      bottom: 600,
      width: 1000,
      height: 600,
      toJSON: () => ({})
    })

    // Mouse drag resize & clamping to [0.15, 0.85]
    fireEvent.mouseDown(separator)
    fireEvent.mouseMove(window, { clientX: 800 })
    expect(onUpdateViewState).toHaveBeenLastCalledWith({ splitPreviewRatio: 0.7 })

    fireEvent.mouseMove(window, { clientX: 120 })
    expect(onUpdateViewState).toHaveBeenLastCalledWith({ splitPreviewRatio: 0.15 })

    fireEvent.mouseMove(window, { clientX: 1080 })
    expect(onUpdateViewState).toHaveBeenLastCalledWith({ splitPreviewRatio: 0.85 })

    fireEvent.mouseUp(window)
    onUpdateViewState.mockClear()
    fireEvent.mouseMove(window, { clientX: 400 })
    expect(onUpdateViewState).not.toHaveBeenCalled()

    // Reflecting updated ratio from tab prop
    rerender(
      <DocumentEditor
        document={doc}
        tab={{ ...tab, splitPreviewRatio: 0.65 }}
        theme="light"
        autoSave={false}
        onChangeContent={vi.fn()}
        onSave={vi.fn()}
        onUpdateViewState={onUpdateViewState}
      />
    )
    expect(separator).toHaveAttribute('aria-valuenow', '65')
    expect((regions[0] as HTMLElement).style.flex).toBe('0.65 1 0%')
    expect((regions[1] as HTMLElement).style.flex).toBe('0.35 1 0%')

    // Keyboard ArrowLeft / ArrowRight step +-0.05 and clamp
    fireEvent.keyDown(separator, { key: 'ArrowLeft' })
    expect(onUpdateViewState).toHaveBeenLastCalledWith({ splitPreviewRatio: 0.6 })

    rerender(
      <DocumentEditor
        document={doc}
        tab={{ ...tab, splitPreviewRatio: 0.15 }}
        theme="light"
        autoSave={false}
        onChangeContent={vi.fn()}
        onSave={vi.fn()}
        onUpdateViewState={onUpdateViewState}
      />
    )
    fireEvent.keyDown(separator, { key: 'ArrowLeft' })
    expect(onUpdateViewState).toHaveBeenLastCalledWith({ splitPreviewRatio: 0.15 })

    rerender(
      <DocumentEditor
        document={doc}
        tab={{ ...tab, splitPreviewRatio: 0.85 }}
        theme="light"
        autoSave={false}
        onChangeContent={vi.fn()}
        onSave={vi.fn()}
        onUpdateViewState={onUpdateViewState}
      />
    )
    fireEvent.keyDown(separator, { key: 'ArrowRight' })
    expect(onUpdateViewState).toHaveBeenLastCalledWith({ splitPreviewRatio: 0.85 })

    // Double-click resets to 0.5
    fireEvent.doubleClick(separator)
    expect(onUpdateViewState).toHaveBeenLastCalledWith({ splitPreviewRatio: 0.5 })
  })

  it('retains the last valid Mermaid SVG alongside an inline error banner without <pre> during live Split mode edits and clears on recovery', async () => {
    const initialContent = '# Arch\n\n```mermaid\nflowchart LR\n  A --> B\n```\n'
    let doc = createDoc({
      content: initialContent,
      savedContent: initialContent
    })
    const tab = createTab('split', 0.5)
    const driver: MermaidDriver = {
      initialize: vi.fn(),
      render: vi.fn(async (_id, text) => {
        if (text.includes('broken')) {
          throw new Error('Syntax error near broken')
        }
        return { svg: `<svg><text>${text.trim()}</text></svg>` }
      })
    }
    const mermaidRenderer = createMermaidRenderer(driver)
    const buildSplitEditor = (targetDoc: DocumentBuffer) => (
      <DocumentEditor
        document={targetDoc}
        tab={tab}
        theme="light"
        autoSave={false}
        mermaidRenderer={mermaidRenderer}
        onChangeContent={vi.fn()}
        onSave={vi.fn()}
        onUpdateViewState={vi.fn()}
      />
    )

    const { rerender } = render(buildSplitEditor(doc))

    const previewRegion = screen.getByTestId('split-markdown-preview')
    await waitFor(() => {
      expect(within(previewRegion).getByTestId('mermaid-svg')).toHaveTextContent('A --> B')
    })
    const initialSvgNode = within(previewRegion).getByTestId('mermaid-svg')

    // Introduce temporary syntax error while typing in Split mode
    doc = {
      ...doc,
      content: '# Arch\n\n```mermaid\nflowchart LR\n  broken\n```\n',
      isDirty: true
    }
    rerender(buildSplitEditor(doc))

    await waitFor(() => {
      expect(within(previewRegion).getByRole('alert')).toHaveTextContent('Syntax error near broken')
    })
    expect(within(previewRegion).getByTestId('mermaid-svg')).toBe(initialSvgNode)
    expect(within(previewRegion).getByTestId('mermaid-svg')).toHaveTextContent('A --> B')
    expect(previewRegion.querySelector('pre.mermaid-error-source')).toBeNull()

    // Fix syntax -> updates SVG and removes inline error banner
    doc = {
      ...doc,
      content: '# Arch\n\n```mermaid\nflowchart LR\n  A --> C\n```\n',
      isDirty: true
    }
    rerender(buildSplitEditor(doc))

    await waitFor(() => {
      expect(within(previewRegion).queryByRole('alert')).not.toBeInTheDocument()
      expect(within(previewRegion).getByTestId('mermaid-svg')).toHaveTextContent('A --> C')
    })
  })

  it('synchronizes scroll bidirectionally by source line in Split mode with anti-ping-pong loop guard and preserves boundaries', async () => {
    const mermaidLines = ['```mermaid', 'flowchart LR', '  A --> B', '  B --> C', '  C --> D', '  D --> E', '  E --> F', '```']
    const trailingLines = Array.from({ length: 49 }, (_, i) => `Trailing line ${i + 1}`)
    const docLines = [
      '# Top',
      '',
      ...mermaidLines, // lines 3..10
      '',
      ...trailingLines.map((t) => `- ${t}`) // lines 12..60 (49-line ul)
    ]
    const fullContent = docLines.join('\n')
    expect(docLines).toHaveLength(60)

    let latestTab = createTab('split', 0.5)
    const onUpdateViewState = vi.fn((patch: Partial<TabItem>) => {
      latestTab = { ...latestTab, ...patch }
    })
    const doc = createDoc({ content: fullContent, savedContent: fullContent })
    const driver: MermaidDriver = {
      initialize: vi.fn(),
      render: vi.fn(async () => ({ svg: '<svg><text>Diagram</text></svg>' }))
    }

    const { container } = render(
      <DocumentEditor
        document={doc}
        tab={latestTab}
        theme="light"
        autoSave={false}
        mermaidRenderer={createMermaidRenderer(driver)}
        onChangeContent={vi.fn()}
        onSave={vi.fn()}
        onUpdateViewState={onUpdateViewState}
      />
    )

    const rawScroller = container.querySelector('.cm-scroller') as HTMLElement
    const previewRegion = screen.getByTestId('split-markdown-preview') as HTMLElement
    const cmView = EditorView.findFromDOM(rawScroller)!
    expect(cmView).not.toBeNull()

    Object.defineProperty(rawScroller, 'clientHeight', { configurable: true, value: 240 })
    Object.defineProperty(rawScroller, 'scrollHeight', {
      configurable: true,
      get: () => cmView.contentHeight
    })

    // Preview has non-proportional heights: huge Mermaid block (600px) for lines 3..10
    Object.defineProperty(previewRegion, 'clientHeight', { configurable: true, value: 240 })
    Object.defineProperty(previewRegion, 'scrollHeight', { configurable: true, value: 1400 })
    previewRegion.getBoundingClientRect = () =>
      ({ top: 0, left: 0, right: 500, bottom: 240, width: 500, height: 240, x: 0, y: 0, toJSON: () => ({}) })

    const h1 = previewRegion.querySelector('h1[data-source-line="1"]') as HTMLElement
    const mermaidEl = screen.getByTestId('mermaid-diagram')
    const ulEl = previewRegion.querySelector('ul[data-source-line="12"]') as HTMLElement
    expect(mermaidEl).toHaveAttribute('data-source-line', '3')
    expect(mermaidEl).toHaveAttribute('data-source-end-line', '10')
    expect(ulEl).toHaveAttribute('data-source-end-line', '60')

    const mockRect = (el: HTMLElement, docTop: number, height: number) => {
      el.getBoundingClientRect = () => {
        const y = docTop - previewRegion.scrollTop
        return { top: y, left: 0, right: 500, bottom: y + height, width: 500, height, x: 0, y, toJSON: () => ({}) }
      }
    }
    mockRect(h1, 0, 40)
    mockRect(mermaidEl, 60, 600)
    mockRect(ulEl, 680, 720)

    // 1. Scroll Raw to exact start of line 7 (50% through 8-line Mermaid block [3, 11])
    const line7Top = cmView.documentPadding.top + cmView.lineBlockAt(cmView.state.doc.line(7).from).top
    rawScroller.scrollTop = line7Top
    fireEvent.scroll(rawScroller)
    // Preview interpolates inside Mermaid block: 60 + 0.5 * 600 = 360 (NOT naive proportional scroll)
    expect(previewRegion.scrollTop).toBeCloseTo(360, 5)

    // Immediate echo scroll from Preview must be ignored by loop guard (no ping-pong back to Raw)
    onUpdateViewState.mockClear()
    fireEvent.scroll(previewRegion)
    expect(rawScroller.scrollTop).toBe(line7Top)
    expect(onUpdateViewState).not.toHaveBeenCalled()

    // 2. User scrolls Preview into list block (25% into [12, 61] => line 24.25): 680 + 0.25 * 720 = 860
    previewRegion.scrollTop = 860
    fireEvent.scroll(previewRegion)
    const line24Block = cmView.lineBlockAt(cmView.state.doc.line(24).from)
    const expectedLine24_25Top = cmView.documentPadding.top + line24Block.top + 0.25 * line24Block.height
    expect(rawScroller.scrollTop).toBeCloseTo(expectedLine24_25Top, 5)
    expect(onUpdateViewState).toHaveBeenCalledWith({ scrollTop: rawScroller.scrollTop })

    // Immediate echo scroll from Raw must be ignored by loop guard (no ping-pong back to Preview)
    fireEvent.scroll(rawScroller)
    expect(previewRegion.scrollTop).toBe(860)

    // 3. Bottom and top boundaries are preserved
    rawScroller.scrollTop = cmView.contentHeight - 240
    fireEvent.scroll(rawScroller)
    expect(previewRegion.scrollTop).toBe(1160) // previewMax = 1400 - 240

    previewRegion.scrollTop = 0
    fireEvent.scroll(previewRegion)
    expect(rawScroller.scrollTop).toBe(0)
  })

  it('scrolls both Raw editor and Preview to the target heading on Outline scrollRequest in Split mode', async () => {
    const origScrollIntoView = Element.prototype.scrollIntoView
    const scrollIntoViewMock = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoViewMock

    try {
      const md = '# Arch\n\nIntro\n\n## Flow\n\nDetails'
      const doc = createDoc({ content: md, savedContent: md })
      const tab = createTab('split', 0.5)
      const onChangeContent = vi.fn()

      const { rerender } = render(
        <DocumentEditor
          document={doc}
          tab={tab}
          theme="light"
          autoSave={false}
          showHeadingNumbers={false}
          onChangeContent={onChangeContent}
          onSave={vi.fn()}
          onUpdateViewState={vi.fn()}
        />
      )

      rerender(
        <DocumentEditor
          document={doc}
          tab={tab}
          theme="light"
          autoSave={false}
          showHeadingNumbers={false}
          scrollRequest={{
            paneId: 'primary',
            tabId: 'tab-1',
            mode: 'split',
            line: 5,
            slug: 'flow',
            index: 1,
            nonce: 7
          }}
          onChangeContent={onChangeContent}
          onSave={vi.fn()}
          onUpdateViewState={vi.fn()}
        />
      )

      const rawEditor = screen.getByTestId('document-editor')
      const previewRegion = screen.getByTestId('split-markdown-preview')
      const targetHeading = within(previewRegion).getByRole('heading', { level: 2, name: 'Flow' })

      await waitFor(() => {
        expect(rawEditor.getAttribute('data-selection-start')).toBe(String(md.indexOf('## Flow')))
        expect(scrollIntoViewMock).toHaveBeenCalledTimes(1)
      })
      expect(scrollIntoViewMock.mock.instances[0]).toBe(targetHeading)
      expect(onChangeContent).not.toHaveBeenCalled()

      // Same nonce does not re-scroll on unrelated rerender
      scrollIntoViewMock.mockClear()
      rerender(
        <DocumentEditor
          document={doc}
          tab={tab}
          theme="dark"
          autoSave={false}
          showHeadingNumbers={false}
          scrollRequest={{
            paneId: 'primary',
            tabId: 'tab-1',
            mode: 'split',
            line: 5,
            slug: 'flow',
            index: 1,
            nonce: 7
          }}
          onChangeContent={onChangeContent}
          onSave={vi.fn()}
          onUpdateViewState={vi.fn()}
        />
      )
      expect(scrollIntoViewMock).not.toHaveBeenCalled()
    } finally {
      Element.prototype.scrollIntoView = origScrollIntoView
    }
  })
})
