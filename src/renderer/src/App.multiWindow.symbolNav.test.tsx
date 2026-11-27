// @vitest-environment jsdom
import { fireEvent, render, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { createEmptyGitStatus, type GitDiffRequest } from '@shared/git'
import type { GitBlobSnapshotRequest, SymbolQueryRequest } from '@shared/symbol'
import { App } from './App'
import { clickActivityBarButton } from './test/appTestHelpers'
import {
  createCrossWindowDataTransfer,
  detachTabViaContextMenu,
  dispatchDragEndAtScreenPoint,
  registerMultiWindowLifecycle
} from './test/multiWindowTestHelpers'
import { triggerMenuCommand } from './test/inMemoryWikiHarness'

vi.mock('mermaid', async () => (await import('./test/appTestHelpers')).createMermaidMockState().module)

const SAMPLE_PATCH = [
  'diff --git a/src/caller.ts b/src/caller.ts',
  'index 1111111..2222222 100644',
  '--- a/src/caller.ts',
  '+++ b/src/caller.ts',
  '@@ -1,3 +1,4 @@',
  ' export function runCaller() {',
  '+  return computeTotal(1, 2)',
  ' }'
].join('\n')

function createSymbolMultiWindowHarness(
  createHarness: ReturnType<typeof registerMultiWindowLifecycle>['createHarness']
) {
  const workspaceRoot = 'C:\\wiki\\repo'
  const searchSymbolsMock = vi.fn(async (req: SymbolQueryRequest) => {
    const query = req.symbolName ?? req.declarationQuery ?? ''
    if (query === 'computeTotal' || req.declarationQuery) {
      if (req.declarationQuery) {
        return [
          {
            path: 'src/math.ts',
            lineNumber: 1,
            lineText: 'export function computeTotal(a: number, b: number) {',
            columnStart: 17,
            columnEnd: 29
          }
        ]
      }
      return [
        {
          path: 'src/math.ts',
          lineNumber: 1,
          lineText: 'export function computeTotal(a: number, b: number) {',
          columnStart: 17,
          columnEnd: 29
        },
        {
          path: 'src/caller.ts',
          lineNumber: 2,
          lineText: '  return computeTotal(1, 2)',
          columnStart: 10,
          columnEnd: 22
        }
      ]
    }
    if (query === 'helperFn') {
      return [
        {
          path: 'src/helper.ts',
          lineNumber: 1,
          lineText: 'export function helperFn() { return 42 }',
          columnStart: 17,
          columnEnd: 25
        }
      ]
    }
    return []
  })

  const readBlobSnapshotMock = vi.fn(async (_ws: string, req: GitBlobSnapshotRequest) => {
    if (req.path === 'src/caller.ts') {
      return {
        path: req.path,
        scope: req.scope,
        isBinary: false,
        isTruncated: false,
        existsInWorkspace: true,
        encoding: 'utf-8' as const,
        content: 'export function runCaller() {\n  return computeTotal(1, 2)\n}\n'
      }
    }
    if (req.path === 'src/math.ts') {
      return {
        path: req.path,
        scope: req.scope,
        isBinary: false,
        isTruncated: false,
        existsInWorkspace: true,
        encoding: 'utf-8' as const,
        content: 'export function computeTotal(a: number, b: number) {\n  return helperFn()\n}\n'
      }
    }
    return {
      path: req.path,
      scope: req.scope,
      isBinary: false,
      isTruncated: false,
      existsInWorkspace: true,
      encoding: 'utf-8' as const,
      content: 'export function helperFn() {\n  return 42\n}\n'
    }
  })

  const harness = createHarness(
    { autoSave: false, theme: 'light' },
    {
      selectedFolder: workspaceRoot,
      workspaces: {
        [workspaceRoot]: {
          'src/caller.ts': 'export function runCaller() {\n  return computeTotal(1, 2)\n}\n',
          'src/math.ts': 'export function computeTotal(a: number, b: number) {\n  return helperFn()\n}\n',
          'src/helper.ts': 'export function helperFn() {\n  return 42\n}\n'
        },
        'C:\\wiki\\other-repo': {
          'README.md': '# Other Repo\n'
        },
        'C:\\wiki\\third-repo': {
          'README.md': '# Third Repo\n'
        }
      },
      git: {
        status: vi.fn(async (ws: string) => ({
          ...createEmptyGitStatus(true, ws),
          repoRoot: workspaceRoot,
          branch: 'main',
          staged: [{ path: 'src/caller.ts', status: 'M' as const }]
        })),
        diff: vi.fn(async (_ws: string, req: GitDiffRequest) => ({
          path: req.path,
          status: req.status,
          isBinary: false,
          isTruncated: false,
          existsInWorkspace: true,
          rawPatch: SAMPLE_PATCH
        })),
        readBlobSnapshot: readBlobSnapshotMock
      }
    }
  )

  return { harness, workspaceRoot, searchSymbolsMock, readBlobSnapshotMock }
}

describe('Multi-window Snapshot tab detach/re-merge and symbol navigation parity (<App />)', () => {
  const { createHarness } = registerMultiWindowLifecycle()

  it('supports detaching a Snapshot tab to an auxiliary window with Ctrl+F, symbol outline, Ctrl+click, Shift+F12 references, history, Ctrl+T palette, and re-merge', async () => {
    const user = userEvent.setup()
    const { harness, searchSymbolsMock } = createSymbolMultiWindowHarness(createHarness)

    const mainWin = harness.createWindow({ role: 'main' })
    mainWin.api.workspace.searchSymbols = searchSymbolsMock
    const mainRendered = render(<App wikiApi={mainWin.api} />)

    await user.click(within(mainRendered.container).getByRole('button', { name: '폴더 열기...' }))
    await within(mainRendered.container).findByText('repo')

    // Open staged/commit-like Diff tab via staged or unstaged? Let's open staged diff so Ctrl+click opens 🔒 Staged snapshot tab
    await clickActivityBarButton(user, 'Git')
    const diffRow = await within(mainRendered.container).findByText('caller.ts')
    await user.click(diffRow)
    const primaryPane = within(mainRendered.container).getByTestId('pane-primary')
    await within(primaryPane).findByText('좌우 비교')

    // Ctrl+click computeTotal on the added line of the Staged Diff -> opens 🔒 Staged · math.ts Snapshot tab
    const computeTotalEl = await waitFor(() => {
      const el = within(primaryPane).getByText('computeTotal')
      expect(el).toHaveClass('tok-function')
      return el
    })
    fireEvent.click(computeTotalEl, { ctrlKey: true, clientX: 120, clientY: 120 })

    const snapshotTab = await within(primaryPane).findByRole('tab', { name: /math\.ts/ })
    expect(snapshotTab.textContent).toContain('🔒 Staged')
    await within(primaryPane).findByTestId('snapshot-viewer')
    expect(within(primaryPane).getByRole('button', { name: '로컬 파일 열기' })).toBeInTheDocument()

    // Detach the Snapshot tab to an Auxiliary Window
    await detachTabViaContextMenu(user, primaryPane, /math\.ts/)
    await waitFor(() => {
      expect(harness.getAuxiliaryWindows(mainWin.windowId)).toHaveLength(1)
    })

    const auxWin = harness.getAuxiliaryWindows(mainWin.windowId)[0]
    auxWin.api.workspace.searchSymbols = searchSymbolsMock
    const auxRendered = render(<App wikiApi={auxWin.api} />)

    const auxPrimaryPane = await within(auxRendered.container).findByTestId('pane-primary')
    await within(auxPrimaryPane).findByTestId('snapshot-viewer')
    expect(auxWin.isClosed()).toBe(false)
    expect(within(auxPrimaryPane).getByRole('button', { name: '로컬 파일 열기' })).toBeInTheDocument()

    // 1. Ctrl+F Find Bar works on Snapshot tab in Auxiliary Window
    fireEvent.keyDown(auxPrimaryPane, { key: 'f', ctrlKey: true })
    const auxFindInput = await within(auxRendered.container).findByLabelText('문서 내 검색어 입력')
    fireEvent.change(auxFindInput, { target: { value: 'helperFn' } })
    expect(within(auxRendered.container).getByText('1 / 1')).toBeInTheDocument()
    fireEvent.keyDown(auxFindInput, { key: 'Escape' })

    // 2. Right sidebar expands and shows symbol Document Outline for the Snapshot tab
    await user.click(within(auxRendered.container).getByRole('button', { name: '문서 목차 펼치기' }))
    const auxRightSidebar = await within(auxRendered.container).findByRole('complementary', {
      name: '우측 사이드바'
    })
    expect(await within(auxRightSidebar).findByText('computeTotal')).toBeInTheDocument()

    // 3. Ctrl+click helperFn in the Auxiliary Window's Snapshot tab -> jumps to 🔒 Staged · helper.ts
    const helperFnEl = within(auxPrimaryPane).getByText('helperFn')
    fireEvent.click(helperFnEl, { ctrlKey: true, clientX: 100, clientY: 100 })
    await waitFor(() => {
      expect(within(auxPrimaryPane).getByRole('tab', { name: /helper\.ts/ })).toBeInTheDocument()
    })

    // 4. Per-pane navigation history (← / →) works in Auxiliary Window
    const backBtn = within(auxPrimaryPane).getByRole('button', { name: '이전 위치로 이동' })
    expect(backBtn).not.toBeDisabled()
    await user.click(backBtn)
    await waitFor(() => {
      const activeTab = within(auxPrimaryPane).getByRole('tab', { selected: true })
      expect(activeTab.textContent).toContain('math.ts')
    })

    // 5. Shift+F12 Find References works in Auxiliary Window
    const snapshotViewerEl = within(auxPrimaryPane).getByTestId('snapshot-viewer')
    const mathSym = await waitFor(() => {
      const el = within(auxPrimaryPane).getByText('computeTotal')
      expect(el).toHaveClass('tok-function')
      return el
    })
    fireEvent.mouseMove(mathSym, { ctrlKey: true, clientX: 100, clientY: 100 })
    fireEvent.keyDown(snapshotViewerEl, { key: 'F12', shiftKey: true })
    await waitFor(() => {
      expect(within(auxRightSidebar).getByText('src/caller.ts')).toBeInTheDocument()
    })

    // 6. Ctrl+T Symbol Search Palette works in Auxiliary Window
    fireEvent.keyDown(auxPrimaryPane, { key: 't', ctrlKey: true })
    const paletteInput = await within(auxRendered.container).findByPlaceholderText(
      /심볼 선언 검색/
    )
    fireEvent.change(paletteInput, { target: { value: 'computeTotal' } })
    fireEvent.keyDown(paletteInput, { key: 'Enter' })
    await waitFor(() => {
      expect(within(auxRendered.container).getByRole('listbox')).toBeInTheDocument()
    })
    fireEvent.keyDown(paletteInput, { key: 'Escape' })

    // 7. Close helper.ts and drag math.ts Snapshot tab from Auxiliary Window back to Main Window tab bar -> re-merges & closes Aux
    await user.click(within(auxPrimaryPane).getByRole('button', { name: 'helper.ts 탭 닫기' }))
    expect(auxWin.isClosed()).toBe(false)
    const auxMathTab = within(auxPrimaryPane).getByRole('tab', { name: /math\.ts/ })
    const dt = createCrossWindowDataTransfer()
    fireEvent.dragStart(auxMathTab, { dataTransfer: dt })
    await new Promise((resolve) => setTimeout(resolve, 0))
    fireEvent.drop(within(primaryPane).getByRole('tab', { name: /caller\.ts/ }), {
      dataTransfer: dt
    })
    await waitFor(() => {
      expect(within(primaryPane).getByRole('tab', { name: /math\.ts/ })).toBeInTheDocument()
    })
    dispatchDragEndAtScreenPoint(auxMathTab, 100, 100)

    await waitFor(() => {
      expect(within(auxPrimaryPane).queryByRole('tab', { name: /math\.ts/ })).toBeNull()
      expect(auxWin.isClosed()).toBe(true)
    })
  })

  it('supports detaching a Diff tab to an auxiliary window with Ctrl+F, symbol outline, Ctrl+click, Shift+F12 references, history, and re-merge', async () => {
    const user = userEvent.setup()
    const { harness, searchSymbolsMock } = createSymbolMultiWindowHarness(createHarness)

    const mainWin = harness.createWindow({ role: 'main' })
    mainWin.api.workspace.searchSymbols = searchSymbolsMock
    const mainRendered = render(<App wikiApi={mainWin.api} />)

    await user.click(within(mainRendered.container).getByRole('button', { name: '폴더 열기...' }))
    await within(mainRendered.container).findByText('repo')

    // Keep helper.ts open in Main Window so tab bar remains present after detaching Diff tab
    await user.click(await within(mainRendered.container).findByText('src'))
    await user.click(await within(mainRendered.container).findByText('helper.ts'))
    const primaryPane = within(mainRendered.container).getByTestId('pane-primary')
    await within(primaryPane).findByRole('tab', { name: /helper\.ts/ })

    await clickActivityBarButton(user, 'Git')
    const diffRow = await within(mainRendered.container).findByText('caller.ts')
    await user.click(diffRow)
    await within(primaryPane).findByText('좌우 비교')

    // Detach the Diff tab to an Auxiliary Window
    await detachTabViaContextMenu(user, primaryPane, /caller\.ts/)
    await waitFor(() => {
      expect(harness.getAuxiliaryWindows(mainWin.windowId)).toHaveLength(1)
    })

    const auxWin = harness.getAuxiliaryWindows(mainWin.windowId)[0]
    auxWin.api.workspace.searchSymbols = searchSymbolsMock
    const auxRendered = render(<App wikiApi={auxWin.api} />)

    const auxPrimaryPane = await within(auxRendered.container).findByTestId('pane-primary')
    await within(auxPrimaryPane).findByText('좌우 비교')

    // 1. Ctrl+F Find Bar works on Diff tab in Auxiliary Window
    fireEvent.keyDown(auxPrimaryPane, { key: 'f', ctrlKey: true })
    const auxFindInput = await within(auxRendered.container).findByLabelText('문서 내 검색어 입력')
    fireEvent.change(auxFindInput, { target: { value: 'computeTotal' } })
    expect(within(auxRendered.container).getByText('1 / 1')).toBeInTheDocument()
    fireEvent.keyDown(auxFindInput, { key: 'Escape' })

    // 2. Right sidebar expands and shows symbol Document Outline for the Diff tab
    await user.click(within(auxRendered.container).getByRole('button', { name: '문서 목차 펼치기' }))
    const auxRightSidebar = await within(auxRendered.container).findByRole('complementary', {
      name: '우측 사이드바'
    })
    expect(await within(auxRightSidebar).findByText('runCaller')).toBeInTheDocument()

    // 3. Shift+F12 Find References works on Diff tab in Auxiliary Window
    const diffViewerEl = auxPrimaryPane.querySelector('.git-diff-viewer') as HTMLElement
    const computeTotalEl = await waitFor(() => {
      const el = within(auxPrimaryPane).getByText('computeTotal')
      expect(el).toHaveClass('tok-function')
      return el
    })
    fireEvent.mouseMove(computeTotalEl, { ctrlKey: true, clientX: 100, clientY: 100 })
    fireEvent.keyDown(diffViewerEl, { key: 'F12', shiftKey: true })
    await waitFor(() => {
      expect(within(auxRightSidebar).getByText('src/math.ts')).toBeInTheDocument()
    })

    // 4. Ctrl+click computeTotal in Aux Diff tab -> jumps to 🔒 Staged · math.ts Snapshot tab & records history
    fireEvent.click(computeTotalEl, { ctrlKey: true, clientX: 120, clientY: 120 })
    await waitFor(() => {
      expect(within(auxPrimaryPane).getByRole('tab', { name: /math\.ts/ })).toBeInTheDocument()
    })

    const backBtn = within(auxPrimaryPane).getByRole('button', { name: '이전 위치로 이동' })
    expect(backBtn).not.toBeDisabled()
    await user.click(backBtn)
    await waitFor(() => {
      const activeTab = within(auxPrimaryPane).getByRole('tab', { selected: true })
      expect(activeTab.textContent).toContain('caller.ts')
    })

    // 5. Close math.ts and drag Diff tab from Auxiliary Window back to Main Window tab bar -> re-merges & closes Aux
    await user.click(within(auxPrimaryPane).getByRole('button', { name: 'math.ts 탭 닫기' }))
    const auxDiffTab = within(auxPrimaryPane).getByRole('tab', { name: /caller\.ts/ })
    const dt = createCrossWindowDataTransfer()
    fireEvent.dragStart(auxDiffTab, { dataTransfer: dt })
    await new Promise((resolve) => setTimeout(resolve, 0))
    fireEvent.drop(within(primaryPane).getByRole('tab', { name: /helper\.ts/ }), {
      dataTransfer: dt
    })
    await waitFor(() => {
      expect(within(primaryPane).getByRole('tab', { name: /caller\.ts/ })).toBeInTheDocument()
    })
    dispatchDragEndAtScreenPoint(auxDiffTab, 100, 100)

    await waitFor(() => {
      expect(within(auxPrimaryPane).queryByRole('tab', { name: /math\.ts/ })).toBeNull()
      expect(auxWin.isClosed()).toBe(true)
    })
  })

  it('clears snapshot tabs, per-pane navigation history, references section, and symbol palette on workspace switch without leaking across focused main windows', async () => {
    const user = userEvent.setup()
    const { harness, workspaceRoot, searchSymbolsMock } = createSymbolMultiWindowHarness(createHarness)
    const secondWorkspaceRoot = 'C:\\wiki\\other-repo'

    const mainWinA = harness.createWindow({ role: 'main' })
    mainWinA.api.workspace.searchSymbols = searchSymbolsMock
    const renderedA = render(<App wikiApi={mainWinA.api} />)

    await user.click(within(renderedA.container).getByRole('button', { name: '폴더 열기...' }))
    await within(renderedA.container).findByText('repo')

    // Open Staged Diff -> Ctrl+click computeTotal -> opens Snapshot tab & pushes backStack
    await clickActivityBarButton(user, 'Git')
    await user.click(await within(renderedA.container).findByText('caller.ts'))
    const primaryPaneA = within(renderedA.container).getByTestId('pane-primary')
    const computeTotalEl = await within(primaryPaneA).findByText('computeTotal')
    fireEvent.click(computeTotalEl, { ctrlKey: true, clientX: 120, clientY: 120 })
    await within(primaryPaneA).findByTestId('snapshot-viewer')
    expect(within(primaryPaneA).getByRole('button', { name: '이전 위치로 이동' })).not.toBeDisabled()

    // Trigger Shift+F12 to populate References section
    const snapshotViewerA = within(primaryPaneA).getByTestId('snapshot-viewer')
    const helperFnEl = await waitFor(() => {
      const el = within(primaryPaneA).getByText('helperFn')
      expect(el).toHaveClass('tok-function')
      return el
    })
    fireEvent.mouseMove(helperFnEl, { ctrlKey: true, clientX: 100, clientY: 100 })
    fireEvent.keyDown(snapshotViewerA, { key: 'F12', shiftKey: true })
    const rightSidebarA = await within(renderedA.container).findByRole('complementary', {
      name: '우측 사이드바'
    })
    await waitFor(() => {
      expect(within(rightSidebarA).getByText('src/helper.ts')).toBeInTheDocument()
    })

    // Open a second Main Window on secondWorkspaceRoot in its own session
    await mainWinA.api.workspace.openInNewWindow!(secondWorkspaceRoot)
    const mainWinB = harness
      .getMainWindows()
      .find((win) => win.windowId !== mainWinA.windowId)!
    expect(mainWinB).toBeDefined()
    const renderedB = render(<App wikiApi={mainWinB.api} />)
    await within(renderedB.container).findByText('README.md')

    // Clicking an already-open workspace (secondWorkspaceRoot) from Main Window A focuses Main Window B without altering A
    const focusIfOpenSpy = vi.spyOn(mainWinA.api.workspace, 'focusIfOpen')
    const activityBarA = within(renderedA.container).getByRole('navigation', { name: '액티비티 바' })
    await user.click(within(activityBarA).getByRole('button', { name: '워크스페이스' }))
    const otherWorkspaceItem = await within(renderedA.container).findByText('other-repo')
    await user.click(otherWorkspaceItem)
    await waitFor(() => expect(focusIfOpenSpy).toHaveBeenCalled())
    expect(await focusIfOpenSpy.mock.results[0]?.value).toMatchObject({ focused: true })
    // Main Window A still has its workspaceRoot and Snapshot tab intact
    expect(within(primaryPaneA).getByTestId('snapshot-viewer')).toBeInTheDocument()

    // Open Ctrl+T Symbol Search Palette right before switching workspace
    fireEvent.keyDown(primaryPaneA, { key: 't', ctrlKey: true })
    expect(
      await within(renderedA.container).findByPlaceholderText(/심볼 선언 검색/)
    ).toBeInTheDocument()

    // Now switch Main Window A to a brand-new workspace via menu open-folder -> all session-only symbol nav state resets
    const thirdWorkspaceRoot = 'C:\\wiki\\third-repo'
    mainWinA.api.workspace.selectFolder = async () => thirdWorkspaceRoot
    await triggerMenuCommand(mainWinA.emitMenuCommand, 'open-folder')
    const thirdReadme = await within(renderedA.container).findByText('README.md')
    await user.click(thirdReadme)

    await waitFor(() => {
      // Snapshot tab cleared
      expect(within(primaryPaneA).queryByTestId('snapshot-viewer')).toBeNull()
      expect(within(primaryPaneA).queryByRole('tab', { name: /math\.ts/ })).toBeNull()
      // Per-pane navigation history cleared
      expect(within(primaryPaneA).getByRole('button', { name: '이전 위치로 이동' })).toBeDisabled()
      expect(within(primaryPaneA).getByRole('button', { name: '다음 위치로 이동' })).toBeDisabled()
      // Symbol Search Palette closed
      expect(within(renderedA.container).queryByPlaceholderText(/심볼 선언 검색/)).toBeNull()
      // References section cleared (no stale src/helper.ts from previous workspace)
      expect(within(renderedA.container).queryByText('src/helper.ts')).toBeNull()
      expect(workspaceRoot).not.toBe(thirdWorkspaceRoot)
    })
  })
})
