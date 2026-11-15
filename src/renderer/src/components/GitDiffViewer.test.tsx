import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { GitDiffRequest, GitFileDiff } from '@shared/git'
import { GitDiffViewer } from './GitDiffViewer'

function makeDiff(overrides: Partial<GitFileDiff> = {}): GitFileDiff {
  return {
    path: 'docs/guide.md',
    status: 'M',
    isBinary: false,
    isTruncated: false,
    existsInWorkspace: true,
    rawPatch: [
      'diff --git a/docs/guide.md b/docs/guide.md',
      '--- a/docs/guide.md',
      '+++ b/docs/guide.md',
      '@@ -1,3 +1,3 @@',
      ' line 1',
      '-old line',
      '+new line',
      ' line 3'
    ].join('\n'),
    ...overrides
  }
}

describe('GitDiffViewer', () => {
  it('renders header metadata, defaults to side-by-side, switches to inline, and triggers 파일 열기', async () => {
    const user = userEvent.setup()
    const onChangeViewMode = vi.fn()
    const onOpenFile = vi.fn()
    const request: GitDiffRequest = { kind: 'staged', path: 'docs/guide.md', status: 'M' }

    const { rerender } = render(
      <GitDiffViewer
        request={request}
        viewMode="side-by-side"
        state={{ status: 'loaded', diff: makeDiff() }}
        onChangeViewMode={onChangeViewMode}
        onOpenFile={onOpenFile}
      />
    )

    expect(screen.getByText('docs/guide.md')).toBeTruthy()
    expect(screen.getByText('Staged')).toBeTruthy()
    expect(screen.getByRole('button', { name: '좌우 비교' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: '인라인' }).getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByTestId('diff-side-by-side')).toBeTruthy()
    expect(screen.getByText('old line')).toBeTruthy()
    expect(screen.getByText('new line')).toBeTruthy()

    await user.click(screen.getByRole('button', { name: '인라인' }))
    expect(onChangeViewMode).toHaveBeenCalledWith('inline')

    const openBtn = screen.getByRole('button', { name: '파일 열기' })
    expect((openBtn as HTMLButtonElement).disabled).toBe(false)
    await user.click(openBtn)
    expect(onOpenFile).toHaveBeenCalledWith('docs/guide.md')

    rerender(
      <GitDiffViewer
        request={{ kind: 'unstaged', path: 'docs/guide.md', status: 'M' }}
        viewMode="inline"
        state={{ status: 'loaded', diff: makeDiff() }}
        onChangeViewMode={onChangeViewMode}
        onOpenFile={onOpenFile}
      />
    )
    expect(screen.getByText('Working Tree')).toBeTruthy()
    expect(screen.getByTestId('diff-inline')).toBeTruthy()
  })

  it('handles loading, error, binary, empty, truncation warning, and missing-in-workspace states', () => {
    const request: GitDiffRequest = { kind: 'unstaged', path: 'assets/logo.png', status: '?' }
    const { rerender } = render(
      <GitDiffViewer
        request={request}
        viewMode="side-by-side"
        state={{ status: 'loading' }}
        onChangeViewMode={vi.fn()}
        onOpenFile={vi.fn()}
      />
    )
    expect(screen.getByText(/Diff 불러오는 중/)).toBeTruthy()

    rerender(
      <GitDiffViewer
        request={request}
        viewMode="side-by-side"
        state={{ status: 'error', errorMessage: 'Diff 로드 실패' }}
        onChangeViewMode={vi.fn()}
        onOpenFile={vi.fn()}
      />
    )
    expect(screen.getByText('Diff 로드 실패')).toBeTruthy()

    rerender(
      <GitDiffViewer
        request={request}
        viewMode="side-by-side"
        state={{
          status: 'loaded',
          diff: makeDiff({ path: 'assets/logo.png', isBinary: true, rawPatch: '' })
        }}
        onChangeViewMode={vi.fn()}
        onOpenFile={vi.fn()}
      />
    )
    expect(screen.getByText('바이너리 파일은 Diff 미리보기를 지원하지 않습니다.')).toBeTruthy()

    rerender(
      <GitDiffViewer
        request={request}
        viewMode="side-by-side"
        state={{
          status: 'loaded',
          diff: makeDiff({ existsInWorkspace: false, rawPatch: '' })
        }}
        onChangeViewMode={vi.fn()}
        onOpenFile={vi.fn()}
      />
    )
    expect(screen.getByText('표시할 텍스트 변경 사항이 없습니다.')).toBeTruthy()
    expect((screen.getByRole('button', { name: '파일 열기' }) as HTMLButtonElement).disabled).toBe(
      true
    )

    rerender(
      <GitDiffViewer
        request={request}
        viewMode="side-by-side"
        state={{ status: 'loaded', diff: makeDiff({ isTruncated: true }) }}
        onChangeViewMode={vi.fn()}
        onOpenFile={vi.fn()}
      />
    )
    expect(screen.getByRole('status').textContent).toMatch(/1MB/)
  })
})
