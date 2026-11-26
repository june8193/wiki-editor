import { useState } from 'react'
import { EditorView } from '@codemirror/view'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WikiApi } from '@shared/ipc'
import type { WorkspaceEntry } from '@shared/workspace'
import { createMermaidRenderer, type MermaidDriver } from '../editor/mermaidRenderer'
import { buildWikiAssetUrl } from '@shared/assets'
import themeCss from '../styles/theme.css?raw'
import { installScrollContainerStub, mockElementBoundingRect } from '../test/domLayoutStub'
import { installSvgCanvasStub } from '../test/svgCanvasStub'
import { DocumentEditor } from './DocumentEditor'
import { DocumentPropertiesSection } from './DocumentPropertiesSection'
import type { DocumentBuffer } from '@shared/documentBuffer'
import {
  applyFrontmatterValues,
  createDefaultFrontmatterSchema,
  parseFrontmatterDocument,
  removeFrontmatterBlock
} from '@shared/frontmatter'
import type { DocumentTabItem, EditorMode, TabViewPatch } from '../stores/PaneTabStore'

function createDoc(overrides: Partial<DocumentBuffer> = {}): DocumentBuffer {
  return {
    key: 'c:/wiki/doc.md',
    kind: 'workspace',
    path: 'C:/wiki/doc.md',
    name: 'doc.md',
    content: '# Heading\n\n*   exact   spacing',
    savedContent: '# Heading\n\n*   exact   spacing',
    encoding: 'utf-8',
    savedEncoding: 'utf-8',
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

function mockScrollElementRect(
  scrollContainer: HTMLElement,
  el: HTMLElement,
  docTop: number | (() => number),
  height: number | (() => number)
): void {
  el.getBoundingClientRect = () => {
    const resolvedTop = typeof docTop === 'function' ? docTop() : docTop
    const resolvedHeight = typeof height === 'function' ? height() : height
    const y = resolvedTop - scrollContainer.scrollTop
    return {
      top: y,
      left: 0,
      right: 500,
      bottom: y + resolvedHeight,
      width: 500,
      height: resolvedHeight,
      x: 0,
      y,
      toJSON: () => ({})
    }
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

  it('threads mermaidRenderer and scrollRequest cleanly without dynamic heading numbers while roundtripping mermaid blocks', async () => {
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
        mermaidRenderer={mermaidRenderer}
        onChangeContent={onChangeContent}
        onSave={vi.fn()}
        onUpdateViewState={onUpdateViewState}
      />
    )
    await waitFor(() => {
      expect(screen.getByTestId('wysiwyg-mermaid-block').querySelector('svg')).not.toBeNull()
    })
    expect(screen.getByTestId('document-editor').querySelector('.heading-number')).toBeNull()

    await user.click(within(modeGroup).getByRole('button', { name: 'Preview' }))
    rerender(
      <DocumentEditor
        document={mermaidDoc}
        tab={createTab(mode)}
        theme="light"
        autoSave={false}
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

  it('renders Raw editor (toolbar, syntax highlighting) and live Preview (markdown + debounced Mermaid) side by side in Split mode', async () => {
    const user = userEvent.setup()
    let latestTab: DocumentTabItem = {
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
    const onUpdateViewState = vi.fn((patch: Partial<DocumentTabItem>) => {
      latestTab = { ...latestTab, ...patch }
    })

    const { container, rerender } = render(
      <DocumentEditor
        document={doc}
        tab={latestTab}
        theme="light"
        autoSave={false}
        mermaidRenderer={mermaidRenderer}
        onChangeContent={(nextContent) => {
          doc = { ...doc, content: nextContent, isDirty: nextContent !== doc.savedContent }
          rerender(
            <DocumentEditor
              document={doc}
              tab={latestTab}
              theme="light"
              autoSave={false}
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

    // Right: Preview region with unique testId, plain heading text, and initial Mermaid SVG
    const previewRegion = screen.getByTestId('split-markdown-preview')
    expect(previewRegion).toHaveAttribute('aria-label', '마크다운 미리보기')
    expect(within(previewRegion).getByRole('heading', { level: 1 }).textContent).toBe('Arch')
    await waitFor(() => {
      expect(within(previewRegion).getByTestId('mermaid-svg').textContent).toContain('A --> B')
    })

    // Scrolling the right preview in Ticket 01 must not clobber Raw tab.scrollTop
    onUpdateViewState.mockClear()
    fireEvent.scroll(previewRegion, { target: { scrollTop: 300 } })
    expect(onUpdateViewState).not.toHaveBeenCalledWith(expect.objectContaining({ scrollTop: 300 }))

    // Editing markdown & Mermaid source on the left updates right Preview + debounced Mermaid SVG
    const renderSplit = (nextDoc: DocumentBuffer, nextTab: DocumentTabItem): void => {
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

    expect(within(previewRegion).getByRole('heading', { level: 1 }).textContent).toBe(
      'Arch Updated'
    )
    await waitFor(() => {
      expect(within(previewRegion).getByTestId('mermaid-svg').textContent).toContain('A --> C')
    })

    // Typing '/' at end of Raw editor does not open any slash command menu
    rawEditor.focus()
    await user.keyboard('/')
    expect(screen.queryByRole('listbox', { name: '슬래시 명령어 자동완성' })).not.toBeInTheDocument()
  })

  it('resizes split regions via splitter mouse drag, ArrowLeft/ArrowRight keys (0.15~0.85 clamp), and double-click reset to 0.5', () => {
    let tab = createTab('split', 0.5)
    const doc = createDoc({ content: '# Left\n\nRight', savedContent: '# Left\n\nRight' })
    const onUpdateViewState = vi.fn((patch: Partial<DocumentTabItem>) => {
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
    const onUpdateViewState = vi.fn((patch: Partial<DocumentTabItem>) => {
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

    mockScrollElementRect(previewRegion, h1, 0, 40)
    mockScrollElementRect(previewRegion, mermaidEl, 60, 600)
    mockScrollElementRect(previewRegion, ulEl, 680, 720)

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

  it('scrolls Raw editor directly on Outline scrollRequest in Split mode and follows in Preview via line sync', async () => {
    const origScrollIntoView = Element.prototype.scrollIntoView
    const scrollIntoViewMock = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoViewMock

    try {
      const trailingLines = Array.from({ length: 24 }, (_, i) => `Trailing ${i + 1}`)
      const md = ['# Arch', '', 'Intro', '', '## Flow', '', ...trailingLines].join('\n')
      const doc = createDoc({ content: md, savedContent: md })
      const tab = createTab('split', 0.5)
      const onChangeContent = vi.fn()

      const buildOutlineSplitEditor = (
        theme: 'light' | 'dark' = 'light',
        request: Parameters<typeof DocumentEditor>[0]['scrollRequest'] = null
      ) => (
        <DocumentEditor
          document={doc}
          tab={tab}
          theme={theme}
          autoSave={false}
          scrollRequest={request}
          onChangeContent={onChangeContent}
          onSave={vi.fn()}
          onUpdateViewState={vi.fn()}
        />
      )

      const { container, rerender } = render(buildOutlineSplitEditor())

      const rawEditor = screen.getByTestId('document-editor')
      const rawScroller = container.querySelector('.cm-scroller') as HTMLElement
      const cmView = EditorView.findFromDOM(rawScroller)!
      Object.defineProperty(rawScroller, 'clientHeight', { configurable: true, value: 200 })
      Object.defineProperty(rawScroller, 'scrollHeight', {
        configurable: true,
        get: () => Math.max(600, cmView.contentHeight)
      })

      const previewRegion = screen.getByTestId('split-markdown-preview')
      Object.defineProperty(previewRegion, 'clientHeight', { configurable: true, value: 200 })
      Object.defineProperty(previewRegion, 'scrollHeight', { configurable: true, value: 800 })
      previewRegion.getBoundingClientRect = () =>
        ({ top: 0, left: 0, right: 500, bottom: 200, width: 500, height: 200, x: 0, y: 0, toJSON: () => ({}) })
      const h1 = previewRegion.querySelector('h1[data-source-line="1"]') as HTMLElement
      const introP = previewRegion.querySelector('p[data-source-line="3"]') as HTMLElement
      const h2 = previewRegion.querySelector('h2[data-source-line="5"]') as HTMLElement
      const trailingP = previewRegion.querySelector('p[data-source-line="7"]') as HTMLElement
      mockScrollElementRect(previewRegion, h1, 0, 40)
      mockScrollElementRect(previewRegion, introP, 60, 40)
      mockScrollElementRect(previewRegion, h2, 240, 40)
      mockScrollElementRect(previewRegion, trailingP, 300, 400)

      rerender(
        buildOutlineSplitEditor('light', {
          paneId: 'primary',
          tabId: 'tab-1',
          mode: 'split',
          line: 5,
          slug: 'flow',
          index: 1,
          nonce: 7
        })
      )

      await waitFor(() => {
        expect(rawEditor.getAttribute('data-selection-start')).toBe(String(md.indexOf('## Flow')))
      })
      // Preview does NOT call scrollIntoView directly in Split mode; it follows Raw via line sync
      expect(scrollIntoViewMock).not.toHaveBeenCalled()
      expect(onChangeContent).not.toHaveBeenCalled()

      // Raw scroll drives Preview scrollTop via line sync
      const line5Top = cmView.lineBlockAt(md.indexOf('## Flow')).top
      rawScroller.scrollTop = Math.max(80, line5Top)
      fireEvent.scroll(rawScroller)
      expect(previewRegion.scrollTop).toBeGreaterThan(0)
    } finally {
      Element.prototype.scrollIntoView = origScrollIntoView
    }
  })
})

describe('DocumentEditor link autocomplete & Ctrl+K gating', () => {
  it('blocks Ctrl+K when isShortcutDisabled is true in Raw and WYSIWYG modes, and disables link autocomplete for non-markdown docs', async () => {
    const user = userEvent.setup()
    const mdDoc = createDoc({ content: '# 개요\n\n본문 텍스트' })
    const rawEndTab = {
      ...createTab('raw'),
      cursor: { selectionStart: mdDoc.content.length, selectionEnd: mdDoc.content.length }
    }

    const { rerender } = render(
      <DocumentEditor
        document={mdDoc}
        tab={rawEndTab}
        theme="light"
        autoSave={false}
        isShortcutDisabled={false}
        onChangeContent={vi.fn()}
        onSave={vi.fn()}
        onUpdateViewState={vi.fn()}
      />
    )

    fireEvent.keyDown(screen.getByTestId('document-editor'), { key: 'k', ctrlKey: true })
    expect(await screen.findByRole('listbox', { name: '링크 자동완성' })).toBeInTheDocument()
    fireEvent.keyDown(screen.getByTestId('document-editor'), { key: 'Escape' })

    rerender(
      <DocumentEditor
        document={mdDoc}
        tab={rawEndTab}
        theme="light"
        autoSave={false}
        isShortcutDisabled
        onChangeContent={vi.fn()}
        onSave={vi.fn()}
        onUpdateViewState={vi.fn()}
      />
    )
    fireEvent.keyDown(screen.getByTestId('document-editor'), { key: 'k', ctrlKey: true })
    expect(screen.queryByRole('listbox', { name: '링크 자동완성' })).not.toBeInTheDocument()

    rerender(
      <DocumentEditor
        document={mdDoc}
        tab={createTab('wysiwyg')}
        theme="light"
        autoSave={false}
        isShortcutDisabled={false}
        onChangeContent={vi.fn()}
        onSave={vi.fn()}
        onUpdateViewState={vi.fn()}
      />
    )
    fireEvent.keyDown(screen.getByTestId('document-editor'), { key: 'k', ctrlKey: true })
    expect(await screen.findByRole('listbox', { name: '링크 자동완성' })).toBeInTheDocument()
    fireEvent.keyDown(screen.getByTestId('document-editor'), { key: 'Escape' })

    rerender(
      <DocumentEditor
        document={mdDoc}
        tab={createTab('wysiwyg')}
        theme="light"
        autoSave={false}
        isShortcutDisabled
        onChangeContent={vi.fn()}
        onSave={vi.fn()}
        onUpdateViewState={vi.fn()}
      />
    )
    fireEvent.keyDown(screen.getByTestId('document-editor'), { key: 'k', ctrlKey: true })
    expect(screen.queryByRole('listbox', { name: '링크 자동완성' })).not.toBeInTheDocument()

    const txtDoc = createDoc({
      key: 'c:/wiki/notes.txt',
      path: 'C:/wiki/notes.txt',
      name: 'notes.txt',
      content: 'plain text '
    })
    rerender(
      <DocumentEditor
        document={txtDoc}
        tab={{ ...createTab('raw'), bufferKey: txtDoc.key }}
        theme="light"
        autoSave={false}
        isShortcutDisabled={false}
        onChangeContent={vi.fn()}
        onSave={vi.fn()}
        onUpdateViewState={vi.fn()}
      />
    )

    const editorEl = screen.getByTestId('document-editor')
    editorEl.focus()
    await user.keyboard('[[링크](')
    expect(screen.queryByRole('listbox', { name: '링크 자동완성' })).not.toBeInTheDocument()
    fireEvent.keyDown(editorEl, { key: 'k', ctrlKey: true })
    expect(screen.queryByRole('listbox', { name: '링크 자동완성' })).not.toBeInTheDocument()
  })

  it('Raw 와 위지윅 모드 모두 workspaceMarkdownFiles 를 받아 현재 문서를 제외한 파일 후보를 자동완성에 전달한다', async () => {
    const files: WorkspaceEntry[] = [
      {
        name: 'doc.md',
        path: 'C:/wiki/doc.md',
        relativePath: 'doc.md',
        kind: 'file'
      },
      {
        name: 'sub-guide.md',
        path: 'C:/wiki/docs/sub-guide.md',
        relativePath: 'docs/sub-guide.md',
        kind: 'file'
      }
    ]
    const mdDoc = createDoc({ content: '# 제목\n\n본문' })
    const rawEndTab = {
      ...createTab('raw'),
      cursor: { selectionStart: mdDoc.content.length, selectionEnd: mdDoc.content.length }
    }

    const { rerender } = render(
      <DocumentEditor
        document={mdDoc}
        tab={rawEndTab}
        theme="light"
        autoSave={false}
        workspaceMarkdownFiles={files}
        onChangeContent={vi.fn()}
        onSave={vi.fn()}
        onUpdateViewState={vi.fn()}
      />
    )

    fireEvent.keyDown(screen.getByTestId('document-editor'), { key: 'k', ctrlKey: true })
    const rawListbox = await screen.findByRole('listbox', { name: '링크 자동완성' })
    expect(within(rawListbox).queryByText('doc.md')).not.toBeInTheDocument()
    expect(within(rawListbox).getByText('docs/sub-guide.md')).toBeInTheDocument()

    fireEvent.keyDown(screen.getByTestId('document-editor'), { key: 'Escape' })

    rerender(
      <DocumentEditor
        document={mdDoc}
        tab={createTab('wysiwyg')}
        theme="light"
        autoSave={false}
        workspaceMarkdownFiles={files}
        onChangeContent={vi.fn()}
        onSave={vi.fn()}
        onUpdateViewState={vi.fn()}
      />
    )

    fireEvent.keyDown(screen.getByTestId('document-editor'), { key: 'k', ctrlKey: true })
    const wysiwygListbox = await screen.findByRole('listbox', { name: '링크 자동완성' })
    expect(within(wysiwygListbox).queryByText('doc.md')).not.toBeInTheDocument()
    expect(within(wysiwygListbox).getByText('docs/sub-guide.md')).toBeInTheDocument()
  })
})

describe('DocumentEditor Mermaid export title propagation', () => {
  const originalWikiApi = (window as { wikiApi?: WikiApi }).wikiApi

  afterEach(() => {
    if (originalWikiApi === undefined) {
      delete (window as { wikiApi?: WikiApi }).wikiApi
    } else {
      window.wikiApi = originalWikiApi
    }
  })

  it('propagates derived documentTitle from active DocumentBuffer into Preview, Split right preview, and WYSIWYG Mermaid blocks', async () => {
    const canvasStub = installSvgCanvasStub()

    try {
      const saveFile = vi.fn(async () => ({ canceled: false, filePath: 'C:\\exports\\out' }))
      window.wikiApi = {
        diagram: {
          copyText: vi.fn(async () => {}),
          copyImage: vi.fn(async () => {}),
          saveFile
        }
      } as unknown as WikiApi

      const driver: MermaidDriver = {
        initialize: vi.fn(),
        render: vi.fn(async () => ({
          svg: '<svg viewBox="0 0 100 50"><g><text>Doc</text></g></svg>'
        }))
      }
      const mermaidRenderer = createMermaidRenderer(driver)
      const doc = createDoc({
        key: 'c:/wiki/system-arch.md',
        path: 'C:/wiki/system-arch.md',
        name: 'System: <Arch>.md',
        content: '# Arch\n\n```mermaid\ngraph TD\n  A --> B\n```',
        savedContent: '# Arch\n\n```mermaid\ngraph TD\n  A --> B\n```'
      })

      const renderMode = (mode: EditorMode) => (
        <DocumentEditor
          document={doc}
          tab={{ ...createTab(mode), bufferKey: doc.key }}
          theme="light"
          autoSave={false}
          mermaidRenderer={mermaidRenderer}
          onChangeContent={vi.fn()}
          onSave={vi.fn()}
          onUpdateViewState={vi.fn()}
        />
      )

      const { rerender } = render(renderMode('preview'))
      await screen.findByTestId('mermaid-svg')
      fireEvent.click(screen.getByRole('button', { name: 'PNG 저장' }))
      await waitFor(() => {
        expect(saveFile).toHaveBeenCalledTimes(1)
      })
      expect(saveFile).toHaveBeenLastCalledWith(
        expect.objectContaining({
          format: 'png',
          suggestedName: 'System Arch-diagram.png'
        })
      )

      rerender(renderMode('split'))
      const splitPreview = await screen.findByTestId('split-markdown-preview')
      await within(splitPreview).findByTestId('mermaid-svg')
      fireEvent.click(within(splitPreview).getByRole('button', { name: 'SVG 저장' }))
      await waitFor(() => {
        expect(saveFile).toHaveBeenCalledTimes(2)
      })
      expect(saveFile).toHaveBeenLastCalledWith(
        expect.objectContaining({
          format: 'svg',
          suggestedName: 'System Arch-diagram.svg'
        })
      )

      rerender(renderMode('wysiwyg'))
      await waitFor(() => {
        expect(screen.getByTestId('wysiwyg-mermaid-block')).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'PNG 저장' })).toBeEnabled()
      })
      fireEvent.click(screen.getByRole('button', { name: 'PNG 저장' }))
      await waitFor(() => {
        expect(saveFile).toHaveBeenCalledTimes(3)
      })
      expect(saveFile).toHaveBeenLastCalledWith(
        expect.objectContaining({
          format: 'png',
          suggestedName: 'System Arch-diagram.png'
        })
      )
    } finally {
      canvasStub.restore()
    }
  })
})

describe('DocumentEditor local markdown image rendering across modes', () => {
  it('renders workspace relative images with wiki-asset URLs in WYSIWYG, Preview, and Split without mutating markdown', async () => {
    const markdown = [
      '# Images',
      '',
      '![local](./assets/pic.png)',
      '',
      '![ext](https://example.com/banner.png)'
    ].join('\n')

    const doc = {
      key: 'file:/vault/docs/guide.md',
      kind: 'workspace' as const,
      contentKind: 'text' as const,
      name: 'guide.md',
      path: '/vault/docs/guide.md',
      content: markdown,
      savedContent: markdown,
      encoding: 'utf-8' as const,
      savedEncoding: 'utf-8' as const,
      isDirty: false,
      isSaving: false,
      version: 1
    }
    const baseTab = {
      id: 'tab-1',
      kind: 'document' as const,
      bufferKey: doc.key,
      mode: 'wysiwyg' as const,
      cursor: { selectionStart: 0, selectionEnd: 0 },
      scrollTop: 0,
      splitPreviewRatio: 0.5
    }
    const onChangeContent = vi.fn()
    const onSave = vi.fn()
    const onUpdateViewState = vi.fn()

    const expectedWikiUrl = buildWikiAssetUrl('/vault/docs/assets/pic.png')

    const { rerender } = render(
      <DocumentEditor
        document={doc}
        tab={baseTab}
        theme="light"
        autoSave={false}
        onChangeContent={onChangeContent}
        onSave={onSave}
        onUpdateViewState={onUpdateViewState}
      />
    )

    await waitFor(() => {
      expect(screen.getByRole('img', { name: 'local' })).toHaveAttribute('src', expectedWikiUrl)
    })
    expect(screen.getByRole('img', { name: 'local' })).toHaveAttribute(
      'data-markdown-src',
      './assets/pic.png'
    )
    expect(screen.getByRole('img', { name: 'ext' })).toHaveAttribute(
      'src',
      'https://example.com/banner.png'
    )

    rerender(
      <DocumentEditor
        document={doc}
        tab={{ ...baseTab, mode: 'preview' }}
        theme="light"
        autoSave={false}
        onChangeContent={onChangeContent}
        onSave={onSave}
        onUpdateViewState={onUpdateViewState}
      />
    )

    expect(screen.getByRole('img', { name: 'local' })).toHaveAttribute('src', expectedWikiUrl)
    expect(screen.getByRole('img', { name: 'ext' })).toHaveAttribute(
      'src',
      'https://example.com/banner.png'
    )

    rerender(
      <DocumentEditor
        document={doc}
        tab={{ ...baseTab, mode: 'split' }}
        theme="light"
        autoSave={false}
        onChangeContent={onChangeContent}
        onSave={onSave}
        onUpdateViewState={onUpdateViewState}
      />
    )

    const splitPreview = screen.getByTestId('split-markdown-preview')
    expect(within(splitPreview).getByRole('img', { name: 'local' })).toHaveAttribute(
      'src',
      expectedWikiUrl
    )
    expect(screen.getByTestId('document-editor').textContent).toContain('./assets/pic.png')
    expect(screen.getByTestId('document-editor').textContent).not.toContain('wiki-asset:')
    expect(onChangeContent).not.toHaveBeenCalled()
  })

  it('inserts images from Split left Raw editor and renders preview without wiki-asset leak while disabling non-markdown ingestion', async () => {
    const ingestImage = vi.fn(async () => ({
      markdownPath: './assets/doc-20260402-090507.png',
      altText: 'doc-20260402-090507',
      savedPath: 'C:/wiki/assets/doc-20260402-090507.png'
    }))
    const prevWikiApi = (window as unknown as { wikiApi?: unknown }).wikiApi
    ;(window as unknown as { wikiApi?: unknown }).wikiApi = {
      workspace: {
        ingestImage,
        getPathForFile: () => ''
      }
    }

    try {
      let doc = createDoc({ content: '# Heading\n\n' })
      const onChangeContent = vi.fn((next: string) => {
        doc = { ...doc, content: next }
      })

      const { rerender } = render(
        <DocumentEditor
          document={doc}
          tab={{ ...createTab('split'), cursor: { selectionStart: 11, selectionEnd: 11 } }}
          theme="light"
          autoSave={false}
          onChangeContent={onChangeContent}
          onSave={vi.fn()}
          onUpdateViewState={vi.fn()}
        />
      )

      const clipFile = new File([new Uint8Array([1, 2, 3])], 'image.png', { type: 'image/png' })
      fireEvent.paste(screen.getByTestId('document-editor'), {
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

      rerender(
        <DocumentEditor
          document={doc}
          tab={{
            ...createTab('split'),
            cursor: { selectionStart: doc.content.length, selectionEnd: doc.content.length }
          }}
          theme="light"
          autoSave={false}
          onChangeContent={onChangeContent}
          onSave={vi.fn()}
          onUpdateViewState={vi.fn()}
        />
      )

      const splitPreview = screen.getByTestId('split-markdown-preview')
      expect(within(splitPreview).getByRole('img', { name: 'doc-20260402-090507' })).toHaveAttribute(
        'src',
        buildWikiAssetUrl('C:/wiki/assets/doc-20260402-090507.png')
      )
      expect(doc.content).toContain('![doc-20260402-090507](./assets/doc-20260402-090507.png)')
      expect(doc.content).not.toContain('wiki-asset:')

      // Non-markdown config buffer disables ingestion on paste while blocking drop navigation
      const configDoc = createDoc({
        key: 'config:app',
        kind: 'config',
        path: 'C:/appdata/config.json',
        name: 'config.json',
        content: '{"theme":"light"}',
        savedContent: '{"theme":"light"}'
      })
      rerender(
        <DocumentEditor
          document={configDoc}
          tab={{ ...createTab('raw'), bufferKey: 'config:app' }}
          theme="light"
          autoSave={false}
          onChangeContent={vi.fn()}
          onSave={vi.fn()}
          onUpdateViewState={vi.fn()}
        />
      )
      fireEvent.paste(screen.getByTestId('document-editor'), {
        clipboardData: {
          types: ['Files'],
          files: [clipFile],
          items: [],
          getData: () => ''
        }
      })
      expect(ingestImage).toHaveBeenCalledTimes(1)
    } finally {
      ;(window as unknown as { wikiApi?: unknown }).wikiApi = prevWikiApi
    }
  })

  it('renders a read-only centered wiki-asset image preview with disabled modes/save and recovers on cache bust', async () => {
    const onSave = vi.fn()
    const onUpdateViewState = vi.fn()
    const onChangeContent = vi.fn()
    const imageDoc = createDoc({
      key: 'c:/wiki/assets/architecture.png',
      kind: 'workspace',
      contentKind: 'image',
      path: 'C:/wiki/assets/architecture.png',
      name: 'architecture.png',
      content: '',
      savedContent: '',
      isDirty: false,
      version: 1
    })
    const imageTab: DocumentTabItem = {
      ...createTab('split'),
      bufferKey: imageDoc.key
    }

    const { rerender } = render(
      <DocumentEditor
        document={imageDoc}
        tab={imageTab}
        theme="light"
        autoSave={true}
        onChangeContent={onChangeContent}
        onSave={onSave}
        onUpdateViewState={onUpdateViewState}
      />
    )

    // Header shows read-only status and disables both all editor mode buttons and save button
    expect(screen.getByText('C:/wiki/assets/architecture.png')).toBeInTheDocument()
    expect(screen.getByText('읽기 전용')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '저장' })).toBeDisabled()
    for (const label of ['Raw', '위지윅', 'Preview', 'Split']) {
      const btn = screen.getByRole('button', { name: label })
      expect(btn).toBeDisabled()
      expect(btn).toHaveAttribute('aria-pressed', 'false')
    }

    // No text editor surfaces are mounted
    expect(screen.queryByTestId('markdown-preview')).not.toBeInTheDocument()
    expect(screen.queryByTestId('split-markdown-preview')).not.toBeInTheDocument()
    expect(screen.queryByTestId('wysiwyg-editor')).not.toBeInTheDocument()
    expect(document.querySelector('.cm-editor')).not.toBeInTheDocument()

    // Image preview renders with wiki-asset URL and supports keyboard shortcut suppression
    const previewContainer = screen.getByTestId('image-preview')
    const img = within(previewContainer).getByRole('img', { name: 'architecture.png' })
    expect(img).toHaveAttribute('src', buildWikiAssetUrl('C:/wiki/assets/architecture.png'))
    expect(img).toHaveAttribute('draggable', 'false')

    const saveEvent = new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true })
    previewContainer.dispatchEvent(saveEvent)
    expect(saveEvent.defaultPrevented).toBe(true)

    for (const key of ['1', '2', '3', '4']) {
      const modeEvent = new KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true, cancelable: true })
      previewContainer.dispatchEvent(modeEvent)
      expect(modeEvent.defaultPrevented).toBe(true)
    }
    const cycleEvent = new KeyboardEvent('keydown', {
      key: 'M',
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true
    })
    previewContainer.dispatchEvent(cycleEvent)
    expect(cycleEvent.defaultPrevented).toBe(true)

    expect(onSave).not.toHaveBeenCalled()
    expect(onUpdateViewState).not.toHaveBeenCalled()
    expect(onChangeContent).not.toHaveBeenCalled()

    // Error state shows accessible fallback without crashing
    fireEvent.error(img)
    expect(screen.getByText('이미지를 불러올 수 없습니다.')).toBeInTheDocument()
    expect(within(previewContainer).queryByRole('img')).not.toBeInTheDocument()

    // Incrementing buffer version updates src cacheKey and recovers from prior load failure
    rerender(
      <DocumentEditor
        document={{ ...imageDoc, version: 2 }}
        tab={imageTab}
        theme="light"
        autoSave={true}
        onChangeContent={onChangeContent}
        onSave={onSave}
        onUpdateViewState={onUpdateViewState}
      />
    )
    const refreshedImg = within(screen.getByTestId('image-preview')).getByRole('img', { name: 'architecture.png' })
    expect(refreshedImg).toHaveAttribute('src', buildWikiAssetUrl('C:/wiki/assets/architecture.png', 2))
    expect(screen.queryByText('이미지를 불러올 수 없습니다.')).not.toBeInTheDocument()
  })
})

describe('DocumentEditor Mermaid scroll coordinates, 120px bottom padding, and edge auto-scroll', () => {
  let installedStyleEl: HTMLStyleElement | null = null

  const mountThemeStyles = (): void => {
    installedStyleEl = document.createElement('style')
    installedStyleEl.textContent = themeCss
    document.head.appendChild(installedStyleEl)
  }

  afterEach(() => {
    vi.useRealTimers()
    installedStyleEl?.remove()
    installedStyleEl = null
  })

  it('applies 120px bottom padding in WYSIWYG, Preview, and Split preview containers and resizes Mermaid via scroll coordinates and edge auto-scroll without mutating markdown', async () => {
    mountThemeStyles()
    vi.useFakeTimers()

    const driver: MermaidDriver = {
      initialize: vi.fn(),
      render: vi.fn(async () => ({
        svg: '<svg viewBox="0 0 100 50"><rect width="100" height="50"/></svg>'
      }))
    }
    const mermaidRenderer = createMermaidRenderer(driver)
    const markdown = ['# Arch', '', 'Intro', '', '```mermaid', 'flowchart LR', '  A --> B', '```'].join('\n')
    const doc = createDoc({ content: markdown, savedContent: markdown })
    const onChangeContent = vi.fn()

    const renderEditor = (mode: EditorMode) => (
      <DocumentEditor
        document={doc}
        tab={createTab(mode)}
        theme="light"
        autoSave={false}
        mermaidRenderer={mermaidRenderer}
        onChangeContent={onChangeContent}
        onSave={vi.fn()}
        onUpdateViewState={vi.fn()}
      />
    )

    const { container, rerender } = render(renderEditor('wysiwyg'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    // 1. WYSIWYG scroll container has 120px bottom padding and supports doc-coord + edge auto-scroll resize
    const wysiwygScroller = container.querySelector('.wysiwyg-scroll-container') as HTMLElement
    expect(getComputedStyle(wysiwygScroller).paddingBottom).toBe('120px')

    const wysiwygViewport = within(wysiwygScroller).getByTestId('mermaid-svg')
    const wysiwygHandle = within(wysiwygScroller).getByTestId('mermaid-resize-handle')
    mockElementBoundingRect(wysiwygViewport, { width: 400, height: 400 })
    const wysScroll = installScrollContainerStub(wysiwygScroller, {
      top: 40,
      clientHeight: 360,
      initialScrollTop: 500,
      getScrollHeight: () => 660 + (Number.parseFloat(wysiwygViewport.style.height) || 400)
    })

    // Drag down into bottom 36px zone (bottom = 400 -> threshold 364) -> expands height + scrollTop together
    fireEvent.pointerDown(wysiwygHandle, { button: 0, clientY: 260 })
    fireEvent.pointerMove(window, { clientY: 380 })
    expect(Number.parseFloat(wysiwygViewport.style.height)).toBe(520)

    act(() => {
      vi.advanceTimersByTime(32)
    })
    const heightAfterDownAuto = Number.parseFloat(wysiwygViewport.style.height)
    expect(heightAfterDownAuto).toBeGreaterThan(520)
    expect(wysScroll.getScrollTop()).toBe(500 + (heightAfterDownAuto - 520))

    // Drag up into top 36px zone (top = 40 -> threshold 76) -> contracts smoothly with upward scroll
    fireEvent.pointerMove(window, { clientY: 60 })
    const heightBeforeUpAuto = Number.parseFloat(wysiwygViewport.style.height)
    const scrollBeforeUpAuto = wysScroll.getScrollTop()
    act(() => {
      vi.advanceTimersByTime(16)
    })
    expect(wysScroll.getScrollTop()).toBeLessThan(scrollBeforeUpAuto)
    expect(Number.parseFloat(wysiwygViewport.style.height)).toBe(
      heightBeforeUpAuto - (scrollBeforeUpAuto - wysScroll.getScrollTop())
    )
    fireEvent.pointerUp(window)
    expect(onChangeContent).not.toHaveBeenCalled()

    // 2. Standalone Preview scroll container has 120px bottom padding and supports bottom-edge auto-scroll
    rerender(renderEditor('preview'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    const previewScroller = screen.getByTestId('document-editor')
    expect(getComputedStyle(previewScroller).paddingBottom).toBe('120px')

    const previewViewport = within(previewScroller).getByTestId('mermaid-svg')
    const previewHandle = within(previewScroller).getByTestId('mermaid-resize-handle')
    mockElementBoundingRect(previewViewport, { width: 400, height: 180 })
    const previewScroll = installScrollContainerStub(previewScroller, {
      clientHeight: 320,
      initialScrollTop: 400,
      getScrollHeight: () => 540 + (Number.parseFloat(previewViewport.style.height) || 180)
    })

    fireEvent.pointerDown(previewHandle, { button: 0, clientY: 200 })
    fireEvent.pointerMove(window, { clientY: 310 })
    act(() => {
      vi.advanceTimersByTime(16)
    })
    expect(Number.parseFloat(previewViewport.style.height)).toBeGreaterThan(290)
    expect(previewScroll.getScrollTop()).toBeGreaterThan(400)
    fireEvent.pointerUp(window)

    // 3. Split right Preview scroll container also has 120px bottom padding
    rerender(renderEditor('split'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    const splitPreview = screen.getByTestId('split-markdown-preview')
    expect(getComputedStyle(splitPreview).paddingBottom).toBe('120px')
    expect(onChangeContent).not.toHaveBeenCalled()
  })

  it('keeps Split mode bidirectional scroll sync loop-free during Mermaid edge auto-scroll and cleans up rAF on unmount', async () => {
    mountThemeStyles()
    vi.useFakeTimers()

    const mermaidLines = [
      '```mermaid',
      'flowchart LR',
      '  A --> B',
      '  B --> C',
      '  C --> D',
      '  D --> E',
      '```'
    ]
    const trailingLines = Array.from({ length: 40 }, (_, i) => `- Trailing item ${i + 1}`)
    const content = ['# Top', '', ...mermaidLines, '', ...trailingLines].join('\n')
    const doc = createDoc({ content, savedContent: content })
    let latestTab = createTab('split', 0.5)
    const onUpdateViewState = vi.fn((patch: Partial<DocumentTabItem>) => {
      latestTab = { ...latestTab, ...patch }
    })
    const driver: MermaidDriver = {
      initialize: vi.fn(),
      render: vi.fn(async () => ({
        svg: '<svg viewBox="0 0 100 50"><rect width="100" height="50"/></svg>'
      }))
    }

    const { container, unmount } = render(
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

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    const rawScroller = container.querySelector('.cm-scroller') as HTMLElement
    const splitPreview = screen.getByTestId('split-markdown-preview') as HTMLElement
    const cmView = EditorView.findFromDOM(rawScroller)!
    expect(cmView).not.toBeNull()

    Object.defineProperty(rawScroller, 'clientHeight', { configurable: true, value: 240 })
    Object.defineProperty(rawScroller, 'scrollHeight', {
      configurable: true,
      get: () => cmView.contentHeight
    })

    const previewViewport = within(splitPreview).getByTestId('mermaid-svg')
    const previewHandle = within(splitPreview).getByTestId('mermaid-resize-handle')
    const h1 = splitPreview.querySelector('h1[data-source-line="1"]') as HTMLElement
    const mermaidBlock = within(splitPreview).getByTestId('mermaid-diagram')
    const ulEl = splitPreview.querySelector('ul[data-source-line]') as HTMLElement

    const currentDiagramHeight = () => Number.parseFloat(previewViewport.style.height) || 200
    mockElementBoundingRect(previewViewport, { width: 400, height: 200 })
    const previewScroll = installScrollContainerStub(splitPreview, {
      clientHeight: 240,
      initialScrollTop: 180,
      getScrollHeight: () => 900 + currentDiagramHeight()
    })

    mockScrollElementRect(splitPreview, h1, 0, 40)
    mockScrollElementRect(splitPreview, mermaidBlock, 60, currentDiagramHeight)
    mockScrollElementRect(splitPreview, ulEl, () => 80 + currentDiagramHeight(), 600)

    // Drag Mermaid handle into Split preview bottom 36px edge zone -> triggers rAF auto-scroll
    fireEvent.pointerDown(previewHandle, { button: 0, clientY: 160 })
    fireEvent.pointerMove(window, { clientY: 230 })
    act(() => {
      vi.advanceTimersByTime(16)
    })
    expect(previewScroll.getScrollTop()).toBeGreaterThan(180)
    const syncedPreviewTop = previewScroll.getScrollTop()

    // Browser scroll event on Split preview syncs Raw editor without echo ping-pong back to Split preview
    onUpdateViewState.mockClear()
    fireEvent.scroll(splitPreview)
    expect(rawScroller.scrollTop).toBeGreaterThan(0)
    expect(onUpdateViewState).toHaveBeenCalledTimes(1)
    expect(onUpdateViewState).toHaveBeenCalledWith({ scrollTop: rawScroller.scrollTop })

    // Immediate echo scroll from Raw is ignored by ScrollSyncLoopGuard (Split preview scrollTop stays untouched)
    previewScroll.clearScrollWrites()
    const syncedRawTop = rawScroller.scrollTop
    fireEvent.scroll(rawScroller)
    expect(previewScroll.getScrollTop()).toBe(syncedPreviewTop)
    expect(rawScroller.scrollTop).toBe(syncedRawTop)
    expect(previewScroll.getScrollWrites()).toHaveLength(0)

    // Unmounting while edge auto-scroll is active cancels rAF cleanly
    const cancelRafSpy = vi.spyOn(window, 'cancelAnimationFrame')
    unmount()
    expect(cancelRafSpy).toHaveBeenCalled()
    const scrollAtUnmount = previewScroll.getScrollTop()
    act(() => {
      vi.advanceTimersByTime(64)
    })
    expect(previewScroll.getScrollTop()).toBe(scrollAtUnmount)
    cancelRafSpy.mockRestore()
  })
})

describe('DocumentEditor Mermaid tab-session height persistence', () => {
  function mountMermaidSessionEditor(initialMarkdown: string, initialMode: EditorMode) {
    let doc = createDoc({ content: initialMarkdown, savedContent: initialMarkdown })
    let tab: DocumentTabItem = createTab(initialMode)

    const driver: MermaidDriver = {
      initialize: vi.fn(),
      render: vi.fn(async (_id, text) => {
        if (text.includes('BROKEN')) {
          throw new Error('Syntax error')
        }
        return {
          svg: `<svg viewBox="0 0 100 50"><g><text>${text.trim()}</text></g></svg>`
        }
      })
    }
    const mermaidRenderer = createMermaidRenderer(driver)

    let rerenderEditor!: () => void
    const onChangeContent = vi.fn((nextContent: string) => {
      doc = { ...doc, content: nextContent, isDirty: nextContent !== doc.savedContent }
      rerenderEditor()
    })
    const onUpdateViewState = vi.fn((patch: TabViewPatch) => {
      const next = { ...tab, ...patch }
      if ('mermaidHeights' in patch && patch.mermaidHeights === undefined) {
        delete next.mermaidHeights
      }
      tab = next
      rerenderEditor()
    })

    const renderView = () => (
      <DocumentEditor
        document={doc}
        tab={tab}
        theme="light"
        autoSave={false}
        mermaidRenderer={mermaidRenderer}
        onChangeContent={onChangeContent}
        onSave={vi.fn()}
        onUpdateViewState={onUpdateViewState}
      />
    )

    const result = render(renderView())
    rerenderEditor = () => result.rerender(renderView())

    return {
      getTab: () => tab,
      onChangeContent,
      updateContentProp: (nextContent: string) => {
        doc = { ...doc, content: nextContent, isDirty: true }
        rerenderEditor()
      }
    }
  }

  it('persists independent heights by 0-based Mermaid block index across Preview <-> Split, live Split edits, and clears on double-click and 뷰 초기화 without mutating markdown', async () => {
    const duplicateDiagram = 'flowchart LR\n  A --> B'
    const initialMarkdown = [
      '# Diagrams',
      '',
      '```ts',
      'const ignored = true',
      '```',
      '',
      '```mermaid',
      duplicateDiagram,
      '```',
      '',
      '```mermaid',
      duplicateDiagram,
      '```'
    ].join('\n')

    const { getTab, onChangeContent, updateContentProp } = mountMermaidSessionEditor(
      initialMarkdown,
      'preview'
    )

    await waitFor(() => {
      expect(screen.getAllByTestId('mermaid-svg')).toHaveLength(2)
    })

    const previewBlocks = screen.getAllByTestId('mermaid-diagram')
    const previewViewports = screen.getAllByTestId('mermaid-svg')
    const previewHandles = screen.getAllByTestId('mermaid-resize-handle')
    mockElementBoundingRect(previewViewports[0], { width: 400, height: 180 })
    mockElementBoundingRect(previewViewports[1], { width: 400, height: 180 })

    // Resize two identical-code Mermaid blocks independently in Preview
    fireEvent.pointerDown(previewHandles[0], { button: 0, clientY: 180 })
    fireEvent.pointerMove(window, { clientY: 280 })
    fireEvent.pointerUp(window)

    fireEvent.pointerDown(previewHandles[1], { button: 0, clientY: 180 })
    fireEvent.pointerMove(window, { clientY: 420 })
    fireEvent.pointerUp(window)

    expect(previewViewports[0].style.height).toBe('280px')
    expect(previewViewports[1].style.height).toBe('420px')
    expect(getTab().mermaidHeights).toEqual({ '0': 280, '1': 420 })
    expect(onChangeContent).not.toHaveBeenCalled()

    // Switch Preview -> Split: both heights match by occurrence index and 뷰 초기화 is enabled
    fireEvent.click(within(screen.getByRole('group', { name: '에디터 모드 전환' })).getByRole('button', { name: 'Split' }))
    const splitPreview = await screen.findByTestId('split-markdown-preview')
    await waitFor(() => {
      expect(within(splitPreview).getAllByTestId('mermaid-svg')).toHaveLength(2)
    })
    const splitViewports = within(splitPreview).getAllByTestId('mermaid-svg')
    expect(splitViewports[0].style.height).toBe('280px')
    expect(splitViewports[1].style.height).toBe('420px')

    const splitBlocks = within(splitPreview).getAllByTestId('mermaid-diagram')
    expect(within(splitBlocks[0]).getByRole('button', { name: '뷰 초기화' })).toBeEnabled()
    expect(within(splitBlocks[1]).getByRole('button', { name: '뷰 초기화' })).toBeEnabled()

    // Live edit block 0 in Split (valid -> BROKEN -> valid) preserves height 280px and 420px
    updateContentProp(initialMarkdown.replace('A --> B', 'A --> LIVE_EDIT'))
    await waitFor(() => {
      expect(within(splitPreview).getAllByTestId('mermaid-svg')[0]).toHaveTextContent('A --> LIVE_EDIT')
    })
    expect(within(splitPreview).getAllByTestId('mermaid-svg')[0].style.height).toBe('280px')
    expect(within(splitPreview).getAllByTestId('mermaid-svg')[1].style.height).toBe('420px')

    updateContentProp(initialMarkdown.replace('A --> B', 'BROKEN'))
    await waitFor(() => {
      expect(within(splitBlocks[0]).getByText('Mermaid 문법 오류')).toBeInTheDocument()
    })
    expect(within(splitPreview).getAllByTestId('mermaid-svg')[0].style.height).toBe('280px')

    updateContentProp(initialMarkdown.replace('A --> B', 'A --> RECOVERED'))
    await waitFor(() => {
      expect(within(splitPreview).getAllByTestId('mermaid-svg')[0]).toHaveTextContent('A --> RECOVERED')
    })
    expect(within(splitPreview).getAllByTestId('mermaid-svg')[0].style.height).toBe('280px')
    expect(within(splitPreview).getAllByTestId('mermaid-svg')[1].style.height).toBe('420px')

    // Zoom + 100% reset preserves custom height 280px
    fireEvent.click(within(splitBlocks[0]).getByRole('button', { name: '확대' }))
    fireEvent.click(within(splitBlocks[0]).getByRole('button', { name: '배율 초기화' }))
    expect(within(splitPreview).getAllByTestId('mermaid-svg')[0].style.height).toBe('280px')
    expect(getTab().mermaidHeights).toEqual({ '0': 280, '1': 420 })

    // Double-clicking handle of block 0 clears only index '0'
    fireEvent.doubleClick(within(splitBlocks[0]).getByTestId('mermaid-resize-handle'))
    expect(within(splitPreview).getAllByTestId('mermaid-svg')[0].style.height).toBe('')
    expect(within(splitPreview).getAllByTestId('mermaid-svg')[1].style.height).toBe('420px')
    expect(getTab().mermaidHeights).toEqual({ '1': 420 })

    // Clicking unified 뷰 초기화 on block 1 clears index '1' as well
    fireEvent.click(within(splitBlocks[1]).getByRole('button', { name: '뷰 초기화' }))
    expect(within(splitPreview).getAllByTestId('mermaid-svg')[1].style.height).toBe('')
    expect(getTab().mermaidHeights).toBeUndefined()

    // Switching back to Preview keeps both blocks at auto height
    fireEvent.click(within(screen.getByRole('group', { name: '에디터 모드 전환' })).getByRole('button', { name: 'Preview' }))
    await waitFor(() => {
      expect(screen.getAllByTestId('mermaid-svg')).toHaveLength(2)
    })
    expect(screen.getAllByTestId('mermaid-svg')[0].style.height).toBe('')
    expect(screen.getAllByTestId('mermaid-svg')[1].style.height).toBe('')
    expect(previewBlocks).toHaveLength(2)
  })

  it('persists independent heights across 위지윅 <-> Preview <-> Split <-> Raw, survives live 위지윅 edits and code-block conversion, and clears on reset', async () => {
    const user = userEvent.setup()
    const duplicateDiagram = 'flowchart LR\n  A --> B'
    const initialMarkdown = [
      '# Editor Modes',
      '',
      '```ts',
      'const keep = 1',
      '```',
      '',
      '```mermaid',
      duplicateDiagram,
      '```',
      '',
      '```mermaid',
      duplicateDiagram,
      '```'
    ].join('\n')

    const { getTab, onChangeContent, updateContentProp } = mountMermaidSessionEditor(
      initialMarkdown,
      'wysiwyg'
    )

    await waitFor(() => {
      expect(screen.getAllByTestId('wysiwyg-mermaid-block')).toHaveLength(2)
      expect(screen.getAllByTestId('mermaid-svg')).toHaveLength(2)
    })

    const wysiwygBlocks = screen.getAllByTestId('wysiwyg-mermaid-block')
    const wysViewports = screen.getAllByTestId('mermaid-svg')
    const wysHandles = screen.getAllByTestId('mermaid-resize-handle')
    mockElementBoundingRect(wysViewports[0], { width: 400, height: 180 })
    mockElementBoundingRect(wysViewports[1], { width: 400, height: 180 })

    // Resize both duplicate blocks independently in 위지윅
    fireEvent.pointerDown(wysHandles[0], { button: 0, clientY: 180 })
    fireEvent.pointerMove(window, { clientY: 260 })
    fireEvent.pointerUp(window)

    fireEvent.pointerDown(wysHandles[1], { button: 0, clientY: 180 })
    fireEvent.pointerMove(window, { clientY: 380 })
    fireEvent.pointerUp(window)

    expect(wysViewports[0].style.height).toBe('260px')
    expect(wysViewports[1].style.height).toBe('380px')
    expect(getTab().mermaidHeights).toEqual({ '0': 260, '1': 380 })
    expect(onChangeContent).not.toHaveBeenCalled()

    // Live edit inside 위지윅 (external sync & direct edit of block 0) preserves both heights
    updateContentProp(initialMarkdown.replace('A --> B', 'A --> LIVE_WYS'))
    await waitFor(() => {
      expect(screen.getAllByTestId('mermaid-svg')[0]).toHaveTextContent('A --> LIVE_WYS')
    })
    expect(screen.getAllByTestId('mermaid-svg')[0].style.height).toBe('260px')
    expect(screen.getAllByTestId('mermaid-svg')[1].style.height).toBe('380px')

    // Converting preceding ts block to Mermaid shifts indices dynamically, and restoring ts brings '0' & '1' back cleanly
    const tsBlock = screen.getByTestId('wysiwyg-code-block')
    await user.click(within(tsBlock).getByRole('button', { name: '코드 블록 언어 선택' }))
    await user.click(
      within(screen.getByRole('listbox', { name: '코드 블록 언어 목록' })).getByRole('option', {
        name: 'Mermaid'
      })
    )
    await waitFor(() => {
      expect(screen.getAllByTestId('wysiwyg-mermaid-block')).toHaveLength(3)
      expect(screen.getAllByTestId('mermaid-svg')).toHaveLength(3)
    })
    const shiftedViewports = screen.getAllByTestId('mermaid-svg')
    expect(shiftedViewports[0].style.height).toBe('260px')
    expect(shiftedViewports[1].style.height).toBe('380px')
    expect(shiftedViewports[2].style.height).toBe('')

    const convertedBlockTrigger = within(screen.getAllByTestId('wysiwyg-mermaid-block')[0]).getByRole(
      'button',
      { name: '코드 블록 언어 선택' }
    )
    await user.click(convertedBlockTrigger)
    await user.click(
      within(screen.getByRole('listbox', { name: '코드 블록 언어 목록' })).getByRole('option', {
        name: 'TypeScript'
      })
    )
    await waitFor(() => {
      expect(screen.getAllByTestId('wysiwyg-mermaid-block')).toHaveLength(2)
    })
    expect(screen.getAllByTestId('mermaid-svg')[0].style.height).toBe('260px')
    expect(screen.getAllByTestId('mermaid-svg')[1].style.height).toBe('380px')

    // Mode roundtrip: 위지윅 -> Preview -> Split -> Raw -> 위지윅 preserves heights
    const modeGroup = screen.getByRole('group', { name: '에디터 모드 전환' })
    await user.click(within(modeGroup).getByRole('button', { name: 'Preview' }))
    await waitFor(() => {
      expect(screen.getAllByTestId('mermaid-svg')).toHaveLength(2)
    })
    expect(screen.getAllByTestId('mermaid-svg')[0].style.height).toBe('260px')
    expect(screen.getAllByTestId('mermaid-svg')[1].style.height).toBe('380px')

    await user.click(within(modeGroup).getByRole('button', { name: 'Split' }))
    const splitPreview = await screen.findByTestId('split-markdown-preview')
    await waitFor(() => {
      expect(within(splitPreview).getAllByTestId('mermaid-svg')).toHaveLength(2)
    })
    expect(within(splitPreview).getAllByTestId('mermaid-svg')[0].style.height).toBe('260px')
    expect(within(splitPreview).getAllByTestId('mermaid-svg')[1].style.height).toBe('380px')

    await user.click(within(modeGroup).getByRole('button', { name: 'Raw' }))
    expect(getTab().mermaidHeights).toEqual({ '0': 260, '1': 380 })

    await user.click(within(modeGroup).getByRole('button', { name: '위지윅' }))
    await waitFor(() => {
      expect(screen.getAllByTestId('mermaid-svg')).toHaveLength(2)
    })
    expect(screen.getAllByTestId('mermaid-svg')[0].style.height).toBe('260px')
    expect(screen.getAllByTestId('mermaid-svg')[1].style.height).toBe('380px')
    expect(within(wysiwygBlocks[0]).getByRole('button', { name: '뷰 초기화' })).toBeEnabled()
    expect(within(wysiwygBlocks[1]).getByRole('button', { name: '뷰 초기화' })).toBeEnabled()

    // Reset block 0 via double-click and block 1 via 뷰 초기화 in 위지윅 -> removed from tab.mermaidHeights
    fireEvent.doubleClick(screen.getAllByTestId('mermaid-resize-handle')[0])
    expect(screen.getAllByTestId('mermaid-svg')[0].style.height).toBe('')
    expect(screen.getAllByTestId('mermaid-svg')[1].style.height).toBe('380px')
    expect(getTab().mermaidHeights).toEqual({ '1': 380 })

    fireEvent.click(within(screen.getAllByTestId('wysiwyg-mermaid-block')[1]).getByRole('button', { name: '뷰 초기화' }))
    expect(screen.getAllByTestId('mermaid-svg')[1].style.height).toBe('')
    expect(getTab().mermaidHeights).toBeUndefined()

    // Switching back to Preview keeps both auto height
    await user.click(within(modeGroup).getByRole('button', { name: 'Preview' }))
    await waitFor(() => {
      expect(screen.getAllByTestId('mermaid-svg')).toHaveLength(2)
    })
    expect(screen.getAllByTestId('mermaid-svg')[0].style.height).toBe('')
    expect(screen.getAllByTestId('mermaid-svg')[1].style.height).toBe('')
  })
})

describe('DocumentEditor frontmatter integration (<DocumentEditor />)', () => {
  it('hides YAML frontmatter in 위지윅 mode, recombines original frontmatter losslessly on body edits, preserves caret on external frontmatter-only updates, and guards syntax-error blocks', async () => {
    const user = userEvent.setup()
    const initialContent = [
      '\uFEFF---',
      '# Keep this YAML comment',
      'status: todo',
      'customBlock:',
      '  owner: platform',
      '  # nested comment',
      '  items: [one, two]',
      '---',
      '',
      '# Body Heading',
      '',
      'AlphaBeta'
    ].join('\r\n')

    let doc = createDoc({ content: initialContent, savedContent: initialContent })
    let tab = createTab('wysiwyg')
    const emittedUpdates: string[] = []
    const onChangeContent = vi.fn((nextContent: string) => {
      emittedUpdates.push(nextContent)
      doc = { ...doc, content: nextContent, isDirty: true }
      rerenderEditor()
    })

    const renderUi = () => (
      <DocumentEditor
        document={doc}
        tab={tab}
        theme="light"
        autoSave={false}
        onChangeContent={onChangeContent}
        onSave={vi.fn()}
        onUpdateViewState={(patch) => {
          tab = { ...tab, ...patch }
          rerenderEditor()
        }}
      />
    )
    const { rerender } = render(renderUi())
    const rerenderEditor = () => rerender(renderUi())

    const wysiwygSurface = screen.getByLabelText('위지윅 문서 에디터')
    // Frontmatter must NOT leak into TipTap rich-text surface
    expect(wysiwygSurface.textContent).not.toContain('status: todo')
    expect(wysiwygSurface.textContent).not.toContain('customBlock')
    expect(wysiwygSurface.textContent).not.toContain('Keep this YAML comment')
    expect(wysiwygSurface.querySelector('hr')).toBeNull()
    expect(within(wysiwygSurface).getByRole('heading', { level: 1, name: 'Body Heading' })).toBeInTheDocument()
    expect(onChangeContent).not.toHaveBeenCalled()

    // Mode roundtrips without body edits must not trigger onChangeContent
    const modeGroup = screen.getByRole('group', { name: '에디터 모드 전환' })
    await user.click(within(modeGroup).getByRole('button', { name: 'Raw' }))
    await user.click(within(modeGroup).getByRole('button', { name: '위지윅' }))
    expect(onChangeContent).not.toHaveBeenCalled()

    // Place caret between 'Alpha' and 'Beta' inside TipTap paragraph
    const activeSurface = screen.getByLabelText('위지윅 문서 에디터')
    const paragraphTextNode = Array.from(activeSurface.querySelectorAll('p')).find(
      (p) => p.textContent === 'AlphaBeta'
    )?.firstChild
    expect(paragraphTextNode).toBeTruthy()
    const selection = window.getSelection()!
    const range = document.createRange()
    range.setStart(paragraphTextNode!, 5)
    range.collapse(true)
    activeSurface.focus()
    selection.removeAllRanges()
    selection.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
    expect(selection.anchorNode).toBe(paragraphTextNode)
    expect(selection.anchorOffset).toBe(5)

    // External update changing ONLY frontmatter must NOT emit onChangeContent or reset caret/selection
    const updatedFrontmatter = applyFrontmatterValues(doc.content, { status: 'done' })
    expect(updatedFrontmatter.applied).toBe(true)
    doc = { ...doc, content: updatedFrontmatter.content, isDirty: true }
    rerenderEditor()

    expect(onChangeContent).not.toHaveBeenCalled()
    expect(selection.rangeCount).toBe(1)
    expect(selection.anchorNode).toBe(paragraphTextNode)
    expect(selection.anchorOffset).toBe(5)

    // Typing at preserved caret inserts at 'Alpha|Beta' and recombines with updated frontmatter + untouched unknown/comments/BOM/CRLF
    await user.keyboard('Mid')
    await waitFor(() => {
      expect(emittedUpdates.length).toBeGreaterThanOrEqual(1)
    })
    const latestEmitted = emittedUpdates[emittedUpdates.length - 1]
    expect(latestEmitted.startsWith('\uFEFF---\r\n# Keep this YAML comment\r\nstatus: done\r\n')).toBe(true)
    expect(latestEmitted).toContain('customBlock:\r\n  owner: platform\r\n  # nested comment\r\n  items: [one, two]')
    const reparsed = parseFrontmatterDocument(latestEmitted)
    expect(reparsed.body).toContain('AlphaMidBeta')

    // External frontmatter removal keeps body intact without losing edited text
    const removed = removeFrontmatterBlock(doc.content)
    expect(removed.applied).toBe(true)
    doc = { ...doc, content: removed.content }
    rerenderEditor()
    expect(screen.getByLabelText('위지윅 문서 에디터').textContent).toContain('AlphaMidBeta')

    // Closed YAML syntax error block stays hidden in 위지윅 and is preserved verbatim on edit
    const brokenYamlDoc = '---\n# invalid yaml kept\nbroken: [unclosed\n---\n# Safe Body\n\nText'
    doc = createDoc({ content: brokenYamlDoc, savedContent: brokenYamlDoc })
    onChangeContent.mockClear()
    emittedUpdates.length = 0
    rerenderEditor()

    const brokenSurface = screen.getByLabelText('위지윅 문서 에디터')
    expect(brokenSurface.textContent).not.toContain('broken:')
    expect(within(brokenSurface).getByRole('heading', { level: 1, name: 'Safe Body' })).toBeInTheDocument()
    const brokenText = Array.from(brokenSurface.querySelectorAll('p')).find(
      (p) => p.textContent === 'Text'
    )!
    const brokenRange = document.createRange()
    brokenRange.selectNodeContents(brokenText)
    brokenRange.collapse(false)
    brokenSurface.focus()
    selection.removeAllRanges()
    selection.addRange(brokenRange)
    document.dispatchEvent(new Event('selectionchange'))
    await user.keyboard('!')
    await waitFor(() => {
      expect(emittedUpdates.length).toBeGreaterThanOrEqual(1)
    })
    expect(emittedUpdates[emittedUpdates.length - 1].startsWith('---\n# invalid yaml kept\nbroken: [unclosed\n---\n')).toBe(true)
  })

  it('hides YAML frontmatter in Split right preview, offsets data-source-line/end-line accurately, and syncs Raw <-> Preview scroll positions', async () => {
    const frontmatterLines = [
      '---',
      'title: Split Sync Doc',
      '# yaml comment',
      'labels: [docs, wiki]',
      '---'
    ] // lines 1..5 -> bodyStartLine = 6 (offset = 5)
    const trailingItems = Array.from({ length: 44 }, (_, i) => `- Item ${i + 1}`)
    const docLines = [
      ...frontmatterLines,
      '# Top Heading', // line 6
      '',
      'Paragraph block', // line 8
      '',
      ...trailingItems // lines 10..53
    ]
    const fullContent = docLines.join('\n')
    const doc = createDoc({ content: fullContent, savedContent: fullContent })
    const tab = createTab('split', 0.5)

    const { container } = render(
      <DocumentEditor
        document={doc}
        tab={tab}
        theme="light"
        autoSave={false}
        onChangeContent={vi.fn()}
        onSave={vi.fn()}
        onUpdateViewState={vi.fn()}
      />
    )

    const rawScroller = container.querySelector('.cm-scroller') as HTMLElement
    const previewRegion = screen.getByTestId('split-markdown-preview') as HTMLElement
    const cmView = EditorView.findFromDOM(rawScroller)!

    expect(previewRegion.textContent).not.toContain('Split Sync Doc')
    expect(previewRegion.textContent).not.toContain('labels:')
    expect(previewRegion.querySelector('hr')).toBeNull()

    const h1 = previewRegion.querySelector('h1') as HTMLElement
    const p = previewRegion.querySelector('p') as HTMLElement
    const ul = previewRegion.querySelector('ul') as HTMLElement
    expect(h1).toHaveAttribute('data-source-line', '6')
    expect(h1).toHaveAttribute('data-source-end-line', '6')
    expect(p).toHaveAttribute('data-source-line', '8')
    expect(p).toHaveAttribute('data-source-end-line', '8')
    expect(ul).toHaveAttribute('data-source-line', '10')
    expect(ul).toHaveAttribute('data-source-end-line', '53')

    Object.defineProperty(rawScroller, 'clientHeight', { configurable: true, value: 200 })
    Object.defineProperty(rawScroller, 'scrollHeight', {
      configurable: true,
      get: () => cmView.contentHeight
    })
    Object.defineProperty(previewRegion, 'clientHeight', { configurable: true, value: 200 })
    Object.defineProperty(previewRegion, 'scrollHeight', { configurable: true, value: 1200 })
    previewRegion.getBoundingClientRect = () =>
      ({ top: 0, left: 0, right: 500, bottom: 200, width: 500, height: 200, x: 0, y: 0, toJSON: () => ({}) })

    mockScrollElementRect(previewRegion, h1, 16, 40)
    mockScrollElementRect(previewRegion, p, 80, 40)
    mockScrollElementRect(previewRegion, ul, 160, 1040)

    // Scroll Raw to line 32 (50% through [10, 54) => 160 + 0.5 * 1040 = 680)
    const line32Top = cmView.documentPadding.top + cmView.lineBlockAt(cmView.state.doc.line(32).from).top
    rawScroller.scrollTop = line32Top
    fireEvent.scroll(rawScroller)
    expect(previewRegion.scrollTop).toBeCloseTo(680, 3)

    // Scroll Preview back to p (line 8) -> Raw jumps accurately to line 8 (not line 3)
    previewRegion.scrollTop = 80
    fireEvent.scroll(previewRegion)
    const expectedLine8Top =
      cmView.documentPadding.top + cmView.lineBlockAt(cmView.state.doc.line(8).from).top
    expect(rawScroller.scrollTop).toBeCloseTo(expectedLine8Top, 3)
  })

  it('syncs DocumentPropertiesSection and DocumentEditor bidirectionally across Raw (preserving Raw focus/cursor) and Split modes', async () => {
    const user = userEvent.setup()
    const initial = '---\nstatus: todo\n---\n# Heading\n\nBody text'
    const schema = createDefaultFrontmatterSchema()

    function Harness() {
      const [doc, setDoc] = useState(() => createDoc({ content: initial, savedContent: initial }))
      const [tab, setTab] = useState<DocumentTabItem>(() => createTab('raw'))

      const handleChange = (nextContent: string): void => {
        setDoc((prev) => ({
          ...prev,
          content: nextContent,
          isDirty: nextContent !== prev.savedContent
        }))
      }

      return (
        <div>
          <DocumentEditor
            document={doc}
            tab={tab}
            theme="light"
            autoSave={false}
            onChangeContent={handleChange}
            onSave={vi.fn()}
            onUpdateViewState={(patch) => setTab((prev) => ({ ...prev, ...patch }))}
          />
          <DocumentPropertiesSection
            document={{
              documentName: doc.name,
              documentKey: doc.key,
              content: doc.content,
              isMarkdownDocument: true
            }}
            schemaResult={{
              exists: true,
              path: 'C:/wiki/.wiki-editor/frontmatter.json',
              schema
            }}
            isExpanded
            onToggleExpanded={vi.fn()}
            onChangeContent={handleChange}
            onCreateDefaultSchema={vi.fn()}
          />
        </div>
      )
    }

    render(<Harness />)

    const rawEditorEl = screen.getByTestId('document-editor')
    const cmView = EditorView.findFromDOM(rawEditorEl)!
    const properties = screen.getByRole('region', { name: '문서 속성' })

    // Typing inside Raw keeps focus & cursor while updating Properties immediately
    act(() => {
      cmView.focus()
      cmView.dispatch({
        changes: { from: 0, to: cmView.state.doc.length, insert: '---\nstatus: in-progress\n---\n# Heading\n\nBody text' },
        selection: { anchor: 23, head: 23 }
      })
    })
    expect(within(properties).getByLabelText('상태')).toHaveValue('in-progress')
    expect(cmView.state.selection.main.head).toBe(23)

    // Switch to Split and edit via Properties -> updates left Raw YAML without exposing YAML in right Preview
    await user.click(within(screen.getByRole('group', { name: '에디터 모드 전환' })).getByRole('button', { name: 'Split' }))
    await user.selectOptions(within(properties).getByLabelText('상태'), 'done')
    await user.type(within(properties).getByLabelText('담당자'), '@bob')

    const splitRaw = screen.getByTestId('document-editor')
    const splitPreview = screen.getByTestId('split-markdown-preview')
    expect(EditorView.findFromDOM(splitRaw)!.state.doc.toString()).toContain('status: done')
    expect(EditorView.findFromDOM(splitRaw)!.state.doc.toString()).toContain('assignee: "@bob"')
    expect(splitPreview.textContent).not.toContain('status:')
    expect(within(splitPreview).getByRole('heading', { level: 1, name: 'Heading' })).toBeInTheDocument()
  })

  it('locks .wiki-editor/frontmatter.json to Raw JSON mode and suppresses editor shortcuts when modal disables shortcuts', () => {
    const onSave = vi.fn()
    const onUpdateViewState = vi.fn()
    const schemaJson = JSON.stringify({ version: 1, fields: [{ key: 'status', label: '상태', type: 'text' }] }, null, 2)
    const schemaDoc = createDoc({
      key: 'c:/wiki/.wiki-editor/frontmatter.json',
      kind: 'workspace',
      path: 'C:/wiki/.wiki-editor/frontmatter.json',
      name: 'frontmatter.json',
      content: schemaJson,
      savedContent: schemaJson,
      isDirty: true
    })

    const { rerender } = render(
      <DocumentEditor
        document={schemaDoc}
        tab={{ ...createTab('split'), bufferKey: schemaDoc.key }}
        theme="light"
        autoSave={false}
        isShortcutDisabled={false}
        onChangeContent={vi.fn()}
        onSave={onSave}
        onUpdateViewState={onUpdateViewState}
      />
    )

    const modeGroup = screen.getByRole('group', { name: '에디터 모드 전환' })
    expect(within(modeGroup).getByRole('button', { name: 'Raw' })).toHaveAttribute('aria-pressed', 'true')
    expect(within(modeGroup).getByRole('button', { name: '위지윅' })).toBeDisabled()
    expect(within(modeGroup).getByRole('button', { name: 'Preview' })).toBeDisabled()
    expect(within(modeGroup).getByRole('button', { name: 'Split' })).toBeDisabled()
    expect(screen.queryByRole('toolbar', { name: 'Raw 표 편집 툴바' })).not.toBeInTheDocument()
    expect(EditorView.findFromDOM(screen.getByTestId('document-editor'))!.state.doc.toString()).toBe(schemaJson)

    fireEvent.keyDown(screen.getByTestId('document-editor'), { key: 's', ctrlKey: true })
    expect(onSave).toHaveBeenCalledTimes(1)

    // When modal disables shortcuts, Ctrl+S / Ctrl+F / Ctrl+1..4 are suppressed
    rerender(
      <DocumentEditor
        document={schemaDoc}
        tab={{ ...createTab('raw'), bufferKey: schemaDoc.key }}
        theme="light"
        autoSave={false}
        isShortcutDisabled
        onChangeContent={vi.fn()}
        onSave={onSave}
        onUpdateViewState={onUpdateViewState}
      />
    )

    fireEvent.keyDown(screen.getByTestId('document-editor'), { key: 's', ctrlKey: true })
    fireEvent.keyDown(screen.getByTestId('document-editor'), { key: 'f', ctrlKey: true })
    fireEvent.keyDown(screen.getByTestId('document-editor'), { key: '2', ctrlKey: true })
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('region', { name: '문서 내 찾기 바' })).not.toBeInTheDocument()
    expect(onUpdateViewState).not.toHaveBeenCalled()
  })
})
