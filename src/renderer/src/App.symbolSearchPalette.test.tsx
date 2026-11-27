// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createEmptyGitStatus, type GitDiffRequest } from '@shared/git'
import type { WikiGitApi } from '@shared/ipc'
import type { GitBlobSnapshotRequest, SymbolQueryRequest } from '@shared/symbol'
import { App } from './App'
import { clickActivityBarButton } from './test/appTestHelpers'
import { createInMemoryWikiApi, triggerMenuCommand } from './test/inMemoryWikiHarness'

vi.mock('mermaid', async () => (await import('./test/appTestHelpers')).createMermaidMockState().module)

describe('App Ctrl+T Symbol Search Palette and Diff/Snapshot Ctrl+F integration', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-theme')
    vi.useRealTimers()
  })

  it('opens Symbol Search Palette with Ctrl+T, suppresses background shortcuts, handles IME & Enter immediate search, and jumps with navigation history', async () => {
    const user = userEvent.setup()

    const searchSymbolsSpy = vi.fn(async (req: SymbolQueryRequest) => {
      if (req.declarationQuery === 'buildWidget' || req.declarationQuery === '위젯') {
        return [
          {
            path: 'src/other.ts',
            lineNumber: 1,
            lineText: 'export function buildWidget() { return 0 }',
            columnStart: 16,
            columnEnd: 27
          },
          {
            path: 'src/changed.ts',
            lineNumber: 2,
            lineText: 'export function buildWidget() { return 1 }',
            columnStart: 16,
            columnEnd: 27
          }
        ]
      }
      return []
    })

    const { api, emitMenuCommand } = createInMemoryWikiApi(
      { autoSave: false },
      {
        selectedFolder: 'C:/wiki',
        workspaces: {
          'C:/wiki': {
            'src/main.ts': 'export const appName = "wiki"\n',
            'src/other.ts': 'export function buildWidget() { return 0 }\n',
            'src/changed.ts': '// header\nexport function buildWidget() { return 1 }\n'
          }
        }
      }
    )
    api.workspace.searchSymbols = searchSymbolsSpy
    window.wikiApi = api

    render(<App />)
    triggerMenuCommand(emitMenuCommand, 'open-folder')
    const explorer = await screen.findByLabelText('워크스페이스 탐색기')
    const srcFolder = await within(explorer).findByText('src')
    await user.click(srcFolder)
    await within(explorer).findByText('main.ts')

    // Open src/main.ts
    await user.click(within(explorer).getByText('main.ts'))
    await screen.findByTestId('document-editor')

    // Open SettingsPanel -> Ctrl+T must be suppressed while modal is open
    await triggerMenuCommand(emitMenuCommand, 'toggle-settings')
    await screen.findByRole('dialog', { name: '전역 설정 패널' })
    fireEvent.keyDown(window, { key: 't', ctrlKey: true })
    expect(screen.queryByRole('dialog', { name: '심볼 검색 팔레트' })).toBeNull()
    await user.click(screen.getByRole('button', { name: '닫기' }))
    expect(screen.queryByRole('dialog', { name: '전역 설정 패널' })).toBeNull()

    // Ctrl+T opens Symbol Search Palette in working-tree scope
    fireEvent.keyDown(window, { key: 't', ctrlKey: true })
    const palette = await screen.findByRole('dialog', { name: '심볼 검색 팔레트' })
    expect(palette.textContent).toContain('워킹트리')

    // Background shortcuts (Ctrl+Shift+F) must be suppressed while palette is open
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true, shiftKey: true })
    expect(screen.queryByPlaceholderText(/파일명 또는 본문 검색/)).toBeNull()

    // IME composition should not trigger search until composition ends
    const input = within(palette).getByRole('textbox', { name: '심볼 이름 검색' })
    fireEvent.compositionStart(input)
    fireEvent.change(input, { target: { value: '위젯' } })
    expect(searchSymbolsSpy).not.toHaveBeenCalled()
    fireEvent.compositionEnd(input, { target: { value: '위젯' } })

    // Enter triggers immediate search without waiting for debounce
    fireEvent.change(input, { target: { value: 'buildWidget' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => {
      expect(searchSymbolsSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          declarationQuery: 'buildWidget',
          scope: { kind: 'working-tree' }
        })
      )
    })

    const options = await within(palette).findAllByRole('option')
    expect(options).toHaveLength(2)

    // ArrowDown moves selection to second option and Enter jumps + records history
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(options[1].getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: '심볼 검색 팔레트' })).toBeNull()
    })

    // Verify jumped to src/other.ts (options[1], since changed.ts sorts before other.ts) and back button returns to main.ts
    const activeTab = screen.getByRole('tab', { selected: true })
    expect(activeTab.textContent).toContain('other.ts')

    const backBtn = screen.getByRole('button', { name: '이전 위치로 이동' })
    expect(backBtn).toBeEnabled()
    await user.click(backBtn)
    await waitFor(() => {
      expect(screen.getByRole('tab', { selected: true }).textContent).toContain('main.ts')
    })

    // Ctrl+T again and Esc closes palette
    fireEvent.keyDown(window, { key: 't', ctrlKey: true })
    await screen.findByRole('dialog', { name: '심볼 검색 팔레트' })
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: '심볼 검색 팔레트' })).toBeNull()
  })

  it('reflects active commit Diff tab Git Ref, prioritizes changed files, and opens 🔒 <ref> snapshot tab', async () => {
    const user = userEvent.setup()

    const callerDiffPatch = [
      'diff --git a/src/caller.ts b/src/caller.ts',
      '--- a/src/caller.ts',
      '+++ b/src/caller.ts',
      '@@ -1,2 +1,3 @@',
      ' import { greet } from "./helper"',
      '+export function run() { return greet() }'
    ].join('\n')

    const searchSymbolsSpy = vi.fn(async (req: SymbolQueryRequest) => {
      if (req.declarationQuery === 'helperFn') {
        return [
          {
            path: 'src/unrelated.ts',
            lineNumber: 1,
            lineText: 'export function helperFn() {}',
            columnStart: 16,
            columnEnd: 24
          },
          {
            path: 'src/changedPeer.ts',
            lineNumber: 4,
            lineText: 'export function helperFn() {}',
            columnStart: 16,
            columnEnd: 24
          }
        ]
      }
      return []
    })

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
            subject: 'feat: commit',
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
        subject: 'feat: commit',
        body: '',
        refs: [],
        files: [
          { path: 'src/caller.ts', status: 'M' as const },
          { path: 'src/changedPeer.ts', status: 'M' as const }
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
        content: '// 1\n// 2\n// 3\nexport function helperFn() {}\n'
      }))
    }

    const { api, emitMenuCommand } = createInMemoryWikiApi(
      { autoSave: false },
      {
        selectedFolder: 'C:/wiki',
        workspaces: {
          'C:/wiki': {
            'src/caller.ts': 'export function run() {}\n',
            'src/changedPeer.ts': 'export function helperFn() {}\n'
          }
        },
        git: gitMocks
      }
    )
    api.workspace.searchSymbols = searchSymbolsSpy
    window.wikiApi = api

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    await clickActivityBarButton(user, 'Git')
    const commitRow = await screen.findByText('feat: commit')
    await user.click(commitRow)
    const callerFile = await screen.findByText('caller.ts')
    await user.click(callerFile)
    await screen.findByTestId('diff-side-by-side')

    // Ctrl+F works inside Diff tab via PaneWorkspace / usePaneDocumentFind
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true })
    const findInput = await screen.findByRole('textbox', { name: '문서 내 검색어 입력' })
    await user.type(findInput, 'greet')
    expect(screen.getByRole('region', { name: '문서 내 찾기 바' }).textContent).toContain('1 / 3')
    fireEvent.keyDown(findInput, { key: 'Escape' })
    expect(screen.queryByRole('region', { name: '문서 내 찾기 바' })).toBeNull()

    // Ctrl+T reflects commit Git Ref (abc1234) and prioritizes changedPeer.ts over unrelated.ts
    fireEvent.keyDown(window, { key: 't', ctrlKey: true })
    const palette = await screen.findByRole('dialog', { name: '심볼 검색 팔레트' })
    expect(palette.textContent).toContain('abc1234')

    const paletteInput = within(palette).getByRole('textbox', { name: '심볼 이름 검색' })
    fireEvent.change(paletteInput, { target: { value: 'helperFn' } })
    fireEvent.keyDown(paletteInput, { key: 'Enter' })

    await waitFor(() => {
      expect(searchSymbolsSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          declarationQuery: 'helperFn',
          scope: { kind: 'git-ref', ref: 'abc1234567890', displayRef: 'abc1234' }
        })
      )
    })

    const options = await within(palette).findAllByRole('option')
    expect(options).toHaveLength(2)
    expect(options[0].textContent).toContain('changedPeer.ts')
    expect(options[0].textContent).toContain('변경')

    // Select first option -> opens 🔒 abc1234 snapshot tab
    await user.click(options[0])
    const snapshotViewer = await screen.findByTestId('snapshot-viewer')
    expect(snapshotViewer.textContent).toContain('🔒 abc1234')
    expect(snapshotViewer.textContent).toContain('changedPeer.ts')

    // Ctrl+F also works inside the opened Snapshot tab
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true })
    const snapFindInput = await screen.findByRole('textbox', { name: '문서 내 검색어 입력' })
    await user.clear(snapFindInput)
    await user.type(snapFindInput, 'helperFn')
    expect(screen.getByRole('region', { name: '문서 내 찾기 바' }).textContent).toContain('1 / 1')
  })
})
