import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createEmptyGitStatus, type GitDiffRequest } from '@shared/git'
import type { WikiGitApi } from '@shared/ipc'
import { App } from './App'
import { clickActivityBarButton } from './test/appTestHelpers'
import { createInMemoryWikiApi, triggerMenuCommand } from './test/inMemoryWikiHarness'

vi.mock('mermaid', async () => (await import('./test/appTestHelpers')).createMermaidMockState().module)

describe('App code Raw highlighting, symbol outline, and diff symbol jump', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-theme')
    vi.useRealTimers()
  })

  it('shows filtered symbol outline for code Raw tab and diff tab, jumps to lines, and restores markdown headings', async () => {
    const user = userEvent.setup()

    const tsContent = [
      'export interface UserData {',
      '  id: string',
      '}',
      '',
      'export function findUser(id: string): UserData {',
      '  return { id }',
      '}',
      '',
      'export function deleteUser(id: string): void {',
      '  void id',
      '}'
    ].join('\n')

    const mdContent = ['# Project Overview', '', '## Setup Guide'].join('\n')

    const rawPatch = [
      'diff --git a/src/service.ts b/src/service.ts',
      '--- a/src/service.ts',
      '+++ b/src/service.ts',
      '@@ -1,7 +1,11 @@',
      ' export interface UserData {',
      '   id: string',
      ' }',
      ' ',
      '-export function findUser(id: string): UserData {',
      '+export function findUser(id: string, strict: boolean): UserData {',
      '   return { id }',
      ' }',
      '+export function createUser(id: string): UserData {',
      '+  return { id }',
      '+}'
    ].join('\n')

    const gitMocks: Partial<WikiGitApi> = {
      status: vi.fn(async () => ({
        ...createEmptyGitStatus(true, 'C:/wiki'),
        branch: 'main',
        unstaged: [{ path: 'src/service.ts', status: 'M' as const }]
      })),
      diff: vi.fn(async (_ws: string, req: GitDiffRequest) => ({
        path: req.path,
        status: req.status,
        isBinary: false,
        isTruncated: false,
        existsInWorkspace: true,
        rawPatch
      }))
    }

    const { api, emitMenuCommand } = createInMemoryWikiApi(
      { autoSave: false },
      {
        selectedFolder: 'C:/wiki',
        workspaces: {
          'C:/wiki': {
            'note.md': mdContent,
            'src/service.ts': tsContent
          }
        },
        git: gitMocks
      }
    )
    window.wikiApi = api

    const { container } = render(<App />)

    await clickActivityBarButton(user, '탐색기')
    const explorer = screen.getByLabelText('워크스페이스 탐색기')
    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    await within(explorer).findByText('note.md')

    // 1. Open markdown file -> Outline shows markdown headings
    await user.click(within(explorer).getByText('note.md'))
    const outlineRegion = screen.getByRole('region', { name: '문서 목차 (Outline)' })
    expect(await within(outlineRegion).findByText('Project Overview')).toBeInTheDocument()
    expect(within(outlineRegion).getByRole('button', { name: '목차 번호 표시' })).toBeInTheDocument()

    // 2. Open code file in Raw mode -> Lezer highlighting + symbol outline + filter + line jump
    await user.click(within(explorer).getByText('src'))
    await user.click(await within(explorer).findByText('service.ts'))

    await waitFor(() => {
      expect(within(outlineRegion).getByRole('searchbox', { name: '심볼 필터' })).toBeInTheDocument()
      expect(within(outlineRegion).getByRole('button', { name: /findUser/ })).toBeInTheDocument()
      expect(within(outlineRegion).getByRole('button', { name: /deleteUser/ })).toBeInTheDocument()
    })
    expect(within(outlineRegion).queryByRole('button', { name: '목차 번호 표시' })).not.toBeInTheDocument()

    // Filter symbols by name
    const filterInput = within(outlineRegion).getByRole('searchbox', { name: '심볼 필터' })
    await user.type(filterInput, 'delete')
    expect(within(outlineRegion).queryByRole('button', { name: /findUser/ })).not.toBeInTheDocument()
    expect(within(outlineRegion).getByRole('button', { name: /deleteUser/ })).toBeInTheDocument()

    // Click symbol -> jumps & highlights in Raw editor
    await user.click(within(outlineRegion).getByRole('button', { name: /deleteUser/ }))
    await waitFor(() => {
      const jumpMark = container.querySelector('.cm-search-jump-highlight')
      expect(jumpMark).not.toBeNull()
      expect(jumpMark?.textContent).toBe('deleteUser')
    })

    // 3. Open Git diff tab -> Outline shows diff symbols with M / + badges and clicking jumps in GitDiffViewer
    await clickActivityBarButton(user, 'Git')
    const gitRegion = screen.getByRole('region', { name: 'Git 소스 제어' })
    const gitFileRow = await within(gitRegion).findByRole('button', { name: /^service\.ts/ })
    await user.click(gitFileRow)

    await waitFor(() => {
      expect(screen.getByRole('region', { name: 'src/service.ts Diff 뷰어' })).toBeInTheDocument()
    })

    // Clear previous filter to see all diff symbols
    await user.clear(within(outlineRegion).getByRole('searchbox', { name: '심볼 필터' }))

    await waitFor(() => {
      const findBtn = within(outlineRegion).getByRole('button', { name: /findUser/ })
      const createBtn = within(outlineRegion).getByRole('button', { name: /createUser/ })
      expect(within(findBtn).getByText('M')).toBeInTheDocument()
      expect(within(createBtn).getByText('+')).toBeInTheDocument()
    })

    await user.click(within(outlineRegion).getByRole('button', { name: /createUser/ }))
    await waitFor(() => {
      const highlightedRow = container.querySelector('tr.git-diff-row.is-jump-highlight')
      expect(highlightedRow).not.toBeNull()
      expect(highlightedRow?.textContent).toContain('createUser')
    })

    // 4. Switch back to Markdown tab -> Outline immediately restores heading list
    await user.click(screen.getByRole('tab', { name: /note\.md/ }))
    await waitFor(() => {
      expect(within(outlineRegion).getByRole('button', { name: '목차 번호 표시' })).toBeInTheDocument()
      expect(within(outlineRegion).getByText('Project Overview')).toBeInTheDocument()
      expect(within(outlineRegion).queryByRole('searchbox', { name: '심볼 필터' })).not.toBeInTheDocument()
    })
  }, 15000)
})
