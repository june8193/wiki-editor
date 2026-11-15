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

function createTab(mode: EditorMode = 'raw'): TabItem {
  return {
    id: 'tab-1',
    kind: 'document',
    bufferKey: 'c:/wiki/doc.md',
    mode,
    cursor: { selectionStart: 0, selectionEnd: 0 },
    scrollTop: 0
  }
}

describe('DocumentEditor 3-mode switcher & roundtrip', () => {
  it('switches between Raw, 위지윅, and Preview via top mode switcher and Ctrl+1/2/3/Shift+M without corrupting unchanged markdown', async () => {
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

    // Cycle back to Raw via Ctrl+Shift+M
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

    // Unchanged document preserved byte-for-byte with zero onChangeContent calls
    expect(onChangeContent).not.toHaveBeenCalled()
    expect(screen.getByTestId('document-editor').textContent).toContain('*   exact   spacing')
  })

  it('keeps config.json locked to Raw mode and respects isShortcutDisabled', () => {
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

    fireEvent.keyDown(screen.getByTestId('document-editor'), { key: '2', ctrlKey: true })
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
})
