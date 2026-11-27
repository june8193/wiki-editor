// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { GitBlobSnapshotRequest } from '@shared/symbol'
import { SnapshotViewer, type SnapshotContentState } from './SnapshotViewer'

describe('SnapshotViewer', () => {
  const baseRequest: GitBlobSnapshotRequest = {
    path: 'src/utils/helper.ts',
    scope: { kind: 'git-ref', ref: 'abc1234', displayRef: 'abc1234' }
  }

  it('renders read-only banner, lock ref badge, code lines, and [로컬 파일 열기] when existsInWorkspace is true', () => {
    const onOpenLocalFile = vi.fn()
    const state: SnapshotContentState = {
      status: 'loaded',
      snapshot: {
        path: 'src/utils/helper.ts',
        scope: baseRequest.scope,
        isBinary: false,
        isTruncated: false,
        existsInWorkspace: true,
        encoding: 'utf-8',
        content: 'export function greet() {\n  return "hi"\n}'
      }
    }

    render(
      <SnapshotViewer
        request={baseRequest}
        state={state}
        onOpenLocalFile={onOpenLocalFile}
      />
    )

    expect(screen.getByText('src/utils/helper.ts')).toBeTruthy()
    expect(screen.getByText('🔒 abc1234')).toBeTruthy()
    expect(screen.getByRole('status').textContent).toContain('읽기 전용')
    expect(screen.queryByRole('button', { name: '저장' })).toBeNull()
    expect(screen.queryByRole('button', { name: /Raw|위지윅|Preview|Split/ })).toBeNull()

    const openLocalBtn = screen.getByRole('button', { name: '로컬 파일 열기' })
    fireEvent.click(openLocalBtn)
    expect(onOpenLocalFile).toHaveBeenCalledWith('src/utils/helper.ts')

    expect(screen.getByText(/greet/)).toBeTruthy()
    expect(screen.getByText('1')).toBeTruthy()
    expect(screen.getByText('2')).toBeTruthy()
  })

  it('hides [로컬 파일 열기] when existsInWorkspace is false and shows truncation notice', () => {
    const state: SnapshotContentState = {
      status: 'loaded',
      snapshot: {
        path: 'src/deleted.ts',
        scope: baseRequest.scope,
        isBinary: false,
        isTruncated: true,
        existsInWorkspace: false,
        encoding: 'utf-8',
        content: 'const x = 1'
      }
    }

    render(
      <SnapshotViewer
        request={{ ...baseRequest, path: 'src/deleted.ts' }}
        state={state}
        onOpenLocalFile={vi.fn()}
      />
    )

    expect(screen.queryByRole('button', { name: '로컬 파일 열기' })).toBeNull()
    expect(screen.getByText(/2MB/)).toBeTruthy()
  })

  it('highlights and scrolls to the target line on jumpRequest', () => {
    const state: SnapshotContentState = {
      status: 'loaded',
      snapshot: {
        path: 'src/utils/helper.ts',
        scope: baseRequest.scope,
        isBinary: false,
        isTruncated: false,
        existsInWorkspace: true,
        encoding: 'utf-8',
        content: 'line 1\nline 2\nexport const target = 42'
      }
    }

    const { container } = render(
      <SnapshotViewer
        request={baseRequest}
        state={state}
        jumpRequest={{ lineNumber: 3, nonce: 1 }}
      />
    )

    const highlighted = container.querySelector('.snapshot-code-row.is-jump-highlight')
    expect(highlighted).toBeTruthy()
    expect(highlighted?.textContent).toContain('target')
  })

  it('emits onSymbolContextMenu on right-click and onFindReferences on Shift+F12', () => {
    const onSymbolContextMenu = vi.fn()
    const onFindReferences = vi.fn()
    const state: SnapshotContentState = {
      status: 'loaded',
      snapshot: {
        path: 'src/utils/helper.ts',
        scope: baseRequest.scope,
        isBinary: false,
        isTruncated: false,
        existsInWorkspace: true,
        encoding: 'utf-8',
        content: 'export function targetFn() { return 42 }'
      }
    }

    render(
      <SnapshotViewer
        request={baseRequest}
        state={state}
        onSymbolContextMenu={onSymbolContextMenu}
        onFindReferences={onFindReferences}
      />
    )

    const targetEl = screen.getByText('targetFn')
    fireEvent.contextMenu(targetEl)
    expect(onSymbolContextMenu).toHaveBeenCalledWith(
      expect.objectContaining({
        symbolName: 'targetFn',
        lineNumber: 1
      })
    )

    fireEvent.keyDown(screen.getByTestId('snapshot-viewer'), { key: 'F12', shiftKey: true })
    expect(onFindReferences).toHaveBeenCalledWith(
      expect.objectContaining({
        symbolName: 'targetFn',
        lineNumber: 1
      })
    )
  })

  it('opens Find Bar on Ctrl+F with single-line selection, highlights matches with Aa/ab/.*, cycles with Enter/Shift+Enter, and closes on Esc', () => {
    const state: SnapshotContentState = {
      status: 'loaded',
      snapshot: {
        path: 'src/utils/helper.ts',
        scope: baseRequest.scope,
        isBinary: false,
        isTruncated: false,
        existsInWorkspace: true,
        encoding: 'utf-8',
        content: [
          'const alpha = 1',
          'const AlphaBeta = 2',
          'const alpha = 3'
        ].join('\n')
      }
    }

    const { container } = render(
      <SnapshotViewer request={baseRequest} state={state} isActive />
    )

    // Select "alpha" on line 1
    const firstCodeCell = container.querySelector('[data-line-number="1"] .snapshot-line-code')
    expect(firstCodeCell).toBeTruthy()
    const walker = document.createTreeWalker(firstCodeCell!, NodeFilter.SHOW_TEXT)
    let alphaNode: Text | null = null
    while (walker.nextNode()) {
      const node = walker.currentNode as Text
      if (node.textContent?.includes('alpha')) {
        alphaNode = node
        break
      }
    }
    expect(alphaNode).toBeTruthy()
    const range = document.createRange()
    const startIdx = alphaNode!.textContent!.indexOf('alpha')
    range.setStart(alphaNode!, startIdx)
    range.setEnd(alphaNode!, startIdx + 5)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)

    fireEvent.keyDown(window, { key: 'f', ctrlKey: true })

    const findInput = screen.getByLabelText('문서 내 검색어 입력') as HTMLInputElement
    expect(findInput.value).toBe('alpha')
    expect(screen.getByText('1 / 3')).toBeTruthy()
    expect(container.querySelectorAll('.viewer-search-match').length).toBe(3)
    expect(container.querySelectorAll('.viewer-search-match.is-active').length).toBe(1)

    // Cycle next with Enter -> 2 / 3
    fireEvent.keyDown(findInput, { key: 'Enter' })
    expect(screen.getByText('2 / 3')).toBeTruthy()

    // Toggle wholeWord (ab) -> only exact 'alpha' matches (2 matches)
    fireEvent.click(screen.getByRole('button', { name: '단어 단위 (ab)' }))
    expect(screen.getByText('1 / 2')).toBeTruthy()
    expect(container.querySelectorAll('.viewer-search-match').length).toBe(2)

    // Cycle prev with Shift+Enter -> wraps to 2 / 2
    fireEvent.keyDown(findInput, { key: 'Enter', shiftKey: true })
    expect(screen.getByText('2 / 2')).toBeTruthy()

    // Esc closes Find Bar and clears highlights
    fireEvent.keyDown(findInput, { key: 'Escape' })
    expect(screen.queryByLabelText('문서 내 검색어 입력')).toBeNull()
    expect(container.querySelectorAll('.viewer-search-match').length).toBe(0)
  })
})
