import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FRONTMATTER_SCHEMA_RELATIVE_PATH,
  serializeFrontmatterSchema,
  type WorkspaceFrontmatterSchema
} from '@shared/frontmatter'
import { App } from './App'
import { switchPaneEditorMode } from './test/appTestHelpers'
import {
  createInMemoryWikiApi,
  setRawEditorText,
  triggerMenuCommand
} from './test/inMemoryWikiHarness'

vi.mock('mermaid', async () => (await import('./test/appTestHelpers')).createMermaidMockState().module)

const FULL_SEARCH_SCHEMA: WorkspaceFrontmatterSchema = {
  version: 1,
  fields: [
    {
      key: 'status',
      label: '상태',
      type: 'select',
      required: true,
      showInSearchBadge: true,
      options: [
        { value: 'todo', color: '#64748b' },
        { value: 'in-progress', color: '#2563eb' },
        { value: 'done', color: '#16a34a' }
      ]
    },
    {
      key: 'priority',
      label: '우선순위',
      type: 'select',
      showInSearchBadge: true,
      options: [
        { value: 'highest', color: '#dc2626' },
        { value: 'high', color: '#ea580c' },
        { value: 'medium', color: '#ca8a04' },
        { value: 'low', color: '#2563eb' }
      ]
    },
    {
      key: 'labels',
      label: '라벨',
      type: 'multi-select',
      allowCustom: true,
      showInSearchBadge: true,
      options: [
        { value: 'docs', color: '#0284c7' },
        { value: 'backend', color: '#7c3aed' }
      ]
    },
    { key: 'score', label: '점수', type: 'number' },
    { key: 'published', label: '공개 여부', type: 'boolean' },
    { key: 'dueDate', label: '마감일', type: 'date' },
    { key: 'assignee', label: '담당자', type: 'text' }
  ]
}

