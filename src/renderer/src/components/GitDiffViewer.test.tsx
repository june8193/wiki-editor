import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { GitDiffRequest, GitFileDiff } from '@shared/git'
import { GitDiffViewer } from './GitDiffViewer'

function matchDiffLineText(expected: string) {
  return (_: string, el: Element | null) =>
    Boolean(el?.classList.contains('git-diff-line-text') && el.textContent === expected)
}

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
    expect(screen.getByText(matchDiffLineText('old line'))).toBeTruthy()
    expect(screen.getByText(matchDiffLineText('new line'))).toBeTruthy()

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

  it('highlights changed intra-line tokens in both side-by-side and inline modes, and falls back to full-line highlight for long lines', () => {
    const patch = [
      'diff --git a/docs/guide.md b/docs/guide.md',
      '--- a/docs/guide.md',
      '+++ b/docs/guide.md',
      '@@ -1,3 +1,3 @@',
      ' unchanged header',
      '-const value = "alpha"',
      '+const value = "beta"',
      ' unchanged footer'
    ].join('\n')

    const { container, rerender } = render(
      <GitDiffViewer
        request={{ kind: 'unstaged', path: 'docs/guide.md', status: 'M' }}
        viewMode="side-by-side"
        state={{ status: 'loaded', diff: makeDiff({ rawPatch: patch }) }}
        onChangeViewMode={vi.fn()}
        onOpenFile={vi.fn()}
      />
    )

    const sideMarks = Array.from(container.querySelectorAll('mark.git-diff-word-highlight'))
    expect(sideMarks.map((el) => el.textContent)).toEqual(['alpha', 'beta'])

    rerender(
      <GitDiffViewer
        request={{ kind: 'unstaged', path: 'docs/guide.md', status: 'M' }}
        viewMode="inline"
        state={{ status: 'loaded', diff: makeDiff({ rawPatch: patch }) }}
        onChangeViewMode={vi.fn()}
        onOpenFile={vi.fn()}
      />
    )

    const inlineMarks = Array.from(container.querySelectorAll('mark.git-diff-word-highlight'))
    expect(inlineMarks.map((el) => el.textContent)).toEqual(['alpha', 'beta'])

    // Long line fallback: highlights full line when line exceeds performance guard
    const longOld = `prefix ${'a'.repeat(600)} old`
    const longNew = `prefix ${'a'.repeat(600)} new`
    const longPatch = [
      'diff --git a/docs/guide.md b/docs/guide.md',
      '--- a/docs/guide.md',
      '+++ b/docs/guide.md',
      '@@ -1,1 +1,1 @@',
      `-${longOld}`,
      `+${longNew}`
    ].join('\n')

    rerender(
      <GitDiffViewer
        request={{ kind: 'unstaged', path: 'docs/guide.md', status: 'M' }}
        viewMode="side-by-side"
        state={{ status: 'loaded', diff: makeDiff({ rawPatch: longPatch }) }}
        onChangeViewMode={vi.fn()}
        onOpenFile={vi.fn()}
      />
    )

    const longMarks = Array.from(container.querySelectorAll('mark.git-diff-word-highlight'))
    expect(longMarks.map((el) => el.textContent)).toEqual([longOld, longNew])
  })

  it('applies extension-based syntax highlighting in both modes and falls back to plain text for unknown extensions or overly long lines', () => {
    const tsPatch = [
      'diff --git a/src/example.ts b/src/example.ts',
      '--- a/src/example.ts',
      '+++ b/src/example.ts',
      '@@ -1,2 +1,2 @@',
      '-const title = "old"',
      '+const title = "new"',
      ' export default title'
    ].join('\n')

    const { container, rerender } = render(
      <GitDiffViewer
        request={{ kind: 'unstaged', path: 'src/example.ts', status: 'M' }}
        viewMode="side-by-side"
        state={{
          status: 'loaded',
          diff: makeDiff({ path: 'src/example.ts', rawPatch: tsPatch })
        }}
        onChangeViewMode={vi.fn()}
        onOpenFile={vi.fn()}
      />
    )

    expect(container.querySelectorAll('.tok-keyword').length).toBeGreaterThan(0)
    expect(container.querySelectorAll('.tok-string').length).toBeGreaterThan(0)

    rerender(
      <GitDiffViewer
        request={{ kind: 'unstaged', path: 'src/example.ts', status: 'M' }}
        viewMode="inline"
        state={{
          status: 'loaded',
          diff: makeDiff({ path: 'src/example.ts', rawPatch: tsPatch })
        }}
        onChangeViewMode={vi.fn()}
        onOpenFile={vi.fn()}
      />
    )

    expect(container.querySelectorAll('.tok-keyword').length).toBeGreaterThan(0)
    expect(container.querySelectorAll('mark.git-diff-word-highlight').length).toBe(2)

    // Unsupported extension falls back to plain text
    rerender(
      <GitDiffViewer
        request={{ kind: 'unstaged', path: 'notes/data.unknownext', status: 'M' }}
        viewMode="inline"
        state={{
          status: 'loaded',
          diff: makeDiff({ path: 'notes/data.unknownext', rawPatch: tsPatch })
        }}
        onChangeViewMode={vi.fn()}
        onOpenFile={vi.fn()}
      />
    )

    expect(container.querySelectorAll('.tok-keyword').length).toBe(0)

    // Overly long line in supported file falls back to plain text for that line
    const hugeLine = `const x = "${'z'.repeat(2500)}"`
    const hugePatch = [
      'diff --git a/src/example.ts b/src/example.ts',
      '--- a/src/example.ts',
      '+++ b/src/example.ts',
      '@@ -1,1 +1,1 @@',
      ` ${hugeLine}`
    ].join('\n')

    rerender(
      <GitDiffViewer
        request={{ kind: 'unstaged', path: 'src/example.ts', status: 'M' }}
        viewMode="inline"
        state={{
          status: 'loaded',
          diff: makeDiff({ path: 'src/example.ts', rawPatch: hugePatch })
        }}
        onChangeViewMode={vi.fn()}
        onOpenFile={vi.fn()}
      />
    )

    expect(container.querySelectorAll('.tok-keyword').length).toBe(0)
  })

  it('supports optional header file navigation callbacks and disables 파일 열기 for deleted files', async () => {
    const user = userEvent.setup()
    const onPrevFile = vi.fn()
    const onNextFile = vi.fn()

    const { rerender } = render(
      <GitDiffViewer
        request={{ kind: 'staged', path: 'docs/guide.md', status: 'M' }}
        viewMode="side-by-side"
        state={{ status: 'loaded', diff: makeDiff() }}
        onChangeViewMode={vi.fn()}
        onOpenFile={vi.fn()}
      />
    )

    expect(screen.queryByRole('button', { name: '이전 파일' })).toBeNull()
    expect(screen.queryByRole('button', { name: '다음 파일' })).toBeNull()

    rerender(
      <GitDiffViewer
        request={{
          kind: 'branch-compare',
          baseRef: 'main',
          compareRef: 'feat/test',
          mode: 'three-dot',
          path: 'docs/deleted.md',
          status: 'D'
        }}
        viewMode="side-by-side"
        state={{
          status: 'loaded',
          diff: makeDiff({ path: 'docs/deleted.md', status: 'D', existsInWorkspace: false })
        }}
        onChangeViewMode={vi.fn()}
        onOpenFile={vi.fn()}
        navigation={{
          currentIndex: 2,
          totalCount: 5,
          onPrevFile,
          onNextFile
        }}
      />
    )

    expect(screen.getByText('2 / 5')).toBeTruthy()
    const prevBtn = screen.getByRole('button', { name: '이전 파일' }) as HTMLButtonElement
    const nextBtn = screen.getByRole('button', { name: '다음 파일' }) as HTMLButtonElement
    expect(prevBtn.disabled).toBe(false)
    expect(nextBtn.disabled).toBe(false)

    await user.click(prevBtn)
    expect(onPrevFile).toHaveBeenCalledTimes(1)
    await user.click(nextBtn)
    expect(onNextFile).toHaveBeenCalledTimes(1)

    expect((screen.getByRole('button', { name: '파일 열기' }) as HTMLButtonElement).disabled).toBe(
      true
    )

    // Boundary disabled states
    rerender(
      <GitDiffViewer
        request={{ kind: 'staged', path: 'docs/guide.md', status: 'M' }}
        viewMode="side-by-side"
        state={{ status: 'loaded', diff: makeDiff() }}
        onChangeViewMode={vi.fn()}
        onOpenFile={vi.fn()}
        navigation={{
          currentIndex: 1,
          totalCount: 1,
          onPrevFile,
          onNextFile
        }}
      />
    )

    expect(screen.getByText('1 / 1')).toBeTruthy()
    expect((screen.getByRole('button', { name: '이전 파일' }) as HTMLButtonElement).disabled).toBe(
      true
    )
    expect((screen.getByRole('button', { name: '다음 파일' }) as HTMLButtonElement).disabled).toBe(
      true
    )
  })
})
