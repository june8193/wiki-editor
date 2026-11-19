import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createEmptyGitStatus } from '@shared/git'
import { App } from './App'
import {
  createInMemoryWikiApi,
  setRawEditorSelection,
  setRawEditorText,
  triggerMenuCommand
} from './test/inMemoryWikiHarness'

vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(async (_id: string, text: string) => ({
      svg: `<svg data-code="${text.trim()}"><text>MermaidDiagramSvg</text></svg>`
    }))
  }
}))

describe('Workspace Search View (<App />)', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-theme')
    vi.useRealTimers()
  })

  it('orders activity bar items as 탐색기, 검색, Git, 워크스페이스, toggles Search View exclusively, and shows empty states', async () => {
    const user = userEvent.setup()
    const { api, emitMenuCommand } = createInMemoryWikiApi(
      { theme: 'light' },
      {
        selectedFolder: 'C:\\wiki\\docs',
        workspaces: {
          'C:\\wiki\\docs': {
            'notes.md': '# Notes\nHello wiki'
          }
        }
      }
    )
    window.wikiApi = api

    render(<App />)

    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute('data-theme', 'light')
    })

    const activityBar = screen.getByRole('navigation', { name: '액티비티 바' })
    const navButtons = within(activityBar).getAllByRole('button')
    expect(navButtons.map((btn) => btn.getAttribute('aria-label'))).toEqual([
      '탐색기',
      '검색',
      'Git',
      '워크스페이스'
    ])

    const searchBtn = within(activityBar).getByRole('button', { name: '검색' })
    expect(searchBtn).toHaveAttribute('aria-pressed', 'false')

    // Click Search icon without open workspace -> shows Search View exclusively with no-workspace guidance
    await user.click(searchBtn)
    expect(searchBtn).toHaveAttribute('aria-pressed', 'true')
    expect(searchBtn).toHaveClass('is-active')

    const leftSidebar = screen.getByRole('complementary', { name: '왼쪽 사이드바' })
    const searchView = within(leftSidebar).getByRole('region', { name: '검색 뷰' })
    expect(within(leftSidebar).queryByRole('region', { name: '워크스페이스 뷰' })).not.toBeInTheDocument()
    expect(within(leftSidebar).queryByRole('region', { name: '워크스페이스 탐색기' })).not.toBeInTheDocument()
    expect(within(leftSidebar).queryByRole('region', { name: 'Git 소스 제어' })).not.toBeInTheDocument()
    expect(within(searchView).getByText('열린 워크스페이스 없음')).toBeInTheDocument()

    // Click active Search icon again -> collapses left sidebar
    await user.click(searchBtn)
    expect(screen.queryByRole('complementary', { name: '왼쪽 사이드바' })).not.toBeInTheDocument()
    expect(searchBtn).toHaveAttribute('aria-pressed', 'false')

    // Click Search icon while collapsed -> expands straight into Search View
    await user.click(searchBtn)
    expect(screen.getByRole('complementary', { name: '왼쪽 사이드바' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: '검색 뷰' })).toBeInTheDocument()
    expect(searchBtn).toHaveAttribute('aria-pressed', 'true')

    // Open a workspace -> Search View stays active and switches to empty-query guidance
    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    await waitFor(() => {
      expect(within(screen.getByRole('region', { name: '검색 뷰' })).getByText('검색어를 입력하세요.')).toBeInTheDocument()
    })
  })

  it('opens Search View and focuses/selects input on Ctrl+Shift+F, suppresses when modals are open, and focuses on Search icon open', async () => {
    const user = userEvent.setup()
    const { api, emitMenuCommand } = createInMemoryWikiApi(
      { autoSave: false, theme: 'light' },
      {
        selectedFolder: 'C:\\wiki\\docs',
        workspaces: {
          'C:\\wiki\\docs': {
            'notes.md': '# Notes\nHello wiki'
          }
        }
      }
    )
    window.wikiApi = api

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')

    const explorer = await screen.findByLabelText('워크스페이스 탐색기')
    await user.click(await within(explorer).findByText('notes.md'))
    const editor = await screen.findByTestId('document-editor')

    // Collapse left sidebar first
    const activityBar = screen.getByRole('navigation', { name: '액티비티 바' })
    await user.click(within(activityBar).getByRole('button', { name: '탐색기' }))
    expect(screen.queryByRole('complementary', { name: '왼쪽 사이드바' })).not.toBeInTheDocument()

    // Ctrl+Shift+F expands Search View and focuses search input
    fireEvent.keyDown(editor, { key: 'F', ctrlKey: true, shiftKey: true })

    const searchInput = (await screen.findByRole('textbox', {
      name: '검색어 입력'
    })) as HTMLInputElement
    expect(searchInput).toHaveFocus()

    await user.type(searchInput, 'wiki')
    expect(searchInput.value).toBe('wiki')

    // Switch to Explorer and focus elsewhere, then Ctrl+Shift+F again -> focuses and selects existing query
    await user.click(within(activityBar).getByRole('button', { name: '탐색기' }))
    expect(screen.queryByRole('region', { name: '검색 뷰' })).not.toBeInTheDocument()

    fireEvent.keyDown(window, { key: 'f', ctrlKey: true, shiftKey: true })
    const reselectedInput = (await screen.findByRole('textbox', {
      name: '검색어 입력'
    })) as HTMLInputElement
    expect(reselectedInput).toHaveFocus()
    expect(reselectedInput.selectionStart).toBe(0)
    expect(reselectedInput.selectionEnd).toBe('wiki'.length)

    // Switch to Explorer, open SettingsPanel -> Ctrl+Shift+F must be suppressed
    await user.click(within(activityBar).getByRole('button', { name: '탐색기' }))
    await triggerMenuCommand(emitMenuCommand, 'toggle-settings')
    expect(await screen.findByRole('dialog', { name: '전역 설정 패널' })).toBeInTheDocument()

    fireEvent.keyDown(window, { key: 'F', ctrlKey: true, shiftKey: true })
    expect(screen.queryByRole('region', { name: '검색 뷰' })).not.toBeInTheDocument()
    expect(screen.getByRole('region', { name: '워크스페이스 탐색기' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '닫기' }))
    expect(screen.queryByRole('dialog', { name: '전역 설정 패널' })).not.toBeInTheDocument()

    // Make document dirty, trigger ConfirmDialog on close tab -> Ctrl+Shift+F must be suppressed
    setRawEditorText(await screen.findByTestId('document-editor'), '# Notes\nUnsaved edit')
    await user.click(screen.getByRole('button', { name: 'notes.md 탭 닫기' }))
    expect(await screen.findByRole('alertdialog')).toBeInTheDocument()

    fireEvent.keyDown(window, { key: 'F', ctrlKey: true, shiftKey: true })
    expect(screen.queryByRole('region', { name: '검색 뷰' })).not.toBeInTheDocument()

    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '취소' }))

    // Clicking Search icon directly also opens Search View and focuses search input
    await user.click(within(activityBar).getByRole('button', { name: '검색' }))
    expect(screen.getByRole('textbox', { name: '검색어 입력' })).toHaveFocus()
  })

  it('debounces typing by 200ms, waits for Korean IME composition end, supports immediate Enter and Refresh, and does not auto-research during document edits', async () => {
    const user = userEvent.setup()
    const { api, emitMenuCommand } = createInMemoryWikiApi(
      { autoSave: false, theme: 'light' },
      {
        selectedFolder: 'C:\\wiki\\docs',
        workspaces: {
          'C:\\wiki\\docs': {
            'notes.md': '# Notes\nAlpha token line\n한글 본문 테스트',
            'guide.md': '# Guide\nPlain content'
          }
        }
      }
    )
    const searchSpy = vi.spyOn(api.workspace as Required<typeof api.workspace>, 'search')
    window.wikiApi = api

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')

    // Open notes.md before switching to Search View
    const explorer = await screen.findByLabelText('워크스페이스 탐색기')
    await user.click(await within(explorer).findByText('notes.md'))
    const editor = await screen.findByTestId('document-editor')

    // Open Search View via Ctrl+Shift+F
    fireEvent.keyDown(editor, { key: 'F', ctrlKey: true, shiftKey: true })
    const searchInput = (await screen.findByRole('textbox', {
      name: '검색어 입력'
    })) as HTMLInputElement
    const searchView = screen.getByRole('region', { name: '검색 뷰' })

    vi.useFakeTimers()
    try {
      // 1. Typing resets 200ms debounce timer
      fireEvent.change(searchInput, { target: { value: 'tok' } })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(199)
      })
      expect(searchSpy).not.toHaveBeenCalled()

      fireEvent.change(searchInput, { target: { value: 'token' } })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100)
      })
      expect(searchSpy).not.toHaveBeenCalled()

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100)
      })
      expect(searchSpy).toHaveBeenCalledTimes(1)
      expect(searchSpy).toHaveBeenLastCalledWith(
        expect.objectContaining({ query: 'token' })
      )
      expect(within(searchView).getByText(/notes\.md/)).toBeInTheDocument()

      // 2. Korean IME composition pauses search until compositionEnd + 200ms debounce
      searchSpy.mockClear()
      fireEvent.compositionStart(searchInput)
      fireEvent.change(searchInput, { target: { value: 'ㅎ' } })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300)
      })
      expect(searchSpy).not.toHaveBeenCalled()

      fireEvent.keyDown(searchInput, { key: 'Enter', isComposing: true })
      expect(searchSpy).not.toHaveBeenCalled()

      fireEvent.change(searchInput, { target: { value: '한글' } })
      fireEvent.compositionEnd(searchInput)
      expect(searchSpy).not.toHaveBeenCalled()

      await act(async () => {
        await vi.advanceTimersByTimeAsync(200)
      })
      expect(searchSpy).toHaveBeenCalledTimes(1)
      expect(searchSpy).toHaveBeenLastCalledWith(
        expect.objectContaining({ query: '한글' })
      )
      expect(within(searchView).getByText(/notes\.md/)).toBeInTheDocument()

      // 3. Pressing Enter executes immediately and cancels pending debounce
      searchSpy.mockClear()
      fireEvent.change(searchInput, { target: { value: 'Alpha' } })
      fireEvent.keyDown(searchInput, { key: 'Enter' })
      await act(async () => {
        await Promise.resolve()
      })
      expect(searchSpy).toHaveBeenCalledTimes(1)
      expect(searchSpy).toHaveBeenLastCalledWith(
        expect.objectContaining({ query: 'Alpha' })
      )

      await act(async () => {
        await vi.advanceTimersByTimeAsync(250)
      })
      expect(searchSpy).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }

    // 4. Editing document buffer does NOT auto-research; Refresh button re-runs search with unsaved buffer
    searchSpy.mockClear()
    setRawEditorText(editor, '# Notes\nReplaced line without target')
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(searchSpy).not.toHaveBeenCalled()
    expect(within(searchView).getByText(/notes\.md/)).toBeInTheDocument()

    const refreshBtn = within(searchView).getByRole('button', { name: '검색 새로고침' })
    await user.click(refreshBtn)
    await waitFor(() => {
      expect(searchSpy).toHaveBeenCalledTimes(1)
    })
    await waitFor(() => {
      expect(within(searchView).getByText('일치하는 결과가 없습니다.')).toBeInTheDocument()
    })
  })

  it('toggles Aa, ab, and .* options, renders invalid regex errors inline without triggering the global error banner, and shows truncation banner', async () => {
    const user = userEvent.setup()
    const { api, emitMenuCommand } = createInMemoryWikiApi(
      { autoSave: false, theme: 'light' },
      {
        selectedFolder: 'C:\\wiki\\docs',
        workspaces: {
          'C:\\wiki\\docs': {
            'case-exact.md': 'WikiTopic',
            'case-lower.md': 'wikitopic',
            'whole-word.md': 'exact word wiki here',
            'partial-word.md': 'superwikiword',
            'regex-hit.md': 'item-42 item-99'
          }
        }
      }
    )
    window.wikiApi = api

    const { container } = render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')

    await user.click(
      within(screen.getByRole('navigation', { name: '액티비티 바' })).getByRole('button', {
        name: '검색'
      })
    )
    const searchView = screen.getByRole('region', { name: '검색 뷰' })
    const searchInput = within(searchView).getByRole('textbox', { name: '검색어 입력' })

    const caseBtn = within(searchView).getByRole('button', { name: /대소문자 구분/ })
    const wholeWordBtn = within(searchView).getByRole('button', { name: /단어 단위/ })
    const regexBtn = within(searchView).getByRole('button', { name: /정규식/ })

    expect(caseBtn).toHaveAttribute('aria-pressed', 'false')
    expect(wholeWordBtn).toHaveAttribute('aria-pressed', 'false')
    expect(regexBtn).toHaveAttribute('aria-pressed', 'false')

    // 1. Default case-insensitive partial match finds WikiTopic, wikitopic, wiki, superwikiword
    await user.type(searchInput, 'Wiki')
    fireEvent.keyDown(searchInput, { key: 'Enter' })

    await waitFor(() => {
      expect(within(searchView).getByText(/case-exact\.md/)).toBeInTheDocument()
      expect(within(searchView).getByText(/case-lower\.md/)).toBeInTheDocument()
      expect(within(searchView).getByText(/whole-word\.md/)).toBeInTheDocument()
      expect(within(searchView).getByText(/partial-word\.md/)).toBeInTheDocument()
    })

    // 2. Toggle Aa (case-sensitive) -> drops case-lower.md, whole-word.md, partial-word.md immediately
    await user.click(caseBtn)
    expect(caseBtn).toHaveAttribute('aria-pressed', 'true')
    await waitFor(() => {
      expect(within(searchView).getByText(/case-exact\.md/)).toBeInTheDocument()
      expect(within(searchView).queryByText(/case-lower\.md/)).not.toBeInTheDocument()
      expect(within(searchView).queryByText(/whole-word\.md/)).not.toBeInTheDocument()
    })

    // 3. Disable Aa, search 'wiki', enable ab (whole word) -> drops partial-word.md and WikiTopic/wikitopic
    await user.click(caseBtn)
    await user.clear(searchInput)
    await user.type(searchInput, 'wiki')
    fireEvent.keyDown(searchInput, { key: 'Enter' })
    await waitFor(() => {
      expect(within(searchView).getByText(/partial-word\.md/)).toBeInTheDocument()
    })

    await user.click(wholeWordBtn)
    expect(wholeWordBtn).toHaveAttribute('aria-pressed', 'true')
    await waitFor(() => {
      expect(within(searchView).getByText(/whole-word\.md/)).toBeInTheDocument()
      expect(within(searchView).queryByText(/partial-word\.md/)).not.toBeInTheDocument()
      expect(within(searchView).queryByText(/case-exact\.md/)).not.toBeInTheDocument()
    })

    // 4. Disable ab, enable .* (regex) -> matches item-\d+
    await user.click(wholeWordBtn)
    await user.click(regexBtn)
    expect(regexBtn).toHaveAttribute('aria-pressed', 'true')
    await user.clear(searchInput)
    await user.type(searchInput, 'item-\\d+')
    fireEvent.keyDown(searchInput, { key: 'Enter' })
    await waitFor(() => {
      expect(within(searchView).getByText(/regex-hit\.md/)).toBeInTheDocument()
    })

    // 5. Invalid regex -> inline error inside Search View, NO global error banner
    await user.clear(searchInput)
    await user.type(searchInput, '[[unclosed')
    fireEvent.keyDown(searchInput, { key: 'Enter' })

    const inlineError = await within(searchView).findByRole('alert')
    expect(inlineError).toHaveTextContent(/정규식/)
    expect(container.querySelector('.error-banner')).toBeNull()

    // 6. Truncated response -> displays truncation notice banner
    const origSearch = api.workspace.search!.bind(api.workspace)
    vi.spyOn(api.workspace as Required<typeof api.workspace>, 'search').mockImplementationOnce(
      async (req) => ({
        ...(await origSearch(req)),
        truncated: true
      })
    )
    await user.click(regexBtn) // Turn regex off -> triggers immediate search for '[unclosed' -> no regex error, truncated: true
    expect(await within(searchView).findByText(/상한/)).toBeInTheDocument()
  })

  it('groups results by file with collapse/expand, badges, ranked name highlights, snippet marks, and opens/activates tabs in the active pane', async () => {
    const user = userEvent.setup()
    const { api, emitMenuCommand } = createInMemoryWikiApi(
      { autoSave: false, theme: 'light' },
      {
        selectedFolder: 'C:\\wiki\\docs',
        workspaces: {
          'C:\\wiki\\docs': {
            'docs/alpha-topic.md': '# Alpha Header\nNo match in body',
            'notes/topic-both.md': 'Line 1 plain\nLine 2 topic one\nLine 3 topic two',
            'a-body-only.txt': 'First plain line\nSecond topic hit here',
            'b-other.md': '# Other Doc'
          }
        }
      }
    )
    window.wikiApi = api

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')

    // Open notes/topic-both.md in primaryPane and switch it to Preview mode, then open b-other.md
    const explorer = await screen.findByLabelText('워크스페이스 탐색기')
    await user.click(await within(explorer).findByText('notes'))
    await user.click(await within(explorer).findByText('topic-both.md'))
    const primaryPane = screen.getByTestId('pane-primary')
    await user.click(
      within(within(primaryPane).getByRole('group', { name: '에디터 모드 전환' })).getByRole(
        'button',
        { name: 'Preview' }
      )
    )

    // Open b-other.md in primaryPane and duplicate it to secondaryPane (activating secondaryPane)
    await user.click(within(explorer).getByText('b-other.md'))
    const otherTab = within(primaryPane).getByRole('tab', { name: 'b-other.md' })
    fireEvent.contextMenu(otherTab)
    await user.click(
      within(screen.getByRole('menu', { name: '탭 작업 메뉴' })).getByRole('menuitem', {
        name: '분할 영역에 복제 열기'
      })
    )
    const secondaryPane = screen.getByTestId('pane-secondary')
    expect(secondaryPane).toHaveClass('is-active-pane')

    // Search for 'topic'
    await user.click(
      within(screen.getByRole('navigation', { name: '액티비티 바' })).getByRole('button', {
        name: '검색'
      })
    )
    const searchView = screen.getByRole('region', { name: '검색 뷰' })
    const searchInput = within(searchView).getByRole('textbox', { name: '검색어 입력' })
    await user.type(searchInput, 'topic')
    fireEvent.keyDown(searchInput, { key: 'Enter' })

    const resultList = await within(searchView).findByRole('list', { name: '검색 결과 목록' })
    const groups = Array.from(resultList.children) as HTMLElement[]
    expect(groups).toHaveLength(3)

    // Filename/path matches rank before body-only matches: docs/alpha-topic.md, notes/topic-both.md, a-body-only.txt
    expect(groups[0]).toHaveTextContent('docs/alpha-topic.md')
    expect(groups[1]).toHaveTextContent('notes/topic-both.md')
    expect(groups[2]).toHaveTextContent('a-body-only.txt')

    // Header highlights on filename/path match groups
    const alphaHeaderBtn = within(groups[0]).getByRole('button')
    expect(alphaHeaderBtn).toHaveClass('is-name-match')
    expect(alphaHeaderBtn.querySelector('mark')).toHaveTextContent('topic')

    const topicBothHeaderBtn = within(groups[1]).getByRole('button', {
      name: /notes\/topic-both\.md/
    })
    expect(topicBothHeaderBtn).toHaveClass('is-name-match')
    expect(topicBothHeaderBtn.querySelector('mark')).toHaveTextContent('topic')
    expect(within(topicBothHeaderBtn).getByText('2')).toBeInTheDocument()
    expect(topicBothHeaderBtn).toHaveAttribute('aria-expanded', 'true')

    const bodyOnlyHeaderBtn = within(groups[2]).getByRole('button', {
      name: /a-body-only\.txt/
    })
    expect(bodyOnlyHeaderBtn).not.toHaveClass('is-name-match')
    expect(bodyOnlyHeaderBtn.querySelector('mark')).toBeNull()
    expect(within(bodyOnlyHeaderBtn).getByText('1')).toBeInTheDocument()

    // Verify 1-based line numbers and snippet <mark> highlights inside notes/topic-both.md
    const lineButtons = within(groups[1]).getAllByRole('button').slice(1)
    expect(lineButtons).toHaveLength(2)
    expect(within(lineButtons[0]).getByText('2')).toBeInTheDocument()
    expect(lineButtons[0].querySelector('mark')).toHaveTextContent('topic')
    expect(within(lineButtons[1]).getByText('3')).toBeInTheDocument()
    expect(lineButtons[1].querySelector('mark')).toHaveTextContent('topic')

    // Collapse and expand notes/topic-both.md group
    await user.click(topicBothHeaderBtn)
    expect(topicBothHeaderBtn).toHaveAttribute('aria-expanded', 'false')
    expect(within(groups[1]).getAllByRole('button')).toHaveLength(1)

    await user.click(topicBothHeaderBtn)
    expect(topicBothHeaderBtn).toHaveAttribute('aria-expanded', 'true')
    expect(within(groups[1]).getAllByRole('button')).toHaveLength(3)

    // Clicking filename-only match header opens docs/alpha-topic.md in active pane (secondaryPane)
    await user.click(alphaHeaderBtn)
    expect(await within(secondaryPane).findByRole('tab', { name: 'alpha-topic.md' })).toHaveAttribute(
      'aria-selected',
      'true'
    )

    // Clicking body line match opens a-body-only.txt in active pane (secondaryPane)
    const bodyOnlyLineBtn = within(groups[2]).getAllByRole('button')[1]
    await user.click(bodyOnlyLineBtn)
    expect(await within(secondaryPane).findByRole('tab', { name: 'a-body-only.txt' })).toHaveAttribute(
      'aria-selected',
      'true'
    )

    // Switch focus back to primaryPane (which holds notes/topic-both.md in Preview mode, inactive behind b-other.md)
    await user.click(within(primaryPane).getByRole('tab', { name: 'b-other.md' }))
    expect(primaryPane).toHaveClass('is-active-pane')

    // Click line match of notes/topic-both.md -> activates existing tab in primaryPane without duplicating and preserves Preview mode
    const topicBothLineBtn = within(groups[1]).getAllByRole('button')[1]
    await user.click(topicBothLineBtn)
    await waitFor(() => {
      expect(within(primaryPane).getByRole('tab', { name: 'topic-both.md' })).toHaveAttribute(
        'aria-selected',
        'true'
      )
    })
    expect(within(primaryPane).getAllByRole('tab', { name: 'topic-both.md' })).toHaveLength(1)
    expect(
      within(within(primaryPane).getByRole('group', { name: '에디터 모드 전환' })).getByRole(
        'button',
        { name: 'Preview' }
      )
    ).toHaveAttribute('aria-pressed', 'true')
  })

  it('retains query, options, results, and collapsed groups across view switches/collapse, ignores stale responses, preserves state on cancelled switch, resets on workspace switch, and never persists to workspace-state.json', async () => {
    const user = userEvent.setup()
    const { api, emitMenuCommand } = createInMemoryWikiApi(
      {
        autoSave: false,
        theme: 'light',
        recentWorkspaces: ['C:/wiki/alpha', 'C:/wiki/beta']
      },
      {
        selectedFolder: 'C:\\wiki\\alpha',
        workspaces: {
          'C:\\wiki\\alpha': {
            'first.md': 'AlphaTarget one\nAlphaTarget two',
            'second.md': 'AlphaTarget only once'
          },
          'C:\\wiki\\beta': {
            'beta.md': 'Beta content'
          }
        }
      }
    )
    const saveWorkspaceStateSpy = vi.spyOn(api.workspaceState!, 'save')
    window.wikiApi = api

    render(<App />)
    await waitFor(() => {
      expect(within(screen.getByLabelText('워크스페이스 탐색기')).getByText('first.md')).toBeInTheDocument()
    })

    // 1. Search with Aa enabled and collapse first.md group
    const activityBar = screen.getByRole('navigation', { name: '액티비티 바' })
    await user.click(within(activityBar).getByRole('button', { name: '검색' }))
    const searchView = screen.getByRole('region', { name: '검색 뷰' })
    const searchInput = within(searchView).getByRole('textbox', { name: '검색어 입력' }) as HTMLInputElement

    await user.click(within(searchView).getByRole('button', { name: /대소문자 구분/ }))
    await user.type(searchInput, 'AlphaTarget')
    fireEvent.keyDown(searchInput, { key: 'Enter' })

    const firstHeader = await within(searchView).findByRole('button', { name: /first\.md/ })
    expect(firstHeader).toHaveAttribute('aria-expanded', 'true')
    await user.click(firstHeader)
    expect(firstHeader).toHaveAttribute('aria-expanded', 'false')

    // 2. Switch to Explorer and Git, then collapse and expand sidebar -> query, Aa, results, and collapsed state remain intact
    const searchSpy = vi.spyOn(api.workspace as Required<typeof api.workspace>, 'search')
    searchSpy.mockClear()

    await user.click(within(activityBar).getByRole('button', { name: '탐색기' }))
    expect(screen.getByRole('region', { name: '워크스페이스 탐색기' })).toBeInTheDocument()
    await user.click(within(activityBar).getByRole('button', { name: 'Git' }))
    expect(screen.getByRole('region', { name: 'Git 소스 제어' })).toBeInTheDocument()

    await user.click(within(activityBar).getByRole('button', { name: '검색' }))
    const restoredSearchView = screen.getByRole('region', { name: '검색 뷰' })
    expect((within(restoredSearchView).getByRole('textbox', { name: '검색어 입력' }) as HTMLInputElement).value).toBe('AlphaTarget')
    expect(within(restoredSearchView).getByRole('button', { name: /대소문자 구분/ })).toHaveAttribute('aria-pressed', 'true')
    expect(within(restoredSearchView).getByRole('button', { name: /first\.md/ })).toHaveAttribute('aria-expanded', 'false')
    expect(within(restoredSearchView).getByRole('button', { name: /second\.md/ })).toHaveAttribute('aria-expanded', 'true')

    // Collapse & expand sidebar on Search View
    await user.click(within(activityBar).getByRole('button', { name: '검색' }))
    expect(screen.queryByRole('complementary', { name: '왼쪽 사이드바' })).not.toBeInTheDocument()
    await user.click(within(activityBar).getByRole('button', { name: '검색' }))

    const expandedSearchView = screen.getByRole('region', { name: '검색 뷰' })
    expect((within(expandedSearchView).getByRole('textbox', { name: '검색어 입력' }) as HTMLInputElement).value).toBe('AlphaTarget')
    expect(within(expandedSearchView).getByRole('button', { name: /first\.md/ })).toHaveAttribute('aria-expanded', 'false')
    expect(searchSpy).not.toHaveBeenCalled()

    // 3. Stale out-of-order response is discarded when a newer search completes first
    const origSearch = api.workspace.search!.bind(api.workspace)
    let releaseSlow!: () => void
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve
    })
    searchSpy.mockImplementationOnce(async () => {
      await slowGate
      return {
        query: 'StaleQuery',
        files: [
          {
            path: 'C:/wiki/alpha/stale.md',
            relativePath: 'stale.md',
            name: 'stale.md',
            nameMatches: [],
            lineMatches: [{ lineNumber: 1, lineText: 'stale hit', lineOffset: 0, matches: [{ start: 0, end: 5 }] }],
            totalMatchCount: 1,
            truncatedInFile: false
          }
        ],
        totalFileCount: 1,
        totalMatchCount: 1,
        truncated: false
      }
    })
    searchSpy.mockImplementationOnce(origSearch)

    const liveInput = within(expandedSearchView).getByRole('textbox', { name: '검색어 입력' })
    await user.clear(liveInput)
    await user.type(liveInput, 'StaleQuery')
    fireEvent.keyDown(liveInput, { key: 'Enter' })

    await user.clear(liveInput)
    await user.type(liveInput, 'AlphaTarget')
    fireEvent.keyDown(liveInput, { key: 'Enter' })

    await waitFor(() => {
      expect(within(expandedSearchView).getByRole('button', { name: /second\.md/ })).toBeInTheDocument()
    })
    releaseSlow()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(within(expandedSearchView).queryByText(/stale\.md/)).not.toBeInTheDocument()

    // 4. Cancelled dirty workspace switch must NOT reset Search View state
    await user.click(within(expandedSearchView).getByRole('button', { name: /AlphaTarget only once/ }))
    const editor = await screen.findByTestId('document-editor')
    setRawEditorText(editor, 'Unsaved AlphaTarget edit')

    await user.click(within(activityBar).getByRole('button', { name: '워크스페이스' }))
    await user.click(
      within(screen.getByRole('region', { name: '워크스페이스 뷰' })).getByRole('button', {
        name: /^beta$/i
      })
    )
    const switchDialog = await screen.findByRole('alertdialog')
    await user.click(within(switchDialog).getByRole('button', { name: '취소' }))

    await user.click(within(activityBar).getByRole('button', { name: '검색' }))
    expect(
      (within(screen.getByRole('region', { name: '검색 뷰' })).getByRole('textbox', { name: '검색어 입력' }) as HTMLInputElement).value
    ).toBe('AlphaTarget')

    // 5. Actually switching workspace resets query, options, results, and collapsed state, and never saves search state to workspaceState
    saveWorkspaceStateSpy.mockClear()
    api.workspace.selectFolder = async () => 'C:/wiki/beta'
    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    const confirmSwitch = await screen.findByRole('alertdialog')
    await user.click(within(confirmSwitch).getByRole('button', { name: '버리고 이동' }))

    await waitFor(() => {
      const switchedSearchView = screen.getByRole('region', { name: '검색 뷰' })
      expect(
        (within(switchedSearchView).getByRole('textbox', { name: '검색어 입력' }) as HTMLInputElement).value
      ).toBe('')
      expect(within(switchedSearchView).getByRole('button', { name: /대소문자 구분/ })).toHaveAttribute(
        'aria-pressed',
        'false'
      )
      expect(within(switchedSearchView).getByText('검색어를 입력하세요.')).toBeInTheDocument()
    })

    const savedAlpha = await api.workspaceState!.get('C:/wiki/alpha')
    expect(JSON.stringify(savedAlpha)).not.toContain('AlphaTarget')
    for (const [, update] of saveWorkspaceStateSpy.mock.calls) {
      expect(JSON.stringify(update)).not.toContain('AlphaTarget')
    }
  })
})

