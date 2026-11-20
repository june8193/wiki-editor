import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildWikiAssetUrl } from '@shared/assets'
import { createEmptyGitStatus } from '@shared/git'
import { addFavoriteWorkspace } from '@shared/workspace'
import { App } from './App'
import { clickActivityBarButton } from './test/appTestHelpers'
import { mockElementBoundingRect, mountThemeStylesAndRoot } from './test/domLayoutStub'
import {
  appendRawEditorText,
  createInMemoryWikiApi,
  getRawEditorScroller,
  getRawEditorSelection,
  getRawEditorText,
  setRawEditorSelection,
  setRawEditorText,
  triggerMenuCommand
} from './test/inMemoryWikiHarness'

vi.mock('mermaid', async () => (await import('./test/appTestHelpers')).createMermaidMockState().module)

describe('Multi-tab and 2-pane Split View layout', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-theme')
    vi.useRealTimers()
  })

  it('omits split mode buttons (단일, 좌우 분할, 상하 분할) from the app header', async () => {
    const { api } = createInMemoryWikiApi()
    window.wikiApi = api

    render(<App />)
    await screen.findByText('열린 워크스페이스 없음')

    expect(screen.queryByRole('banner')).not.toBeInTheDocument()
    expect(screen.queryByRole('group', { name: '화면 분할' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '단일 화면' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '좌우 분할' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '상하 분할' })).not.toBeInTheDocument()
  })

  it('opens multiple tabs, switches tabs, closes via X and middle-click, and prompts before closing the last tab of a dirty buffer', async () => {
    const user = userEvent.setup()
    const { api, emitMenuCommand, getFilesSnapshot } = createInMemoryWikiApi(
      {},
      {
        selectedFolder: 'C:\\wiki\\tabs',
        workspaces: {
          'C:\\wiki\\tabs': {
            'one.md': '# One',
            'two.md': '# Two',
            'three.md': '# Three'
          }
        }
      }
    )
    window.wikiApi = api

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    const sidebar = screen.getByLabelText('워크스페이스 탐색기')

    await user.click(await within(sidebar).findByText('one.md'))
    await user.click(within(sidebar).getByText('two.md'))
    await user.click(within(sidebar).getByText('three.md'))

    const primaryPane = screen.getByTestId('pane-primary')
    const tabs = within(primaryPane).getAllByRole('tab')
    expect(tabs).toHaveLength(3)
    expect(tabs.map((t) => t.textContent)).toEqual(['one.md', 'two.md', 'three.md'])
    expect(tabs[2]).toHaveAttribute('aria-selected', 'true')

    // Edit three.md so it becomes dirty
    appendRawEditorText(within(primaryPane).getByTestId('document-editor'), ' edited')
    expect(within(tabs[2]).getByTestId('tab-dirty-indicator')).toHaveTextContent('●')

    // Click one.md tab to switch cleanly without losing three.md edits
    await user.click(tabs[0])
    expect(within(primaryPane).getByRole('tab', { name: /one\.md/i })).toHaveAttribute(
      'aria-selected',
      'true'
    )
    expect(getRawEditorText(within(primaryPane).getByTestId('document-editor'))).toBe('# One')

    // Middle-click clean two.md tab closes it immediately
    const twoTab = within(primaryPane).getByRole('tab', { name: /two\.md/i })
    fireEvent(twoTab, new MouseEvent('auxclick', { button: 1, bubbles: true }))
    expect(within(primaryPane).queryByRole('tab', { name: /two\.md/i })).not.toBeInTheDocument()

    // Close dirty three.md via X button -> opens confirmation dialog -> choose 저장 후 닫기
    await user.click(within(primaryPane).getByRole('button', { name: 'three.md 탭 닫기' }))
    const dialog = await screen.findByRole('alertdialog')
    await user.click(within(dialog).getByRole('button', { name: /저장 후 닫기/i }))

    await waitFor(() => {
      expect(within(primaryPane).queryByRole('tab', { name: /three\.md/i })).not.toBeInTheDocument()
    })
    expect(getFilesSnapshot().get('C:/wiki/tabs/three.md')).toBe('# Three edited')
  })

  it('supports horizontal/vertical split view, resizing divider, context menu move/duplicate, real-time shared buffer sync, and auto-collapse', async () => {
    const user = userEvent.setup()
    const { api, emitMenuCommand, getFilesSnapshot } = createInMemoryWikiApi(
      {},
      {
        selectedFolder: 'C:\\wiki\\split',
        workspaces: {
          'C:\\wiki\\split': {
            'shared.md': '# Shared',
            'side.md': '# Side'
          }
        }
      }
    )
    window.wikiApi = api

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    const sidebar = screen.getByLabelText('워크스페이스 탐색기')

    await user.click(await within(sidebar).findByText('shared.md'))
    await user.click(within(sidebar).getByText('side.md'))

    const workspaceEl = screen.getByTestId('pane-workspace')
    expect(workspaceEl).toHaveAttribute('data-split-mode', 'single')

    // Context menu "분할 영역으로 이동" moves side.md to secondary and opens horizontal split
    const primaryPane = screen.getByTestId('pane-primary')
    fireEvent.contextMenu(within(primaryPane).getByRole('tab', { name: /side\.md/i }))
    const tabMenu = await screen.findByRole('menu', { name: '탭 작업 메뉴' })
    await user.click(within(tabMenu).getByRole('menuitem', { name: '분할 영역으로 이동' }))

    expect(workspaceEl).toHaveAttribute('data-split-mode', 'horizontal')
    const secondaryPane = screen.getByTestId('pane-secondary')
    expect(within(primaryPane).getAllByRole('tab')).toHaveLength(1)
    expect(within(secondaryPane).getByRole('tab', { name: /side\.md/i })).toBeInTheDocument()

    // Duplicate shared.md into secondary pane so both panes show the same file simultaneously
    fireEvent.contextMenu(within(primaryPane).getByRole('tab', { name: /shared\.md/i }))
    const dupMenu = await screen.findByRole('menu', { name: '탭 작업 메뉴' })
    await user.click(within(dupMenu).getByRole('menuitem', { name: '분할 영역에 복제 열기' }))

    expect(within(secondaryPane).getByRole('tab', { name: /shared\.md/i })).toBeInTheDocument()

    // Editing in primary immediately syncs content and dirty ● to secondary
    const primaryEditor = within(primaryPane).getByTestId('document-editor')
    const secondaryEditor = within(secondaryPane).getByTestId('document-editor')
    appendRawEditorText(primaryEditor, ' synced!')

    expect(getRawEditorText(secondaryEditor)).toBe('# Shared synced!')
    expect(within(primaryPane).getByTestId('dirty-indicator')).toHaveTextContent('●')
    expect(within(secondaryPane).getByTestId('dirty-indicator')).toHaveTextContent('●')

    // Closing one split tab of a dirty file does NOT prompt because the other pane still holds the buffer
    await user.click(within(secondaryPane).getByRole('button', { name: 'shared.md 탭 닫기' }))
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(within(primaryPane).getByTestId('dirty-indicator')).toBeInTheDocument()

    // Duplicate back, then save in secondary -> clears dirty ● in BOTH panes
    fireEvent.contextMenu(within(primaryPane).getByRole('tab', { name: /shared\.md/i }))
    const dupMenu2 = await screen.findByRole('menu', { name: '탭 작업 메뉴' })
    await user.click(within(dupMenu2).getByRole('menuitem', { name: '분할 영역에 복제 열기' }))

    const syncedSecondaryEditor = within(secondaryPane).getByTestId('document-editor')
    fireEvent.keyDown(syncedSecondaryEditor, { key: 's', ctrlKey: true })

    await waitFor(() => {
      expect(screen.queryByTestId('dirty-indicator')).not.toBeInTheDocument()
    })
    expect(getFilesSnapshot().get('C:/wiki/split/shared.md')).toBe('# Shared synced!')

    // Switch split direction to vertical by dragging a tab to the vertical drop zone and resize splitter via keyboard and pointer drag
    fireEvent.dragStart(within(secondaryPane).getByRole('tab', { name: /side\.md/i }))
    fireEvent.drop(await screen.findByTestId('split-drop-zone-vertical'))
    expect(workspaceEl).toHaveAttribute('data-split-mode', 'vertical')

    const divider = screen.getByRole('separator', { name: '화면 분할 크기 조절' })
    expect(divider).toHaveAttribute('aria-orientation', 'horizontal')
    expect(divider).toHaveAttribute('aria-valuenow', '50')

    fireEvent.keyDown(divider, { key: 'ArrowDown' })
    expect(divider).toHaveAttribute('aria-valuenow', '55')

    mockElementBoundingRect(workspaceEl, { width: 800, height: 600 })
    fireEvent.mouseDown(divider, { clientY: 330 })
    fireEvent.mouseMove(window, { clientY: 180 })
    fireEvent.mouseUp(window)
    expect(divider).toHaveAttribute('aria-valuenow', '30')

    // Closing all tabs in secondary auto-collapses back to single pane
    await user.click(within(secondaryPane).getByRole('button', { name: 'shared.md 탭 닫기' }))
    await user.click(within(secondaryPane).getByRole('button', { name: 'side.md 탭 닫기' }))

    expect(workspaceEl).toHaveAttribute('data-split-mode', 'single')
    expect(screen.queryByTestId('pane-secondary')).not.toBeInTheDocument()
  })

  it('supports drag-and-drop reordering and moving tabs between panes', async () => {
    const user = userEvent.setup()
    const { api, emitMenuCommand } = createInMemoryWikiApi(
      {},
      {
        selectedFolder: 'C:\\wiki\\dnd',
        workspaces: {
          'C:\\wiki\\dnd': {
            'a.md': '# A',
            'b.md': '# B',
            'c.md': '# C'
          }
        }
      }
    )
    window.wikiApi = api

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    const sidebar = screen.getByLabelText('워크스페이스 탐색기')

    await user.click(await within(sidebar).findByText('a.md'))
    await user.click(within(sidebar).getByText('b.md'))
    await user.click(within(sidebar).getByText('c.md'))

    const primaryPane = screen.getByTestId('pane-primary')
    const cTab = within(primaryPane).getByRole('tab', { name: /c\.md/i })
    const aTab = within(primaryPane).getByRole('tab', { name: /a\.md/i })

    // Reorder c.md before a.md within primary tab bar
    fireEvent.dragStart(cTab)
    fireEvent.drop(aTab)
    expect(within(primaryPane).getAllByRole('tab').map((t) => t.textContent)).toEqual([
      'c.md',
      'a.md',
      'b.md'
    ])

    // Drag b.md onto horizontal split drop zone in single mode -> creates horizontal split with b.md
    const bTab = within(primaryPane).getByRole('tab', { name: /b\.md/i })
    fireEvent.dragStart(bTab)
    const horizontalDropZone = await screen.findByTestId('split-drop-zone-horizontal')
    expect(screen.getByTestId('split-drop-zone-vertical')).toBeInTheDocument()
    fireEvent.drop(horizontalDropZone)

    expect(screen.getByTestId('pane-workspace')).toHaveAttribute('data-split-mode', 'horizontal')
    const secondaryPane = screen.getByTestId('pane-secondary')
    expect(within(secondaryPane).getByRole('tab', { name: /b\.md/i })).toBeInTheDocument()
    expect(within(primaryPane).queryByRole('tab', { name: /b\.md/i })).not.toBeInTheDocument()
  })

  it('supports vertical drag split from single mode, orientation switching in split mode, and auto-collapse focus preservation', async () => {
    const user = userEvent.setup()
    const { api, emitMenuCommand } = createInMemoryWikiApi(
      {},
      {
        selectedFolder: 'C:\\wiki\\drag-split',
        workspaces: {
          'C:\\wiki\\drag-split': {
            'a.md': '# A',
            'b.md': '# B',
            'c.md': '# C'
          }
        }
      }
    )
    window.wikiApi = api

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    const sidebar = screen.getByLabelText('워크스페이스 탐색기')

    // With only 1 tab open in single mode, dragging must NOT show split drop zones
    await user.click(await within(sidebar).findByText('a.md'))
    const primaryPane = screen.getByTestId('pane-primary')
    fireEvent.dragStart(within(primaryPane).getByRole('tab', { name: /a\.md/i }))
    expect(screen.queryByTestId('split-drop-zone-horizontal')).not.toBeInTheDocument()
    expect(screen.queryByTestId('split-drop-zone-vertical')).not.toBeInTheDocument()
    fireEvent.dragEnd(within(primaryPane).getByRole('tab', { name: /a\.md/i }))

    // Open b.md (2 tabs) -> dragging shows both horizontal and vertical drop zones; drop on vertical
    await user.click(within(sidebar).getByText('b.md'))
    fireEvent.dragStart(within(primaryPane).getByRole('tab', { name: /b\.md/i }))
    expect(screen.getByTestId('split-drop-zone-horizontal')).toBeInTheDocument()
    const verticalDropZone = screen.getByTestId('split-drop-zone-vertical')
    fireEvent.drop(verticalDropZone)

    const workspaceEl = screen.getByTestId('pane-workspace')
    expect(workspaceEl).toHaveAttribute('data-split-mode', 'vertical')
    const secondaryPane = screen.getByTestId('pane-secondary')
    expect(within(primaryPane).getAllByRole('tab').map((t) => t.textContent)).toEqual(['a.md'])
    expect(within(secondaryPane).getAllByRole('tab').map((t) => t.textContent)).toEqual(['b.md'])

    // In vertical mode with 1 tab in primary, dragging primary tab shows ONLY horizontal drop zone & switches orientation without collapsing
    fireEvent.dragStart(within(primaryPane).getByRole('tab', { name: /a\.md/i }))
    expect(screen.queryByTestId('split-drop-zone-vertical')).not.toBeInTheDocument()
    const switchHorizontalZone = screen.getByTestId('split-drop-zone-horizontal')
    fireEvent.drop(switchHorizontalZone)

    expect(workspaceEl).toHaveAttribute('data-split-mode', 'horizontal')
    expect(within(primaryPane).getAllByRole('tab').map((t) => t.textContent)).toEqual(['a.md'])
    expect(within(secondaryPane).getAllByRole('tab').map((t) => t.textContent)).toEqual(['b.md'])

    // In horizontal mode, dragging secondary tab shows ONLY vertical drop zone & switches back to vertical
    fireEvent.dragStart(within(secondaryPane).getByRole('tab', { name: /b\.md/i }))
    expect(screen.queryByTestId('split-drop-zone-horizontal')).not.toBeInTheDocument()
    fireEvent.drop(screen.getByTestId('split-drop-zone-vertical'))

    expect(workspaceEl).toHaveAttribute('data-split-mode', 'vertical')
    expect(within(secondaryPane).getByRole('tab', { name: /b\.md/i })).toHaveAttribute(
      'aria-selected',
      'true'
    )

    // With 2 tabs in primary (open c.md in primary), dragging c.md to horizontal drop zone moves c.md to secondary AND switches to horizontal
    await user.click(within(primaryPane).getByRole('tab', { name: /a\.md/i }))
    await user.click(within(sidebar).getByText('c.md'))
    expect(within(primaryPane).getAllByRole('tab').map((t) => t.textContent)).toEqual(['a.md', 'c.md'])

    fireEvent.dragStart(within(primaryPane).getByRole('tab', { name: /c\.md/i }))
    expect(screen.queryByTestId('split-drop-zone-vertical')).not.toBeInTheDocument()
    fireEvent.drop(screen.getByTestId('split-drop-zone-horizontal'))

    expect(workspaceEl).toHaveAttribute('data-split-mode', 'horizontal')
    expect(within(primaryPane).getAllByRole('tab').map((t) => t.textContent)).toEqual(['a.md'])
    expect(within(secondaryPane).getAllByRole('tab').map((t) => t.textContent)).toEqual([
      'b.md',
      'c.md'
    ])
    expect(within(secondaryPane).getByRole('tab', { name: /c\.md/i })).toHaveAttribute(
      'aria-selected',
      'true'
    )

    // Moving all tabs from secondary to primary auto-collapses to single mode while preserving active focus on c.md
    fireEvent.dragStart(within(secondaryPane).getByRole('tab', { name: /b\.md/i }))
    fireEvent.drop(primaryPane)
    expect(workspaceEl).toHaveAttribute('data-split-mode', 'horizontal')

    fireEvent.dragStart(within(secondaryPane).getByRole('tab', { name: /c\.md/i }))
    fireEvent.drop(primaryPane)

    expect(workspaceEl).toHaveAttribute('data-split-mode', 'single')
    expect(screen.queryByTestId('pane-secondary')).not.toBeInTheDocument()
    expect(within(primaryPane).getByRole('tab', { name: /c\.md/i })).toHaveAttribute(
      'aria-selected',
      'true'
    )
    expect(getRawEditorText(screen.getByTestId('document-editor'))).toBe('# C')
  })

  it('keeps at most 2 editor instances mounted when 25+ tabs are open and restores cursor/scroll on tab switch', async () => {
    const user = userEvent.setup()
    const files: Record<string, string> = {}
    for (let i = 1; i <= 25; i += 1) {
      const num = String(i).padStart(2, '0')
      files[`doc-${num}.md`] = `# Document ${num}\nLine 2 content for testing cursor and scroll`
    }

    const { api, emitMenuCommand } = createInMemoryWikiApi(
      {},
      {
        selectedFolder: 'C:\\wiki\\many',
        workspaces: {
          'C:\\wiki\\many': files
        }
      }
    )
    window.wikiApi = api

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    const sidebar = screen.getByLabelText('워크스페이스 탐색기')

    for (let i = 1; i <= 25; i += 1) {
      const num = String(i).padStart(2, '0')
      await user.click(await within(sidebar).findByText(`doc-${num}.md`))
    }

    const primaryPane = screen.getByTestId('pane-primary')
    expect(within(primaryPane).getAllByRole('tab')).toHaveLength(25)
    // In single pane, only 1 editor DOM node is mounted regardless of 25 open tabs
    expect(screen.getAllByTestId('document-editor')).toHaveLength(1)

    // Switch to doc-01.md, set selection range and scrollTop, then switch to doc-02.md and back
    await user.click(within(primaryPane).getByRole('tab', { name: 'doc-01.md' }))
    const editor01 = within(primaryPane).getByTestId('document-editor')
    setRawEditorSelection(editor01, 4, 11)
    const scroller01 = getRawEditorScroller(editor01)
    scroller01.scrollTop = 180
    fireEvent.scroll(scroller01)

    await user.click(within(primaryPane).getByRole('tab', { name: 'doc-02.md' }))
    expect(screen.getAllByTestId('document-editor')).toHaveLength(1)
    expect(getRawEditorText(within(primaryPane).getByTestId('document-editor'))).toContain(
      '# Document 02'
    )

    // Switch back to doc-01.md -> restored cursor & scrollTop
    await user.click(within(primaryPane).getByRole('tab', { name: 'doc-01.md' }))
    const restored01 = within(primaryPane).getByTestId('document-editor')
    expect(getRawEditorSelection(restored01)).toEqual({ start: 4, end: 11 })
    expect(getRawEditorScroller(restored01).scrollTop).toBe(180)

    // Move doc-25.md to secondary pane -> still at most 2 editor DOM instances across 25 tabs
    fireEvent.contextMenu(within(primaryPane).getByRole('tab', { name: 'doc-25.md' }))
    const menu = await screen.findByRole('menu', { name: '탭 작업 메뉴' })
    await user.click(within(menu).getByRole('menuitem', { name: '분할 영역으로 이동' }))

    expect(screen.getAllByTestId('document-editor')).toHaveLength(2)
  }, 30_000)

  it('syncs file renames and deletions across split panes and keeps config.json tab open across workspace switches', async () => {
    const user = userEvent.setup()
    const nextFav = addFavoriteWorkspace([], 'C:/wiki/ws2', 'ws2', '2026-11-14T00:00:00.000Z')
    const { api, emitMenuCommand } = createInMemoryWikiApi(
      { favoriteWorkspaces: nextFav },
      {
        selectedFolder: 'C:\\wiki\\ws1',
        workspaces: {
          'C:\\wiki\\ws1': {
            'target.md': '# Target',
            'keep.md': '# Keep'
          },
          'C:\\wiki\\ws2': {
            'ws2.md': '# WS2'
          }
        }
      }
    )
    window.wikiApi = api

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    const sidebar = screen.getByLabelText('워크스페이스 탐색기')

    await user.click(await within(sidebar).findByText('target.md'))
    await user.click(within(sidebar).getByText('keep.md'))

    // Open config.json as its own tab too
    await triggerMenuCommand(emitMenuCommand, 'toggle-settings')
    await user.click(screen.getByRole('button', { name: /설정 파일 직접 열기/i }))

    const primaryPane = screen.getByTestId('pane-primary')
    expect(within(primaryPane).getByRole('tab', { name: /config\.json/i })).toBeInTheDocument()

    // Duplicate target.md to secondary pane
    fireEvent.contextMenu(within(primaryPane).getByRole('tab', { name: /target\.md/i }))
    await user.click(
      within(await screen.findByRole('menu', { name: '탭 작업 메뉴' })).getByRole('menuitem', {
        name: '분할 영역에 복제 열기'
      })
    )
    const secondaryPane = screen.getByTestId('pane-secondary')

    // Rename target.md -> updated.md updates tabs in BOTH panes
    const targetItem = within(sidebar).getByRole('treeitem', { name: 'target.md' })
    targetItem.focus()
    fireEvent.keyDown(targetItem, { key: 'F2' })
    const renameInput = await within(sidebar).findByLabelText('새 이름 입력')
    await user.clear(renameInput)
    await user.type(renameInput, 'updated.md{Enter}')

    expect(await within(primaryPane).findByRole('tab', { name: /updated\.md/i })).toBeInTheDocument()
    expect(within(secondaryPane).getByRole('tab', { name: /updated\.md/i })).toBeInTheDocument()

    // Delete updated.md removes tab in both panes and auto-collapses secondary
    fireEvent.contextMenu(within(sidebar).getByText('updated.md'))
    await user.click(
      within(await screen.findByRole('menu')).getByRole('menuitem', { name: /삭제/i })
    )
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: /삭제 확인/i })
    )

    await waitFor(() => {
      expect(within(primaryPane).queryByRole('tab', { name: /updated\.md/i })).not.toBeInTheDocument()
      expect(screen.queryByTestId('pane-secondary')).not.toBeInTheDocument()
    })

    // Switching workspace closes workspace tabs (keep.md) while preserving config.json tab
    await clickActivityBarButton(user, '워크스페이스')
    const workspaceView = screen.getByRole('region', { name: '워크스페이스 뷰' })
    await user.click(within(workspaceView).getByRole('button', { name: /★\s*ws2/i }))

    const updatedSidebar = await screen.findByLabelText('워크스페이스 탐색기')
    expect(await within(updatedSidebar).findByText('ws2.md')).toBeInTheDocument()
    expect(within(primaryPane).queryByRole('tab', { name: /keep\.md/i })).not.toBeInTheDocument()
    expect(within(primaryPane).getByRole('tab', { name: /config\.json/i })).toBeInTheDocument()
  })

  it('preserves unfocused split pane cursor selection when the other pane edits and scrolls', async () => {
    const user = userEvent.setup()
    const { api, emitMenuCommand } = createInMemoryWikiApi(
      { autoSave: false },
      {
        selectedFolder: 'C:\\wiki\\ws1',
        workspaces: {
          'C:\\wiki\\ws1': {
            'doc.md': 'Hello World!'
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
    const primaryEditor = within(primaryPane).getByTestId('document-editor')
    const secondaryEditor = within(secondaryPane).getByTestId('document-editor')

    secondaryEditor.focus()
    setRawEditorSelection(secondaryEditor, 2, 5)

    primaryEditor.focus()
    const secondaryScroller = getRawEditorScroller(secondaryEditor)
    secondaryScroller.scrollTop = 90
    fireEvent.scroll(secondaryScroller)

    setRawEditorText(primaryEditor, 'Hello World! Edited')

    expect(getRawEditorText(secondaryEditor)).toBe('Hello World! Edited')
    expect(getRawEditorSelection(secondaryEditor)).toEqual({ start: 2, end: 5 })
    expect(getRawEditorScroller(secondaryEditor).scrollTop).toBe(90)
  })

  it('stops auto-save retries after a write failure until the next edit', async () => {
    const user = userEvent.setup()
    const { api, emitMenuCommand } = createInMemoryWikiApi(
      { autoSave: true, autoSaveDelayMs: 40 },
      {
        selectedFolder: 'C:\\wiki\\ws1',
        workspaces: {
          'C:\\wiki\\ws1': {
            'fail.md': '# Start'
          }
        }
      }
    )
    const writeSpy = vi
      .spyOn(api.workspace, 'writeFile')
      .mockRejectedValueOnce(new Error('Disk full'))
    window.wikiApi = api

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    await user.click(await screen.findByText('fail.md'))

    const editor = screen.getByTestId('document-editor')
    setRawEditorText(editor, '# First failed edit')

    expect(await screen.findByRole('alert')).toHaveTextContent('Disk full')
    expect(writeSpy).toHaveBeenCalledTimes(1)

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 120))
    })
    expect(writeSpy).toHaveBeenCalledTimes(1)

    setRawEditorText(editor, '# Recovered edit')
    await waitFor(() => {
      expect(writeSpy).toHaveBeenCalledTimes(2)
      expect(screen.queryByTestId('dirty-indicator')).not.toBeInTheDocument()
    })
  })

  it('ignores Ctrl+S shortcuts while a ConfirmDialog is open', async () => {
    const user = userEvent.setup()
    const { api, emitMenuCommand } = createInMemoryWikiApi(
      { autoSave: false },
      {
        selectedFolder: 'C:\\wiki\\ws1',
        workspaces: {
          'C:\\wiki\\ws1': {
            'dirty.md': 'initial'
          }
        }
      }
    )
    const writeSpy = vi.spyOn(api.workspace, 'writeFile')
    window.wikiApi = api

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    await user.click(await screen.findByText('dirty.md'))

    const editor = screen.getByTestId('document-editor')
    setRawEditorText(editor, 'unsaved changes')

    await user.click(screen.getByRole('button', { name: 'dirty.md 탭 닫기' }))
    const dialog = await screen.findByRole('alertdialog')

    fireEvent.keyDown(editor, { key: 's', ctrlKey: true })
    fireEvent.keyDown(dialog, { key: 's', ctrlKey: true })
    fireEvent.keyDown(window, { key: 's', ctrlKey: true })

    expect(writeSpy).not.toHaveBeenCalled()
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
  })

  it('clears saving state cleanly when renaming a file while a save is in flight', async () => {
    const user = userEvent.setup()
    const { api, emitMenuCommand } = createInMemoryWikiApi(
      { autoSave: false },
      {
        selectedFolder: 'C:\\wiki\\ws1',
        workspaces: {
          'C:\\wiki\\ws1': {
            'slow.md': '# Slow'
          }
        }
      }
    )
    let resolveWrite!: () => void
    vi.spyOn(api.workspace, 'writeFile').mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveWrite = resolve
      })
    )
    window.wikiApi = api

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    const sidebar = screen.getByLabelText('워크스페이스 탐색기')
    await user.click(await within(sidebar).findByText('slow.md'))

    setRawEditorText(screen.getByTestId('document-editor'), '# Slow edited')
    await user.click(screen.getByRole('button', { name: '저장' }))
    expect(screen.getByText('저장 중...')).toBeInTheDocument()

    const slowItem = within(sidebar).getByRole('treeitem', { name: 'slow.md' })
    slowItem.focus()
    fireEvent.keyDown(slowItem, { key: 'F2' })
    const renameInput = await within(sidebar).findByLabelText('새 이름 입력')
    await user.clear(renameInput)
    await user.type(renameInput, 'fast.md{Enter}')

    expect(await screen.findByRole('tab', { name: /fast\.md/i })).toBeInTheDocument()

    await act(async () => {
      resolveWrite()
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(screen.getByText('저장됨')).toBeInTheDocument()
      expect(screen.queryByTestId('dirty-indicator')).not.toBeInTheDocument()
    })
  })

  it('preserves active secondary tab focus when collapsing split view to single mode', async () => {
    const user = userEvent.setup()
    const { api, emitMenuCommand } = createInMemoryWikiApi(
      { autoSave: false },
      {
        selectedFolder: 'C:\\wiki\\ws1',
        workspaces: {
          'C:\\wiki\\ws1': {
            'a.md': '# A',
            'b.md': '# B'
          }
        }
      }
    )
    window.wikiApi = api

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    await user.click(await screen.findByText('a.md'))
    await user.click(screen.getByText('b.md'))

    const primaryPane = screen.getByTestId('pane-primary')
    fireEvent.contextMenu(within(primaryPane).getByRole('tab', { name: /b\.md/i }))
    await user.click(
      within(await screen.findByRole('menu', { name: '탭 작업 메뉴' })).getByRole('menuitem', {
        name: '분할 영역으로 이동'
      })
    )

    const secondaryPane = screen.getByTestId('pane-secondary')
    expect(within(secondaryPane).getByRole('tab', { name: /b\.md/i })).toHaveAttribute(
      'aria-selected',
      'true'
    )

    // Closing the sole primary tab promotes secondary into primary and preserves focus on b.md
    await user.click(within(primaryPane).getByRole('button', { name: 'a.md 탭 닫기' }))

    expect(screen.queryByTestId('pane-secondary')).not.toBeInTheDocument()
    expect(within(primaryPane).getByRole('tab', { name: /b\.md/i })).toHaveAttribute(
      'aria-selected',
      'true'
    )
    expect(getRawEditorText(screen.getByTestId('document-editor'))).toBe('# B')
  })
})

