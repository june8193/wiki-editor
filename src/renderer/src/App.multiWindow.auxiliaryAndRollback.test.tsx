import { act, fireEvent, render, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { createEmptyGitStatus, type GitDiffRequest, type GitStatus } from '@shared/git'
import type { WikiGitApi } from '@shared/ipc'
import type { ActiveTabDragSession } from '@shared/window'
import type { WorkspaceChangeEvent } from '@shared/workspace'
import { App } from './App'
import {
  getRawEditorScroller,
  getRawEditorSelection,
  getRawEditorText,
  type InMemoryWindowHandle,
  setRawEditorSelection,
  setRawEditorText,
  triggerMenuCommand
} from './test/inMemoryWikiHarness'
import {
  createCrossWindowDataTransfer,
  detachTabViaContextMenu,
  dispatchDragEndAtScreenPoint,
  openConfigFromSettings,
  openFolderAndNoteInWindow,
  registerMultiWindowLifecycle
} from './test/multiWindowTestHelpers'

vi.mock('mermaid', async () => (await import('./test/appTestHelpers')).createMermaidMockState().module)

const { createHarness, trackDisposer } = registerMultiWindowLifecycle()

function createRepoGitStatus(repoRoot: string, partial: Partial<GitStatus> = {}): GitStatus {
  return {
    ...createEmptyGitStatus(true, repoRoot),
    branch: 'main',
    ...partial
  }
}

function createRollbackHistoryGitMocks(): Pick<WikiGitApi, 'log' | 'commitDetail' | 'diff'> {
  return {
    log: async () => ({
      commits: [
        {
          hash: 'abcdef1234567890',
          shortHash: 'abcdef1',
          parents: [],
          refs: [],
          subject: 'Initial commit',
          authorName: 'Tester',
          committedAt: '2026-11-16T00:00:00Z'
        }
      ],
      hasMore: false
    }),
    commitDetail: async () => ({
      hash: 'abcdef1234567890',
      shortHash: 'abcdef1',
      parents: [],
      subject: 'Initial commit',
      body: '',
      authorName: 'Tester',
      authorEmail: 'test@example.com',
      committedAt: '2026-11-16T00:00:00Z',
      files: [{ path: 'wiki/notes.md', status: 'M' }]
    }),
    diff: async (_wsPath: string, request: GitDiffRequest) => ({
      path: request.path,
      status: request.status,
      isBinary: false,
      isTruncated: false,
      existsInWorkspace: true,
      rawPatch: `diff --git a/${request.path} b/${request.path}\n@@ -1 +1 @@\n-old\n+new`
    })
  }
}

describe('Auxiliary window shell, tab detach/merge, and close guards (<App />)', () => {
  it('renders stripped auxiliary editing shell, collapsed right sidebar, dynamic title, and preserves main watch ownership', async () => {
    const user = userEvent.setup()
    const harness = createHarness(
      { autoSave: false, theme: 'light', recentWorkspaces: ['C:\\wiki\\docs'] },
      {
        selectedFolder: 'C:\\wiki\\docs',
        workspaces: {
          'C:\\wiki\\docs': {
            'intro.md': '# Intro'
          }
        }
      }
    )

    const mainWin = harness.createWindow({ role: 'main' })
    const mainRendered = render(<App wikiApi={mainWin.api} />)
    await openFolderAndNoteInWindow(user, mainRendered.container, mainWin.emitMenuCommand, 'intro.md')

    await waitFor(() => {
      expect(harness.getWatchState().active).toBe(true)
    })

    const auxWin = harness.createWindow({ role: 'auxiliary', initialTabs: [] })
    const auxRendered = render(<App wikiApi={auxWin.api} />)

    await waitFor(() => {
      expect(document.title).toBe('Wiki Editor')
    })

    // Auxiliary shell omits Activity Bar, Left Sidebar, and Settings panel, and collapses Right Sidebar
    expect(within(auxRendered.container).queryByLabelText('액티비티 바')).toBeNull()
    expect(within(auxRendered.container).queryByLabelText('왼쪽 사이드바')).toBeNull()
    expect(within(auxRendered.container).queryByLabelText('우측 사이드바')).toBeNull()
    expect(within(auxRendered.container).getByTestId('pane-workspace')).toBeInTheDocument()

    // Right sidebar expands from collapsed button and resizes within 180-500px
    const expandBtn = within(auxRendered.container).getByRole('button', { name: '문서 목차 펼치기' })
    await user.click(expandBtn)
    const rightSidebar = within(auxRendered.container).getByLabelText('우측 사이드바')
    expect(rightSidebar).toBeInTheDocument()
    const rightResizer = within(auxRendered.container).getByRole('separator', {
      name: '우측 사이드바 너비 조절'
    })
    fireEvent.mouseDown(rightResizer, { clientX: 600 })
    fireEvent.mouseMove(window, { clientX: 520 })
    fireEvent.mouseUp(window)
    expect(Number.parseInt(rightSidebar.style.width, 10)).toBeGreaterThanOrEqual(180)
    expect(Number.parseInt(rightSidebar.style.width, 10)).toBeLessThanOrEqual(500)

    // Unmounting auxiliary never touches main workspace watch ownership
    auxRendered.unmount()
    expect(harness.getWatchState().active).toBe(true)
    expect(harness.getWatchState().auxWatchCalls).toBe(0)
    expect(harness.getWatchState().auxUnwatchCalls).toBe(0)
  })

  it('detaches dirty 1-tab document from main via context menu keeping mode, cursor, scrollTop, editor/outline parity, and Ctrl+S save', async () => {
    const user = userEvent.setup()
    const harness = createHarness(
      { autoSave: false, theme: 'light' },
      {
        selectedFolder: 'C:\\wiki\\docs',
        workspaces: {
          'C:\\wiki\\docs': {
            'guide.md': '# Heading One\n\nBody paragraph\n\n## Heading Two\n\nMore text'
          }
        }
      }
    )

    const mainWin = harness.createWindow({ role: 'main' })
    const mainRendered = render(<App wikiApi={mainWin.api} />)
    const editor = await openFolderAndNoteInWindow(
      user,
      mainRendered.container,
      mainWin.emitMenuCommand,
      'guide.md'
    )

    // Make unsaved edit and set cursor + scrollTop on active raw editor
    setRawEditorText(editor, '# Heading One\n\nEdited unsaved body\n\n## Heading Two\n\nMore text')
    await waitFor(() => {
      expect(within(mainRendered.container).getByTestId('dirty-indicator')).toBeInTheDocument()
    })
    setRawEditorSelection(editor, 5, 10)
    const scrollDom = getRawEditorScroller(editor)
    scrollDom.scrollTop = 145
    fireEvent.scroll(scrollDom)

    // Right-click tab bar item on 1-tab main window -> '새 창으로 이동' is between duplicate & close and enabled
    const tabButton = within(mainRendered.container).getByRole('tab', { name: /guide\.md/ })
    fireEvent.contextMenu(tabButton)
    const menu = await within(mainRendered.container).findByRole('menu', { name: '탭 작업 메뉴' })
    const items = within(menu).getAllByRole('menuitem')
    expect(items.map((el) => el.textContent?.trim())).toEqual([
      '분할 영역으로 이동',
      '분할 영역에 복제 열기',
      '새 창으로 이동',
      '닫기'
    ])
    const detachMenuItem = within(menu).getByRole('menuitem', { name: '새 창으로 이동' })
    expect(detachMenuItem).not.toBeDisabled()

    await user.click(detachMenuItem)

    // Main window now shows empty workspace without prompting confirm dialog, while shared dirty buffer lives on
    await waitFor(() => {
      expect(within(mainRendered.container).queryByRole('tab', { name: /guide\.md/ })).toBeNull()
      expect(harness.getAuxiliaryWindows()).toHaveLength(1)
    })
    expect(within(mainRendered.container).queryByRole('alertdialog')).toBeNull()
    expect(harness.hub.getSnapshot().buffers['c:/wiki/docs/guide.md']?.isDirty).toBe(true)

    // Mount detached auxiliary window -> receives title, dirty edit, cursor, scrollTop, editor/outline parity & save
    const auxWin = harness.getAuxiliaryWindows()[0]
    const auxRendered = render(<App wikiApi={auxWin.api} />)

    const auxEditor = await within(auxRendered.container).findByTestId('document-editor')
    await waitFor(() => {
      expect(document.title).toBe('guide.md - Wiki Editor')
      expect(within(auxRendered.container).getByTestId('dirty-indicator')).toBeInTheDocument()
      expect(getRawEditorText(auxEditor)).toContain('Edited unsaved body')
    })

    expect(getRawEditorSelection(auxEditor)).toEqual({ start: 5, end: 10 })
    expect(getRawEditorScroller(auxEditor).scrollTop).toBe(145)

    // Expand Right Sidebar outline & verify headings + outline scroll + mode switching work inside auxiliary
    await user.click(within(auxRendered.container).getByRole('button', { name: '문서 목차 펼치기' }))
    const outlinePanel = within(auxRendered.container).getByLabelText('문서 목차 (Outline)')
    expect(within(outlinePanel).getByText(/Heading One/)).toBeInTheDocument()
    const headingTwoBtn = within(outlinePanel).getByText(/Heading Two/)
    expect(headingTwoBtn).toBeInTheDocument()
    await user.click(headingTwoBtn)
    await user.click(within(outlinePanel).getByRole('button', { name: '목차 번호 표시' }))
    await user.click(within(outlinePanel).getByRole('button', { name: '목차 번호 표시' }))

    // Toggle preview and back to raw in auxiliary
    await user.click(within(auxRendered.container).getByRole('button', { name: 'Preview' }))
    expect(within(auxRendered.container).getByRole('heading', { name: /Heading One/ })).toBeInTheDocument()
    await user.click(within(auxRendered.container).getByRole('button', { name: 'Raw' }))
    const auxRawAgain = await within(auxRendered.container).findByTestId('document-editor')

    // Save via Ctrl+S inside auxiliary -> persists edited content to disk and clears dirty indicator
    fireEvent.keyDown(auxRawAgain, { key: 's', ctrlKey: true })
    await waitFor(() => {
      expect(within(auxRendered.container).queryByTestId('dirty-indicator')).toBeNull()
    })
    expect(harness.getFilesSnapshot().get('C:/wiki/docs/guide.md')).toContain('Edited unsaved body')

    // Insert table via Raw toolbar inside auxiliary
    const rawEnd = getRawEditorText(auxRawAgain).length
    setRawEditorSelection(auxRawAgain, rawEnd, rawEnd)
    const rawToolbar = within(auxRendered.container).getByRole('toolbar', {
      name: 'Raw 표 편집 툴바'
    })
    await user.click(within(rawToolbar).getByRole('button', { name: '표 삽입' }))
    await waitFor(() => {
      expect(getRawEditorText(auxRawAgain)).toContain('| 열 1 | 열 2 | 열 3 |')
    })

    // Failed save surfaces Error Banner inside auxiliary
    const origAuxSave = auxWin.api.buffer.saveBuffer.bind(auxWin.api.buffer)
    auxWin.api.buffer.saveBuffer = async () => {
      throw new Error('Disk write denied')
    }
    fireEvent.keyDown(auxRawAgain, { key: 's', ctrlKey: true })
    const alertBanner = await within(auxRendered.container).findByRole('alert')
    expect(alertBanner).toHaveTextContent('Disk write denied')
    auxWin.api.buffer.saveBuffer = origAuxSave

    // Closing the sole dirty document tab prompts ConfirmDialog and saves before closing auxiliary
    await user.click(within(auxRendered.container).getByRole('button', { name: 'guide.md 탭 닫기' }))
    const confirmDialog = await within(auxRendered.container).findByRole('alertdialog')
    expect(confirmDialog).toHaveTextContent('저장하지 않은 변경 사항')
    await user.click(within(confirmDialog).getByRole('button', { name: '저장 후 닫기' }))
    await waitFor(() => {
      expect(auxWin.isClosed()).toBe(true)
    })
    expect(harness.getFilesSnapshot().get('C:/wiki/docs/guide.md')).toContain('| 열 1 | 열 2 | 열 3 |')
    expect(harness.getFilesSnapshot().get('C:/wiki/docs/guide.md')).toContain('| 열 1 | 열 2 | 열 3 |')
  })

  it('enforces single-tab disablement on auxiliary windows, allows detaching when 2+ tabs exist, and auto-closes at 0 tabs', async () => {
    const user = userEvent.setup()
    const harness = createHarness(
      { autoSave: false, theme: 'light' },
      {
        selectedFolder: 'C:\\wiki\\docs',
        workspaces: {
          'C:\\wiki\\docs': {
            'one.md': '# One',
            'two.md': '# Two'
          }
        }
      }
    )

    const mainWin = harness.createWindow({ role: 'main' })
    const mainRendered = render(<App wikiApi={mainWin.api} />)
    await triggerMenuCommand(mainWin.emitMenuCommand, 'open-folder')
    const sidebar = await within(mainRendered.container).findByLabelText('워크스페이스 탐색기')
    await user.click(await within(sidebar).findByText('one.md'))
    await user.click(await within(sidebar).findByText('two.md'))
    await waitFor(() => {
      expect(harness.hub.getSnapshot().tabCounts['c:/wiki/docs/one.md']).toBe(1)
      expect(harness.hub.getSnapshot().tabCounts['c:/wiki/docs/two.md']).toBe(1)
    })

    // Seed an auxiliary window with 2 tabs via initialTabs
    const aux1 = harness.createWindow({
      role: 'auxiliary',
      initialTabs: [
        {
          bufferKey: 'c:/wiki/docs/one.md',
          mode: 'raw',
          cursor: { selectionStart: 0, selectionEnd: 0 },
          scrollTop: 0
        },
        {
          bufferKey: 'c:/wiki/docs/two.md',
          mode: 'wysiwyg',
          cursor: { selectionStart: 0, selectionEnd: 0 },
          scrollTop: 0
        }
      ]
    })
    const aux1Rendered = render(<App wikiApi={aux1.api} />)
    await waitFor(() => {
      expect(within(aux1Rendered.container).getAllByRole('tab')).toHaveLength(2)
    })

    // With 2 tabs open in auxiliary, '새 창으로 이동' IS enabled and spawns another auxiliary window
    fireEvent.contextMenu(within(aux1Rendered.container).getByRole('tab', { name: /two\.md/ }))
    const auxMenu2 = await within(aux1Rendered.container).findByRole('menu', { name: '탭 작업 메뉴' })
    const detachBtn2 = within(auxMenu2).getByRole('menuitem', { name: '새 창으로 이동' })
    expect(detachBtn2).not.toBeDisabled()
    await user.click(detachBtn2)

    await waitFor(() => {
      expect(within(aux1Rendered.container).getAllByRole('tab')).toHaveLength(1)
      expect(harness.getAuxiliaryWindows()).toHaveLength(2)
    })

    // Second auxiliary opens with two.md in wysiwyg mode -> '새 창으로 이동' is disabled on its sole tab
    const aux2 = harness.getAuxiliaryWindows()[1]
    const aux2Rendered = render(<App wikiApi={aux2.api} />)
    await waitFor(() => {
      expect(within(aux2Rendered.container).getByRole('tab', { name: /two\.md/ })).toBeInTheDocument()
      expect(within(aux2Rendered.container).getByLabelText('위지윅 문서 에디터')).toBeInTheDocument()
    })

    fireEvent.contextMenu(within(aux1Rendered.container).getByRole('tab', { name: /one\.md/ }))
    const aux1SoloMenu = await within(aux1Rendered.container).findByRole('menu', { name: '탭 작업 메뉴' })
    expect(within(aux1SoloMenu).getByRole('menuitem', { name: '새 창으로 이동' })).toBeDisabled()

    // Closing the sole remaining tab on auxiliary automatically closes that auxiliary window, leaving main untouched
    await user.click(within(aux1Rendered.container).getByRole('button', { name: 'one.md 탭 닫기' }))
    await waitFor(() => {
      expect(aux1.isClosed()).toBe(true)
    })
    expect(within(mainRendered.container).getAllByRole('tab')).toHaveLength(2)
  })

  it('detaches sole tab from main window outside all bounds at clamped cursor position with state preserved', async () => {
    const user = userEvent.setup()
    const harness = createHarness(
      { autoSave: false, theme: 'light' },
      {
        selectedFolder: 'C:\\wiki\\drag',
        workspaces: {
          'C:\\wiki\\drag': {
            'alpha.md': '# Alpha initial content'
          }
        },
        mainBounds: { x: 100, y: 120, width: 1280, height: 820 },
        screen: {
          getDisplayNearestPoint: () => ({
            workArea: { x: 0, y: 0, width: 1920, height: 1080 }
          })
        }
      }
    )

    const mainWin = harness.createWindow({ role: 'main' })
    const mainRendered = render(<App wikiApi={mainWin.api} />)
    await triggerMenuCommand(mainWin.emitMenuCommand, 'open-folder')

    const rawEditor = (await openFolderAndNoteInWindow(
      user,
      mainRendered.container,
      mainWin.emitMenuCommand,
      'alpha.md'
    )) as HTMLTextAreaElement
    setRawEditorText(rawEditor, '# Alpha unsaved drag edit')
    await waitFor(() => {
      expect(within(mainRendered.container).getByTestId('dirty-indicator')).toBeInTheDocument()
    })
    setRawEditorSelection(rawEditor, 2, 7)
    const mainScroller = getRawEditorScroller(rawEditor)
    mainScroller.scrollTop = 180
    fireEvent.scroll(mainScroller)

    const alphaTab = within(mainRendered.container).getByRole('tab', { name: /alpha\.md/ })
    fireEvent.dragStart(alphaTab)
    dispatchDragEndAtScreenPoint(alphaTab, 1600, 500)

    await waitFor(() => {
      expect(harness.getAuxiliaryWindows()).toHaveLength(1)
      expect(within(mainRendered.container).queryAllByRole('tab')).toHaveLength(0)
    })

    // Main window retains an empty editor space (편집 공간)
    expect(within(mainRendered.container).getByText('마크다운 위키 에디터 준비 완료')).toBeInTheDocument()

    const aux1 = harness.getAuxiliaryWindows()[0]
    expect(aux1.getBounds()).toEqual({ x: 960, y: 320, width: 960, height: 760 })

    const auxRendered = render(<App wikiApi={aux1.api} />)
    const auxEditor = await within(auxRendered.container).findByTestId('document-editor')
    await waitFor(() => {
      expect(within(auxRendered.container).getByTestId('dirty-indicator')).toBeInTheDocument()
      expect(getRawEditorText(auxEditor)).toBe('# Alpha unsaved drag edit')
    })
    expect(getRawEditorSelection(auxEditor)).toEqual({ start: 2, end: 7 })
    expect(getRawEditorScroller(auxEditor).scrollTop).toBe(180)
  })

  it('suppresses detach on inside-window drops and enforces auxiliary single-tab vs multi-tab drag-out', async () => {
    const user = userEvent.setup()
    const harness = createHarness(
      { autoSave: false, theme: 'light' },
      {
        selectedFolder: 'C:\\wiki\\drag',
        workspaces: {
          'C:\\wiki\\drag': {
            'one.md': '# One',
            'two.md': '# Two'
          }
        },
        mainBounds: { x: 100, y: 120, width: 1280, height: 820 },
        screen: {
          getDisplayNearestPoint: () => ({
            workArea: { x: 0, y: 0, width: 2560, height: 1440 }
          })
        }
      }
    )

    const mainWin = harness.createWindow({ role: 'main' })
    const mainRendered = render(<App wikiApi={mainWin.api} />)
    await triggerMenuCommand(mainWin.emitMenuCommand, 'open-folder')

    const sidebar = await within(mainRendered.container).findByLabelText('워크스페이스 탐색기')
    await user.click(await within(sidebar).findByText('one.md'))
    await user.click(await within(sidebar).findByText('two.md'))

    await waitFor(() => {
      expect(within(mainRendered.container).getAllByRole('tab')).toHaveLength(2)
    })

    // Dropping in a non-drop area inside main window (same-pane editor body / sidebar) must not detach
    const oneTab = within(mainRendered.container).getByRole('tab', { name: /one\.md/ })
    const primaryPane = within(mainRendered.container).getByTestId('pane-primary')
    fireEvent.dragStart(oneTab)
    fireEvent.dragOver(primaryPane)
    fireEvent.drop(primaryPane)
    fireEvent.dragOver(sidebar)
    fireEvent.drop(sidebar)
    dispatchDragEndAtScreenPoint(oneTab, 180, 320)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(harness.getAuxiliaryWindows()).toHaveLength(0)
    expect(within(mainRendered.container).getAllByRole('tab')).toHaveLength(2)

    // Drag two.md outside main bounds -> opens aux1 at (1450, 200)
    const twoTab = within(mainRendered.container).getByRole('tab', { name: /two\.md/ })
    fireEvent.dragStart(twoTab)
    dispatchDragEndAtScreenPoint(twoTab, 1450, 200)

    await waitFor(() => {
      expect(harness.getAuxiliaryWindows()).toHaveLength(1)
      expect(within(mainRendered.container).getAllByRole('tab')).toHaveLength(1)
    })
    const aux1 = harness.getAuxiliaryWindows()[0]
    expect(aux1.getBounds()).toEqual({ x: 1450, y: 200, width: 960, height: 760 })
    const aux1Rendered = render(<App wikiApi={aux1.api} />)
    await waitFor(() => {
      expect(within(aux1Rendered.container).getAllByRole('tab')).toHaveLength(1)
    })

    // Dropping one.md inside open aux1 non-drop area (1600, 450) does NOT create a new window
    const mainOneTab = within(mainRendered.container).getByRole('tab', { name: /one\.md/ })
    fireEvent.dragStart(mainOneTab)
    dispatchDragEndAtScreenPoint(mainOneTab, 1600, 450)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(harness.getAuxiliaryWindows()).toHaveLength(1)
    expect(within(mainRendered.container).getAllByRole('tab')).toHaveLength(1)

    // Outside drop from 1-tab auxiliary window is silently ignored (no new window, no error banner)
    const aux1SoloTab = within(aux1Rendered.container).getByRole('tab', { name: /two\.md/ })
    fireEvent.dragStart(aux1SoloTab)
    dispatchDragEndAtScreenPoint(aux1SoloTab, 20, 20)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(harness.getAuxiliaryWindows()).toHaveLength(1)
    expect(aux1.isClosed()).toBe(false)
    expect(within(aux1Rendered.container).getAllByRole('tab')).toHaveLength(1)
    expect(within(aux1Rendered.container).queryByRole('alert')).not.toBeInTheDocument()

    // Seed an auxiliary window with 2 tabs in wysiwyg mode -> dragging 1 tab outside detaches to a new auxiliary
    const auxMulti = harness.createWindow({
      role: 'auxiliary',
      bounds: { x: 200, y: 80, width: 960, height: 760 },
      initialTabs: [
        {
          bufferKey: 'c:/wiki/drag/one.md',
          mode: 'raw',
          cursor: { selectionStart: 0, selectionEnd: 0 },
          scrollTop: 0
        },
        {
          bufferKey: 'c:/wiki/drag/two.md',
          mode: 'wysiwyg',
          cursor: { selectionStart: 0, selectionEnd: 0 },
          scrollTop: 0
        }
      ]
    })
    const auxMultiRendered = render(<App wikiApi={auxMulti.api} />)
    await waitFor(() => {
      expect(within(auxMultiRendered.container).getAllByRole('tab')).toHaveLength(2)
    })

    const auxMultiTwoTab = within(auxMultiRendered.container).getByRole('tab', { name: /two\.md/ })
    fireEvent.dragStart(auxMultiTwoTab)
    dispatchDragEndAtScreenPoint(auxMultiTwoTab, 1500, 1100)

    await waitFor(() => {
      expect(harness.getAuxiliaryWindows()).toHaveLength(3)
      expect(within(auxMultiRendered.container).getAllByRole('tab')).toHaveLength(1)
    })

    const auxDetachedFromAux = harness.getAuxiliaryWindows()[2]
    const auxDetachedRendered = render(<App wikiApi={auxDetachedFromAux.api} />)
    await waitFor(() => {
      expect(
        within(auxDetachedRendered.container).getByRole('tab', { name: /two\.md/ })
      ).toBeInTheDocument()
      expect(
        within(auxDetachedRendered.container).getByLabelText('위지윅 문서 에디터')
      ).toBeInTheDocument()
    })
  })

  it('cancels or completes active tab drag on Escape, missing coordinates, and split drop without spurious detach or cancel transitions', async () => {
    const user = userEvent.setup()
    const harness = createHarness(
      { autoSave: false, theme: 'light' },
      {
        selectedFolder: 'C:\\wiki\\drag-esc',
        workspaces: {
          'C:\\wiki\\drag-esc': {
            'a.md': '# A',
            'b.md': '# B'
          }
        },
        mainBounds: { x: 100, y: 120, width: 1280, height: 820 },
        screen: {
          getDisplayNearestPoint: () => ({
            workArea: { x: 0, y: 0, width: 2560, height: 1440 }
          })
        }
      }
    )

    const mainWin = harness.createWindow({ role: 'main' })
    const mainRendered = render(<App wikiApi={mainWin.api} />)
    await triggerMenuCommand(mainWin.emitMenuCommand, 'open-folder')

    const sidebar = await within(mainRendered.container).findByLabelText('워크스페이스 탐색기')
    await user.click(await within(sidebar).findByText('a.md'))
    await user.click(await within(sidebar).findByText('b.md'))

    await waitFor(() => {
      expect(within(mainRendered.container).getAllByRole('tab')).toHaveLength(2)
    })

    // 1. DOM Escape keydown during drag hides drop zones and prevents outside detach
    const bTab = within(mainRendered.container).getByRole('tab', { name: /b\.md/ })
    fireEvent.dragStart(bTab)
    expect(within(mainRendered.container).getByTestId('split-drop-zone-horizontal')).toBeInTheDocument()
    expect(within(mainRendered.container).getByTestId('split-drop-zone-vertical')).toBeInTheDocument()

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(
      within(mainRendered.container).queryByTestId('split-drop-zone-horizontal')
    ).not.toBeInTheDocument()
    expect(
      within(mainRendered.container).queryByTestId('split-drop-zone-vertical')
    ).not.toBeInTheDocument()

    dispatchDragEndAtScreenPoint(bTab, 1700, 300)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(harness.getAuxiliaryWindows()).toHaveLength(0)
    expect(within(mainRendered.container).getAllByRole('tab')).toHaveLength(2)

    // 2. Main-process before-input-event Escape during drag also cancels and blocks outside detach
    fireEvent.dragStart(bTab)
    expect(within(mainRendered.container).getByTestId('split-drop-zone-vertical')).toBeInTheDocument()

    await act(async () => {
      mainWin.emitBeforeInput({ type: 'keyDown', key: 'Escape' })
    })
    expect(
      within(mainRendered.container).queryByTestId('split-drop-zone-vertical')
    ).not.toBeInTheDocument()

    dispatchDragEndAtScreenPoint(bTab, 1700, 300)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(harness.getAuxiliaryWindows()).toHaveLength(0)
    expect(within(mainRendered.container).getAllByRole('tab')).toHaveLength(2)

    // 3. Missing dragend coordinates (non-MouseEvent jsdom dragEnd) on offset window does not coerce to (0, 0)
    fireEvent.dragStart(bTab)
    fireEvent.dragEnd(bTab)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(harness.getAuxiliaryWindows()).toHaveLength(0)
    expect(within(mainRendered.container).getAllByRole('tab')).toHaveLength(2)

    // 4. Split drop unmounts source tab without dragend: session finishes cleanly and late Escape emits no cancel
    if (!mainWin.api.window) {
      throw new Error('Expected main window API to be defined')
    }
    const dragEvents: Array<ActiveTabDragSession | null> = []
    const unsubDrag = mainWin.api.window.onTabDragStateChanged((session) => {
      dragEvents.push(session)
    })
    try {
      fireEvent.dragStart(bTab)
      const splitVerticalZone = within(mainRendered.container).getByTestId('split-drop-zone-vertical')
      await waitFor(() => {
        expect(dragEvents.at(-1)?.outcome).toBe('pending')
      })

      fireEvent.drop(splitVerticalZone)
      await waitFor(() => {
        expect(within(mainRendered.container).getByTestId('pane-secondary')).toBeInTheDocument()
      })
      await waitFor(() => {
        expect(dragEvents.some((event) => event?.outcome === 'dropped-in-window')).toBe(true)
        expect(dragEvents.at(-1)).toBeNull()
      })

      const eventCountBeforeLateEsc = dragEvents.length
      await act(async () => {
        mainWin.emitBeforeInput({ type: 'keyDown', key: 'Escape' })
      })
      expect(dragEvents).toHaveLength(eventCountBeforeLateEsc)
      expect(dragEvents.some((event) => event?.outcome === 'cancelled')).toBe(false)
      expect(harness.getAuxiliaryWindows()).toHaveLength(0)
    } finally {
      unsubDrag()
    }
  })

  it('merges tabs bidirectionally between main and auxiliary windows, inserts at tab index or end, deduplicates by bufferKey, suppresses duplicate spawn, and auto-closes empty auxiliary windows', async () => {
    const user = userEvent.setup()
    const harness = createHarness(
      { autoSave: false, theme: 'light' },
      {
        selectedFolder: 'C:\\wiki\\reattach',
        workspaces: {
          'C:\\wiki\\reattach': {
            'alpha.md': '# Alpha initial content',
            'beta.md': '# Beta initial content',
            'gamma.md': '# Gamma initial content'
          }
        },
        mainBounds: { x: 100, y: 120, width: 1280, height: 820 },
        screen: {
          getDisplayNearestPoint: () => ({
            workArea: { x: 0, y: 0, width: 2560, height: 1440 }
          })
        }
      }
    )

    const mainWin = harness.createWindow({ role: 'main' })
    const mainRendered = render(<App wikiApi={mainWin.api} />)
    await triggerMenuCommand(mainWin.emitMenuCommand, 'open-folder')

    const sidebar = await within(mainRendered.container).findByLabelText('워크스페이스 탐색기')
    await user.click(await within(sidebar).findByText('alpha.md'))
    await user.click(await within(sidebar).findByText('beta.md'))
    await user.click(await within(sidebar).findByText('gamma.md'))
    await waitFor(() => {
      expect(within(mainRendered.container).getAllByRole('tab')).toHaveLength(3)
    })

    // Detach beta.md -> aux1, gamma.md -> aux2 (leaving alpha.md in main)
    await detachTabViaContextMenu(user, mainRendered.container, /beta\.md/)
    await detachTabViaContextMenu(user, mainRendered.container, /gamma\.md/)

    await waitFor(() => {
      expect(harness.getAuxiliaryWindows()).toHaveLength(2)
      expect(within(mainRendered.container).getAllByRole('tab')).toHaveLength(1)
    })

    const [aux1, aux2] = harness.getAuxiliaryWindows()
    const aux1Rendered = render(<App wikiApi={aux1.api} />)
    const aux2Rendered = render(<App wikiApi={aux2.api} />)

    const aux1Editor = await within(aux1Rendered.container).findByTestId('document-editor')
    setRawEditorText(aux1Editor, '# Beta cross-window edit')
    setRawEditorSelection(aux1Editor, 2, 8)
    const aux1Scroller = getRawEditorScroller(aux1Editor)
    aux1Scroller.scrollTop = 145
    fireEvent.scroll(aux1Scroller)
    await waitFor(() => {
      expect(within(aux1Rendered.container).getByTestId('dirty-indicator')).toBeInTheDocument()
    })

    // 1. Aux1 (beta.md, sole tab) -> Main tab bar at index 0 (before alpha.md)
    const aux1BetaTab = within(aux1Rendered.container).getByRole('tab', { name: /beta\.md/ })
    const dt1 = createCrossWindowDataTransfer()
    fireEvent.dragStart(aux1BetaTab, { dataTransfer: dt1 })

    const mainAlphaTab = within(mainRendered.container).getByRole('tab', { name: /alpha\.md/ })
    fireEvent.drop(mainAlphaTab, { dataTransfer: dt1 })
    dispatchDragEndAtScreenPoint(aux1BetaTab, 2100, 900)

    await waitFor(() => {
      expect(aux1.isClosed()).toBe(true)
      const mainTabLabels = within(mainRendered.container)
        .getAllByRole('tab')
        .map((el) => el.textContent)
      expect(mainTabLabels.map((label) => label?.replace(/●/g, '').trim())).toEqual([
        'beta.md',
        'alpha.md'
      ])
    })

    // Duplicate auxiliary spawn was suppressed even though dragend fired at (2100, 900)
    expect(harness.getAuxiliaryWindows()).toHaveLength(2)
    const mainBetaEditor = await within(mainRendered.container).findByTestId('document-editor')
    expect(getRawEditorText(mainBetaEditor)).toBe('# Beta cross-window edit')
    expect(getRawEditorSelection(mainBetaEditor)).toEqual({ start: 2, end: 8 })
    expect(getRawEditorScroller(mainBetaEditor).scrollTop).toBe(145)

    // 2. Duplicate bufferKey prevention: open gamma.md in Main too, then drag gamma.md from aux2 onto Main tab bar
    await user.click(await within(sidebar).findByText('gamma.md'))
    await waitFor(() => {
      expect(within(mainRendered.container).getAllByRole('tab')).toHaveLength(3)
    })
    await user.click(within(mainRendered.container).getByRole('tab', { name: /alpha\.md/ }))
    const aux2Editor = await within(aux2Rendered.container).findByTestId('document-editor')
    setRawEditorText(aux2Editor, '# Gamma synced edit')
    await waitFor(() => {
      expect(within(aux2Rendered.container).getByTestId('dirty-indicator')).toBeInTheDocument()
    })

    const aux2GammaTab = within(aux2Rendered.container).getByRole('tab', { name: /gamma\.md/ })
    const dt2 = createCrossWindowDataTransfer()
    fireEvent.dragStart(aux2GammaTab, { dataTransfer: dt2 })
    fireEvent.drop(within(mainRendered.container).getByRole('tablist', { name: '주 탭 목록' }), {
      dataTransfer: dt2
    })

    await waitFor(() => {
      expect(aux2.isClosed()).toBe(true)
      expect(within(mainRendered.container).getAllByRole('tab')).toHaveLength(3)
      expect(
        within(mainRendered.container).getByRole('tab', { name: /gamma\.md/ })
      ).toHaveAttribute('aria-selected', 'true')
    })
    expect(
      getRawEditorText(await within(mainRendered.container).findByTestId('document-editor'))
    ).toBe('# Gamma synced edit')

    // 3. Main -> Aux and Aux A -> Aux B bidirectional transfer
    await detachTabViaContextMenu(user, mainRendered.container, /beta\.md/)
    await detachTabViaContextMenu(user, mainRendered.container, /gamma\.md/)
    await waitFor(() => {
      expect(harness.getAuxiliaryWindows()).toHaveLength(4)
      expect(within(mainRendered.container).getAllByRole('tab')).toHaveLength(1)
    })

    const aux3 = harness.getAuxiliaryWindows()[2]
    const aux4 = harness.getAuxiliaryWindows()[3]
    const aux3Rendered = render(<App wikiApi={aux3.api} />)
    const aux4Rendered = render(<App wikiApi={aux4.api} />)
    await waitFor(() => {
      expect(within(aux3Rendered.container).getAllByRole('tab')).toHaveLength(1)
      expect(within(aux4Rendered.container).getAllByRole('tab')).toHaveLength(1)
    })

    // Main (alpha.md) -> aux3 tab bar (append at end -> [beta.md, alpha.md])
    const mainAlphaAgain = within(mainRendered.container).getByRole('tab', { name: /alpha\.md/ })
    const dt3 = createCrossWindowDataTransfer()
    fireEvent.dragStart(mainAlphaAgain, { dataTransfer: dt3 })
    fireEvent.drop(within(aux3Rendered.container).getByRole('tablist', { name: '주 탭 목록' }), {
      dataTransfer: dt3
    })

    await waitFor(() => {
      const aux3Tabs = within(aux3Rendered.container)
        .getAllByRole('tab')
        .map((el) => el.textContent?.replace(/●/g, '').trim())
      expect(aux3Tabs).toEqual(['beta.md', 'alpha.md'])
      expect(within(mainRendered.container).queryAllByRole('tab')).toHaveLength(0)
    })

    // Aux3 (alpha.md) -> Aux4 tab bar (insert at index 0 before gamma.md -> [alpha.md, gamma.md]); aux3 remains open with [beta.md]
    const aux3AlphaTab = within(aux3Rendered.container).getByRole('tab', { name: /alpha\.md/ })
    const dt4 = createCrossWindowDataTransfer()
    fireEvent.dragStart(aux3AlphaTab, { dataTransfer: dt4 })
    fireEvent.drop(within(aux4Rendered.container).getByRole('tab', { name: /gamma\.md/ }), {
      dataTransfer: dt4
    })

    await waitFor(() => {
      const aux4Tabs = within(aux4Rendered.container)
        .getAllByRole('tab')
        .map((el) => el.textContent?.replace(/●/g, '').trim())
      expect(aux4Tabs).toEqual(['alpha.md', 'gamma.md'])
      expect(within(aux3Rendered.container).getAllByRole('tab')).toHaveLength(1)
      expect(aux3.isClosed()).toBe(false)
    })
  })

  it('activates both split drop zones on 1-tab single-mode target windows via MIME types or session broadcast, rejects non-drop areas, and supports empty main window drop', async () => {
    const user = userEvent.setup()
    const harness = createHarness(
      { autoSave: false, theme: 'light' },
      {
        selectedFolder: 'C:\\wiki\\splitdrop',
        workspaces: {
          'C:\\wiki\\splitdrop': {
            'one.md': '# One',
            'two.md': '# Two',
            'three.md': '# Three'
          }
        },
        mainBounds: { x: 100, y: 120, width: 1280, height: 820 },
        screen: {
          getDisplayNearestPoint: () => ({
            workArea: { x: 0, y: 0, width: 2560, height: 1440 }
          })
        }
      }
    )

    const mainWin = harness.createWindow({ role: 'main' })
    const mainRendered = render(<App wikiApi={mainWin.api} />)
    await triggerMenuCommand(mainWin.emitMenuCommand, 'open-folder')

    const sidebar = await within(mainRendered.container).findByLabelText('워크스페이스 탐색기')
    await user.click(await within(sidebar).findByText('one.md'))
    await user.click(await within(sidebar).findByText('two.md'))
    await user.click(await within(sidebar).findByText('three.md'))
    await waitFor(() => {
      expect(within(mainRendered.container).getAllByRole('tab')).toHaveLength(3)
    })

    // Switch two.md to wysiwyg before detaching to aux1
    await user.click(within(mainRendered.container).getByRole('tab', { name: /two\.md/ }))
    await user.click(within(mainRendered.container).getByRole('button', { name: '위지윅' }))
    await detachTabViaContextMenu(user, mainRendered.container, /two\.md/)
    await detachTabViaContextMenu(user, mainRendered.container, /three\.md/)

    // Main now has ONLY 1 tab (one.md) in single mode
    await waitFor(() => {
      expect(harness.getAuxiliaryWindows()).toHaveLength(2)
      expect(within(mainRendered.container).getAllByRole('tab')).toHaveLength(1)
    })

    const [aux1, aux2] = harness.getAuxiliaryWindows()
    const aux1Rendered = render(<App wikiApi={aux1.api} />)
    const aux2Rendered = render(<App wikiApi={aux2.api} />)
    await waitFor(() => {
      expect(within(aux1Rendered.container).getByRole('tab', { name: /two\.md/ })).toBeInTheDocument()
      expect(within(aux2Rendered.container).getByRole('tab', { name: /three\.md/ })).toBeInTheDocument()
    })

    // 1. Synchronous MIME-only detection (before getData or session broadcast settles) on 1-tab single-mode Main
    const blockedGetDataDt = createCrossWindowDataTransfer({ allowGetData: false })
    const aux1Tab = within(aux1Rendered.container).getByRole('tab', { name: /two\.md/ })
    fireEvent.dragStart(aux1Tab, { dataTransfer: blockedGetDataDt })

    const mainWorkspace = within(mainRendered.container).getByTestId('pane-workspace')
    expect(mainWorkspace).toHaveAttribute('data-split-mode', 'single')
    fireEvent.dragEnter(mainWorkspace, { dataTransfer: blockedGetDataDt })
    expect(within(mainRendered.container).getByTestId('split-drop-zone-horizontal')).toBeInTheDocument()
    expect(within(mainRendered.container).getByTestId('split-drop-zone-vertical')).toBeInTheDocument()

    // dragleave hides split drop zones
    fireEvent.dragLeave(mainWorkspace)
    expect(
      within(mainRendered.container).queryByTestId('split-drop-zone-horizontal')
    ).not.toBeInTheDocument()

    // Non-drop areas (left sidebar, non-empty editor body) neither merge/split nor spawn auxiliary windows
    fireEvent.drop(sidebar, { dataTransfer: blockedGetDataDt })
    fireEvent.drop(within(mainRendered.container).getByTestId('document-editor'), {
      dataTransfer: blockedGetDataDt
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(within(mainRendered.container).getAllByRole('tab')).toHaveLength(1)
    expect(aux1.isClosed()).toBe(false)
    expect(harness.getAuxiliaryWindows()).toHaveLength(2)

    // Re-enter and drop onto horizontal split drop zone -> splits Main horizontally with wysiwyg two.md, auto-closes aux1
    fireEvent.dragOver(mainWorkspace, { dataTransfer: blockedGetDataDt })
    const horizZone = within(mainRendered.container).getByTestId('split-drop-zone-horizontal')
    fireEvent.drop(horizZone, { dataTransfer: blockedGetDataDt })

    await waitFor(() => {
      expect(aux1.isClosed()).toBe(true)
      expect(mainWorkspace).toHaveAttribute('data-split-mode', 'horizontal')
      expect(within(mainRendered.container).getByTestId('pane-secondary')).toBeInTheDocument()
    })
    const mainSecondary = within(mainRendered.container).getByTestId('pane-secondary')
    expect(within(mainSecondary).getByRole('tab', { name: /two\.md/ })).toBeInTheDocument()
    expect(within(mainSecondary).getByLabelText('위지윅 문서 에디터')).toBeInTheDocument()
    expect(harness.getAuxiliaryWindows()).toHaveLength(2)

    // 2. Broadcast-only detection (no DataTransfer on target!) -> Main drags two.md into 1-tab single-mode Aux2 vertical split
    const mainTwoTab = within(mainSecondary).getByRole('tab', { name: /two\.md/ })
    fireEvent.dragStart(mainTwoTab)

    const aux2Workspace = within(aux2Rendered.container).getByTestId('pane-workspace')
    await waitFor(() => {
      fireEvent.dragOver(aux2Workspace)
      expect(within(aux2Rendered.container).getByTestId('split-drop-zone-horizontal')).toBeInTheDocument()
      expect(within(aux2Rendered.container).getByTestId('split-drop-zone-vertical')).toBeInTheDocument()
    })
    fireEvent.drop(within(aux2Rendered.container).getByTestId('split-drop-zone-vertical'))

    await waitFor(() => {
      expect(aux2Workspace).toHaveAttribute('data-split-mode', 'vertical')
      expect(
        within(within(aux2Rendered.container).getByTestId('pane-secondary')).getByRole('tab', {
          name: /two\.md/
        })
      ).toBeInTheDocument()
      expect(within(mainRendered.container).queryByTestId('pane-secondary')).not.toBeInTheDocument()
    })

    // 3. Empty 0-tab Main window accepts external tab drop into primary without split zones
    await user.click(within(mainRendered.container).getByRole('button', { name: 'one.md 탭 닫기' }))
    await waitFor(() => {
      expect(within(mainRendered.container).queryAllByRole('tab')).toHaveLength(0)
      expect(within(mainRendered.container).getByText('마크다운 위키 에디터 준비 완료')).toBeInTheDocument()
    })

    const aux2TwoTab = within(aux2Rendered.container).getByRole('tab', { name: /two\.md/ })
    const dtEmpty = createCrossWindowDataTransfer()
    fireEvent.dragStart(aux2TwoTab, { dataTransfer: dtEmpty })
    fireEvent.dragEnter(mainWorkspace, { dataTransfer: dtEmpty })
    expect(
      within(mainRendered.container).queryByTestId('split-drop-zone-horizontal')
    ).not.toBeInTheDocument()
    fireEvent.drop(within(mainRendered.container).getByTestId('pane-primary'), {
      dataTransfer: dtEmpty
    })

    await waitFor(() => {
      expect(within(mainRendered.container).getByRole('tab', { name: /two\.md/ })).toBeInTheDocument()
      expect(aux2Workspace).toHaveAttribute('data-split-mode', 'single')
      expect(within(aux2Rendered.container).getAllByRole('tab')).toHaveLength(1)
    })

    // 4. Cross-process IPC ordering race: source dragend/endTabDrag wins before target acceptTabDragDrop reaches main
    let releaseDelayedAccept!: () => void
    const delayedAcceptGate = new Promise<void>((resolve) => {
      releaseDelayedAccept = resolve
    })
    let markSourceEndSettled!: () => void
    const sourceEndSettled = new Promise<void>((resolve) => {
      markSourceEndSettled = resolve
    })
    const origAccept = mainWin.api.window!.acceptTabDragDrop.bind(mainWin.api.window)
    mainWin.api.window!.acceptTabDragDrop = async (input) => {
      await delayedAcceptGate
      return origAccept(input)
    }
    const origAuxEnd = aux2.api.window!.endTabDrag.bind(aux2.api.window)
    aux2.api.window!.endTabDrag = async (input) => {
      const result = await origAuxEnd(input)
      markSourceEndSettled()
      return result
    }

    const aux2ThreeTab = within(aux2Rendered.container).getByRole('tab', { name: /three\.md/ })
    const dtRace = createCrossWindowDataTransfer()
    fireEvent.dragStart(aux2ThreeTab, { dataTransfer: dtRace })
    fireEvent.drop(within(mainRendered.container).getByRole('tablist', { name: '주 탭 목록' }), {
      dataTransfer: dtRace
    })
    // Source dragend resolves endTabDrag BEFORE target acceptTabDragDrop IPC arrives
    dispatchDragEndAtScreenPoint(aux2ThreeTab, 300, 300)
    await sourceEndSettled
    releaseDelayedAccept()

    await waitFor(() => {
      expect(within(mainRendered.container).getByRole('tab', { name: /three\.md/ })).toBeInTheDocument()
      expect(aux2.isClosed()).toBe(true)
    })
  })

  it('guards auxiliary X close only for last-reference dirty workspace/config buffers and surfaces save error banner on abort', async () => {
    const user = userEvent.setup()
    const harness = createHarness(
      { autoSave: false, theme: 'light' },
      {
        selectedFolder: 'C:\\wiki\\docs',
        workspaces: {
          'C:\\wiki\\docs': {
            'shared.md': '# Shared',
            'sole.md': '# Sole'
          }
        }
      }
    )

    const mainWin = harness.createWindow({ role: 'main' })
    const mainRendered = render(<App wikiApi={mainWin.api} />)
    trackDisposer(() => mainRendered.unmount())

    // Open shared.md and split it so Main keeps one copy while Aux1 gets the second copy
    await openFolderAndNoteInWindow(user, mainRendered.container, mainWin.emitMenuCommand, 'shared.md')
    fireEvent.contextMenu(within(mainRendered.container).getByRole('tab', { name: /shared\.md/ }))
    const mainTabMenu = await within(mainRendered.container).findByRole('menu', { name: '탭 작업 메뉴' })
    await user.click(within(mainTabMenu).getByRole('menuitem', { name: '분할 영역에 복제 열기' }))
    await waitFor(() => {
      expect(within(mainRendered.container).getAllByRole('tab', { name: /shared\.md/ })).toHaveLength(2)
    })

    const rightSharedTab = within(within(mainRendered.container).getByTestId('pane-secondary')).getByRole(
      'tab',
      { name: /shared\.md/ }
    )
    fireEvent.contextMenu(rightSharedTab)
    const rightMenu = await within(mainRendered.container).findByRole('menu', { name: '탭 작업 메뉴' })
    await user.click(within(rightMenu).getByRole('menuitem', { name: '새 창으로 이동' }))

    await waitFor(() => {
      expect(harness.getAuxiliaryWindows()).toHaveLength(1)
    })
    const auxShared = harness.getAuxiliaryWindows()[0]
    const auxSharedRendered = render(<App wikiApi={auxShared.api} />)
    trackDisposer(() => auxSharedRendered.unmount())

    const auxSharedEditor = await within(auxSharedRendered.container).findByTestId('document-editor')
    setRawEditorText(auxSharedEditor, '# Shared Dirty From Aux')
    await waitFor(() => {
      expect(within(auxSharedRendered.container).getByTestId('dirty-indicator')).toBeInTheDocument()
    })

    // Shared dirty buffer still open in Main -> Aux X closes immediately without ConfirmDialog
    act(() => {
      auxShared.requestClose()
    })
    expect(within(auxSharedRendered.container).queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(auxShared.isClosed()).toBe(true)

    // Open sole.md + config.json in Main, move sole.md to new Aux2 and drag config.json into Aux2 so Aux2 holds sole references
    const sidebar = within(mainRendered.container).getByLabelText('워크스페이스 탐색기')
    await user.click(await within(sidebar).findByText('sole.md'))
    await detachTabViaContextMenu(user, mainRendered.container, /sole\.md/)
    await waitFor(() => {
      expect(harness.getAuxiliaryWindows()).toHaveLength(2)
    })
    const auxSole = harness.getAuxiliaryWindows()[1]
    const auxSoleRendered = render(<App wikiApi={auxSole.api} />)
    trackDisposer(() => auxSoleRendered.unmount())
    await within(auxSoleRendered.container).findByRole('tab', { name: /sole\.md/ })

    await openConfigFromSettings(user, mainRendered.container, mainWin.emitMenuCommand)
    const configTabInMain = await within(mainRendered.container).findByRole('tab', {
      name: /config\.json/
    })
    const dtConfig = createCrossWindowDataTransfer()
    fireEvent.dragStart(configTabInMain, { dataTransfer: dtConfig })
    fireEvent.drop(
      within(auxSoleRendered.container).getByRole('tablist', { name: '주 탭 목록' }),
      { dataTransfer: dtConfig }
    )
    await waitFor(() => {
      expect(
        within(auxSoleRendered.container).getByRole('tab', { name: /config\.json/ })
      ).toBeInTheDocument()
      expect(
        within(mainRendered.container).queryByRole('tab', { name: /config\.json/ })
      ).not.toBeInTheDocument()
    })

    // Make sole.md dirty AND config.json invalid JSON inside Aux2
    await user.click(within(auxSoleRendered.container).getByRole('tab', { name: /sole\.md/ }))
    setRawEditorText(await within(auxSoleRendered.container).findByTestId('document-editor'), '# Saved Sole')
    await user.click(within(auxSoleRendered.container).getByRole('tab', { name: /config\.json/ }))
    setRawEditorText(await within(auxSoleRendered.container).findByTestId('document-editor'), '{invalid json')
    await waitFor(() => {
      expect(within(auxSoleRendered.container).getAllByTestId('tab-dirty-indicator')).toHaveLength(2)
    })

    // First X click -> ConfirmDialog in Aux2; Cancel keeps Aux2 open
    act(() => {
      auxSole.requestClose()
    })
    const auxDialog = await within(auxSoleRendered.container).findByRole('alertdialog')
    await user.click(within(auxDialog).getByRole('button', { name: '취소' }))
    expect(within(auxSoleRendered.container).queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(auxSole.isClosed()).toBe(false)

    // Second X click -> Save & Close fails on invalid JSON config -> aborts close and shows error banner
    act(() => {
      auxSole.requestClose()
    })
    const saveRetryDialog = await within(auxSoleRendered.container).findByRole('alertdialog')
    await user.click(within(saveRetryDialog).getByRole('button', { name: '저장 후 닫기' }))

    expect(await within(auxSoleRendered.container).findByRole('alert')).toBeInTheDocument()
    expect(auxSole.isClosed()).toBe(false)
    expect(harness.getFilesSnapshot().get('C:/wiki/docs/sole.md')).toBe('# Saved Sole')

    // Fix config.json -> Save & Close persists config and closes Aux2
    const validRaw = JSON.stringify(
      { ...(await mainWin.api.config.get()), autoSave: false, theme: 'dark' },
      null,
      2
    )
    setRawEditorText(await within(auxSoleRendered.container).findByTestId('document-editor'), validRaw)
    act(() => {
      auxSole.requestClose()
    })
    const finalDialog = await within(auxSoleRendered.container).findByRole('alertdialog')
    await user.click(within(finalDialog).getByRole('button', { name: '저장 후 닫기' }))

    await waitFor(() => {
      expect(auxSole.isClosed()).toBe(true)
    })
    expect((await mainWin.api.config.get()).theme).toBe('dark')
  })

  it('guards main window X close across main and all auxiliary windows, saves/discards cleanly, aborts on error, and closes auxiliary windows without individual prompts', async () => {
    const user = userEvent.setup()
    const harness = createHarness(
      { autoSave: false, theme: 'light' },
      {
        selectedFolder: 'C:\\wiki\\docs',
        workspaces: {
          'C:\\wiki\\docs': {
            'main.md': '# Main Clean',
            'aux-a.md': '# Aux A Initial'
          }
        }
      }
    )

    const mainWin = harness.createWindow({ role: 'main' })
    const mainRendered = render(<App wikiApi={mainWin.api} />)
    trackDisposer(() => mainRendered.unmount())

    await openFolderAndNoteInWindow(user, mainRendered.container, mainWin.emitMenuCommand, 'main.md')
    const sidebar = within(mainRendered.container).getByLabelText('워크스페이스 탐색기')
    await user.click(await within(sidebar).findByText('aux-a.md'))
    await detachTabViaContextMenu(user, mainRendered.container, /aux-a\.md/)

    await openConfigFromSettings(user, mainRendered.container, mainWin.emitMenuCommand)
    await detachTabViaContextMenu(user, mainRendered.container, /config\.json/)

    await waitFor(() => {
      expect(harness.getAuxiliaryWindows()).toHaveLength(2)
    })
    const [auxA, auxConfig] = harness.getAuxiliaryWindows()
    const auxARendered = render(<App wikiApi={auxA.api} />)
    const auxConfigRendered = render(<App wikiApi={auxConfig.api} />)
    trackDisposer(() => auxARendered.unmount(), () => auxConfigRendered.unmount())

    // Dirty aux-a.md and invalid config.json in auxConfig while main.md stays clean
    setRawEditorText(await within(auxARendered.container).findByTestId('document-editor'), '# Aux A Saved')
    setRawEditorText(await within(auxConfigRendered.container).findByTestId('document-editor'), '{broken config')

    await waitFor(() => {
      expect(within(auxARendered.container).getByTestId('dirty-indicator')).toBeInTheDocument()
      expect(within(auxConfigRendered.container).getByTestId('dirty-indicator')).toBeInTheDocument()
    })

    // Main X close -> ConfirmDialog shown ONLY in Main, never in Aux1 or Aux2
    act(() => {
      mainWin.requestClose()
    })
    const mainDialog = await within(mainRendered.container).findByRole('alertdialog')
    expect(within(mainDialog).getByText(/aux-a\.md 외 1개/)).toBeInTheDocument()
    expect(within(auxARendered.container).queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(within(auxConfigRendered.container).queryByRole('alertdialog')).not.toBeInTheDocument()

    // Cancel keeps all 3 windows open
    await user.click(within(mainDialog).getByRole('button', { name: '취소' }))
    expect(mainWin.isClosed()).toBe(false)
    expect(auxA.isClosed()).toBe(false)
    expect(auxConfig.isClosed()).toBe(false)

    // Save & Close fails due to invalid JSON in auxConfig -> Main shows error banner and aborts all closes
    act(() => {
      mainWin.requestClose()
    })
    const saveFailDialog = await within(mainRendered.container).findByRole('alertdialog')
    await user.click(within(saveFailDialog).getByRole('button', { name: '저장 후 닫기' }))
    expect(await within(mainRendered.container).findByRole('alert')).toBeInTheDocument()
    expect(mainWin.isClosed()).toBe(false)
    expect(auxA.isClosed()).toBe(false)
    expect(auxConfig.isClosed()).toBe(false)

    // Fix config.json in auxConfig -> Main Save & Close persists and closes all 3 without aux prompts
    const validRaw = JSON.stringify(
      { ...(await mainWin.api.config.get()), autoSave: false, theme: 'dark' },
      null,
      2
    )
    setRawEditorText(await within(auxConfigRendered.container).findByTestId('document-editor'), validRaw)
    act(() => {
      mainWin.requestClose()
    })
    const confirmSaveDialog = await within(mainRendered.container).findByRole('alertdialog')
    await user.click(within(confirmSaveDialog).getByRole('button', { name: '저장 후 닫기' }))

    await waitFor(() => {
      expect(auxA.isClosed()).toBe(true)
      expect(auxConfig.isClosed()).toBe(true)
      expect(mainWin.isClosed()).toBe(true)
    })
    expect(within(auxARendered.container).queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(within(auxConfigRendered.container).queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(harness.getFilesSnapshot().get('C:/wiki/docs/aux-a.md')).toBe('# Aux A Saved')
  })

  it('closes auxiliary windows with main on discard/clean close and handles cross-window workspace switching cleanup preserving config.json windows', async () => {
    const user = userEvent.setup()
    let folderToSelect = 'C:\\wiki\\ws1'
    const harness = createHarness(
      { autoSave: false, theme: 'light' },
      {
        selectedFolder: 'C:\\wiki\\ws1',
        workspaces: {
          'C:\\wiki\\ws1': {
            'one.md': '# One Initial',
            'aux-ws.md': '# Aux WS Initial'
          },
          'C:\\wiki\\ws2': {
            'two.md': '# Workspace Two'
          }
        }
      }
    )

    const mainWin = harness.createWindow({ role: 'main' })
    mainWin.api.workspace.selectFolder = async () => folderToSelect
    const mainRendered = render(<App wikiApi={mainWin.api} />)
    trackDisposer(() => mainRendered.unmount())

    // Open ws1 files in Main, detach aux-ws.md to Aux1 and config.json to Aux2
    await openFolderAndNoteInWindow(user, mainRendered.container, mainWin.emitMenuCommand, 'one.md')
    const sidebar = within(mainRendered.container).getByLabelText('워크스페이스 탐색기')
    await user.click(await within(sidebar).findByText('aux-ws.md'))
    await detachTabViaContextMenu(user, mainRendered.container, /aux-ws\.md/)

    await openConfigFromSettings(user, mainRendered.container, mainWin.emitMenuCommand)
    await detachTabViaContextMenu(user, mainRendered.container, /config\.json/)

    await waitFor(() => {
      expect(harness.getAuxiliaryWindows()).toHaveLength(2)
    })
    const [auxWs, auxConfig] = harness.getAuxiliaryWindows()
    const auxWsRendered = render(<App wikiApi={auxWs.api} />)
    const auxConfigRendered = render(<App wikiApi={auxConfig.api} />)
    trackDisposer(() => auxWsRendered.unmount(), () => auxConfigRendered.unmount())

    // Edit aux-ws.md and config.json dirty while Main's one.md stays clean
    setRawEditorText(await within(auxWsRendered.container).findByTestId('document-editor'), '# Aux WS Saved')
    setRawEditorText(
      await within(auxConfigRendered.container).findByTestId('document-editor'),
      '{"autoSave":false,"theme":"dark"}'
    )
    await waitFor(() => {
      expect(within(auxWsRendered.container).getByTestId('dirty-indicator')).toBeInTheDocument()
      expect(within(auxConfigRendered.container).getByTestId('dirty-indicator')).toBeInTheDocument()
    })

    // Switch workspace to ws2 -> Main prompts for aux-ws.md (ignores config.json)
    folderToSelect = 'C:\\wiki\\ws2'
    await triggerMenuCommand(mainWin.emitMenuCommand, 'open-folder')
    const switchDialog = await within(mainRendered.container).findByRole('alertdialog')
    expect(within(switchDialog).getByText(/aux-ws\.md/)).toBeInTheDocument()
    expect(within(switchDialog).queryByText(/config\.json/)).not.toBeInTheDocument()

    await user.click(within(switchDialog).getByRole('button', { name: '저장 후 이동' }))

    // Verify aux-ws.md saved, ws2 opened, auxWs auto-closed cleanly without close guard, while auxConfig stays open
    await waitFor(() => {
      expect(within(mainRendered.container).getByText('two.md')).toBeInTheDocument()
      expect(within(mainRendered.container).queryByRole('tab', { name: /one\.md/ })).not.toBeInTheDocument()
      expect(auxWs.isClosed()).toBe(true)
    })
    expect(harness.getFilesSnapshot().get('C:/wiki/ws1/aux-ws.md')).toBe('# Aux WS Saved')
    expect(auxConfig.isClosed()).toBe(false)
    expect(
      within(auxConfigRendered.container).getByRole('tab', { name: /config\.json/ })
    ).toBeInTheDocument()
    expect(within(auxConfigRendered.container).getByTestId('dirty-indicator')).toBeInTheDocument()

    // Main X -> 버리고 닫기 discards dirty config.json in auxConfig and closes both windows without aux prompt
    act(() => {
      mainWin.requestClose()
    })
    const discardDialog = await within(mainRendered.container).findByRole('alertdialog')
    await user.click(within(discardDialog).getByRole('button', { name: '버리고 닫기' }))
    await waitFor(() => {
      expect(auxConfig.isClosed()).toBe(true)
      expect(mainWin.isClosed()).toBe(true)
    })
    expect(within(auxConfigRendered.container).queryByRole('alertdialog')).not.toBeInTheDocument()
  })
})

describe('Multi-window Git discard rollback integration (<App />)', () => {
  it('discards clean M/D/U/? files immediately in a subfolder workspace without prompting unrelated dirty buffers, syncs tree/badges/unstaged diffs', async () => {
    const user = userEvent.setup()
    const repoRoot = 'C:/repo'
    const workspaceRoot = 'C:/repo/wiki'
    const headContents: Record<string, string> = {
      'wiki/notes.md': '# Head Notes',
      'wiki/deleted.md': '# Head Deleted',
      'wiki/conflict.md': '# Head Conflict'
    }
    let gitState = createRepoGitStatus(repoRoot, {
      hasConflicts: true,
      staged: [{ path: 'wiki/staged.md', status: 'M' }],
      unstaged: [
        { path: 'wiki/notes.md', status: 'M' },
        { path: 'wiki/deleted.md', status: 'D' },
        { path: 'wiki/conflict.md', status: 'U' }
      ],
      untracked: [{ path: 'wiki/untracked.md', status: '?' }]
    })

    let emitWsChange: ((event: WorkspaceChangeEvent) => void) | null = null
    let mainWorkspaceApi: InMemoryWindowHandle['api']['workspace'] | null = null

    const discardSpy = vi.fn(async (_wsPath: string, paths: string[]) => {
      const targetSet = new Set(paths)
      for (const relPath of paths) {
        const absPath = `${repoRoot}/${relPath}`
        if (relPath in headContents) {
          await mainWorkspaceApi?.writeFile(absPath, headContents[relPath])
        } else {
          await mainWorkspaceApi?.deleteEntry(absPath).catch(() => undefined)
        }
        const wsRelPath = relPath.startsWith('wiki/') ? relPath.slice('wiki/'.length) : relPath
        emitWsChange?.({ rootPath: workspaceRoot, eventType: 'change', relativePath: wsRelPath })
      }
      const nextUnstaged = gitState.unstaged.filter((item) => !targetSet.has(item.path))
      gitState = {
        ...gitState,
        hasConflicts: nextUnstaged.some((item) => item.status === 'U'),
        unstaged: nextUnstaged,
        untracked: gitState.untracked.filter((item) => !targetSet.has(item.path))
      }
      return gitState
    })

    const harness = createHarness(
      { autoSave: false, theme: 'light' },
      {
        selectedFolder: 'C:\\repo\\wiki',
        workspaces: {
          'C:\\repo\\wiki': {
            'notes.md': '# Modified Worktree',
            'conflict.md': '<<<<<<< HEAD\n# Head Conflict\n=======\n# Theirs\n>>>>>>> other',
            'untracked.md': '# New Untracked',
            'other.md': '# Clean Other',
            'staged.md': '# Staged Only'
          }
        },
        git: {
          status: async () => gitState,
          discard: discardSpy,
          ...createRollbackHistoryGitMocks()
        }
      }
    )
    emitWsChange = harness.emitWorkspaceChange

    const mainWin = harness.createWindow({ role: 'main' })
    mainWorkspaceApi = mainWin.api.workspace
    const rendered = render(<App wikiApi={mainWin.api} />)
    trackDisposer(() => rendered.unmount())

    // Open folder, keep notes.md clean, make other.md & config.json dirty
    await openFolderAndNoteInWindow(user, rendered.container, mainWin.emitMenuCommand, 'notes.md')
    const explorerSidebar = within(rendered.container).getByLabelText('워크스페이스 탐색기')
    await user.click(await within(explorerSidebar).findByText('other.md'))
    await waitFor(() => {
      expect(getRawEditorText(within(rendered.container).getByTestId('document-editor'))).toBe(
        '# Clean Other'
      )
    })
    setRawEditorText(within(rendered.container).getByTestId('document-editor'), '# Dirty Other')

    await openConfigFromSettings(user, rendered.container, mainWin.emitMenuCommand)
    await within(rendered.container).findByRole('tab', { name: /config\.json/ })
    await waitFor(() => {
      expect(getRawEditorText(within(rendered.container).getByTestId('document-editor'))).toContain(
        '"autoSave"'
      )
    })
    setRawEditorText(
      within(rendered.container).getByTestId('document-editor'),
      '{"autoSave":false,"theme":"dark"}'
    )
    await waitFor(() => {
      expect(within(rendered.container).getAllByTestId('tab-dirty-indicator')).toHaveLength(2)
    })

    // Switch to Git view and inspect badge + buttons
    await user.click(within(rendered.container).getByRole('button', { name: 'Git' }))
    const gitPanel = await within(rendered.container).findByLabelText('Git 소스 제어')
    expect(within(rendered.container).getByRole('button', { name: 'Git' })).toHaveTextContent('5')

    const stagedSection = within(gitPanel).getByRole('group', { name: 'Staged Changes' })
    expect(within(stagedSection).queryByRole('button', { name: /변경 사항 롤백/ })).toBeNull()

    const changesSection = within(gitPanel).getByRole('group', { name: 'Changes' })
    const notesDiscardBtn = within(changesSection).getByRole('button', {
      name: 'wiki/notes.md 변경 사항 롤백'
    })
    const notesStageBtn = within(changesSection).getByRole('button', { name: 'wiki/notes.md Stage' })
    expect(notesDiscardBtn).toHaveAttribute('title', '변경 사항 롤백')
    expect(
      Boolean(notesDiscardBtn.compareDocumentPosition(notesStageBtn) & Node.DOCUMENT_POSITION_FOLLOWING)
    ).toBe(true)

    // Open unstaged Diff(wiki/notes.md) in primary, duplicate to secondary, and replace primary with commit Diff(wiki/notes.md)
    await user.click(within(changesSection).getByText('notes.md'))
    const primaryPane = within(rendered.container).getByTestId('pane-primary')
    await within(primaryPane).findByText('Working Tree')
    const unstagedDiffTab = within(primaryPane).getByRole('tab', { selected: true })
    fireEvent.contextMenu(unstagedDiffTab)
    const tabMenu = await within(rendered.container).findByRole('menu', { name: '탭 작업 메뉴' })
    await user.click(within(tabMenu).getByRole('menuitem', { name: '분할 영역에 복제 열기' }))
    const secondaryPane = await within(rendered.container).findByTestId('pane-secondary')
    expect(within(secondaryPane).getByRole('tab', { name: /notes\.md/ })).toBeInTheDocument()

    // Activate primary pane and open commit Diff for wiki/notes.md
    fireEvent.mouseDown(primaryPane)
    const graphSection = within(gitPanel).getByRole('region', { name: 'Graph' })
    await user.click(within(graphSection).getByRole('button', { name: /Initial commit/ }))
    await user.click(await within(graphSection).findByTitle('wiki/notes.md'))
    expect(await within(primaryPane).findByText('Commit abcdef1')).toBeInTheDocument()

    // 1. Discard M (wiki/notes.md) -> immediate (no modal), syncs clean notes.md buffer, closes secondary unstaged diff tab while preserving primary commit diff & dirty other/config
    await user.click(
      within(changesSection).getByRole('button', { name: 'wiki/notes.md 변경 사항 롤백' })
    )

    await waitFor(() => {
      expect(discardSpy).toHaveBeenCalledWith(workspaceRoot, ['wiki/notes.md'])
      expect(within(rendered.container).queryByTestId('pane-secondary')).toBeNull()
    })
    expect(within(rendered.container).queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(within(rendered.container).queryByText(/외부에서 변경/)).not.toBeInTheDocument()
    expect(
      within(primaryPane).getByRole('tab', { name: /notes\.md \(abcdef1\)/ })
    ).toBeInTheDocument()
    expect(within(rendered.container).getAllByTestId('tab-dirty-indicator')).toHaveLength(2)

    const notesDocTab = within(primaryPane)
      .getAllByRole('tab', { name: /notes\.md/ })
      .find((el) => !el.textContent?.includes('abcdef1'))!
    await user.click(notesDocTab)
    expect(getRawEditorText(within(primaryPane).getByTestId('document-editor'))).toBe('# Head Notes')

    // 2. Also preserve staged Diff tab while discarding D, U, and ? files and updating tree & badge
    await user.click(within(stagedSection).getByText('staged.md'))
    expect(await within(primaryPane).findByText('Staged')).toBeInTheDocument()

    await user.click(
      within(changesSection).getByRole('button', { name: 'wiki/deleted.md 변경 사항 롤백' })
    )
    await user.click(
      within(changesSection).getByRole('button', { name: 'wiki/conflict.md 변경 사항 롤백' })
    )
    await user.click(
      within(changesSection).getByRole('button', { name: 'wiki/untracked.md 변경 사항 롤백' })
    )

    await waitFor(() => {
      expect(within(rendered.container).getByRole('button', { name: 'Git' })).toHaveTextContent('1')
    })
    // Staged diff tab remains open
    expect(within(primaryPane).getByRole('tab', { name: /staged\.md/ })).toBeInTheDocument()
    expect(within(primaryPane).queryByRole('tab', { name: /deleted\.md/ })).not.toBeInTheDocument()

    // Switch back to explorer to confirm deleted.md appeared and untracked.md disappeared
    await user.click(within(rendered.container).getByRole('button', { name: '탐색기' }))
    const refreshedSidebar = within(rendered.container).getByLabelText('워크스페이스 탐색기')
    expect(within(refreshedSidebar).getByText('deleted.md')).toBeInTheDocument()
    expect(within(refreshedSidebar).queryByText('untracked.md')).not.toBeInTheDocument()
  }, 15_000)

  it('handles target-dirty rollback prompt cancel, save-and-proceed, and discard-without-saving with autoSave race suppression', async () => {
    const user = userEvent.setup()
    const workspaceRoot = 'C:/wiki'
    let mainWorkspaceApi: InMemoryWindowHandle['api']['workspace'] | null = null
    let notesDiskContent = '# Worktree Notes'
    let discardDelayMs = 0
    let gitState = createRepoGitStatus(workspaceRoot, {
      unstaged: [{ path: 'notes.md', status: 'M' }]
    })

    const discardSpy = vi.fn(async (_wsPath: string, paths: string[]) => {
      if (discardDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, discardDelayMs))
      }
      if (paths.includes('notes.md')) {
        notesDiskContent = '# Clean Head Notes'
        await mainWorkspaceApi?.writeFile(`${workspaceRoot}/notes.md`, notesDiskContent)
      }
      gitState = {
        ...gitState,
        unstaged: []
      }
      return gitState
    })

    const harness = createHarness(
      { autoSave: false, autoSaveDelayMs: 120, theme: 'light' },
      {
        selectedFolder: 'C:\\wiki',
        workspaces: {
          'C:\\wiki': {
            'notes.md': '# Worktree Notes',
            'other.md': '# Other Dirty'
          }
        },
        git: {
          status: async () => gitState,
          discard: discardSpy
        }
      }
    )

    const mainWin = harness.createWindow({ role: 'main' })
    mainWorkspaceApi = mainWin.api.workspace
    const rendered = render(<App wikiApi={mainWin.api} />)
    trackDisposer(() => rendered.unmount())

    await openFolderAndNoteInWindow(user, rendered.container, mainWin.emitMenuCommand, 'notes.md')
    const explorer = within(rendered.container).getByLabelText('워크스페이스 탐색기')
    await user.click(await within(explorer).findByText('other.md'))
    await waitFor(() => {
      expect(getRawEditorText(within(rendered.container).getByTestId('document-editor'))).toBe(
        '# Other Dirty'
      )
    })
    setRawEditorText(within(rendered.container).getByTestId('document-editor'), '# Other Unsaved')
    const notesTab = within(rendered.container).getByRole('tab', { name: /notes\.md/ })
    await user.click(notesTab)
    await waitFor(() => {
      expect(getRawEditorText(within(rendered.container).getByTestId('document-editor'))).toBe(
        '# Worktree Notes'
      )
    })

    setRawEditorText(
      within(rendered.container).getByTestId('document-editor'),
      '# Dirty Before Cancel'
    )
    await waitFor(() => {
      expect(within(notesTab).getByTestId('tab-dirty-indicator')).toBeInTheDocument()
    })

    await user.click(within(rendered.container).getByRole('button', { name: 'Git' }))
    const gitPanel = await within(rendered.container).findByLabelText('Git 소스 제어')

    // 1. Click ↶ -> prompt lists ONLY target notes.md; 취소 aborts discard and preserves dirty edit
    await user.click(within(gitPanel).getByRole('button', { name: 'notes.md 변경 사항 롤백' }))
    const cancelDialog = await within(rendered.container).findByRole('alertdialog')
    expect(within(cancelDialog).getByText(/notes\.md/)).toBeInTheDocument()
    expect(within(cancelDialog).queryByText(/other\.md/)).not.toBeInTheDocument()
    await user.click(within(cancelDialog).getByRole('button', { name: '취소' }))

    expect(discardSpy).not.toHaveBeenCalled()
    expect(getRawEditorText(within(rendered.container).getByTestId('document-editor'))).toBe(
      '# Dirty Before Cancel'
    )

    // 2. Click ↶ -> 저장 후 진행 saves only target notes.md and proceeds with discard
    await user.click(within(gitPanel).getByRole('button', { name: 'notes.md 변경 사항 롤백' }))
    const saveDialog = await within(rendered.container).findByRole('alertdialog')
    await user.click(within(saveDialog).getByRole('button', { name: '저장 후 진행' }))

    await waitFor(() => {
      expect(discardSpy).toHaveBeenCalledTimes(1)
      expect(getRawEditorText(within(rendered.container).getByTestId('document-editor'))).toBe(
        '# Clean Head Notes'
      )
    })
    expect(harness.getFilesSnapshot().get('C:/wiki/other.md')).toBe('# Other Dirty')

    // 3. Enable autoSave (500ms delay), re-dirty notes.md, then slow discard (650ms > 500ms) with 저장 없이 진행 must suppress auto-save
    await mainWin.api.config.update({ autoSave: true, autoSaveDelayMs: 500 })
    discardDelayMs = 650
    gitState = {
      ...gitState,
      unstaged: [{ path: 'notes.md', status: 'M' }]
    }
    await user.click(within(gitPanel).getByRole('button', { name: 'Git 상태 새로고침' }))
    await waitFor(() => {
      expect(within(gitPanel).getByRole('button', { name: 'notes.md 변경 사항 롤백' })).toBeEnabled()
    })

    setRawEditorText(
      within(rendered.container).getByTestId('document-editor'),
      '# Dirty Before Discard Without Saving'
    )
    await user.click(within(gitPanel).getByRole('button', { name: 'notes.md 변경 사항 롤백' }))
    const skipSaveDialog = await within(rendered.container).findByRole('alertdialog')
    await user.click(within(skipSaveDialog).getByRole('button', { name: '저장 없이 진행' }))

    await waitFor(() => {
      expect(discardSpy).toHaveBeenCalledTimes(2)
      expect(within(notesTab).queryByTestId('tab-dirty-indicator')).toBeNull()
    })
    // Wait past another auto-save delay cycle to verify no late flush overwrote disk
    await new Promise((resolve) => setTimeout(resolve, 550))
    expect(harness.getFilesSnapshot().get('C:/wiki/notes.md')).toBe('# Clean Head Notes')
    expect(getRawEditorText(within(rendered.container).getByTestId('document-editor'))).toBe(
      '# Clean Head Notes'
    )
    expect(within(rendered.container).queryByText(/외부에서 변경/)).not.toBeInTheDocument()
  })

  it('force-syncs restored dirty buffers across main & auxiliary windows and auto-closes removed untracked tabs across windows without close confirmation', async () => {
    const user = userEvent.setup()
    const workspaceRoot = 'C:/wiki'
    let mainWorkspaceApi: InMemoryWindowHandle['api']['workspace'] | null = null
    let gitState = createRepoGitStatus(workspaceRoot, {
      unstaged: [{ path: 'modified.md', status: 'M' }],
      untracked: [{ path: 'draft.md', status: '?' }]
    })

    const harness = createHarness(
      { autoSave: false, theme: 'light' },
      {
        selectedFolder: 'C:\\wiki',
        workspaces: {
          'C:\\wiki': {
            'modified.md': '# Worktree Modified',
            'draft.md': '# Untracked Draft',
            'keep.md': '# Keep Open'
          }
        },
        git: {
          status: async () => gitState,
          discard: async (_wsPath: string, paths: string[]) => {
            const targetSet = new Set(paths)
            if (targetSet.has('modified.md')) {
              await mainWorkspaceApi?.writeFile(`${workspaceRoot}/modified.md`, '# Head Restored')
            }
            if (targetSet.has('draft.md')) {
              await mainWorkspaceApi?.deleteEntry(`${workspaceRoot}/draft.md`).catch(() => undefined)
            }
            gitState = {
              ...gitState,
              unstaged: gitState.unstaged.filter((item) => !targetSet.has(item.path)),
              untracked: gitState.untracked.filter((item) => !targetSet.has(item.path))
            }
            return gitState
          }
        }
      }
    )

    const mainWin = harness.createWindow({ role: 'main' })
    mainWorkspaceApi = mainWin.api.workspace
    const mainRendered = render(<App wikiApi={mainWin.api} />)
    trackDisposer(() => mainRendered.unmount())

    await openFolderAndNoteInWindow(
      user,
      mainRendered.container,
      mainWin.emitMenuCommand,
      'keep.md'
    )
    const explorer = within(mainRendered.container).getByLabelText('워크스페이스 탐색기')
    await user.click(await within(explorer).findByText('modified.md'))
    await detachTabViaContextMenu(user, mainRendered.container, /modified\.md/)
    await user.click(await within(explorer).findByText('modified.md'))
    await user.click(await within(explorer).findByText('draft.md'))
    await detachTabViaContextMenu(user, mainRendered.container, /draft\.md/)
    await user.click(await within(explorer).findByText('draft.md'))

    await waitFor(() => {
      expect(harness.getAuxiliaryWindows()).toHaveLength(2)
    })
    const [auxModified, auxDraft] = harness.getAuxiliaryWindows()
    const auxModifiedRendered = render(<App wikiApi={auxModified.api} />)
    const auxDraftRendered = render(<App wikiApi={auxDraft.api} />)
    trackDisposer(
      () => auxModifiedRendered.unmount(),
      () => auxDraftRendered.unmount()
    )

    // Make modified.md dirty in Aux1 and draft.md dirty in Aux2
    setRawEditorText(
      await within(auxModifiedRendered.container).findByTestId('document-editor'),
      '# Aux Dirty Modified'
    )
    setRawEditorText(
      await within(auxDraftRendered.container).findByTestId('document-editor'),
      '# Aux Dirty Draft'
    )
    await waitFor(() => {
      expect(
        within(auxModifiedRendered.container).getByTestId('dirty-indicator')
      ).toBeInTheDocument()
      expect(within(auxDraftRendered.container).getByTestId('dirty-indicator')).toBeInTheDocument()
    })

    await user.click(within(mainRendered.container).getByRole('button', { name: 'Git' }))
    const gitPanel = await within(mainRendered.container).findByLabelText('Git 소스 제어')

    // 1. Discard modified.md -> prompt, choose 저장 없이 진행 -> both Main & Aux1 show restored content cleanly
    await user.click(within(gitPanel).getByRole('button', { name: 'modified.md 변경 사항 롤백' }))
    const modDialog = await within(mainRendered.container).findByRole('alertdialog')
    await user.click(within(modDialog).getByRole('button', { name: '저장 없이 진행' }))

    await waitFor(() => {
      expect(within(auxModifiedRendered.container).queryByTestId('dirty-indicator')).toBeNull()
    })
    expect(getRawEditorText(within(auxModifiedRendered.container).getByTestId('document-editor'))).toBe(
      '# Head Restored'
    )
    await user.click(within(mainRendered.container).getByRole('tab', { name: /modified\.md/ }))
    expect(getRawEditorText(within(mainRendered.container).getByTestId('document-editor'))).toBe(
      '# Head Restored'
    )
    expect(within(auxModifiedRendered.container).queryByText(/외부에서 변경/)).not.toBeInTheDocument()

    // 2. Discard untracked draft.md -> prompt once, 저장 없이 진행 -> Main tab closes & Aux2 auto-closes without close prompt
    await user.click(within(gitPanel).getByRole('button', { name: 'draft.md 변경 사항 롤백' }))
    const draftDialog = await within(mainRendered.container).findByRole('alertdialog')
    await user.click(within(draftDialog).getByRole('button', { name: '저장 없이 진행' }))

    await waitFor(() => {
      expect(auxDraft.isClosed()).toBe(true)
      expect(within(mainRendered.container).queryByRole('tab', { name: /draft\.md/ })).toBeNull()
    })
    expect(within(auxDraftRendered.container).queryByRole('alertdialog')).toBeNull()
  })

  it('disables 전체 ↶ when 변경 사항 is empty or busy, distinguishes tracked/untracked counts in danger dialog, and cancels cleanly', async () => {
    const user = userEvent.setup()
    const workspaceRoot = 'C:/wiki'
    let resolvePendingPull: ((value: GitStatus) => void) | null = null
    let gitState = createRepoGitStatus(workspaceRoot, {
      hasUpstream: true,
      staged: [{ path: 'staged.md', status: 'M' }]
    })

    const discardAllSpy = vi.fn(async () => gitState)
    const harness = createHarness(
      { autoSave: false, theme: 'light' },
      {
        selectedFolder: 'C:\\wiki',
        workspaces: {
          'C:\\wiki': {
            'staged.md': '# Staged',
            'a.md': '# A',
            'u.md': '<<<<<<< HEAD\na\n=======\nb\n>>>>>>> other',
            'd1.md': '# Draft 1',
            'd2.md': '# Draft 2',
            'd3.md': '# Draft 3'
          }
        },
        git: {
          status: async () => gitState,
          discardAll: discardAllSpy,
          pull: () =>
            new Promise<GitStatus>((resolve) => {
              resolvePendingPull = resolve
            })
        }
      }
    )

    const mainWin = harness.createWindow({ role: 'main' })
    const rendered = render(<App wikiApi={mainWin.api} />)
    trackDisposer(() => rendered.unmount())

    await triggerMenuCommand(mainWin.emitMenuCommand, 'open-folder')
    await within(rendered.container).findByLabelText('워크스페이스 탐색기')
    await user.click(within(rendered.container).getByRole('button', { name: 'Git' }))
    const gitPanel = await within(rendered.container).findByLabelText('Git 소스 제어')

    // 1. 0 unstaged/untracked changes (even with staged files) -> 전체 ↶ disabled & absent from Staged Changes
    const stagedSection = within(gitPanel).getByRole('group', { name: 'Staged Changes' })
    expect(within(stagedSection).queryByRole('button', { name: '전체 변경 사항 롤백' })).toBeNull()

    const discardAllBtn = within(gitPanel).getByRole('button', { name: '전체 변경 사항 롤백' })
    const stageAllBtn = within(gitPanel).getByRole('button', { name: '전체 Stage' })
    expect(discardAllBtn).toHaveAttribute('title', '전체 변경 사항 롤백')
    expect(discardAllBtn.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
    expect(discardAllBtn).toBeDisabled()
    expect(
      Boolean(discardAllBtn.compareDocumentPosition(stageAllBtn) & Node.DOCUMENT_POSITION_FOLLOWING)
    ).toBe(true)

    // 2. Tracked-only (M + U = 2) -> danger dialog shows tracked count & irreversible warning without trash text
    gitState = {
      ...gitState,
      hasConflicts: true,
      unstaged: [
        { path: 'a.md', status: 'M' },
        { path: 'u.md', status: 'U' }
      ],
      untracked: []
    }
    await user.click(within(gitPanel).getByRole('button', { name: 'Git 상태 새로고침' }))
    await waitFor(() => {
      expect(within(gitPanel).getByRole('button', { name: '전체 변경 사항 롤백' })).toBeEnabled()
    })

    await user.click(within(gitPanel).getByRole('button', { name: '전체 변경 사항 롤백' }))
    let dialog = await within(rendered.container).findByRole('alertdialog')
    expect(within(dialog).getAllByRole('button')).toHaveLength(2)
    expect(dialog).toHaveTextContent('2')
    expect(dialog).toHaveTextContent(/복구/)
    expect(dialog).not.toHaveTextContent(/휴지통/)
    let confirmBtn = within(dialog).getByRole('button', { name: '전체 롤백' })
    expect(confirmBtn).toHaveClass('btn-danger')
    expect(confirmBtn).not.toHaveClass('btn-primary')
    await user.click(within(dialog).getByRole('button', { name: '취소' }))
    expect(within(rendered.container).queryByRole('alertdialog')).toBeNull()
    expect(discardAllSpy).not.toHaveBeenCalled()

    // 3. Untracked-only (3) -> danger dialog shows untracked count & OS trash notice without irreversible warning
    gitState = {
      ...gitState,
      hasConflicts: false,
      unstaged: [],
      untracked: [
        { path: 'd1.md', status: '?' },
        { path: 'd2.md', status: '?' },
        { path: 'd3.md', status: '?' }
      ]
    }
    await user.click(within(gitPanel).getByRole('button', { name: 'Git 상태 새로고침' }))
    await waitFor(() => {
      expect(
        within(within(gitPanel).getByRole('group', { name: 'Changes' })).getByText('3')
      ).toBeInTheDocument()
    })

    await user.click(within(gitPanel).getByRole('button', { name: '전체 변경 사항 롤백' }))
    dialog = await within(rendered.container).findByRole('alertdialog')
    expect(within(dialog).getAllByRole('button')).toHaveLength(2)
    expect(dialog).toHaveTextContent('3')
    expect(dialog).toHaveTextContent(/휴지통/)
    expect(dialog).not.toHaveTextContent(/복구/)
    confirmBtn = within(dialog).getByRole('button', { name: '전체 롤백' })
    expect(confirmBtn).toHaveClass('btn-danger')
    await user.click(within(dialog).getByRole('button', { name: '취소' }))
    expect(discardAllSpy).not.toHaveBeenCalled()

    // 4. Mixed tracked (2) + untracked (3) = total 5 -> shows total 5, tracked 2 (복구 불가), untracked 3 (휴지통)
    gitState = {
      ...gitState,
      hasConflicts: true,
      unstaged: [
        { path: 'a.md', status: 'M' },
        { path: 'u.md', status: 'U' }
      ],
      untracked: [
        { path: 'd1.md', status: '?' },
        { path: 'd2.md', status: '?' },
        { path: 'd3.md', status: '?' }
      ]
    }
    await user.click(within(gitPanel).getByRole('button', { name: 'Git 상태 새로고침' }))
    await waitFor(() => {
      expect(
        within(within(gitPanel).getByRole('group', { name: 'Changes' })).getByText('5')
      ).toBeInTheDocument()
    })

    await user.click(within(gitPanel).getByRole('button', { name: '전체 변경 사항 롤백' }))
    dialog = await within(rendered.container).findByRole('alertdialog')
    expect(within(dialog).getAllByRole('button')).toHaveLength(2)
    expect(dialog).toHaveTextContent('5')
    expect(dialog).toHaveTextContent('2')
    expect(dialog).toHaveTextContent('3')
    expect(dialog).toHaveTextContent(/복구/)
    expect(dialog).toHaveTextContent(/휴지통/)
    expect(within(dialog).getByRole('button', { name: '전체 롤백' })).toHaveClass('btn-danger')
    await user.click(within(dialog).getByRole('button', { name: '취소' }))
    expect(discardAllSpy).not.toHaveBeenCalled()

    // 5. Disabled while another Git action is running
    await user.click(within(gitPanel).getByRole('button', { name: '더 보기' }))
    await user.click(within(gitPanel).getByRole('menuitem', { name: 'Pull' }))
    await waitFor(() => {
      expect(within(gitPanel).getByRole('button', { name: '전체 변경 사항 롤백' })).toBeDisabled()
    })
    resolvePendingPull!(gitState)
    await waitFor(() => {
      expect(within(gitPanel).getByRole('button', { name: '전체 변경 사항 롤백' })).toBeEnabled()
    })
  })

  it('executes discardAll with target-only dirty prompts, cross-window sync/tab-closing, closing all unstaged diffs across panes while preserving staged/commit diffs, and updating tree & badge', async () => {
    const user = userEvent.setup()
    const repoRoot = 'C:/repo'
    const workspaceRoot = 'C:/repo/wiki'
    let mainWorkspaceApi: InMemoryWindowHandle['api']['workspace'] | null = null
    let emitWsChange: ((event: WorkspaceChangeEvent) => void) | null = null
    let discardAllDelayMs = 0

    const headContents: Record<string, string> = {
      'wiki/notes.md': '# Head Notes',
      'wiki/deleted.md': '# Head Deleted',
      'wiki/conflict.md': '# Head Conflict'
    }
    let gitState = createRepoGitStatus(repoRoot, {
      hasConflicts: true,
      staged: [{ path: 'wiki/staged.md', status: 'M' }],
      unstaged: [
        { path: 'wiki/notes.md', status: 'M' },
        { path: 'wiki/deleted.md', status: 'D' },
        { path: 'wiki/conflict.md', status: 'U' }
      ],
      untracked: [{ path: 'wiki/draft.md', status: '?' }]
    })

    const discardAllSpy = vi.fn(async () => {
      if (discardAllDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, discardAllDelayMs))
      }
      for (const item of gitState.unstaged) {
        const absPath = `${repoRoot}/${item.path}`
        if (item.path in headContents) {
          await mainWorkspaceApi?.writeFile(absPath, headContents[item.path])
        } else {
          await mainWorkspaceApi?.deleteEntry(absPath).catch(() => undefined)
        }
        const wsRel = item.path.startsWith('wiki/') ? item.path.slice('wiki/'.length) : item.path
        emitWsChange?.({ rootPath: workspaceRoot, eventType: 'change', relativePath: wsRel })
      }
      for (const item of gitState.untracked) {
        const absPath = `${repoRoot}/${item.path}`
        await mainWorkspaceApi?.deleteEntry(absPath).catch(() => undefined)
        const wsRel = item.path.startsWith('wiki/') ? item.path.slice('wiki/'.length) : item.path
        emitWsChange?.({ rootPath: workspaceRoot, eventType: 'unlink', relativePath: wsRel })
      }
      gitState = {
        ...gitState,
        hasConflicts: false,
        unstaged: [],
        untracked: []
      }
      return gitState
    })

    const harness = createHarness(
      { autoSave: false, autoSaveDelayMs: 500, theme: 'light' },
      {
        selectedFolder: 'C:\\repo\\wiki',
        workspaces: {
          'C:\\repo\\wiki': {
            'notes.md': '# Worktree Notes',
            'conflict.md': '<<<<<<< HEAD\n# Head Conflict\n=======\n# Theirs\n>>>>>>> other',
            'draft.md': '# Untracked Draft',
            'other.md': '# Clean Other',
            'staged.md': '# Staged Doc'
          }
        },
        git: {
          status: async () => gitState,
          discardAll: discardAllSpy,
          ...createRollbackHistoryGitMocks()
        }
      }
    )
    emitWsChange = harness.emitWorkspaceChange

    const mainWin = harness.createWindow({ role: 'main' })
    mainWorkspaceApi = mainWin.api.workspace
    const mainRendered = render(<App wikiApi={mainWin.api} />)
    trackDisposer(() => mainRendered.unmount())

    // Open notes.md (also detached to Aux1), draft.md (detached to Aux2), staged.md (dirty non-target), other.md (dirty non-target), config.json (dirty non-target)
    await openFolderAndNoteInWindow(
      user,
      mainRendered.container,
      mainWin.emitMenuCommand,
      'notes.md'
    )
    await detachTabViaContextMenu(user, mainRendered.container, /notes\.md/)
    const explorer = within(mainRendered.container).getByLabelText('워크스페이스 탐색기')
    await user.click(await within(explorer).findByText('notes.md'))
    await user.click(await within(explorer).findByText('draft.md'))
    await detachTabViaContextMenu(user, mainRendered.container, /draft\.md/)
    await user.click(await within(explorer).findByText('draft.md'))

    for (const [fileName, dirtyText] of [
      ['other.md', '# Dirty Other'],
      ['staged.md', '# Dirty Staged Only']
    ] as const) {
      await user.click(await within(explorer).findByText(fileName))
      await waitFor(() => {
        expect(within(mainRendered.container).getByRole('tab', { name: new RegExp(fileName) })).toHaveAttribute(
          'aria-selected',
          'true'
        )
      })
      setRawEditorText(within(mainRendered.container).getByTestId('document-editor'), dirtyText)
    }

    await openConfigFromSettings(user, mainRendered.container, mainWin.emitMenuCommand)
    await within(mainRendered.container).findByRole('tab', { name: /config\.json/ })
    await waitFor(() => {
      expect(getRawEditorText(within(mainRendered.container).getByTestId('document-editor'))).toContain(
        '"autoSave"'
      )
    })
    setRawEditorText(
      within(mainRendered.container).getByTestId('document-editor'),
      '{"autoSave":false,"theme":"dark"}'
    )

    await waitFor(() => {
      expect(harness.getAuxiliaryWindows()).toHaveLength(2)
    })
    const [auxNotes, auxDraft] = harness.getAuxiliaryWindows()
    const auxNotesRendered = render(<App wikiApi={auxNotes.api} />)
    const auxDraftRendered = render(<App wikiApi={auxDraft.api} />)
    trackDisposer(
      () => auxNotesRendered.unmount(),
      () => auxDraftRendered.unmount()
    )

    // Phase 1: Target notes.md is dirty; Primary has unstaged(wiki/notes.md), Secondary has staged(wiki/staged.md) + unstaged(wiki/draft.md)
    setRawEditorText(
      await within(auxNotesRendered.container).findByTestId('document-editor'),
      '# Aux Dirty Notes For Save'
    )

    await user.click(within(mainRendered.container).getByRole('button', { name: 'Git' }))
    const gitPanel = await within(mainRendered.container).findByLabelText('Git 소스 제어')
    expect(within(mainRendered.container).getByRole('button', { name: 'Git' })).toHaveTextContent('5')

    const stagedSection = within(gitPanel).getByRole('group', { name: 'Staged Changes' })
    const changesSection = within(gitPanel).getByRole('group', { name: 'Changes' })

    // Open staged(wiki/staged.md) in Primary and move to Secondary, then open unstaged(wiki/draft.md) in Primary and duplicate to Secondary, then open unstaged(wiki/notes.md) in Primary
    await user.click(within(stagedSection).getByText('staged.md'))
    const primaryPane = within(mainRendered.container).getByTestId('pane-primary')
    await within(primaryPane).findByText('Staged')
    fireEvent.contextMenu(within(primaryPane).getByRole('tab', { selected: true }))
    await user.click(
      within(await within(mainRendered.container).findByRole('menu', { name: '탭 작업 메뉴' })).getByRole(
        'menuitem',
        { name: '분할 영역으로 이동' }
      )
    )
    const secondaryPane = await within(mainRendered.container).findByTestId('pane-secondary')

    fireEvent.mouseDown(primaryPane)
    await user.click(within(changesSection).getByText('draft.md'))
    await within(primaryPane).findByText('Working Tree')
    fireEvent.contextMenu(within(primaryPane).getByRole('tab', { selected: true }))
    await user.click(
      within(await within(mainRendered.container).findByRole('menu', { name: '탭 작업 메뉴' })).getByRole(
        'menuitem',
        { name: '분할 영역에 복제 열기' }
      )
    )
    expect(within(secondaryPane).getByRole('tab', { name: /draft\.md/ })).toBeInTheDocument()
    expect(within(secondaryPane).getByRole('tab', { name: /staged\.md/ })).toBeInTheDocument()

    fireEvent.mouseDown(primaryPane)
    await user.click(within(changesSection).getByText('notes.md'))
    await within(primaryPane).findByText('Working Tree')

    // Canceling at target-only dirty prompt aborts discardAll and keeps dirty edits intact
    await user.click(within(gitPanel).getByRole('button', { name: '전체 변경 사항 롤백' }))
    await user.click(
      within(await within(mainRendered.container).findByRole('alertdialog')).getByRole('button', {
        name: '전체 롤백'
      })
    )
    const dirtyCancelDialog = await within(mainRendered.container).findByRole('alertdialog')
    expect(dirtyCancelDialog).toHaveTextContent(/notes\.md/)
    expect(dirtyCancelDialog).not.toHaveTextContent(/other\.md|staged\.md|config\.json/)
    await user.click(within(dirtyCancelDialog).getByRole('button', { name: '취소' }))
    expect(discardAllSpy).not.toHaveBeenCalled()
    expect(getRawEditorText(within(auxNotesRendered.container).getByTestId('document-editor'))).toBe(
      '# Aux Dirty Notes For Save'
    )

    // Click 전체 ↶ -> danger confirm -> 전체 롤백 -> target-only dirty prompt (only notes.md, NOT other.md/staged.md/config.json) -> 저장 후 진행
    await user.click(within(gitPanel).getByRole('button', { name: '전체 변경 사항 롤백' }))
    const confirmDangerDialog = await within(mainRendered.container).findByRole('alertdialog')
    expect(within(confirmDangerDialog).getByRole('button', { name: '전체 롤백' })).toHaveClass(
      'btn-danger'
    )
    await user.click(within(confirmDangerDialog).getByRole('button', { name: '전체 롤백' }))

    const dirtySaveDialog = await within(mainRendered.container).findByRole('alertdialog')
    expect(dirtySaveDialog).toHaveTextContent(/notes\.md/)
    expect(dirtySaveDialog).not.toHaveTextContent(/other\.md|staged\.md|config\.json/)
    await user.click(within(dirtySaveDialog).getByRole('button', { name: '저장 후 진행' }))

    await waitFor(() => {
      expect(discardAllSpy).toHaveBeenCalledTimes(1)
      expect(auxDraft.isClosed()).toBe(true)
    })
    // Both unstaged diffs across primary & secondary closed; staged diff in secondary remained open
    expect(within(primaryPane).queryByText('Working Tree')).toBeNull()
    expect(within(secondaryPane).queryByRole('tab', { name: /draft\.md/ })).toBeNull()
    expect(within(secondaryPane).getByRole('tab', { name: /staged\.md/ })).toBeInTheDocument()
    // Restored notes.md synced cleanly across Main and Aux1; non-target dirty buffers preserved unsaved on disk
    expect(getRawEditorText(within(auxNotesRendered.container).getByTestId('document-editor'))).toBe(
      '# Head Notes'
    )
    expect(harness.getFilesSnapshot().get('C:/repo/wiki/other.md')).toBe('# Clean Other')
    expect(harness.getFilesSnapshot().get('C:/repo/wiki/staged.md')).toBe('# Staged Doc')
    expect(within(mainRendered.container).getByRole('button', { name: 'Git' })).toHaveTextContent('1')

    // Phase 2: Re-enable autoSave + slow discardAll (650ms > 500ms) with 저장 없이 진행; commit diff in Primary & sole unstaged diff in Secondary
    await mainWin.api.config.update({ autoSave: true, autoSaveDelayMs: 500 })
    discardAllDelayMs = 650
    gitState = {
      ...gitState,
      unstaged: [{ path: 'wiki/notes.md', status: 'M' }]
    }
    await user.click(within(gitPanel).getByRole('button', { name: 'Git 상태 새로고침' }))
    await waitFor(() => {
      expect(within(gitPanel).getByRole('button', { name: '전체 변경 사항 롤백' })).toBeEnabled()
    })

    // Replace secondary staged diff with unstaged(wiki/notes.md), and open commit diff in primary
    fireEvent.mouseDown(secondaryPane)
    await user.click(within(changesSection).getByText('notes.md'))
    expect(await within(secondaryPane).findByText('Working Tree')).toBeInTheDocument()

    fireEvent.mouseDown(primaryPane)
    const graphSection = within(gitPanel).getByRole('region', { name: 'Graph' })
    await user.click(within(graphSection).getByRole('button', { name: /Initial commit/ }))
    await user.click(await within(graphSection).findByTitle('wiki/notes.md'))
    expect(await within(primaryPane).findByText('Commit abcdef1')).toBeInTheDocument()

    // Re-dirty notes.md in Aux1 -> 전체 ↶ -> 전체 롤백 -> 저장 없이 진행
    setRawEditorText(
      within(auxNotesRendered.container).getByTestId('document-editor'),
      '# Aux Dirty Discard Skip'
    )
    await waitFor(() => {
      expect(within(auxNotesRendered.container).getByTestId('dirty-indicator')).toBeInTheDocument()
    })

    await user.click(within(gitPanel).getByRole('button', { name: '전체 변경 사항 롤백' }))
    const phase2Danger = await within(mainRendered.container).findByRole('alertdialog')
    await user.click(within(phase2Danger).getByRole('button', { name: '전체 롤백' }))
    const phase2Dirty = await within(mainRendered.container).findByRole('alertdialog')
    await user.click(within(phase2Dirty).getByRole('button', { name: '저장 없이 진행' }))

    await waitFor(() => {
      expect(discardAllSpy).toHaveBeenCalledTimes(2)
      expect(within(mainRendered.container).queryByTestId('pane-secondary')).toBeNull()
    })
    await new Promise((resolve) => setTimeout(resolve, 550))
    expect(harness.getFilesSnapshot().get('C:/repo/wiki/notes.md')).toBe('# Head Notes')
    expect(getRawEditorText(within(auxNotesRendered.container).getByTestId('document-editor'))).toBe(
      '# Head Notes'
    )
    expect(within(auxNotesRendered.container).queryByTestId('dirty-indicator')).toBeNull()
    expect(within(auxNotesRendered.container).queryByText(/외부에서 변경/)).not.toBeInTheDocument()
    expect(within(primaryPane).getByRole('tab', { name: /notes\.md \(abcdef1\)/ })).toBeInTheDocument()
    expect(within(mainRendered.container).getByRole('button', { name: 'Git' })).toHaveTextContent('1')

    // Explorer tree reflects restored deleted.md and removed draft.md
    await user.click(within(mainRendered.container).getByRole('button', { name: '탐색기' }))
    const refreshedExplorer = within(mainRendered.container).getByLabelText('워크스페이스 탐색기')
    expect(within(refreshedExplorer).getByText('deleted.md')).toBeInTheDocument()
    expect(within(refreshedExplorer).queryByText('draft.md')).toBeNull()
  }, 15_000)
})

describe('Multi-window workspaceState exclusion and close flush (<App />)', () => {
  it('excludes auxiliary windows from workspaceState access and flushes main window expandedDirs before resolving dirty close', async () => {
    const user = userEvent.setup()
    const harness = createHarness(
      { autoSave: false, recentWorkspaces: ['C:\\wiki\\docs'] },
      {
        workspaces: {
          'C:\\wiki\\docs': {
            'note.md': '# Note',
            'extra.md': '# Extra',
            'sub/deep.md': '# Deep'
          }
        }
      }
    )

    const mainWin = harness.createWindow({ role: 'main' })
    const mainGetSpy = vi.spyOn(mainWin.api.workspaceState!, 'get')
    const mainSaveSpy = vi.spyOn(mainWin.api.workspaceState!, 'save')

    const mainRendered = render(<App wikiApi={mainWin.api} />)
    const explorer = await within(mainRendered.container).findByLabelText('워크스페이스 탐색기')
    expect(await within(explorer).findByText('note.md')).toBeInTheDocument()
    expect(mainGetSpy).toHaveBeenCalledTimes(1)

    // Open two tabs and detach note.md into an auxiliary window -> aux window never touches workspaceState
    await user.click(within(explorer).getByText('note.md'))
    await user.click(within(explorer).getByText('extra.md'))
    const noteTab = within(mainRendered.container).getByRole('tab', { name: /note\.md/ })
    fireEvent.contextMenu(noteTab)
    const tabMenu = await within(mainRendered.container).findByRole('menu')
    await user.click(within(tabMenu).getByRole('menuitem', { name: '새 창으로 이동' }))

    await waitFor(() => {
      expect(harness.getAuxiliaryWindows()).toHaveLength(1)
    })
    const auxWin = harness.getAuxiliaryWindows()[0]
    const auxGetSpy = vi.spyOn(auxWin.api.workspaceState!, 'get')
    const auxSaveSpy = vi.spyOn(auxWin.api.workspaceState!, 'save')
    const auxRendered = render(<App wikiApi={auxWin.api} />)
    expect(await within(auxRendered.container).findByTestId('document-editor')).toBeInTheDocument()
    expect(auxGetSpy).not.toHaveBeenCalled()
    expect(auxSaveSpy).not.toHaveBeenCalled()

    // Make main window dirty, expand sub right before closing, and discard on close prompt -> flushed before close resolves
    const mainEditor = within(mainRendered.container).getByTestId('document-editor')
    setRawEditorText(mainEditor, '# Dirty before close')
    const savesBeforeSub = mainSaveSpy.mock.calls.length
    await user.click(within(explorer).getByText('sub'))
    expect(await within(explorer).findByText('deep.md')).toBeInTheDocument()
    expect(mainSaveSpy).toHaveBeenCalledTimes(savesBeforeSub)

    act(() => {
      mainWin.requestClose()
    })
    const closeDialog = await within(mainRendered.container).findByRole('alertdialog')
    await user.click(within(closeDialog).getByRole('button', { name: '버리고 닫기' }))

    await waitFor(() => {
      expect(mainWin.isClosed()).toBe(true)
    })
    expect(mainSaveSpy).toHaveBeenCalledTimes(savesBeforeSub + 1)
    const saved = await mainWin.api.workspaceState!.get('C:/wiki/docs')
    expect(saved?.expandedDirs).toEqual(['C:\\wiki\\docs\\sub'])
    expect(saved?.layout.panes.primary.tabs.map((tab) => tab.path)).toEqual([
      'C:\\wiki\\docs\\extra.md'
    ])
    expect(auxGetSpy).not.toHaveBeenCalled()
    expect(auxSaveSpy).not.toHaveBeenCalled()
  })

  it('flushes pending expandedDirs immediately on clean main window close without showing confirm dialog', async () => {
    const user = userEvent.setup()
    const harness = createHarness(
      { autoSave: false, recentWorkspaces: ['C:\\wiki\\docs'] },
      {
        workspaces: {
          'C:\\wiki\\docs': {
            'note.md': '# Note',
            'sub/deep.md': '# Deep'
          }
        }
      }
    )

    const mainWin = harness.createWindow({ role: 'main' })
    const mainSaveSpy = vi.spyOn(mainWin.api.workspaceState!, 'save')

    const mainRendered = render(<App wikiApi={mainWin.api} />)
    const explorer = await within(mainRendered.container).findByLabelText('워크스페이스 탐색기')
    expect(await within(explorer).findByText('note.md')).toBeInTheDocument()

    await user.click(within(explorer).getByText('sub'))
    expect(await within(explorer).findByText('deep.md')).toBeInTheDocument()
    expect(mainSaveSpy).not.toHaveBeenCalled()

    // Clean close (no dirty buffers) -> no confirm dialog, yet flushes expandedDirs before closing
    act(() => {
      mainWin.requestClose()
    })
    expect(within(mainRendered.container).queryByRole('alertdialog')).not.toBeInTheDocument()

    await waitFor(() => {
      expect(mainWin.isClosed()).toBe(true)
    })
    expect(mainSaveSpy).toHaveBeenCalledTimes(1)
    const saved = await mainWin.api.workspaceState!.get('C:/wiki/docs')
    expect(saved?.expandedDirs).toEqual(['C:\\wiki\\docs\\sub'])
  })

  it('excludes auxiliary window splits/tabs from workspaceState and flushes main split layout and tab view state on clean close', async () => {
    const user = userEvent.setup()
    const harness = createHarness(
      { autoSave: false, recentWorkspaces: ['C:\\wiki\\docs'] },
      {
        workspaces: {
          'C:\\wiki\\docs': {
            'primary.md': '# Primary\n\nBody text',
            'secondary.md': '# Secondary\n\nMore text',
            'detached.md': '# Detached'
          }
        }
      }
    )

    const mainWin = harness.createWindow({ role: 'main' })
    const mainRendered = render(<App wikiApi={mainWin.api} />)
    const explorer = await within(mainRendered.container).findByLabelText('워크스페이스 탐색기')
    await user.click(await within(explorer).findByText('primary.md'))
    await user.click(within(explorer).getByText('secondary.md'))
    await user.click(within(explorer).getByText('detached.md'))

    // Detach detached.md to auxiliary window, and set split + wysiwyg in auxiliary -> never persisted
    const detachedTab = within(mainRendered.container).getByRole('tab', { name: /detached\.md/ })
    fireEvent.contextMenu(detachedTab)
    await user.click(
      within(await within(mainRendered.container).findByRole('menu')).getByRole('menuitem', {
        name: '새 창으로 이동'
      })
    )
    await waitFor(() => {
      expect(harness.getAuxiliaryWindows()).toHaveLength(1)
    })
    const auxWin = harness.getAuxiliaryWindows()[0]
    const auxRendered = render(<App wikiApi={auxWin.api} />)
    const auxModeSwitcher = await within(auxRendered.container).findByRole('group', {
      name: '에디터 모드 전환'
    })
    await user.click(within(auxModeSwitcher).getByRole('button', { name: '위지윅' }))

    // In main window: move secondary.md to secondary pane, switch primary.md to split mode with cursor & scroll, then clean close immediately
    const mainPrimary = within(mainRendered.container).getByTestId('pane-primary')
    fireEvent.contextMenu(within(mainPrimary).getByRole('tab', { name: /secondary\.md/ }))
    await user.click(
      within(await within(mainRendered.container).findByRole('menu', { name: '탭 작업 메뉴' })).getByRole(
        'menuitem',
        { name: '분할 영역으로 이동' }
      )
    )
    const mainSplitter = within(mainRendered.container).getByRole('separator', {
      name: '화면 분할 크기 조절'
    })
    fireEvent.keyDown(mainSplitter, { key: 'ArrowRight' })
    expect(mainSplitter).toHaveAttribute('aria-valuenow', '55')

    await user.click(within(mainPrimary).getByRole('tab', { name: /primary\.md/ }))
    await user.click(
      within(within(mainPrimary).getByRole('group', { name: '에디터 모드 전환' })).getByRole(
        'button',
        { name: 'Split' }
      )
    )
    const splitRaw = within(mainPrimary).getAllByTestId('document-editor')[0]
    setRawEditorSelection(splitRaw, 3, 7)
    const splitScroller = getRawEditorScroller(splitRaw)
    splitScroller.scrollTop = 135
    fireEvent.scroll(splitScroller)

    act(() => {
      mainWin.requestClose()
    })
    await waitFor(() => {
      expect(mainWin.isClosed()).toBe(true)
    })
    mainRendered.unmount()

    // Reopen main window -> primary.md (split) + secondary.md (raw) at 55% restore; detached.md in aux does NOT restore
    const reopenedWin = harness.createWindow({ role: 'main' })
    const reopenedRendered = render(<App wikiApi={reopenedWin.api} />)
    await waitFor(() => {
      expect(within(reopenedRendered.container).getByTestId('pane-workspace')).toHaveAttribute(
        'data-split-mode',
        'horizontal'
      )
    })
    expect(within(reopenedRendered.container).queryByRole('tab', { name: /detached\.md/ })).toBeNull()
    expect(
      within(reopenedRendered.container).getByRole('separator', { name: '화면 분할 크기 조절' })
    ).toHaveAttribute('aria-valuenow', '55')
    const restoredSplitRaw = within(
      within(reopenedRendered.container).getByTestId('pane-primary')
    ).getAllByTestId('document-editor')[0]
    expect(getRawEditorSelection(restoredSplitRaw)).toEqual({ start: 3, end: 7 })
    expect(getRawEditorScroller(restoredSplitRaw).scrollTop).toBe(135)
  })
})