describe('Search View Frontmatter Filter Bar, Summary Badges & Sort (<App />)', () => {
  const disposers: Array<() => void> = []

  beforeEach(() => {
    document.documentElement.removeAttribute('data-theme')
    vi.useRealTimers()
  })

  afterEach(() => {
    for (const dispose of disposers.splice(0)) {
      dispose()
    }
  })

  it('shows 스키마 생성 guidance in Search View when workspace schema is missing and initializes starter schema on click', async () => {
    const user = userEvent.setup()
    const { api, emitMenuCommand, getFilesSnapshot, dispose } = createInMemoryWikiApi(
      { autoSave: false, theme: 'light' },
      {
        selectedFolder: 'C:\\wiki\\no-schema',
        workspaces: {
          'C:\\wiki\\no-schema': {
            'note.md': '---\nstatus: todo\n---\n# Note'
          }
        }
      }
    )
    disposers.push(dispose)
    window.wikiApi = api

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')

    await user.click(
      within(screen.getByRole('navigation', { name: '액티비티 바' })).getByRole('button', {
        name: '검색'
      })
    )

    const searchView = screen.getByRole('region', { name: '검색 뷰' })
    const filterBar = await within(searchView).findByRole('region', {
      name: '프론트매터 필터 바'
    })
    const createBtn = within(filterBar).getByRole('button', { name: '스키마 생성' })
    expect(within(filterBar).queryByRole('button', { name: '+ 필터 추가' })).not.toBeInTheDocument()

    await user.click(createBtn)

    await waitFor(() => {
      expect(getFilesSnapshot().has(`C:/wiki/no-schema/${FRONTMATTER_SCHEMA_RELATIVE_PATH}`)).toBe(
        true
      )
      expect(within(filterBar).getByRole('button', { name: '+ 필터 추가' })).toBeInTheDocument()
    })

    const sortSelect = within(filterBar).getByRole('combobox', {
      name: '검색 결과 정렬'
    }) as HTMLSelectElement
    expect(sortSelect.value).toBe('path:asc')
    expect(within(sortSelect).getByRole('option', { name: '기본 경로순' })).toBeInTheDocument()
    expect(within(sortSelect).getByRole('option', { name: '상태 오름차순' })).toBeInTheDocument()
    expect(within(sortSelect).getByRole('option', { name: '상태 내림차순' })).toBeInTheDocument()
  })

  it('supports keyboard-searchable + 필터 추가 popover, allowCustom live buffer values, attribute-only search, Refresh/Enter re-search, chip edit/remove, and 전체 초기화', async () => {
    const user = userEvent.setup()
    const { api, emitMenuCommand, dispose } = createInMemoryWikiApi(
      { autoSave: false, theme: 'light' },
      {
        selectedFolder: 'C:\\wiki\\docs',
        workspaces: {
          'C:\\wiki\\docs': {
            [FRONTMATTER_SCHEMA_RELATIVE_PATH]: serializeFrontmatterSchema(FULL_SEARCH_SCHEMA),
            'alpha.md': [
              '---',
              'status: in-progress',
              'priority: high',
              'labels: [backend, disk-custom]',
              '---',
              '# Alpha',
              'Alpha body'
            ].join('\n'),
            'beta.md': [
              '---',
              'status: in-progress',
              'priority: low',
              'labels: [docs]',
              '---',
              '# Beta',
              'Beta body'
            ].join('\n'),
            'gamma.md': [
              '---',
              'status: todo',
              'priority: medium',
              'labels: [backend]',
              '---',
              '# Gamma'
            ].join('\n')
          }
        }
      }
    )
    disposers.push(dispose)
    window.wikiApi = api

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')

    // Make unsaved frontmatter edit in beta.md adding custom label 'unsaved-sec'
    const explorer = await screen.findByLabelText('워크스페이스 탐색기')
    await user.click(await within(explorer).findByText('beta.md'))
    const betaEditor = await screen.findByTestId('document-editor')
    setRawEditorText(
      betaEditor,
      [
        '---',
        'status: in-progress',
        'priority: low',
        'labels: [docs, unsaved-sec]',
        '---',
        '# Beta',
        'Beta body'
      ].join('\n')
    )

    await user.click(
      within(screen.getByRole('navigation', { name: '액티비티 바' })).getByRole('button', {
        name: '검색'
      })
    )
    const searchView = screen.getByRole('region', { name: '검색 뷰' })
    const filterBar = within(searchView).getByRole('region', { name: '프론트매터 필터 바' })

    // 1. Add filter via keyboard search popover: 상태 -> 포함 -> in-progress (attribute-only, no text query!)
    await user.click(within(filterBar).getByRole('button', { name: '+ 필터 추가' }))
    const popover1 = within(filterBar).getByRole('dialog', { name: '프론트매터 필터 설정' })
    const fieldSearch1 = within(popover1).getByRole('textbox', { name: '필터 필드 검색' })
    expect(fieldSearch1).toHaveFocus()
    await user.type(fieldSearch1, '상태{Enter}')

    const opList1 = within(popover1).getByRole('listbox', { name: '필터 연산자 목록' })
    expect(opList1).toHaveFocus()
    fireEvent.keyDown(opList1, { key: 'Enter' }) // selects '포함' ('in')

    const valSearch1 = within(popover1).getByRole('textbox', { name: '옵션 값 검색' })
    expect(valSearch1).toHaveFocus()
    await user.type(valSearch1, 'in-progress{Enter}')
    fireEvent.keyDown(valSearch1, { key: 'Enter' }) // commits chip & triggers attribute-only search

    await waitFor(() => {
      const resultList = within(searchView).getByRole('list', { name: '검색 결과 목록' })
      expect(within(resultList).getByText('alpha.md')).toBeInTheDocument()
      expect(within(resultList).getByText('beta.md')).toBeInTheDocument()
      expect(within(resultList).queryByText('gamma.md')).not.toBeInTheDocument()
    })

    // Refresh & Enter both work without text query when filters are active
    const searchSpy = vi.spyOn(api.workspace as Required<typeof api.workspace>, 'search')
    const refreshBtn = within(searchView).getByRole('button', { name: '검색 새로고침' })
    expect(refreshBtn).toBeEnabled()
    await user.click(refreshBtn)
    await waitFor(() => expect(searchSpy).toHaveBeenCalledTimes(1))

    fireEvent.keyDown(within(searchView).getByRole('textbox', { name: '검색어 입력' }), {
      key: 'Enter'
    })
    await waitFor(() => expect(searchSpy).toHaveBeenCalledTimes(2))
    searchSpy.mockRestore()

    // 2. Add second filter on allowCustom multi-select '라벨': sees schema options, disk-custom, AND unsaved-sec!
    await user.click(within(filterBar).getByRole('button', { name: '+ 필터 추가' }))
    const popover2 = within(filterBar).getByRole('dialog', { name: '프론트매터 필터 설정' })
    await user.type(within(popover2).getByRole('textbox', { name: '필터 필드 검색' }), '라벨{Enter}')
    await user.click(within(popover2).getByRole('option', { name: '하나라도 포함' }))

    await waitFor(() => {
      expect(within(popover2).getByLabelText('backend')).toBeInTheDocument()
      expect(within(popover2).getByLabelText('disk-custom')).toBeInTheDocument()
      expect(within(popover2).getByLabelText('unsaved-sec')).toBeInTheDocument()
    })
    await user.click(within(popover2).getByLabelText('unsaved-sec'))
    await user.click(within(popover2).getByRole('button', { name: '적용' }))

    await waitFor(() => {
      const resultList = within(searchView).getByRole('list', { name: '검색 결과 목록' })
      expect(within(resultList).getByText('beta.md')).toBeInTheDocument()
      expect(within(resultList).queryByText('alpha.md')).not.toBeInTheDocument()
    })

    // 3. Edit the '라벨' filter chip -> switch to '제외' ('none-of') -> alpha.md matches instead of beta.md
    await user.click(within(filterBar).getByRole('button', { name: /라벨 필터 수정/ }))
    const editPopover = within(filterBar).getByRole('dialog', { name: '프론트매터 필터 설정' })
    await user.selectOptions(within(editPopover).getByRole('combobox', { name: '연산자 선택' }), 'none-of')
    await user.click(within(editPopover).getByRole('button', { name: '적용' }))

    await waitFor(() => {
      const resultList = within(searchView).getByRole('list', { name: '검색 결과 목록' })
      expect(within(resultList).getByText('alpha.md')).toBeInTheDocument()
      expect(within(resultList).queryByText('beta.md')).not.toBeInTheDocument()
    })

    // 4. Individual chip removal ('라벨 필터 제거') restores both alpha.md and beta.md
    await user.click(within(filterBar).getByRole('button', { name: '라벨 필터 제거' }))
    await waitFor(() => {
      const resultList = within(searchView).getByRole('list', { name: '검색 결과 목록' })
      expect(within(resultList).getByText('alpha.md')).toBeInTheDocument()
      expect(within(resultList).getByText('beta.md')).toBeInTheDocument()
    })

    // 5. 전체 초기화 clears all chips and returns to empty prompt
    await user.click(within(filterBar).getByRole('button', { name: '필터 전체 초기화' }))
    await waitFor(() => {
      expect(within(searchView).getByText('검색어를 입력하세요.')).toBeInTheDocument()
    })
  })

  it('filters across text, number, date, boolean, and is-empty operators combined with regex search and preserves editor mode on search jump', async () => {
    const user = userEvent.setup()
    const { api, emitMenuCommand, dispose } = createInMemoryWikiApi(
      { autoSave: false, theme: 'light' },
      {
        selectedFolder: 'C:\\wiki\\ops',
        workspaces: {
          'C:\\wiki\\ops': {
            [FRONTMATTER_SCHEMA_RELATIVE_PATH]: serializeFrontmatterSchema(FULL_SEARCH_SCHEMA),
            'target.md': [
              '---',
              'status: in-progress',
              'score: 3',
              'published: true',
              'dueDate: 2026-11-20',
              'assignee: alice-kim',
              '---',
              '# Security Report',
              '',
              'Audit  Token verified'
            ].join('\n'),
            'out-of-range.md': [
              '---',
              'status: in-progress',
              'score: 10',
              'published: true',
              'dueDate: 2026-11-20',
              'assignee: alice-kim',
              '---',
              '# Out of range',
              '',
              'Audit  Token verified'
            ].join('\n'),
            'unpublished.md': [
              '---',
              'status: in-progress',
              'score: 3',
              'published: false',
              'dueDate: 2026-11-20',
              'assignee: alice-kim',
              '---',
              '# Unpublished',
              '',
              'Audit  Token verified'
            ].join('\n'),
            'empty-assignee.md': [
              '---',
              'status: todo',
              'score: 3',
              '---',
              '# Unassigned'
            ].join('\n')
          }
        }
      }
    )
    disposers.push(dispose)
    window.wikiApi = api

    const scrollIntoViewMock = vi.fn()
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView
    HTMLElement.prototype.scrollIntoView = scrollIntoViewMock

    try {
      const { container } = render(<App />)
      await triggerMenuCommand(emitMenuCommand, 'open-folder')

      // Open target.md in Preview mode before searching
      const explorer = await screen.findByLabelText('워크스페이스 탐색기')
      await user.click(await within(explorer).findByText('target.md'))
      await switchPaneEditorMode(user, screen.getByTestId('pane-primary'), 'Preview')
      await user.click(within(explorer).getByText('empty-assignee.md'))

      await user.click(
        within(screen.getByRole('navigation', { name: '액티비티 바' })).getByRole('button', {
          name: '검색'
        })
      )
      const searchView = screen.getByRole('region', { name: '검색 뷰' })
      const filterBar = within(searchView).getByRole('region', { name: '프론트매터 필터 바' })

      // 1. number between [1, 5]
      await user.click(within(filterBar).getByRole('button', { name: '+ 필터 추가' }))
      let popover = within(filterBar).getByRole('dialog', { name: '프론트매터 필터 설정' })
      await user.click(within(popover).getByRole('option', { name: /점수/ }))
      await user.click(within(popover).getByRole('option', { name: '범위' }))
      await user.type(within(popover).getByLabelText('최솟값'), '1')
      await user.type(within(popover).getByLabelText('최댓값'), '5')
      await user.click(within(popover).getByRole('button', { name: '적용' }))

      // 2. boolean equals true ('예')
      await user.click(within(filterBar).getByRole('button', { name: '+ 필터 추가' }))
      popover = within(filterBar).getByRole('dialog', { name: '프론트매터 필터 설정' })
      await user.click(within(popover).getByRole('option', { name: /공개 여부/ }))
      await user.click(within(popover).getByRole('option', { name: '일치' }))
      await user.click(within(popover).getByRole('option', { name: '예' }))

      // 3. date lte 2026-11-25
      await user.click(within(filterBar).getByRole('button', { name: '+ 필터 추가' }))
      popover = within(filterBar).getByRole('dialog', { name: '프론트매터 필터 설정' })
      await user.click(within(popover).getByRole('option', { name: /마감일/ }))
      await user.click(within(popover).getByRole('option', { name: '이전 (<=)' }))
      fireEvent.change(within(popover).getByLabelText('날짜 값 입력'), {
        target: { value: '2026-11-25' }
      })
      await user.click(within(popover).getByRole('button', { name: '적용' }))

      // 4. text contains 'KIM' (case-insensitive)
      await user.click(within(filterBar).getByRole('button', { name: '+ 필터 추가' }))
      popover = within(filterBar).getByRole('dialog', { name: '프론트매터 필터 설정' })
      await user.click(within(popover).getByRole('option', { name: /담당자/ }))
      await user.click(within(popover).getByRole('option', { name: '포함' }))
      await user.type(within(popover).getByLabelText('필터 값 입력'), 'KIM')
      await user.click(within(popover).getByRole('button', { name: '적용' }))

      // 5. Combine with regex search (.*)
      await user.click(within(searchView).getByRole('button', { name: /정규식/ }))
      const searchInput = within(searchView).getByRole('textbox', { name: '검색어 입력' })
      await user.type(searchInput, 'Audit\\s+Token')
      fireEvent.keyDown(searchInput, { key: 'Enter' })

      await waitFor(() => {
        const list = within(searchView).getByRole('list', { name: '검색 결과 목록' })
        expect(within(list).getByText('target.md')).toBeInTheDocument()
        expect(within(list).queryByText('out-of-range.md')).not.toBeInTheDocument()
        expect(within(list).queryByText('unpublished.md')).not.toBeInTheDocument()
        expect(within(list).queryByText('empty-assignee.md')).not.toBeInTheDocument()
      })

      // Summary badge coexists with line snippet & Preview mode jump
      const targetRow = within(searchView).getByRole('group', { name: 'target.md 프론트매터 요약' })
      expect(within(targetRow).getByRole('button', { name: /상태: in-progress/ })).toBeInTheDocument()
      await user.click(within(searchView).getByRole('button', { name: /Audit\s+Token verified/ }))

      await waitFor(() => {
        expect(screen.getByRole('tab', { name: 'target.md' })).toHaveAttribute('aria-selected', 'true')
        expect(container.querySelector('.preview-search-jump-highlight')).toBeInTheDocument()
      })
      expect(
        within(screen.getByRole('group', { name: '에디터 모드 전환' })).getByRole('button', {
          name: 'Preview'
        })
      ).toHaveAttribute('aria-pressed', 'true')

      // 6. Verify is-empty operator finds empty-assignee.md after clearing previous filters & query
      await user.click(within(filterBar).getByRole('button', { name: '필터 전체 초기화' }))
      await user.clear(searchInput)
      await user.click(within(filterBar).getByRole('button', { name: '+ 필터 추가' }))
      popover = within(filterBar).getByRole('dialog', { name: '프론트매터 필터 설정' })
      await user.click(within(popover).getByRole('option', { name: /담당자/ }))
      await user.click(within(popover).getByRole('option', { name: '비어 있음' }))

      await waitFor(() => {
        const list = within(searchView).getByRole('list', { name: '검색 결과 목록' })
        expect(within(list).getByText('empty-assignee.md')).toBeInTheDocument()
        expect(within(list).queryByText('target.md')).not.toBeInTheDocument()
      })
    } finally {
      HTMLElement.prototype.scrollIntoView = originalScrollIntoView
    }
  }, 20_000)

  it('displays summary badges, adds/applies filter immediately on badge click, and sorts by path or schema field order with empty values last', async () => {
    const user = userEvent.setup()
    const { api, emitMenuCommand, dispose } = createInMemoryWikiApi(
      { autoSave: false, theme: 'light' },
      {
        selectedFolder: 'C:\\wiki\\sort',
        workspaces: {
          'C:\\wiki\\sort': {
            [FRONTMATTER_SCHEMA_RELATIVE_PATH]: serializeFrontmatterSchema(FULL_SEARCH_SCHEMA),
            'a-low.md': '---\nstatus: todo\npriority: low\nlabels: [docs]\n---\nSharedToken',
            'b-empty.md': '---\nstatus: todo\n---\nSharedToken',
            'c-highest.md': '---\nstatus: in-progress\npriority: highest\nlabels: [backend]\n---\nSharedToken',
            'd-high.md': '---\nstatus: done\npriority: high\nlabels: [backend, docs]\n---\nSharedToken'
          }
        }
      }
    )
    disposers.push(dispose)
    window.wikiApi = api

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')

    await user.click(
      within(screen.getByRole('navigation', { name: '액티비티 바' })).getByRole('button', {
        name: '검색'
      })
    )
    const searchView = screen.getByRole('region', { name: '검색 뷰' })
    const filterBar = within(searchView).getByRole('region', { name: '프론트매터 필터 바' })
    const searchInput = within(searchView).getByRole('textbox', { name: '검색어 입력' })

    await user.type(searchInput, 'SharedToken')
    fireEvent.keyDown(searchInput, { key: 'Enter' })

    const getOrderedPaths = () =>
      Array.from(
        within(searchView).getByRole('list', { name: '검색 결과 목록' }).children
      ).map((li) => li.querySelector('.search-file-path')?.textContent)

    await waitFor(() => {
      expect(getOrderedPaths()).toEqual(['a-low.md', 'b-empty.md', 'c-highest.md', 'd-high.md'])
    })

    // Sort by priority asc (schema options order: highest -> high -> low, empty last)
    const sortSelect = within(filterBar).getByRole('combobox', { name: '검색 결과 정렬' })
    await user.selectOptions(sortSelect, 'frontmatter:asc:priority')
    await waitFor(() => {
      expect(getOrderedPaths()).toEqual(['c-highest.md', 'd-high.md', 'a-low.md', 'b-empty.md'])
    })

    // Sort by priority desc (low -> high -> highest, empty STILL last)
    await user.selectOptions(sortSelect, 'frontmatter:desc:priority')
    await waitFor(() => {
      expect(getOrderedPaths()).toEqual(['a-low.md', 'd-high.md', 'c-highest.md', 'b-empty.md'])
    })

    // Reset to 기본 경로순
    await user.selectOptions(sortSelect, 'path:asc')
    await waitFor(() => {
      expect(getOrderedPaths()).toEqual(['a-low.md', 'b-empty.md', 'c-highest.md', 'd-high.md'])
    })

    // Clicking summary badge ('backend' on c-highest.md) adds filter chip immediately and narrows results
    const cSummary = within(searchView).getByRole('group', { name: 'c-highest.md 프론트매터 요약' })
    await user.click(within(cSummary).getByRole('button', { name: '라벨: backend 필터 추가' }))

    await waitFor(() => {
      expect(getOrderedPaths()).toEqual(['c-highest.md', 'd-high.md'])
      expect(within(filterBar).getByRole('button', { name: /라벨 필터 수정/ })).toHaveTextContent(
        '라벨 (모두): backend'
      )
    })

    // Clicking 'high' summary badge on d-high.md adds status/priority filter and narrows further to d-high.md
    const dSummary = within(searchView).getByRole('group', { name: 'd-high.md 프론트매터 요약' })
    await user.click(within(dSummary).getByRole('button', { name: '우선순위: high 필터 추가' }))

    await waitFor(() => {
      expect(getOrderedPaths()).toEqual(['d-high.md'])
      expect(within(filterBar).getByRole('button', { name: /우선순위 필터 수정/ })).toHaveTextContent(
        '우선순위: high'
      )
    })

    // Clicking already-active 'high' badge again does not duplicate the chip
    await user.click(within(dSummary).getByRole('button', { name: '우선순위: high 필터 추가' }))
    expect(within(filterBar).getAllByRole('button', { name: /우선순위 필터 수정/ })).toHaveLength(1)
  })

  it('retains filter and sort state across left sidebar view switches/collapse and cancelled workspace switch, resets on workspace switch, and never persists to workspace-state.json', async () => {
    const user = userEvent.setup()
    const { api, emitMenuCommand, dispose } = createInMemoryWikiApi(
      {
        autoSave: false,
        theme: 'light',
        recentWorkspaces: ['C:/wiki/alpha', 'C:/wiki/beta']
      },
      {
        selectedFolder: 'C:\\wiki\\alpha',
        workspaces: {
          'C:\\wiki\\alpha': {
            [FRONTMATTER_SCHEMA_RELATIVE_PATH]: serializeFrontmatterSchema(FULL_SEARCH_SCHEMA),
            'a.md': '---\nstatus: in-progress\npriority: low\n---\nAlpha',
            'b.md': '---\nstatus: in-progress\npriority: highest\n---\nBeta'
          },
          'C:\\wiki\\beta': {
            [FRONTMATTER_SCHEMA_RELATIVE_PATH]: serializeFrontmatterSchema(FULL_SEARCH_SCHEMA),
            'c.md': '---\nstatus: todo\n---\nGamma'
          }
        }
      }
    )
    disposers.push(dispose)
    const saveWorkspaceStateSpy = vi.spyOn(api.workspaceState!, 'save')
    window.wikiApi = api

    render(<App />)
    await waitFor(() => {
      expect(within(screen.getByLabelText('워크스페이스 탐색기')).getByText('a.md')).toBeInTheDocument()
    })

    const activityBar = screen.getByRole('navigation', { name: '액티비티 바' })
    await user.click(within(activityBar).getByRole('button', { name: '검색' }))
    const searchView = screen.getByRole('region', { name: '검색 뷰' })
    const filterBar = within(searchView).getByRole('region', { name: '프론트매터 필터 바' })

    // Select filter & custom sort
    await user.click(within(filterBar).getByRole('button', { name: '+ 필터 추가' }))
    const popover = within(filterBar).getByRole('dialog', { name: '프론트매터 필터 설정' })
    await user.click(within(popover).getByRole('option', { name: /상태/ }))
    await user.click(within(popover).getByRole('option', { name: '포함' }))
    await user.click(within(popover).getByLabelText('in-progress'))
    await user.click(within(popover).getByRole('button', { name: '적용' }))
    await user.selectOptions(
      within(filterBar).getByRole('combobox', { name: '검색 결과 정렬' }),
      'frontmatter:asc:priority'
    )

    await waitFor(() => {
      expect(within(searchView).getByText('b.md')).toBeInTheDocument()
    })

    // Switch to Explorer & Git, then collapse & expand Search View -> state retained without re-searching
    const searchSpy = vi.spyOn(api.workspace as Required<typeof api.workspace>, 'search')
    searchSpy.mockClear()

    await user.click(within(activityBar).getByRole('button', { name: '탐색기' }))
    await user.click(within(activityBar).getByRole('button', { name: 'Git' }))
    await user.click(within(activityBar).getByRole('button', { name: '검색' }))
    await user.click(within(activityBar).getByRole('button', { name: '검색' })) // collapse
    await user.click(within(activityBar).getByRole('button', { name: '검색' })) // expand

    const restoredView = screen.getByRole('region', { name: '검색 뷰' })
    const restoredBar = within(restoredView).getByRole('region', { name: '프론트매터 필터 바' })
    expect(within(restoredBar).getByRole('button', { name: /상태 필터 수정/ })).toHaveTextContent(
      '상태: in-progress'
    )
    expect(
      (within(restoredBar).getByRole('combobox', { name: '검색 결과 정렬' }) as HTMLSelectElement)
        .value
    ).toBe('frontmatter:asc:priority')
    expect(within(restoredView).getByText('b.md')).toBeInTheDocument()
    expect(searchSpy).not.toHaveBeenCalled()

    // Cancelled dirty workspace switch keeps filter & sort intact
    await user.click(within(restoredView).getByText('b.md'))
    setRawEditorText(await screen.findByTestId('document-editor'), '---\nstatus: in-progress\n---\nDirty')
    await user.click(within(activityBar).getByRole('button', { name: '워크스페이스' }))
    await user.click(
      within(screen.getByRole('region', { name: '워크스페이스 뷰' })).getByRole('button', {
        name: /^beta$/i
      })
    )
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: '취소' }))
    await user.click(within(activityBar).getByRole('button', { name: '검색' }))
    expect(
      within(screen.getByRole('region', { name: '프론트매터 필터 바' })).getByRole('button', {
        name: /상태 필터 수정/
      })
    ).toBeInTheDocument()

    // Confirmed workspace switch cleanly resets filters, sort, and results and never persists to workspace-state.json
    saveWorkspaceStateSpy.mockClear()
    api.workspace.selectFolder = async () => 'C:/wiki/beta'
    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: '버리고 이동' })
    )

    await waitFor(() => {
      const switchedSearch = screen.getByRole('region', { name: '검색 뷰' })
      const switchedBar = within(switchedSearch).getByRole('region', { name: '프론트매터 필터 바' })
      expect(within(switchedBar).queryByRole('button', { name: /필터 수정/ })).not.toBeInTheDocument()
      expect(
        (within(switchedBar).getByRole('combobox', { name: '검색 결과 정렬' }) as HTMLSelectElement)
          .value
      ).toBe('path:asc')
      expect(within(switchedSearch).getByText('검색어를 입력하세요.')).toBeInTheDocument()
    })

    const savedAlpha = await api.workspaceState!.get('C:/wiki/alpha')
    expect(JSON.stringify(savedAlpha)).not.toContain('in-progress')
    expect(JSON.stringify(savedAlpha)).not.toContain('priority')
    for (const [, update] of saveWorkspaceStateSpy.mock.calls) {
      expect(JSON.stringify(update)).not.toContain('in-progress')
      expect(JSON.stringify(update)).not.toContain('priority')
    }
  })

  it('keeps filter popover state consistent across chip removal, cross-chip edit switch, and live schema field deletion', async () => {
    const user = userEvent.setup()
    const { api, emitMenuCommand, dispose } = createInMemoryWikiApi(
      { autoSave: false, theme: 'light' },
      {
        selectedFolder: 'C:\\wiki\\popover-guards',
        workspaces: {
          'C:\\wiki\\popover-guards': {
            [FRONTMATTER_SCHEMA_RELATIVE_PATH]: serializeFrontmatterSchema(FULL_SEARCH_SCHEMA),
            'a.md': '---\nstatus: in-progress\npriority: high\nassignee: kim\n---\nAlpha',
            'b.md': '---\nstatus: done\npriority: low\npublished: true\n---\nBeta'
          }
        }
      }
    )
    disposers.push(dispose)
    window.wikiApi = api

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    await waitFor(() => {
      expect(within(screen.getByLabelText('워크스페이스 탐색기')).getByText('a.md')).toBeInTheDocument()
    })

    await user.click(
      within(screen.getByRole('navigation', { name: '액티비티 바' })).getByRole('button', {
        name: '검색'
      })
    )
    const searchView = screen.getByRole('region', { name: '검색 뷰' })
    const filterBar = within(searchView).getByRole('region', { name: '프론트매터 필터 바' })

    // 1. Removing chip 0 while editing chip 1 closes stale edit popover without corrupting chip 1
    await user.click(within(filterBar).getByRole('button', { name: '+ 필터 추가' }))
    let popover = within(filterBar).getByRole('dialog', { name: '프론트매터 필터 설정' })
    await user.click(within(popover).getByRole('option', { name: /상태/ }))
    await user.click(within(popover).getByRole('option', { name: '포함' }))
    await user.click(within(popover).getByLabelText('in-progress'))
    await user.click(within(popover).getByRole('button', { name: '적용' }))

    await user.click(within(filterBar).getByRole('button', { name: '+ 필터 추가' }))
    popover = within(filterBar).getByRole('dialog', { name: '프론트매터 필터 설정' })
    await user.click(within(popover).getByRole('option', { name: /우선순위/ }))
    await user.click(within(popover).getByRole('option', { name: '포함' }))
    await user.click(within(popover).getByLabelText('high'))
    await user.click(within(popover).getByRole('button', { name: '적용' }))

    await user.click(within(filterBar).getByRole('button', { name: /우선순위 필터 수정/ }))
    expect(within(filterBar).getByRole('dialog', { name: '프론트매터 필터 설정' })).toBeInTheDocument()

    await user.click(within(filterBar).getByRole('button', { name: '상태 필터 제거' }))
    expect(within(filterBar).queryByRole('dialog', { name: '프론트매터 필터 설정' })).not.toBeInTheDocument()
    expect(within(filterBar).queryByRole('button', { name: /상태 필터 수정/ })).not.toBeInTheDocument()
    expect(within(filterBar).getByRole('button', { name: /우선순위 필터 수정/ })).toBeInTheDocument()

    await user.click(within(filterBar).getByRole('button', { name: /우선순위 필터 수정/ }))
    popover = within(filterBar).getByRole('dialog', { name: '프론트매터 필터 설정' })
    await user.click(within(popover).getByLabelText('high'))
    await user.click(within(popover).getByLabelText('low'))
    await user.click(within(popover).getByRole('button', { name: '적용' }))
    await waitFor(() => {
      const list = within(searchView).getByRole('list', { name: '검색 결과 목록' })
      expect(within(list).getByText('b.md')).toBeInTheDocument()
      expect(within(list).queryByText('a.md')).not.toBeInTheDocument()
    })

    // 2. Switching directly from editing a 3-operator field (상태 · 비어 있음) to a 2-operator field (공개 여부 · 비어 있음)
    await user.click(within(filterBar).getByRole('button', { name: '필터 전체 초기화' }))

    await user.click(within(filterBar).getByRole('button', { name: '+ 필터 추가' }))
    popover = within(filterBar).getByRole('dialog', { name: '프론트매터 필터 설정' })
    await user.click(within(popover).getByRole('option', { name: /상태/ }))
    await user.click(within(popover).getByRole('option', { name: '비어 있음' }))

    await user.click(within(filterBar).getByRole('button', { name: '+ 필터 추가' }))
    popover = within(filterBar).getByRole('dialog', { name: '프론트매터 필터 설정' })
    await user.click(within(popover).getByRole('option', { name: /공개 여부/ }))
    await user.click(within(popover).getByRole('option', { name: '비어 있음' }))

    await user.click(within(filterBar).getByRole('button', { name: /상태 필터 수정/ }))
    await user.click(within(filterBar).getByRole('button', { name: /공개 여부 필터 수정/ }))
    popover = within(filterBar).getByRole('dialog', { name: '프론트매터 필터 설정' })
    const operatorList = within(popover).getByRole('listbox', { name: '필터 연산자 목록' })
    fireEvent.keyDown(operatorList, { key: 'Enter' })
    expect(within(filterBar).queryByRole('dialog', { name: '프론트매터 필터 설정' })).not.toBeInTheDocument()
    expect(within(filterBar).getByRole('button', { name: /공개 여부 필터 수정/ })).toHaveTextContent(
      '공개 여부 · 비어 있음'
    )

    await user.click(within(filterBar).getByRole('button', { name: /공개 여부 필터 수정/ }))
    const switchedOperatorList = within(filterBar).getByRole('listbox', {
      name: '필터 연산자 목록'
    })
    fireEvent.keyDown(switchedOperatorList, { key: 'ArrowDown' })
    fireEvent.keyDown(switchedOperatorList, { key: 'Enter' })
    await user.click(within(filterBar).getByRole('option', { name: '예' }))
    expect(within(filterBar).getByRole('button', { name: /공개 여부 필터 수정/ })).toHaveTextContent(
      '공개 여부: 예'
    )

    // 3. Deleting the currently edited field from schema closes the popover cleanly
    await user.click(within(filterBar).getByRole('button', { name: '필터 전체 초기화' }))
    await user.click(within(filterBar).getByRole('button', { name: '+ 필터 추가' }))
    popover = within(filterBar).getByRole('dialog', { name: '프론트매터 필터 설정' })
    await user.click(within(popover).getByRole('option', { name: /담당자/ }))
    await user.click(within(popover).getByRole('option', { name: '포함' }))
    await user.type(within(popover).getByLabelText('필터 값 입력'), 'kim')
    await user.click(within(popover).getByRole('button', { name: '적용' }))

    await user.click(within(filterBar).getByRole('button', { name: /담당자 필터 수정/ }))
    expect(within(filterBar).getByRole('dialog', { name: '프론트매터 필터 설정' })).toBeInTheDocument()

    await api.frontmatter!.saveSchema({
      version: 1,
      fields: FULL_SEARCH_SCHEMA.fields.filter((field) => field.key !== 'assignee')
    })

    await waitFor(() => {
      expect(within(filterBar).queryByRole('dialog', { name: '프론트매터 필터 설정' })).not.toBeInTheDocument()
      expect(within(filterBar).queryByRole('button', { name: /담당자 필터 수정/ })).not.toBeInTheDocument()
    })
  })

  it('clears draft values when backing out to another field, dismisses/drops incompatible conditions on live field type changes, and keys summary label off response.query', async () => {
    const user = userEvent.setup()
    const { api, emitMenuCommand, dispose } = createInMemoryWikiApi(
      { autoSave: false, theme: 'light' },
      {
        selectedFolder: 'C:\\wiki\\draft-reset',
        workspaces: {
          'C:\\wiki\\draft-reset': {
            [FRONTMATTER_SCHEMA_RELATIVE_PATH]: serializeFrontmatterSchema(FULL_SEARCH_SCHEMA),
            'a.md': '---\nstatus: in-progress\npriority: high\npublished: true\nassignee: kim\n---\nAlpha',
            'b.md': '---\nstatus: done\npriority: low\npublished: false\n---\nBeta'
          }
        }
      }
    )
    disposers.push(dispose)
    window.wikiApi = api

    render(<App />)
    await triggerMenuCommand(emitMenuCommand, 'open-folder')
    await waitFor(() => {
      expect(within(screen.getByLabelText('워크스페이스 탐색기')).getByText('a.md')).toBeInTheDocument()
    })

    await user.click(
      within(screen.getByRole('navigation', { name: '액티비티 바' })).getByRole('button', {
        name: '검색'
      })
    )
    const searchView = screen.getByRole('region', { name: '검색 뷰' })
    const filterBar = within(searchView).getByRole('region', { name: '프론트매터 필터 바' })

    // 1. Backing out from value step to field step and picking another field clears selectedValues & textValue
    await user.click(within(filterBar).getByRole('button', { name: '+ 필터 추가' }))
    let popover = within(filterBar).getByRole('dialog', { name: '프론트매터 필터 설정' })
    await user.click(within(popover).getByRole('option', { name: /상태/ }))
    await user.click(within(popover).getByRole('option', { name: '포함' }))
    await user.click(within(popover).getByLabelText('in-progress'))
    await user.click(within(popover).getByRole('button', { name: '연산자 선택으로 돌아가기' }))
    await user.click(within(popover).getByRole('button', { name: '필드 선택으로 돌아가기' }))
    await user.click(within(popover).getByRole('option', { name: /우선순위/ }))
    await user.click(within(popover).getByRole('option', { name: '포함' }))
    expect(within(popover).queryByLabelText('in-progress')).not.toBeInTheDocument()

    await user.click(within(popover).getByRole('button', { name: '연산자 선택으로 돌아가기' }))
    await user.click(within(popover).getByRole('button', { name: '필드 선택으로 돌아가기' }))
    await user.click(within(popover).getByRole('option', { name: /담당자/ }))
    await user.click(within(popover).getByRole('option', { name: '일치' }))
    await user.type(within(popover).getByLabelText('필터 값 입력'), '123')
    await user.click(within(popover).getByRole('button', { name: '연산자 선택으로 돌아가기' }))
    await user.click(within(popover).getByRole('button', { name: '필드 선택으로 돌아가기' }))
    await user.click(within(popover).getByRole('option', { name: /점수/ }))
    await user.click(within(popover).getByRole('option', { name: '같음 (=)' }))
    expect(within(popover).getByLabelText('숫자 값 입력')).toHaveValue(null)
    await user.click(within(filterBar).getByRole('button', { name: '+ 필터 추가' })) // close

    // 2. Summary text reflects response.query during debounce rather than unsubmitted input query
    await user.click(within(filterBar).getByRole('button', { name: '+ 필터 추가' }))
    popover = within(filterBar).getByRole('dialog', { name: '프론트매터 필터 설정' })
    await user.click(within(popover).getByRole('option', { name: /공개 여부/ }))
    await user.click(within(popover).getByRole('option', { name: '일치' }))
    await user.click(within(popover).getByRole('option', { name: '예' }))

    await waitFor(() => {
      expect(within(searchView).getByText('1개 파일 (속성 일치)')).toBeInTheDocument()
    })
    const searchInput = within(searchView).getByRole('textbox', { name: '검색어 입력' })
    fireEvent.change(searchInput, { target: { value: 'a' } })
    expect(within(searchView).getByText('1개 파일 (속성 일치)')).toBeInTheDocument()

    // 3. Changing a field's type in schema dismisses open edit popover and reconciles incompatible conditions
    await user.clear(searchInput)
    await user.click(within(filterBar).getByRole('button', { name: /공개 여부 필터 수정/ }))
    expect(within(filterBar).getByRole('dialog', { name: '프론트매터 필터 설정' })).toBeInTheDocument()

    await api.frontmatter!.saveSchema({
      version: 1,
      fields: FULL_SEARCH_SCHEMA.fields.map((field) =>
        field.key === 'published' ? { key: 'published', label: '공개 여부', type: 'text' } : field
      )
    })

    await waitFor(() => {
      expect(within(filterBar).queryByRole('dialog', { name: '프론트매터 필터 설정' })).not.toBeInTheDocument()
      expect(within(filterBar).queryByRole('button', { name: /공개 여부 필터 수정/ })).not.toBeInTheDocument()
    })
  })
})
