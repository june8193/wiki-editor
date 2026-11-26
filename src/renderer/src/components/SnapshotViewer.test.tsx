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
})
