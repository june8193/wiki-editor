// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createEmptyGitStatus, type GitDiffRequest } from '@shared/git'
import type { WikiGitApi } from '@shared/ipc'
import type { GitBlobSnapshotRequest, SymbolQueryRequest } from '@shared/symbol'
import { App } from './App'
import { clickActivityBarButton } from './test/appTestHelpers'
import { createInMemoryWikiApi, getRawEditorView, triggerMenuCommand } from './test/inMemoryWikiHarness'

vi.mock('mermaid', async () => (await import('./test/appTestHelpers')).createMermaidMockState().module)

describe('App snapshot tab, per-pane navigation history, and Ctrl+click symbol definition navigation', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-theme')
    vi.useRealTimers()
  })

  it('opens a 🔒 <ref> snapshot tab from commit diff Ctrl+click, supports [로컬 파일 열기], and navigates back/forward per pane', async () => {
    const user = userEvent.setup()

    const callerDiffPatch = [
      'diff --git a/src/caller.ts b/src/caller.ts',
      '--- a/src/caller.ts',
      '+++ b/src/caller.ts',
      '@@ -1,3 +1,4 @@',
      ' import { greet } from "./helper"',
      '+export function run() {',
      '+  return greet()',
      '+}'
    ].join('\n')

    const helperSnapshotContent = [
      'export const VERSION = 1',
      'export function greet() {',
      '  return "hello from commit"',
      '}'
    ].join('\n')

    const gitMocks: Partial<WikiGitApi> = {
      status: vi.fn(async () => ({
        ...createEmptyGitStatus(true, 'C:/wiki'),
        branch: 'main'
      })),
      log: vi.fn(async () => ({
        commits: [
          {
            hash: 'abc1234567890',
            shortHash: 'abc1234',
            parents: ['0000000'],
            authorName: 'Alice',
            authorEmail: 'alice@example.com',
            committedAt: '2026-11-26T10:00:00Z',
            subject: 'feat: call greet',
            body: '',
            refs: []
          }
        ],
        hasMore: false
      })),
      commitDetail: vi.fn(async () => ({
        hash: 'abc1234567890',
        shortHash: 'abc1234',
        parents: ['0000000'],
        authorName: 'Alice',
        authorEmail: 'alice@example.com',
        committedAt: '2026-11-26T10:00:00Z',
        subject: 'feat: call greet',
        body: '',
        refs: [],
        files: [{ path: 'src/caller.ts', status: 'M' as const }]
      })),
      diff: vi.fn(async (_ws: string, req: GitDiffRequest) => ({
        path: req.path,
        status: req.status,
        isBinary: false,
        isTruncated: false,
        existsInWorkspace: true,
        rawPatch: callerDiffPatch
      })),
      readBlobSnapshot: vi.fn(async (_ws: string, req: GitBlobSnapshotRequest) => ({
        path: req.path,
        scope: req.scope,
        isBinary: false,
        isTruncated: false,
        existsInWorkspace: true,
        encoding: 'utf-8' as const,
        content: helperSnapshotContent
      }))
    }

    const { api, emitMenuCommand } = createInMemoryWikiApi(
      { autoSave: false },
      {
        selectedFolder: 'C:/wiki',
        workspaces: {
          'C:/wiki': {
            'src/caller.ts': 'import { greet } from "./helper"\nexport function run() {\n  return greet()\n}\n',
            'src/helper.ts': 'export function greet() {\n  return "local"\n}\n'
          }
        },
        git: gitMocks
      }
    )
    api.workspace.searchSymbols = vi.fn(async (query: SymbolQueryRequest) => {
      if (query.symbolName === 'greet') {
        return [
          {
            path: 'src/helper.ts',
            lineNumber: 2,
            lineText: 'export function greet() {',
            columnStart: 16,
            columnEnd: 21
          }
        ]
      }
      return []
    })

    window.wikiApi = api
    render(<App />)

    await clickActivityBarButton(user, '탐색기')
    const explorer = screen.getByLabelText('워크스페이스 탐색기')
    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    await within(explorer).findByText('src')

    // Open Git sidebar -> expand commit -> click changed file to open commit Diff tab
    await clickActivityBarButton(user, 'Git')
    const commitRow = await screen.findByText('feat: call greet')
    await user.click(commitRow)
    const changedFile = await screen.findByText('caller.ts')
    await user.click(changedFile)

    const diffViewer = await screen.findByTestId('diff-side-by-side')
    await waitFor(() => {
      expect(within(diffViewer).getAllByText('greet').length).toBeGreaterThan(0)
    })

    // Ctrl+Click on `greet` in the new-side line (last occurrence = `return greet()`)
    const greetTokens = within(diffViewer).getAllByText('greet')
    const greetToken = greetTokens[greetTokens.length - 1]
    fireEvent.click(greetToken, { ctrlKey: true })

    // Should open a 🔒 abc1234 snapshot tab & SnapshotViewer
    const snapshotViewer = await screen.findByTestId('snapshot-viewer')
    expect(within(snapshotViewer).getByText('🔒 abc1234')).toBeTruthy()
    expect(within(snapshotViewer).getByRole('status').textContent).toContain('읽기 전용')
    expect(screen.queryByRole('button', { name: '저장' })).toBeNull()

    // Right sidebar outline should show symbols for the snapshot file
    const rightSidebar = screen.getByLabelText('우측 사이드바')
    await waitFor(() => {
      expect(within(rightSidebar).getByText('VERSION')).toBeTruthy()
    })

    // Pane history back button should be enabled and return to the Diff tab
    const backBtn = screen.getByRole('button', { name: '이전 위치로 이동' })
    expect((backBtn as HTMLButtonElement).disabled).toBe(false)
    await user.click(backBtn)

    await waitFor(() => {
      expect(screen.getByTestId('diff-side-by-side')).toBeTruthy()
    })

    // Forward button should return to the snapshot tab
    const forwardBtn = screen.getByRole('button', { name: '다음 위치로 이동' })
    expect((forwardBtn as HTMLButtonElement).disabled).toBe(false)
    await user.click(forwardBtn)

    const restoredSnapshot = await screen.findByTestId('snapshot-viewer')
    expect(within(restoredSnapshot).getByText('🔒 abc1234')).toBeTruthy()

    // Clicking [로컬 파일 열기] opens the local editable Raw tab
    await user.click(within(restoredSnapshot).getByRole('button', { name: '로컬 파일 열기' }))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '저장' })).toBeTruthy()
    })

    void emitMenuCommand
    void triggerMenuCommand
  })

  it('shows candidate picker popover when multiple declarations exist', async () => {
    const user = userEvent.setup()

    const callerCode = ['import { sharedFn } from "./a"', 'sharedFn()'].join('\n')
    const fileA = 'export function sharedFn() { return 1 }\n'
    const fileB = 'export function sharedFn() { return 2 }\n'

    const { api, emitMenuCommand } = createInMemoryWikiApi(
      { autoSave: false },
      {
        selectedFolder: 'C:/wiki',
        workspaces: {
          'C:/wiki': {
            'src/caller.ts': callerCode,
            'src/a.ts': fileA,
            'src/b.ts': fileB
          }
        }
      }
    )

    window.wikiApi = api
    render(<App />)

    await clickActivityBarButton(user, '탐색기')
    const explorer = screen.getByLabelText('워크스페이스 탐색기')
    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    await user.click(await within(explorer).findByText('src'))
    const callerTreeItem = await within(explorer).findByText('caller.ts')
    await user.click(callerTreeItem)

    await waitFor(() => {
      expect(screen.getByTestId('document-editor')).toBeTruthy()
    })

    // Ctrl+Click on `sharedFn` in Raw code editor -> shows candidate picker popover
    const rawEditor = await screen.findByTestId('document-editor')
    const sharedFnEl = within(rawEditor).getAllByText('sharedFn').pop()!
    fireEvent.click(sharedFnEl, { ctrlKey: true })

    const popover = await screen.findByTestId('symbol-candidate-popover')
    expect(popover.textContent).toContain('선언 후보 (2)')
    expect(within(popover).getByText('src/a.ts:1')).toBeTruthy()
    expect(within(popover).getByText('src/b.ts:1')).toBeTruthy()

    await user.click(within(popover).getByText('src/b.ts:1'))
    await waitFor(() => {
      expect(screen.queryByTestId('symbol-candidate-popover')).toBeNull()
    })
  })

  it('finds references via context menu & Shift+F12, auto-expands right sidebar, keeps list open across jumps, and restores 문서 속성 for markdown', async () => {
    const user = userEvent.setup()

    const callerCode = ['import { helperFn } from "./helper"', 'const a = helperFn()', 'export { helperFn }'].join('\n')
    const helperCode = 'export function helperFn() { return 1 }\n'
    const otherCode = '// helperFn in comment\nconst b = helperFn()\n'
    const markdownCode = '# Guide\n\nBody text\n'

    const { api, emitMenuCommand } = createInMemoryWikiApi(
      { autoSave: false },
      {
        selectedFolder: 'C:/wiki',
        workspaces: {
          'C:/wiki': {
            'src/caller.ts': callerCode,
            'src/helper.ts': helperCode,
            'src/other.ts': otherCode,
            'guide.md': markdownCode
          }
        }
      }
    )

    window.wikiApi = api
    render(<App />)

    await clickActivityBarButton(user, '탐색기')
    const explorer = screen.getByLabelText('워크스페이스 탐색기')
    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    await user.click(await within(explorer).findByText('src'))
    await user.click(await within(explorer).findByText('caller.ts'))

    await waitFor(() => {
      expect(screen.getByTestId('document-editor')).toBeTruthy()
    })

    // Collapse the right sidebar first to verify auto-expand on Find References
    const rightSidebar = screen.getByLabelText('우측 사이드바')
    await user.click(within(rightSidebar).getByRole('button', { name: '문서 목차 접기' }))
    expect(screen.queryByLabelText('우측 사이드바')).toBeNull()

    // Right-click `helperFn` in Raw code editor -> click '레퍼런스 찾기'
    const rawEditor = await screen.findByTestId('document-editor')
    const helperToken = await within(rawEditor).findByText('helperFn')
    fireEvent.contextMenu(helperToken)

    const contextMenu = await screen.findByTestId('symbol-context-menu')
    await user.click(within(contextMenu).getByRole('menuitem', { name: '레퍼런스 찾기' }))

    // Right sidebar auto-expands and shows 레퍼런스 section with comment excluded
    const expandedSidebar = await screen.findByLabelText('우측 사이드바')
    const refSection = within(expandedSidebar).getByRole('region', { name: '레퍼런스' })
    await waitFor(() => {
      expect(within(refSection).getByText('src/other.ts')).toBeInTheDocument()
    })
    expect(within(refSection).queryByText('// helperFn in comment')).toBeNull()
    expect(within(refSection).getByText('const b = helperFn()')).toBeInTheDocument()

    // Click reference item -> jumps to src/other.ts, list stays open
    await user.click(within(refSection).getByText('const b = helperFn()'))
    await waitFor(() => {
      expect(screen.getByTestId('document-editor').textContent).toContain('const b = helperFn()')
    })
    expect(within(refSection).getByText('src/caller.ts')).toBeInTheDocument()

    // Switch to markdown file -> restores 문서 속성
    await user.click(within(explorer).getByText('guide.md'))
    await waitFor(() => {
      expect(within(expandedSidebar).getByRole('region', { name: '문서 속성' })).toBeInTheDocument()
    })
    expect(within(expandedSidebar).queryByRole('region', { name: '레퍼런스' })).toBeNull()
  })

  it('falls back to References section on Ctrl+click when no declaration exists but other references exist, and shows Esc-dismissible tooltip for external symbols', async () => {
    const user = userEvent.setup()

    const fileA = 'unknownShared()\n'
    const fileB = 'const res = unknownShared()\n'
    const fileC = 'consoleOnlyExternal()\n'

    const { api, emitMenuCommand } = createInMemoryWikiApi(
      { autoSave: false },
      {
        selectedFolder: 'C:/wiki',
        workspaces: {
          'C:/wiki': {
            'src/a.ts': fileA,
            'src/b.ts': fileB,
            'src/c.ts': fileC
          }
        }
      }
    )

    window.wikiApi = api
    render(<App />)

    await clickActivityBarButton(user, '탐색기')
    const explorer = screen.getByLabelText('워크스페이스 탐색기')
    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    await user.click(await within(explorer).findByText('src'))
    await user.click(await within(explorer).findByText('a.ts'))

    const rawEditor = await screen.findByTestId('document-editor')
    const unknownSharedEl = within(rawEditor).getByText('unknownShared')
    fireEvent.click(unknownSharedEl, { ctrlKey: true })

    // No declaration, but src/b.ts also references unknownShared -> opens References with fallback notice
    const rightSidebar = screen.getByLabelText('우측 사이드바')
    const refSection = within(rightSidebar).getByRole('region', { name: '레퍼런스' })
    await waitFor(() => {
      expect(
        within(refSection).getByText('명확한 선언부를 찾지 못해 참조 2건을 표시합니다')
      ).toBeInTheDocument()
    })
    expect(within(refSection).getByText('src/b.ts')).toBeInTheDocument()

    // Now open c.ts and Ctrl+click consoleOnlyExternal (no other references anywhere)
    await user.click(within(explorer).getByText('c.ts'))
    await waitFor(() => {
      expect(screen.getByTestId('document-editor').textContent).toContain('consoleOnlyExternal')
    })
    const extEl = within(screen.getByTestId('document-editor')).getByText('consoleOnlyExternal')
    fireEvent.click(extEl, { ctrlKey: true })

    const tooltip = await screen.findByTestId('symbol-not-found-tooltip')
    expect(tooltip.textContent).toContain('consoleOnlyExternal')
    // Existing References section is NOT overwritten
    expect(within(refSection).getByText('src/b.ts')).toBeInTheDocument()

    // Esc dismisses tooltip
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => {
      expect(screen.queryByTestId('symbol-not-found-tooltip')).toBeNull()
    })
  })

  it('supports Shift+F12 in Raw code editor and right-click Find References in DiffViewer with changed-file priority and scope badge', async () => {
    const user = userEvent.setup()

    const callerDiffPatch = [
      'diff --git a/src/caller.ts b/src/caller.ts',
      '--- a/src/caller.ts',
      '+++ b/src/caller.ts',
      '@@ -1,3 +1,4 @@',
      ' import { greet } from "./helper"',
      '+export function run() {',
      '+  return greet()',
      '+}'
    ].join('\n')

    const helperSnapshot = 'export function greet() {\n  return "commit"\n}\n'
    const callerSnapshot = 'import { greet } from "./helper"\nexport function run() {\n  return greet()\n}\n'
    const otherSnapshot = 'import { greet } from "./helper"\nexport const x = greet()\n'

    const gitMocks: Partial<WikiGitApi> = {
      status: vi.fn(async () => ({
        ...createEmptyGitStatus(true, 'C:/wiki'),
        branch: 'main'
      })),
      log: vi.fn(async () => ({
        commits: [
          {
            hash: 'abc1234567890',
            shortHash: 'abc1234',
            parents: ['0000000'],
            authorName: 'Alice',
            authorEmail: 'alice@example.com',
            committedAt: '2026-11-26T10:00:00Z',
            subject: 'feat: call greet',
            body: '',
            refs: []
          }
        ],
        hasMore: false
      })),
      commitDetail: vi.fn(async () => ({
        hash: 'abc1234567890',
        shortHash: 'abc1234',
        parents: ['0000000'],
        authorName: 'Alice',
        authorEmail: 'alice@example.com',
        committedAt: '2026-11-26T10:00:00Z',
        subject: 'feat: call greet',
        body: '',
        refs: [],
        files: [
          { path: 'src/caller.ts', status: 'M' as const },
          { path: 'src/other.ts', status: 'M' as const }
        ]
      })),
      diff: vi.fn(async (_ws: string, req: GitDiffRequest) => ({
        path: req.path,
        status: req.status,
        isBinary: false,
        isTruncated: false,
        existsInWorkspace: true,
        rawPatch: callerDiffPatch
      })),
      readBlobSnapshot: vi.fn(async (_ws: string, req: GitBlobSnapshotRequest) => ({
        path: req.path,
        scope: req.scope,
        isBinary: false,
        isTruncated: false,
        existsInWorkspace: true,
        encoding: 'utf-8' as const,
        content:
          req.path === 'src/helper.ts'
            ? helperSnapshot
            : req.path === 'src/other.ts'
              ? otherSnapshot
              : callerSnapshot
      }))
    }

    const { api, emitMenuCommand } = createInMemoryWikiApi(
      { autoSave: false },
      {
        selectedFolder: 'C:/wiki',
        workspaces: {
          'C:/wiki': {
            'src/caller.ts': callerSnapshot,
            'src/helper.ts': 'export function greet() { return "local" }\n',
            'src/other.ts': otherSnapshot
          }
        },
        git: gitMocks
      }
    )
    api.workspace.searchSymbols = vi.fn(async (query: SymbolQueryRequest) => {
      if (query.symbolName === 'greet') {
        return [
          { path: 'src/helper.ts', lineNumber: 1, lineText: 'export function greet() {', columnStart: 16, columnEnd: 21 },
          { path: 'src/other.ts', lineNumber: 2, lineText: 'export const x = greet()', columnStart: 17, columnEnd: 22 }
        ]
      }
      return []
    })

    window.wikiApi = api
    render(<App />)

    await clickActivityBarButton(user, '탐색기')
    const explorer = screen.getByLabelText('워크스페이스 탐색기')
    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    await within(explorer).findByText('src')

    // 1. Open Git commit diff -> right-click `greet` -> '레퍼런스 찾기'
    await clickActivityBarButton(user, 'Git')
    await user.click(await screen.findByText('feat: call greet'))
    await user.click(await screen.findByText('caller.ts'))

    const diffViewer = await screen.findByTestId('diff-side-by-side')
    await waitFor(() => {
      expect(within(diffViewer).getAllByText('greet').length).toBeGreaterThan(0)
    })
    const greetTokens = within(diffViewer).getAllByText('greet')
    fireEvent.contextMenu(greetTokens[greetTokens.length - 1], { clientX: 160, clientY: 180 })

    const contextMenu = await screen.findByTestId('symbol-context-menu')
    await user.click(within(contextMenu).getByRole('menuitem', { name: '레퍼런스 찾기' }))

    const rightSidebar = screen.getByLabelText('우측 사이드바')
    const refSection = within(rightSidebar).getByRole('region', { name: '레퍼런스' })
    await waitFor(() => {
      expect(within(refSection).getByText('abc1234')).toBeInTheDocument()
      expect(within(refSection).getByText('src/other.ts')).toBeInTheDocument()
    })
    expect(within(refSection).getByText('변경됨')).toBeInTheDocument()

    // 2. Open local Raw file and press Shift+F12 on `greet`
    await clickActivityBarButton(user, '탐색기')
    const reopenedExplorer = screen.getByLabelText('워크스페이스 탐색기')
    await user.click(await within(reopenedExplorer).findByText('src'))
    await user.click(await within(reopenedExplorer).findByText('other.ts'))
    await waitFor(() => {
      expect(screen.getByTestId('document-editor').textContent).toContain('export const x = greet()')
    })
    const cmView = getRawEditorView(screen.getByTestId('document-editor'))!
    const offset = cmView.state.doc.toString().lastIndexOf('greet')
    cmView.dispatch({ selection: { anchor: offset + 1 } })
    fireEvent.keyDown(cmView.contentDOM, { key: 'F12', shiftKey: true })

    await waitFor(() => {
      expect(within(refSection).getByText('워킹트리')).toBeInTheDocument()
    })
  })
})
