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

    // Right: Preview pane with unique testId, heading numbers, and initial Mermaid SVG
    const previewPane = screen.getByTestId('split-markdown-preview')
    expect(previewPane).toHaveAttribute('aria-label', '마크다운 미리보기')
    expect(within(previewPane).getByRole('heading', { level: 1 }).textContent).toContain('1. Arch')
    await waitFor(() => {
      expect(within(previewPane).getByTestId('mermaid-svg').textContent).toContain('A --> B')
    })

    // Scrolling the right preview in Ticket 01 must not clobber Raw tab.scrollTop
    onUpdateViewState.mockClear()
    fireEvent.scroll(previewPane, { target: { scrollTop: 300 } })
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

    expect(within(previewPane).getByRole('heading', { level: 1 }).textContent).toContain(
      '1. Arch Updated'
    )
    await waitFor(() => {
      expect(within(previewPane).getByTestId('mermaid-svg').textContent).toContain('A --> C')
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
})
