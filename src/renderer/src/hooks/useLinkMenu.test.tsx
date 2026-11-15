import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react'
import type { WorkspaceEntry } from '@shared/workspace'
import { LinkAutocompleteMenu } from '../components/LinkAutocompleteMenu'
import type { LinkCandidate, LinkQueryMatch } from '../editor/LinkAutocompleteEngine'
import { useLinkMenu } from './useLinkMenu'

function createMatch(label: string, query: string, rangeFrom = 0, rangeTo = 10): LinkQueryMatch {
  return { label, query, rangeFrom, rangeTo }
}

describe('useLinkMenu', () => {
  const sampleMarkdown = [
    '# 1.1. 개요',
    '',
    '## API 가이드',
    '',
    '## 요약'
  ].join('\n')

  it('매치가 전달되면 메뉴를 열고 우선순위 정렬된 헤딩 후보를 제공한다', () => {
    const onSelect = vi.fn()
    const onOpenMenu = vi.fn()

    const { result } = renderHook(() =>
      useLinkMenu({
        documentContent: sampleMarkdown,
        onSelectCandidate: onSelect,
        onOpenMenu
      })
    )

    expect(result.current.linkMenuProps.isOpen).toBe(false)

    act(() => {
      result.current.linkControlsRef.current.updateFromMatch(
        createMatch('API', '', 5, 11),
        { left: 40, top: 80, bottom: 98 },
        null
      )
    })

    expect(onOpenMenu).toHaveBeenCalledTimes(1)
    expect(result.current.linkMenuProps.isOpen).toBe(true)
    expect(
      result.current.linkMenuProps.candidates.map((c) => (c.kind === 'heading' ? c.title : c.name))
    ).toEqual([
      'API 가이드',
      '개요',
      '요약'
    ])
    expect(result.current.linkMenuProps.selectedIndex).toBe(0)
  })

  it('ArrowDown/ArrowUp 이동, applySelected 선택, dismiss 및 선택 영역 이탈 시 닫기를 처리한다', () => {
    const onSelect = vi.fn()

    const { result } = renderHook(() =>
      useLinkMenu({
        documentContent: sampleMarkdown,
        onSelectCandidate: onSelect
      })
    )

    act(() => {
      result.current.linkControlsRef.current.updateFromMatch(
        createMatch('', '', 0, 3),
        { left: 10, top: 20, bottom: 38 },
        null
      )
    })

    let handled = false
    act(() => {
      handled = result.current.linkControlsRef.current.moveSelection(1)
    })
    expect(handled).toBe(true)
    expect(result.current.linkMenuProps.selectedIndex).toBe(1)

    act(() => {
      handled = result.current.linkControlsRef.current.moveSelection(-1)
    })
    expect(handled).toBe(true)
    expect(result.current.linkMenuProps.selectedIndex).toBe(0)

    act(() => {
      result.current.linkControlsRef.current.moveSelection(-1)
    })
    expect(result.current.linkMenuProps.selectedIndex).toBe(2)

    act(() => {
      result.current.linkControlsRef.current.syncOpenSelection(
        createMatch('', '', 0, 3),
        { coordsAtPos: () => ({ left: 10, top: 20, bottom: 38 }) },
        null
      )
    })
    expect(result.current.linkMenuProps.isOpen).toBe(true)

    act(() => {
      handled = result.current.linkControlsRef.current.applySelected()
    })
    expect(handled).toBe(true)
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect.mock.calls[0][0].slug).toBe('요약')
    expect(onSelect.mock.calls[0][1]).toEqual(createMatch('', '', 0, 3))
    expect(result.current.linkMenuProps.isOpen).toBe(false)

    act(() => {
      result.current.linkControlsRef.current.updateFromMatch(
        createMatch('', '', 0, 3),
        { left: 10, top: 20, bottom: 38 },
        null
      )
    })
    expect(result.current.linkMenuProps.isOpen).toBe(true)

    act(() => {
      result.current.linkControlsRef.current.syncOpenSelection(
        createMatch('', '', 4, 7),
        { coordsAtPos: () => ({ left: 10, top: 20, bottom: 38 }) },
        null
      )
    })
    expect(result.current.linkMenuProps.isOpen).toBe(false)

    act(() => {
      result.current.linkControlsRef.current.updateFromMatch(
        createMatch('', '', 0, 3),
        { left: 10, top: 20, bottom: 38 },
        null
      )
    })
    expect(result.current.linkMenuProps.isOpen).toBe(true)

    act(() => {
      result.current.linkMenuProps.onHoverIndex(2)
    })
    expect(result.current.linkMenuProps.selectedIndex).toBe(2)

    act(() => {
      result.current.linkControlsRef.current.syncOpenSelection(
        null,
        { coordsAtPos: () => ({ left: 10, top: 20, bottom: 38 }) },
        null
      )
    })
    expect(result.current.linkMenuProps.isOpen).toBe(false)
  })

  it('일치하는 후보가 없으면 메뉴를 닫는다', () => {
    const onSelect = vi.fn()

    const { result } = renderHook(() =>
      useLinkMenu({
        documentContent: sampleMarkdown,
        onSelectCandidate: onSelect
      })
    )

    act(() => {
      result.current.linkControlsRef.current.updateFromMatch(
        createMatch('', '', 0, 3),
        { left: 10, top: 20, bottom: 38 },
        null
      )
    })
    expect(result.current.linkMenuProps.isOpen).toBe(true)

    act(() => {
      result.current.linkControlsRef.current.updateFromMatch(
        createMatch('', '없는검색어', 0, 8),
        { left: 10, top: 20, bottom: 38 },
        null
      )
    })

    expect(result.current.linkMenuProps.isOpen).toBe(false)
    expect(result.current.linkMenuProps.candidates).toEqual([])
    expect(result.current.linkControlsRef.current.applySelected()).toBe(false)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('workspaceMarkdownFiles 와 activeFilePath 를 병합·제외·필터링하고 열린 상태에서 파일 목록 변경 시 즉시 갱신한다', () => {
    const initialFiles: WorkspaceEntry[] = [
      {
        name: 'current.md',
        path: 'C:\\wiki\\docs\\current.md',
        relativePath: 'docs/current.md',
        kind: 'file'
      },
      {
        name: 'guide.md',
        path: 'C:\\wiki\\docs\\guide.md',
        relativePath: 'docs/guide.md',
        kind: 'file'
      },
      {
        name: 'overview.markdown',
        path: 'C:\\wiki\\overview.markdown',
        relativePath: 'overview.markdown',
        kind: 'file'
      }
    ]

    const { result, rerender } = renderHook(
      ({ files }: { files: WorkspaceEntry[] }) =>
        useLinkMenu({
          documentContent: sampleMarkdown,
          workspaceMarkdownFiles: files,
          activeFilePath: 'c:/wiki/docs/current.md',
          onSelectCandidate: vi.fn()
        }),
      { initialProps: { files: initialFiles } }
    )

    act(() => {
      result.current.linkControlsRef.current.updateFromMatch(
        createMatch('', '', 0, 3),
        { left: 10, top: 20, bottom: 38 },
        null
      )
    })

    expect(result.current.linkMenuProps.isOpen).toBe(true)
    expect(result.current.linkMenuProps.candidates.map((c) => c.id)).toEqual([
      'heading:1:11-개요',
      'heading:3:api-가이드',
      'heading:5:요약',
      'file:docs/guide.md',
      'file:overview.markdown'
    ])

    act(() => {
      result.current.linkControlsRef.current.updateFromMatch(
        createMatch('', './', 0, 5),
        { left: 10, top: 20, bottom: 38 },
        null
      )
    })
    expect(result.current.linkMenuProps.candidates.map((c) => c.id)).toEqual(['file:docs/guide.md'])

    rerender({
      files: [
        ...initialFiles,
        {
          name: 'new-sub.md',
          path: 'C:\\wiki\\docs\\sub\\new-sub.md',
          relativePath: 'docs/sub/new-sub.md',
          kind: 'file'
        }
      ]
    })

    expect(result.current.linkMenuProps.candidates.map((c) => c.id)).toEqual([
      'file:docs/guide.md',
      'file:docs/sub/new-sub.md'
    ])
  })
})

describe('LinkAutocompleteMenu', () => {
  it('role="listbox" aria-label="링크 자동완성" 로 렌더링하고 호버·클릭 선택과 바깥 클릭 닫기를 처리한다', () => {
    const onSelect = vi.fn()
    const onHoverIndex = vi.fn()
    const onDismiss = vi.fn()
    const candidates = [
      {
        kind: 'heading' as const,
        id: 'heading:1:overview',
        heading: {
          line: 1,
          level: 1 as const,
          depth: 1,
          number: '1.',
          rawTitle: '1. 개요',
          title: '개요',
          slug: '1-개요',
          hasExplicitNumber: true
        },
        title: '개요',
        slug: '1-개요'
      },
      {
        kind: 'heading' as const,
        id: 'heading:3:api',
        heading: {
          line: 3,
          level: 2 as const,
          depth: 2,
          number: '1.1.',
          rawTitle: 'API 가이드',
          title: 'API 가이드',
          slug: 'api-가이드',
          hasExplicitNumber: false
        },
        title: 'API 가이드',
        slug: 'api-가이드'
      }
    ]

    render(
      <div>
        <button type="button">outside</button>
        <LinkAutocompleteMenu
          isOpen
          candidates={candidates}
          selectedIndex={0}
          position={{ top: 50, left: 60 }}
          menuRef={{ current: null }}
          onSelect={onSelect}
          onHoverIndex={onHoverIndex}
          onDismiss={onDismiss}
        />
      </div>
    )

    const listbox = screen.getByRole('listbox', { name: '링크 자동완성' })
    expect(listbox).toBeInTheDocument()

    const options = screen.getAllByRole('option')
    expect(options[0]).toHaveAttribute('aria-selected', 'true')
    expect(options[1]).toHaveAttribute('aria-selected', 'false')
    expect(options[0]).toHaveTextContent('개요')
    expect(options[0]).toHaveTextContent('#1-개요')

    fireEvent.mouseEnter(options[1])
    expect(onHoverIndex).toHaveBeenCalledWith(1)

    const mouseDownEvent = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    options[1].dispatchEvent(mouseDownEvent)
    expect(mouseDownEvent.defaultPrevented).toBe(true)
    expect(onSelect).not.toHaveBeenCalled()

    fireEvent.click(options[1])
    expect(onSelect).toHaveBeenCalledWith(candidates[1])

    fireEvent.mouseDown(screen.getByRole('button', { name: 'outside' }))
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('후보가 비어 있으면 팝업을 렌더링하지 않는다', () => {
    render(
      <LinkAutocompleteMenu
        isOpen
        candidates={[]}
        selectedIndex={0}
        position={{ top: 0, left: 0 }}
        menuRef={{ current: null }}
        onSelect={vi.fn()}
        onHoverIndex={vi.fn()}
        onDismiss={vi.fn()}
      />
    )

    expect(screen.queryByRole('listbox', { name: '링크 자동완성' })).not.toBeInTheDocument()
  })

  it('파일 후보를 MD 배지, 파일명, 워크스페이스 루트 상대 경로로 구분해 렌더링한다', () => {
    const onSelect = vi.fn()
    const fileCandidate: LinkCandidate = {
      kind: 'file',
      id: 'file:docs/api/guide.md',
      name: 'guide.md',
      path: 'C:\\wiki\\docs\\api\\guide.md',
      relativePath: 'docs/api/guide.md',
      href: './api/guide.md',
      displayName: 'guide'
    }

    render(
      <LinkAutocompleteMenu
        isOpen
        candidates={[fileCandidate]}
        selectedIndex={0}
        position={{ top: 10, left: 20 }}
        menuRef={{ current: null }}
        onSelect={onSelect}
        onHoverIndex={vi.fn()}
        onDismiss={vi.fn()}
      />
    )

    const option = screen.getByRole('option')
    expect(option).toHaveTextContent('MD')
    expect(option).toHaveTextContent('guide.md')
    expect(option).toHaveTextContent('docs/api/guide.md')

    fireEvent.click(option)
    expect(onSelect).toHaveBeenCalledWith(fileCandidate)
  })
})
