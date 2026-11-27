// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createEmptyGitStatus, type GitDiffRequest } from '@shared/git'
import type { WikiGitApi } from '@shared/ipc'
import type { GitBlobSnapshotRequest } from '@shared/symbol'
import { App } from './App'
import { clickActivityBarButton } from './test/appTestHelpers'
import { createInMemoryWikiApi, triggerMenuCommand } from './test/inMemoryWikiHarness'

vi.mock('mermaid', async () => (await import('./test/appTestHelpers')).createMermaidMockState().module)

describe('App Ctrl+F in Diff/Snapshot tabs and Ctrl+T Symbol Search Palette', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-theme')
    vi.useRealTimers()
  })

  it('supports Ctrl+F Find Bar on Diff and Snapshot tabs with per-pane state isolation and Esc close', async () => {
    const user = userEvent.setup()
    const patch = [
      'diff --git a/src/demo.ts b/src/demo.ts',
      '--- a/src/demo.ts',
      '+++ b/src/demo.ts',
      '@@ -1,3 +1,4 @@',
      ' export function alpha() {',
      '+  const beta = alpha()',
      '+  return beta',
      ' }'
    ].join('\n')

    const gitMocks: Partial<WikiGitApi> = {
      status: vi.fn(async () => ({
        ...createEmptyGitStatus(true, 'C:/wiki'),
        branch: 'main',
        unstaged: [{ path: 'src/demo.ts', status: 'M' as const }]
      })),
      diff: vi.fn(async (_ws: string, req: GitDiffRequest) => ({
        path: req.path,
        status: req.status,
        isBinary: false,
        isTruncated: false,
        existsInWorkspace: true,
        rawPatch: patch
      })),
      readBlobSnapshot: vi.fn(async (_ws: string, req: GitBlobSnapshotRequest) => ({
        path: req.path,
        scope: req.scope,
        isBinary: false,
        isTruncated: false,
        existsInWorkspace: true,
        encoding: 'utf-8' as const,
        content: 'export function gamma() { return 1 }\nconst x = gamma()'
      }))
    }

    const { api, emitMenuCommand } = createInMemoryWikiApi(
      { autoSave: false },
      {
        selectedFolder: 'C:/wiki',
        workspaces: {
          'C:/wiki': {
            'src/demo.ts': 'export function alpha() {\n  const beta = alpha()\n  return beta\n}\n'
          }
        },
        git: gitMocks
      }
    )

    window.wikiApi = api
    const { container } = render(<App />)

    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    await clickActivityBarButton(user, 'Git')
    const diffFileRow = await screen.findByText('demo.ts')
    await user.click(diffFileRow)
    await screen.findByText('좌우 비교')

    // Ctrl+F on Diff tab opens Find Bar
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true })
    const findInput = screen.getByLabelText('문서 내 검색어 입력') as HTMLInputElement
    fireEvent.change(findInput, { target: { value: 'beta' } })
    expect(screen.getByText('1 / 2')).toBeTruthy()
    expect(container.querySelectorAll('.viewer-search-match').length).toBe(2)

    // Switching to a regular Document tab in the same pane preserves the pane's Find Bar query
    await user.click(screen.getByRole('button', { name: '파일 열기' }))
    await screen.findByTestId('document-editor')
    const persistedInput = screen.getByLabelText('문서 내 검색어 입력') as HTMLInputElement
    expect(persistedInput.value).toBe('beta')

    // Esc closes Find Bar and clears highlights
    fireEvent.keyDown(persistedInput, { key: 'Escape' })
    expect(screen.queryByLabelText('문서 내 검색어 입력')).toBeNull()
    expect(container.querySelectorAll('.viewer-search-match').length).toBe(0)
  })
})
