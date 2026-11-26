import { describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { GitDiffRequest, GitFileDiff } from '@shared/git'
import { typescriptLanguage } from '@codemirror/lang-javascript'
import * as diffSyntaxHighlight from '../utils/diffSyntaxHighlight'
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

  it('resolves bundled parsers synchronously in a single pass without triggering async reload', async () => {
    const loadSpy = vi.spyOn(diffSyntaxHighlight, 'loadDiffLanguageParser')
    const tsParseSpy = vi.spyOn(typescriptLanguage.parser, 'parse')

    const tsPatch = [
      'diff --git a/src/singlePass.ts b/src/singlePass.ts',
      '--- a/src/singlePass.ts',
      '+++ b/src/singlePass.ts',
      '@@ -1,1 +1,1 @@',
      '-const a = 1',
      '+const a = 2'
    ].join('\n')

    const { container } = render(
      <GitDiffViewer
        request={{ kind: 'unstaged', path: 'src/singlePass.ts', status: 'M' }}
        viewMode="side-by-side"
        state={{
          status: 'loaded',
          diff: makeDiff({ path: 'src/singlePass.ts', rawPatch: tsPatch })
        }}
        onChangeViewMode={vi.fn()}
        onOpenFile={vi.fn()}
      />
    )

    // Bundled parser is applied synchronously on initial render
    expect(container.querySelectorAll('.tok-keyword').length).toBeGreaterThan(0)
    const initialParseCount = tsParseSpy.mock.calls.length

    // Flush microtasks; no async parser load or second-pass re-parse should occur
    await act(async () => {
      await Promise.resolve()
    })

    expect(loadSpy).not.toHaveBeenCalled()
    expect(tsParseSpy.mock.calls.length).toBe(initialParseCount)

    loadSpy.mockRestore()
    tsParseSpy.mockRestore()
  })

  it('loads uncached dynamic parsers once without fallback parsing, then resolves synchronously from cache on subsequent renders', async () => {
    const rbPatch = [
      'diff --git a/scripts/build.rb b/scripts/build.rb',
      '--- a/scripts/build.rb',
      '+++ b/scripts/build.rb',
      '@@ -1,1 +1,1 @@',
      '-def hello(name)',
      '+def greet(name)'
    ].join('\n')

    const { container, unmount } = render(
      <GitDiffViewer
        request={{ kind: 'unstaged', path: 'scripts/build.rb', status: 'M' }}
        viewMode="inline"
        state={{
          status: 'loaded',
          diff: makeDiff({ path: 'scripts/build.rb', rawPatch: rbPatch })
        }}
        onChangeViewMode={vi.fn()}
        onOpenFile={vi.fn()}
      />
    )

    // Before async parser resolves: word highlights are present, no syntax tokens yet
    expect(container.querySelectorAll('mark.git-diff-word-highlight').length).toBe(2)

    // Wait for dynamic parser to load and apply syntax spans
    await vi.waitFor(() => {
      expect(container.querySelectorAll('.tok-keyword').length).toBeGreaterThan(0)
    })

    unmount()

    // Second render for another .rb file should resolve synchronously from cache without calling loadDiffLanguageParser
    const loadSpy = vi.spyOn(diffSyntaxHighlight, 'loadDiffLanguageParser')
    const { container: secondContainer } = render(
      <GitDiffViewer
        request={{ kind: 'unstaged', path: 'scripts/deploy.rb', status: 'M' }}
        viewMode="inline"
        state={{
          status: 'loaded',
          diff: makeDiff({ path: 'scripts/deploy.rb', rawPatch: rbPatch })
        }}
        onChangeViewMode={vi.fn()}
        onOpenFile={vi.fn()}
      />
    )

    expect(secondContainer.querySelectorAll('.tok-keyword').length).toBeGreaterThan(0)
    expect(loadSpy).not.toHaveBeenCalled()
    loadSpy.mockRestore()
  })

  it('memoizes syntax spans per line and parser so side-by-side context lines and mode switches do not re-parse', () => {
    const tsParseSpy = vi.spyOn(typescriptLanguage.parser, 'parse')
    const uniqueSuffix = `${Date.now()}_${Math.random().toString(36).slice(2)}`
    const contextLine = `const sharedContext_${uniqueSuffix} = true`
    const oldLine = `const oldVal_${uniqueSuffix} = 1`
    const newLine = `const newVal_${uniqueSuffix} = 2`

    const patch = [
      'diff --git a/src/memoTest.ts b/src/memoTest.ts',
      '--- a/src/memoTest.ts',
      '+++ b/src/memoTest.ts',
      '@@ -1,3 +1,3 @@',
      ` ${contextLine}`,
      `-${oldLine}`,
      `+${newLine}`
    ].join('\n')

    const diff = makeDiff({ path: 'src/memoTest.ts', rawPatch: patch })
    const request: GitDiffRequest = { kind: 'unstaged', path: 'src/memoTest.ts', status: 'M' }

    const { rerender } = render(
      <GitDiffViewer
        request={request}
        viewMode="side-by-side"
        state={{ status: 'loaded', diff }}
        onChangeViewMode={vi.fn()}
        onOpenFile={vi.fn()}
      />
    )

    // 1 parse for contextLine (shared across old/new), 1 for oldLine, 1 for newLine = 3
    expect(tsParseSpy).toHaveBeenCalledTimes(3)

    // Switching to inline and back should reuse cached spans with 0 additional parses
    rerender(
      <GitDiffViewer
        request={request}
        viewMode="inline"
        state={{ status: 'loaded', diff }}
        onChangeViewMode={vi.fn()}
        onOpenFile={vi.fn()}
      />
    )
    rerender(
      <GitDiffViewer
        request={request}
        viewMode="side-by-side"
        state={{ status: 'loaded', diff }}
        onChangeViewMode={vi.fn()}
        onOpenFile={vi.fn()}
      />
    )

    expect(tsParseSpy).toHaveBeenCalledTimes(3)
    tsParseSpy.mockRestore()
  })

  it('skips re-rendering via React.memo when props and navigation values are unchanged', () => {
    const request: GitDiffRequest = {
      kind: 'branch-compare',
      baseRef: 'main',
      compareRef: 'feat/test',
      mode: 'three-dot',
      path: 'docs/guide.md',
      status: 'M'
    }
    const state = { status: 'loaded' as const, diff: makeDiff() }
    const onChangeViewMode = vi.fn()
    const onOpenFile = vi.fn()
    const onPrevFile = vi.fn()
    const onNextFile = vi.fn()

    const { rerender } = render(
      <GitDiffViewer
        request={request}
        viewMode="side-by-side"
        state={state}
        onChangeViewMode={onChangeViewMode}
        onOpenFile={onOpenFile}
        navigation={{ currentIndex: 1, totalCount: 3, onPrevFile, onNextFile }}
      />
    )

    const spanSpy = vi.spyOn(diffSyntaxHighlight, 'getDiffLineSyntaxSpans')

    // Re-render parent with a fresh navigation object having identical values & callbacks
    rerender(
      <GitDiffViewer
        request={request}
        viewMode="side-by-side"
        state={state}
        onChangeViewMode={onChangeViewMode}
        onOpenFile={onOpenFile}
        navigation={{ currentIndex: 1, totalCount: 3, onPrevFile, onNextFile }}
      />
    )

    expect(spanSpy).not.toHaveBeenCalled()
    spanSpy.mockRestore()
  })
})