describe('In-Document Find Bar Pane State & Integration (<App />)', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-theme')
    vi.useRealTimers()
  })

  it('persists Find Bar state per pane across text tabs, hides/suppresses on Diff and Image tabs, suppresses during modals, shows inline regex errors, and resets on workspace switch', async () => {
    const user = userEvent.setup()
    const gitStatus = {
      ...createEmptyGitStatus(true, 'C:/wiki/alpha'),
      branch: 'main',
      unstaged: [{ path: 'notes.md', status: 'M' as const }]
    }
    const { api, emitMenuCommand } = createInMemoryWikiApi(
      {
        autoSave: false,
        theme: 'light',
        recentWorkspaces: ['C:/wiki/alpha', 'C:/wiki/beta']
      },
      {
        selectedFolder: 'C:\\wiki\\alpha',
        workspaces: {
          'C:\\wiki\\alpha': {
            'notes.md': '# Notes\nAlpha note\nalpha lower',
            'guide.txt': 'Plain text alpha only',
            'diagram.png': '<binary-png>'
          },
          'C:\\wiki\\beta': {
            'beta.md': '# Beta\nAlpha in beta'
          }
        },
        git: {
          status: vi.fn(async () => gitStatus),
          branches: vi.fn(async () => ({
            current: 'main',
            isDetached: false,
            branches: [{ name: 'main', current: true, upstream: null }]
          })),
          diff: vi.fn(async () => ({
            path: 'notes.md',
            status: 'M' as const,
            isBinary: false,
            isTruncated: false,
            existsInWorkspace: true,
            rawPatch: '@@ -1 +1 @@\n-# Notes\n+# Notes updated'
          }))
        }
      }
    )
    window.wikiApi = api

    const { container } = render(<App />)
    const explorer = await screen.findByLabelText('워크스페이스 탐색기')
    await user.click(await within(explorer).findByText('notes.md'))

    const editor = await screen.findByTestId('document-editor')
    const alphaText = '# Notes\nAlpha note\nalpha lower'
    const alphaStart = alphaText.indexOf('Alpha')
    setRawEditorSelection(editor, alphaStart, alphaStart + 5)

    // Ctrl+F from pane-workspace (outside CodeMirror) still reads active pane selection and opens Find Bar
    fireEvent.keyDown(screen.getByTestId('pane-workspace'), { key: 'f', ctrlKey: true })
    const findBar = await screen.findByRole('region', { name: '문서 내 찾기 바' })
    const findInput = within(findBar).getByRole('textbox', {
      name: '문서 내 검색어 입력'
    }) as HTMLInputElement
    expect(findInput.value).toBe('Alpha')
    expect(findInput).toHaveFocus()
    expect(within(findBar).getByText('1 / 2')).toBeInTheDocument()

    // Toggle Aa (caseSensitive) -> '1 / 1'
    await user.click(within(findBar).getByRole('button', { name: /대소문자 구분/ }))
    expect(within(findBar).getByText('1 / 1')).toBeInTheDocument()

    // Switch to guide.txt in the same pane -> Find Bar stays open with query 'Alpha' and Aa active, immediately re-searches ('결과 없음')
    await user.click(within(explorer).getByText('guide.txt'))
    const txtFindBar = screen.getByRole('region', { name: '문서 내 찾기 바' })
    expect(
      (within(txtFindBar).getByRole('textbox', { name: '문서 내 검색어 입력' }) as HTMLInputElement).value
    ).toBe('Alpha')
    expect(within(txtFindBar).getByRole('button', { name: /대소문자 구분/ })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    expect(within(txtFindBar).getByText('결과 없음')).toBeInTheDocument()

    // Toggle Aa off -> matches 'alpha' in guide.txt ('1 / 1') and highlights in Raw mode
    await user.click(within(txtFindBar).getByRole('button', { name: /대소문자 구분/ }))
    expect(within(txtFindBar).getByText('1 / 1')).toBeInTheDocument()
    expect(container.querySelectorAll('.cm-search-match')).toHaveLength(1)

    // Switch to diagram.png (image tab) -> Find Bar temporarily hides, header button disabled, Ctrl+F suppressed
    await user.click(within(explorer).getByText('diagram.png'))
    expect(screen.queryByRole('region', { name: '문서 내 찾기 바' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '문서 내 찾기' })).toBeDisabled()
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true })
    expect(screen.queryByRole('region', { name: '문서 내 찾기 바' })).not.toBeInTheDocument()

    // Switch back to notes.md -> Find Bar reappears with preserved query ('Alpha', Aa off) -> '1 / 2'
    await user.click(screen.getByRole('tab', { name: 'notes.md' }))
    const restoredBar1 = await screen.findByRole('region', { name: '문서 내 찾기 바' })
    expect(within(restoredBar1).getByText('1 / 2')).toBeInTheDocument()
    expect(container.querySelectorAll('.cm-search-match')).toHaveLength(2)

    // Open Git Diff tab -> Find Bar hides, Ctrl+F suppressed
    const activityBar = screen.getByRole('navigation', { name: '액티비티 바' })
    await user.click(within(activityBar).getByRole('button', { name: 'Git' }))
    const gitRegion = screen.getByRole('region', { name: 'Git 소스 제어' })
    await user.click(await within(gitRegion).findByText('notes.md'))
    expect(await screen.findByText('Working Tree')).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: '문서 내 찾기 바' })).not.toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true })
    expect(screen.queryByRole('region', { name: '문서 내 찾기 바' })).not.toBeInTheDocument()

    // Switch back to notes.md -> Find Bar reappears
    await user.click(screen.getByRole('tab', { name: 'notes.md' }))
    const restoredBar2 = await screen.findByRole('region', { name: '문서 내 찾기 바' })
    expect(within(restoredBar2).getByText('1 / 2')).toBeInTheDocument()

    // Invalid regex inside Find Bar shows inline alert without global .error-banner
    const liveInput = within(restoredBar2).getByRole('textbox', { name: '문서 내 검색어 입력' })
    await user.click(within(restoredBar2).getByRole('button', { name: /정규식/ }))
    await user.clear(liveInput)
    await user.type(liveInput, '[[bad')
    expect(within(restoredBar2).getByRole('alert')).toHaveTextContent(/정규식/)
    expect(container.querySelector('.error-banner')).toBeNull()

    // Close Find Bar, open SettingsPanel -> Ctrl+F suppressed; open ConfirmDialog -> Ctrl+F suppressed
    await user.click(within(restoredBar2).getByRole('button', { name: '찾기 바 닫기' }))
    expect(screen.queryByRole('region', { name: '문서 내 찾기 바' })).not.toBeInTheDocument()

    await triggerMenuCommand(emitMenuCommand, 'toggle-settings')
    expect(await screen.findByRole('dialog', { name: '전역 설정 패널' })).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true })
    expect(screen.queryByRole('region', { name: '문서 내 찾기 바' })).not.toBeInTheDocument()
    await user.click(within(screen.getByRole('dialog', { name: '전역 설정 패널' })).getByRole('button', { name: '닫기' }))

    setRawEditorText(await screen.findByTestId('document-editor'), 'Dirty change')
    await user.click(screen.getAllByRole('button', { name: 'notes.md 탭 닫기' })[0])
    const dirtyDialog = await screen.findByRole('alertdialog')
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true })
    expect(screen.queryByRole('region', { name: '문서 내 찾기 바' })).not.toBeInTheDocument()
    await user.click(within(dirtyDialog).getByRole('button', { name: '취소' }))

    // Open Find Bar again, then switch workspace -> Find Bar state resets
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true })
    expect(await screen.findByRole('region', { name: '문서 내 찾기 바' })).toBeInTheDocument()
    api.workspace.selectFolder = async () => 'C:/wiki/beta'
    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    const confirmSwitch = await screen.findByRole('alertdialog')
    await user.click(within(confirmSwitch).getByRole('button', { name: '버리고 이동' }))
    await user.click(within(activityBar).getByRole('button', { name: '탐색기' }))
    await waitFor(() => {
      expect(within(screen.getByLabelText('워크스페이스 탐색기')).getByText('beta.md')).toBeInTheDocument()
    })
    await user.click(within(screen.getByLabelText('워크스페이스 탐색기')).getByText('beta.md'))
    expect(screen.queryByRole('region', { name: '문서 내 찾기 바' })).not.toBeInTheDocument()
  })

  it('maintains independent Find Bar states for Primary Pane and Secondary Pane', async () => {
    const user = userEvent.setup()
    const { api, emitMenuCommand } = createInMemoryWikiApi(
      { autoSave: false, theme: 'light' },
      {
        selectedFolder: 'C:\\wiki\\docs',
        workspaces: {
          'C:\\wiki\\docs': {
            'first.md': 'FirstToken one\nFirstToken two',
            'second.md': 'SecondToken exact SecondTokenMore'
          }
        }
      }
    )
    window.wikiApi = api

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    const explorer = await screen.findByLabelText('워크스페이스 탐색기')
    await user.click(await within(explorer).findByText('first.md'))
    await user.click(within(explorer).getByText('second.md'))

    const primaryPane = screen.getByTestId('pane-primary')
    fireEvent.contextMenu(within(primaryPane).getByRole('tab', { name: 'second.md' }))
    await user.click(
      within(screen.getByRole('menu', { name: '탭 작업 메뉴' })).getByRole('menuitem', {
        name: '분할 영역으로 이동'
      })
    )
    const secondaryPane = screen.getByTestId('pane-secondary')

    // Open Find Bar in primaryPane via header button -> secondaryPane stays closed
    await user.click(within(primaryPane).getByRole('button', { name: '문서 내 찾기' }))
    const primaryBar = within(primaryPane).getByRole('region', { name: '문서 내 찾기 바' })
    await user.type(
      within(primaryBar).getByRole('textbox', { name: '문서 내 검색어 입력' }),
      'FirstToken'
    )
    expect(within(primaryBar).getByText('1 / 2')).toBeInTheDocument()
    expect(within(secondaryPane).queryByRole('region', { name: '문서 내 찾기 바' })).not.toBeInTheDocument()

    // Focus secondaryPane editor and press Ctrl+F -> opens independent Find Bar in secondaryPane
    const secondaryEditor = within(secondaryPane).getByTestId('document-editor')
    fireEvent.keyDown(secondaryEditor, { key: 'f', ctrlKey: true })
    const secondaryBar = within(secondaryPane).getByRole('region', { name: '문서 내 찾기 바' })
    await user.type(
      within(secondaryBar).getByRole('textbox', { name: '문서 내 검색어 입력' }),
      'SecondToken'
    )
    expect(within(secondaryBar).getByText('1 / 2')).toBeInTheDocument()

    await user.click(within(secondaryBar).getByRole('button', { name: /단어 단위/ }))
    expect(within(secondaryBar).getByText('1 / 1')).toBeInTheDocument()
    expect(within(primaryBar).getByText('1 / 2')).toBeInTheDocument()
    expect(within(primaryBar).getByRole('button', { name: /단어 단위/ })).toHaveAttribute(
      'aria-pressed',
      'false'
    )

    // Close primaryPane Find Bar via Esc -> secondaryPane Find Bar stays open
    fireEvent.keyDown(within(primaryBar).getByRole('textbox', { name: '문서 내 검색어 입력' }), {
      key: 'Escape'
    })
    expect(within(primaryPane).queryByRole('region', { name: '문서 내 찾기 바' })).not.toBeInTheDocument()
    expect(within(secondaryPane).getByRole('region', { name: '문서 내 찾기 바' })).toBeInTheDocument()
  })

  it('supports in-document Find Bar across 위지윅, Preview, Split, and Raw modes in <App /> with selection auto-fill, live edit sync, and non-pollution', async () => {
    const user = userEvent.setup()
    const md = [
      '# Main Topic',
      '',
      'Topic body [topic link](https://topic.example.com)',
      '',
      '```ts',
      'const topicCode = 1',
      '```',
      '',
      '```mermaid',
      'graph TD',
      '  TopicA --> TopicB',
      '```'
    ].join('\n')

    const { api, emitMenuCommand } = createInMemoryWikiApi(
      { autoSave: false, theme: 'light' },
      {
        selectedFolder: 'C:\\wiki\\docs',
        workspaces: {
          'C:\\wiki\\docs': {
            'guide.md': md
          }
        }
      }
    )
    window.wikiApi = api

    const { container } = render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    const explorer = await screen.findByLabelText('워크스페이스 탐색기')
    await user.click(await within(explorer).findByText('guide.md'))

    const modeGroup = screen.getByRole('group', { name: '에디터 모드 전환' })

    // 1. Switch to 위지윅 mode, select 'Topic' in heading, press Ctrl+F -> auto-fills and highlights 3 rendered matches
    await user.click(within(modeGroup).getByRole('button', { name: '위지윅' }))
    const wysiwygEl = await screen.findByTestId('document-editor')
    const h1Text = wysiwygEl.querySelector('h1')!.firstChild!
    const selection = window.getSelection()!
    const h1Range = document.createRange()
    h1Range.setStart(h1Text, 5)
    h1Range.setEnd(h1Text, 10)
    selection.removeAllRanges()
    selection.addRange(h1Range)
    document.dispatchEvent(new Event('selectionchange'))

    fireEvent.keyDown(wysiwygEl, { key: 'f', ctrlKey: true })
    const findBar = await screen.findByRole('region', { name: '문서 내 찾기 바' })
    const findInput = within(findBar).getByRole('textbox', {
      name: '문서 내 검색어 입력'
    }) as HTMLInputElement
    expect(findInput.value).toBe('Topic')
    expect(within(findBar).getByText('1 / 4')).toBeInTheDocument()
    expect(container.querySelectorAll('.pm-search-match')).toHaveLength(4)
    expect(screen.queryByTestId('dirty-indicator')).not.toBeInTheDocument()

    // 2. Edit directly in 위지윅 mode -> count updates live to 1 / 5 and marks dirty
    const pEl = wysiwygEl.querySelector('p')!
    const caretRange = document.createRange()
    caretRange.selectNodeContents(pEl)
    caretRange.collapse(false)
    selection.removeAllRanges()
    selection.addRange(caretRange)
    wysiwygEl.focus()
    document.dispatchEvent(new Event('selectionchange'))
    await user.keyboard(' topic')
    expect(within(findBar).getByText('1 / 5')).toBeInTheDocument()
    expect(screen.getByTestId('dirty-indicator')).toBeInTheDocument()

    // 3. Switch to Split -> Raw counts 8 (incl. URL and mermaid source) & right Preview simultaneously highlights 5
    await user.click(within(modeGroup).getByRole('button', { name: 'Split' }))
    expect(within(findBar).getByText('1 / 8')).toBeInTheDocument()
    expect(container.querySelectorAll('.cm-search-match')).toHaveLength(8)
    expect(
      screen.getByTestId('split-markdown-preview').querySelectorAll('.preview-search-match')
    ).toHaveLength(5)

    // 4. Switch to Preview -> preserves Find Bar, highlights 5 rendered matches, and excludes code header & Mermaid chrome
    await user.click(within(modeGroup).getByRole('button', { name: 'Preview' }))
    expect(within(findBar).getByText('1 / 5')).toBeInTheDocument()
    expect(container.querySelectorAll('.preview-search-match')).toHaveLength(5)
    expect(await screen.findByTestId('mermaid-svg')).toHaveTextContent('MermaidDiagramSvg')

    // Searching code block header / Mermaid SVG / source text returns '결과 없음'
    await user.clear(findInput)
    await user.type(findInput, '코드 복사')
    expect(within(findBar).getByText('결과 없음')).toBeInTheDocument()
    await user.clear(findInput)
    await user.type(findInput, 'MermaidDiagramSvg')
    expect(within(findBar).getByText('결과 없음')).toBeInTheDocument()

    // Close Find Bar, select 'topicCode' in Preview code block body, press window Ctrl+F -> auto-fills
    fireEvent.keyDown(findInput, { key: 'Escape' })
    expect(screen.queryByRole('region', { name: '문서 내 찾기 바' })).not.toBeInTheDocument()

    const previewEl = screen.getByTestId('document-editor')
    const codeTextNode = Array.from(previewEl.querySelectorAll('pre code *')).find((el) =>
      el.textContent?.includes('topicCode')
    )!.firstChild!
    const codeRange = document.createRange()
    codeRange.selectNodeContents(codeTextNode)
    selection.removeAllRanges()
    selection.addRange(codeRange)

    fireEvent.keyDown(window, { key: 'f', ctrlKey: true })
    const reopenedBar = await screen.findByRole('region', { name: '문서 내 찾기 바' })
    expect(
      (within(reopenedBar).getByRole('textbox', { name: '문서 내 검색어 입력' }) as HTMLInputElement).value
    ).toBe('topicCode')
    expect(within(reopenedBar).getByText('1 / 1')).toBeInTheDocument()
    selection.removeAllRanges()
  })
})