describe('Read-only image preview tabs', () => {
  it('opens supported image files from the folder tree as read-only preview tabs without UTF-8 reads or writes', async () => {
    const { api, emitMenuCommand } = createInMemoryWikiApi(
      { autoSave: true, autoSaveDelayMs: 40 },
      {
        selectedFolder: 'C:/wiki/img-preview',
        workspaces: {
          'C:/wiki/img-preview': {
            'docs/guide.md': '# Guide\n\nBody',
            'assets/diagram.png': '<binary-png>',
            'assets/photo.jpg': '<binary-jpg>',
            'assets/frame.jpeg': '<binary-jpeg>',
            'assets/anim.gif': '<binary-gif>',
            'assets/hero.webp': '<binary-webp>',
            'assets/vector.svg': '<svg></svg>',
            'assets/icon.bmp': '<binary-bmp>',
            'assets/modern.AVIF': '<binary-avif>'
          }
        }
      }
    )
    const readFileSpy = vi.spyOn(api.workspace, 'readFile')
    const writeFileSpy = vi.spyOn(api.workspace, 'writeFile')
    window.wikiApi = api

    const { rootEl, cleanup } = mountThemeStylesAndRoot()
    try {
      const user = userEvent.setup()
      render(<App />, { container: rootEl })
      await triggerMenuCommand(emitMenuCommand, 'open-folder')

      const explorer = screen.getByLabelText('워크스페이스 탐색기')
      const docsTreeItem = await within(explorer).findByRole('treeitem', { name: 'docs' })
      await user.click(within(docsTreeItem).getByText('docs'))
      await user.click(await within(explorer).findByText('guide.md'))
      expect(readFileSpy).toHaveBeenCalledTimes(1)
      expect(readFileSpy).toHaveBeenCalledWith('C:/wiki/img-preview/docs/guide.md')

      // Expand assets and click diagram.png -> opens read-only image preview WITHOUT readFile
      const assetsTreeItem = await within(explorer).findByRole('treeitem', { name: 'assets' })
      await user.click(within(assetsTreeItem).getByText('assets'))
      await user.click(await within(explorer).findByText('diagram.png'))

      const previewContainer = await screen.findByTestId('image-preview')
      const img = within(previewContainer).getByRole('img', { name: 'diagram.png' })
      expect(img).toHaveAttribute('src', buildWikiAssetUrl('C:/wiki/img-preview/assets/diagram.png'))
      expect(readFileSpy).toHaveBeenCalledTimes(1)

      // Centered & responsive layout CSS applied via themeCss
      const containerStyle = getComputedStyle(previewContainer)
      const imgStyle = getComputedStyle(img)
      expect(containerStyle.display).toBe('flex')
      expect(containerStyle.alignItems).toBe('center')
      expect(containerStyle.justifyContent).toBe('center')
      expect(imgStyle.maxWidth).toBe('100%')
      expect(imgStyle.maxHeight).toBe('100%')

      // Header displays read-only status and disables modes & Save
      expect(screen.getByText('읽기 전용')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: '저장' })).toBeDisabled()
      for (const label of ['Raw', '위지윅', 'Preview', 'Split']) {
        expect(screen.getByRole('button', { name: label })).toBeDisabled()
      }
      expect(screen.queryByTestId('document-editor')).not.toBeInTheDocument()

      // Document Outline treats active image tab as non-markdown
      const rightSidebar = screen.getByRole('complementary', { name: '우측 사이드바' })
      expect(within(rightSidebar).getByText('마크다운 문서에서만 목차를 지원합니다.')).toBeInTheDocument()

      // Global shortcuts (Ctrl+S, Ctrl+1..4, Ctrl+Shift+M) and auto-save timer never write binary image files
      fireEvent.keyDown(window, { key: 's', ctrlKey: true })
      fireEvent.keyDown(window, { key: '2', ctrlKey: true })
      fireEvent.keyDown(window, { key: '4', ctrlKey: true })
      fireEvent.keyDown(window, { key: 'M', ctrlKey: true, shiftKey: true })
      await new Promise((resolve) => setTimeout(resolve, 90))
      expect(writeFileSpy).not.toHaveBeenCalled()
      expect(screen.queryByTestId('dirty-indicator')).not.toBeInTheDocument()

      // Context menu "열기" on case-insensitive .AVIF opens image preview without readFile
      fireEvent.contextMenu(await within(explorer).findByText('modern.AVIF'))
      const menu = await screen.findByRole('menu')
      await user.click(within(menu).getByRole('menuitem', { name: '열기' }))
      const avifImg = within(await screen.findByTestId('image-preview')).getByRole('img', {
        name: 'modern.AVIF'
      })
      expect(avifImg).toHaveAttribute('src', buildWikiAssetUrl('C:/wiki/img-preview/assets/modern.AVIF'))

      // All remaining supported extensions open via click without readFile
      for (const filename of ['photo.jpg', 'frame.jpeg', 'anim.gif', 'hero.webp', 'vector.svg', 'icon.bmp']) {
        await user.click(await within(explorer).findByText(filename))
        const extImg = within(await screen.findByTestId('image-preview')).getByRole('img', { name: filename })
        expect(extImg).toHaveAttribute(
          'src',
          buildWikiAssetUrl(`C:/wiki/img-preview/assets/${filename}`)
        )
      }
      expect(readFileSpy).toHaveBeenCalledTimes(1)

      // Closing image tab skips unsaved-changes confirmation dialog
      await user.click(screen.getByRole('button', { name: 'diagram.png 탭 닫기' }))
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
      expect(screen.queryByRole('tab', { name: /diagram\.png/i })).not.toBeInTheDocument()
    } finally {
      cleanup()
    }
  })

  it('supports tab switching, moving, duplicating across panes, and horizontal/vertical split modes alongside markdown tabs', async () => {
    const { api, emitMenuCommand, getFilesSnapshot } = createInMemoryWikiApi(
      { autoSave: false },
      {
        selectedFolder: 'C:/wiki/split-img',
        workspaces: {
          'C:/wiki/split-img': {
            'docs/spec.md': '# Spec\n\nDetails',
            'assets/mockup.png': '<binary-png>'
          }
        }
      }
    )
    window.wikiApi = api

    const user = userEvent.setup()
    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')

    const explorer = screen.getByLabelText('워크스페이스 탐색기')
    await user.click(within(await within(explorer).findByRole('treeitem', { name: 'docs' })).getByText('docs'))
    await user.click(await within(explorer).findByText('spec.md'))
    await user.click(within(await within(explorer).findByRole('treeitem', { name: 'assets' })).getByText('assets'))
    await user.click(await within(explorer).findByText('mockup.png'))

    const workspaceEl = screen.getByTestId('pane-workspace')
    const primaryPane = screen.getByTestId('pane-primary')
    expect(workspaceEl).toHaveAttribute('data-split-mode', 'single')
    expect(within(primaryPane).getByTestId('image-preview')).toBeInTheDocument()

    // Tab switching between markdown and image tabs
    await user.click(within(primaryPane).getByRole('tab', { name: /spec\.md/i }))
    expect(within(primaryPane).getByTestId('document-editor')).toBeInTheDocument()
    expect(within(primaryPane).queryByTestId('image-preview')).not.toBeInTheDocument()

    await user.click(within(primaryPane).getByRole('tab', { name: /mockup\.png/i }))
    expect(within(primaryPane).getByTestId('image-preview')).toBeInTheDocument()

    // Move image tab into horizontal Split Mode next to markdown tab
    fireEvent.contextMenu(within(primaryPane).getByRole('tab', { name: /mockup\.png/i }))
    const tabMenu = await screen.findByRole('menu', { name: '탭 작업 메뉴' })
    await user.click(within(tabMenu).getByRole('menuitem', { name: '분할 영역으로 이동' }))

    expect(workspaceEl).toHaveAttribute('data-split-mode', 'horizontal')
    const secondaryPane = screen.getByTestId('pane-secondary')
    expect(within(primaryPane).getByTestId('document-editor')).toBeInTheDocument()
    expect(within(secondaryPane).getByTestId('image-preview')).toBeInTheDocument()
    expect(within(secondaryPane).getByText('읽기 전용')).toBeInTheDocument()
    expect(within(secondaryPane).getByRole('button', { name: '저장' })).toBeDisabled()

    // Edit & save markdown in primary while image remains open & read-only in secondary
    const primaryEditor = within(primaryPane).getByTestId('document-editor')
    appendRawEditorText(primaryEditor, '\nUpdated')
    fireEvent.keyDown(primaryEditor, { key: 's', ctrlKey: true })
    await waitFor(() => {
      expect(getFilesSnapshot().get('C:/wiki/split-img/docs/spec.md')).toContain('Updated')
    })

    // Switch split orientation to vertical via split drop zone
    fireEvent.dragStart(within(secondaryPane).getByRole('tab', { name: /mockup\.png/i }))
    fireEvent.drop(await screen.findByTestId('split-drop-zone-vertical'))
    expect(workspaceEl).toHaveAttribute('data-split-mode', 'vertical')
    expect(within(secondaryPane).getByTestId('image-preview')).toBeInTheDocument()

    // Duplicate image tab into primary pane so both panes display the image preview simultaneously
    fireEvent.contextMenu(within(secondaryPane).getByRole('tab', { name: /mockup\.png/i }))
    const dupMenu = await screen.findByRole('menu', { name: '탭 작업 메뉴' })
    await user.click(within(dupMenu).getByRole('menuitem', { name: '분할 영역에 복제 열기' }))

    expect(within(primaryPane).getByTestId('image-preview')).toBeInTheDocument()
    expect(within(secondaryPane).getByTestId('image-preview')).toBeInTheDocument()

    // Closing secondary image tab auto-collapses split back to single while keeping primary image open
    await user.click(within(secondaryPane).getByRole('button', { name: 'mockup.png 탭 닫기' }))
    expect(workspaceEl).toHaveAttribute('data-split-mode', 'single')
    expect(within(primaryPane).getByTestId('image-preview')).toBeInTheDocument()
  })

  it('synchronizes open image tabs across file/folder renames, deletions, external watch events, and git mutations', async () => {
    const repoRoot = 'C:/wiki/sync-img'
    const baseGitStatus = {
      ...createEmptyGitStatus(true, repoRoot),
      branch: 'main'
    }
    const { api, emitMenuCommand, emitWorkspaceChange } = createInMemoryWikiApi(
      { autoSave: false },
      {
        selectedFolder: repoRoot,
        workspaces: {
          [repoRoot]: {
            'docs/other.md': '# Other',
            'assets/logo.png': '<png-v1>',
            'assets/delete-me.png': '<png-del>',
            'media/pic2.png': '<png-media>'
          }
        },
        git: {
          status: vi.fn(async () => baseGitStatus),
          pull: vi.fn(async () => baseGitStatus)
        }
      }
    )
    const readFileSpy = vi.spyOn(api.workspace, 'readFile')
    window.wikiApi = api

    const user = userEvent.setup()
    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')

    const explorer = screen.getByLabelText('워크스페이스 탐색기')
    const assetsTreeItem = await within(explorer).findByRole('treeitem', { name: 'assets' })
    await user.click(within(assetsTreeItem).getByText('assets'))
    const mediaTreeItem = await within(explorer).findByRole('treeitem', { name: 'media' })
    await user.click(within(mediaTreeItem).getByText('media'))

    await user.click(await within(explorer).findByText('pic2.png'))
    await user.click(await within(explorer).findByText('delete-me.png'))
    await user.click(await within(explorer).findByText('logo.png'))

    expect(
      within(screen.getByTestId('image-preview')).getByRole('img', { name: 'logo.png' })
    ).toHaveAttribute('src', buildWikiAssetUrl(`${repoRoot}/assets/logo.png`))

    // 1. Renaming open image file updates tab title, header meta, and wiki-asset URL immediately
    const logoItem = within(explorer).getByRole('treeitem', { name: 'logo.png' })
    logoItem.focus()
    fireEvent.keyDown(logoItem, { key: 'F2' })
    const fileRenameInput = await within(explorer).findByLabelText('새 이름 입력')
    await user.clear(fileRenameInput)
    await user.type(fileRenameInput, 'brand.png{Enter}')

    await waitFor(() => {
      expect(screen.getByRole('tab', { name: /brand\.png/i })).toHaveAttribute('aria-selected', 'true')
      expect(screen.getByText('brand.png', { selector: '.editor-doc-title' })).toBeInTheDocument()
      expect(screen.getByText(`${repoRoot}/assets/brand.png`)).toBeInTheDocument()
      expect(
        within(screen.getByTestId('image-preview')).getByRole('img', { name: 'brand.png' })
      ).toHaveAttribute('src', buildWikiAssetUrl(`${repoRoot}/assets/brand.png`))
    })

    // 2. Renaming parent folder updates path & wiki-asset URL of open image tab
    const renamedAssetsItem = within(explorer).getByRole('treeitem', { name: 'assets' })
    renamedAssetsItem.focus()
    fireEvent.keyDown(renamedAssetsItem, { key: 'F2' })
    const folderRenameInput = await within(explorer).findByLabelText('새 이름 입력')
    await user.clear(folderRenameInput)
    await user.type(folderRenameInput, 'images{Enter}')

    await waitFor(() => {
      expect(screen.getByText(`${repoRoot}/images/brand.png`)).toBeInTheDocument()
      expect(
        within(screen.getByTestId('image-preview')).getByRole('img', { name: 'brand.png' })
      ).toHaveAttribute('src', buildWikiAssetUrl(`${repoRoot}/images/brand.png`))
    })

    // 3. Deleting an image file via FolderTree closes its tab cleanly
    fireEvent.contextMenu(await within(explorer).findByText('delete-me.png'))
    const deleteMenu = await screen.findByRole('menu')
    await user.click(within(deleteMenu).getByRole('menuitem', { name: /삭제/i }))
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: /삭제 확인/i }))

    await waitFor(() => {
      expect(screen.queryByRole('tab', { name: /delete-me\.png/i })).not.toBeInTheDocument()
    })

    // Switch back to brand.png
    await user.click(screen.getByRole('tab', { name: /brand\.png/i }))

    // 4. Unrelated workspace change event leaves existing image URL cache stable
    act(() => {
      emitWorkspaceChange({
        rootPath: repoRoot,
        eventType: 'change',
        relativePath: 'docs/other.md'
      })
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(
      within(screen.getByTestId('image-preview')).getByRole('img', { name: 'brand.png' })
    ).toHaveAttribute('src', buildWikiAssetUrl(`${repoRoot}/images/brand.png`))

    // 5. External modification of the open image (direct path & coalesced null) busts preview URL cache without readFile
    act(() => {
      emitWorkspaceChange({
        rootPath: repoRoot,
        eventType: 'change',
        relativePath: 'images/brand.png'
      })
    })
    await waitFor(() => {
      expect(
        within(screen.getByTestId('image-preview')).getByRole('img', { name: 'brand.png' })
      ).toHaveAttribute('src', buildWikiAssetUrl(`${repoRoot}/images/brand.png`, 2))
    })

    act(() => {
      emitWorkspaceChange({
        rootPath: repoRoot,
        eventType: 'change',
        relativePath: null
      })
    })
    await waitFor(() => {
      expect(
        within(screen.getByTestId('image-preview')).getByRole('img', { name: 'brand.png' })
      ).toHaveAttribute('src', buildWikiAssetUrl(`${repoRoot}/images/brand.png`, 3))
    })

    // 6. Git workspace mutation refreshes open image cache without readFile
    await clickActivityBarButton(user, 'Git')
    const gitRegion = screen.getByRole('region', { name: 'Git 소스 제어' })
    await user.click(within(gitRegion).getByRole('button', { name: '더 보기' }))
    await user.click(within(gitRegion).getByRole('menuitem', { name: 'Pull' }))
    await waitFor(() => {
      expect(
        within(screen.getByTestId('image-preview')).getByRole('img', { name: 'brand.png' })
      ).toHaveAttribute('src', buildWikiAssetUrl(`${repoRoot}/images/brand.png`, 4))
    })

    // 7. External parent folder deletion & external image deletion auto-close affected image tabs cleanly without alerts or readFile
    await api.workspace.deleteEntry(`${repoRoot}/media`)
    act(() => {
      emitWorkspaceChange({
        rootPath: repoRoot,
        eventType: 'rename',
        relativePath: 'media'
      })
    })
    await waitFor(() => {
      expect(screen.queryByRole('tab', { name: /pic2\.png/i })).not.toBeInTheDocument()
    })

    await api.workspace.deleteEntry(`${repoRoot}/images/brand.png`)
    act(() => {
      emitWorkspaceChange({
        rootPath: repoRoot,
        eventType: 'rename',
        relativePath: 'images/brand.png'
      })
    })
    await waitFor(() => {
      expect(screen.queryByRole('tab', { name: /brand\.png/i })).not.toBeInTheDocument()
    })

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(readFileSpy).not.toHaveBeenCalled()
  })
})
