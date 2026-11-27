import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { GitDiffRequest, GitFileDiff } from '@shared/git'
import { typescriptLanguage } from '@codemirror/lang-javascript'
import * as diffSyntaxHighlight from '../utils/diffSyntaxHighlight'
import {
  installResizeObserverStub,
  installScrollContainerStub,
  mockElementBoundingRect
} from '../test/domLayoutStub'
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

function makeLargePatch(lineCount: number, filePath = 'src/large.ts', prefix = 'line'): string {
  const lines = [
    `diff --git a/${filePath} b/${filePath}`,
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    `@@ -1,${lineCount} +1,${lineCount} @@`
  ]
  for (let i = 1; i <= lineCount; i += 1) {
    lines.push(`+const ${prefix}_${i} = ${i}`)
  }
  return lines.join('\n')
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

  it('renders small diffs directly without spacers and virtualizes large diffs in both side-by-side and inline modes', () => {
    // Small diff (<= 200 rows): all rows rendered directly, no spacer rows
    const smallPatch = makeLargePatch(20, 'src/small.ts')
    const { container, rerender } = render(
      <GitDiffViewer
        request={{ kind: 'unstaged', path: 'src/small.ts', status: 'M' }}
        viewMode="side-by-side"
        state={{
          status: 'loaded',
          diff: makeDiff({ path: 'src/small.ts', rawPatch: smallPatch })
        }}
        onChangeViewMode={vi.fn()}
        onOpenFile={vi.fn()}
      />
    )

    expect(container.querySelectorAll('tr.git-diff-spacer-row').length).toBe(0)
    expect(container.querySelectorAll('tr.git-diff-row').length).toBe(20)

    // Large diff (> 200 rows): side-by-side virtualizes rows & syntax parsing, even with clientHeight=0 fallback
    const largePatch = makeLargePatch(500, 'src/large.ts')
    const spanSpy = vi.spyOn(diffSyntaxHighlight, 'getDiffLineSyntaxSpans')

    rerender(
      <GitDiffViewer
        request={{ kind: 'unstaged', path: 'src/large.ts', status: 'M' }}
        viewMode="side-by-side"
        state={{
          status: 'loaded',
          diff: makeDiff({ path: 'src/large.ts', rawPatch: largePatch })
        }}
        onChangeViewMode={vi.fn()}
        onOpenFile={vi.fn()}
      />
    )

    const sideRenderedRows = container.querySelectorAll('tr.git-diff-row').length
    expect(sideRenderedRows).toBeGreaterThan(0)
    expect(sideRenderedRows).toBeLessThan(100)
    expect(container.querySelectorAll('tr.git-diff-spacer-row').length).toBeGreaterThan(0)
    expect(spanSpy.mock.calls.length).toBeLessThan(100)

    // Inline mode also virtualizes large diffs
    spanSpy.mockClear()
    rerender(
      <GitDiffViewer
        request={{ kind: 'unstaged', path: 'src/large.ts', status: 'M' }}
        viewMode="inline"
        state={{
          status: 'loaded',
          diff: makeDiff({ path: 'src/large.ts', rawPatch: largePatch })
        }}
        onChangeViewMode={vi.fn()}
        onOpenFile={vi.fn()}
      />
    )

    const inlineRenderedRows = container.querySelectorAll('tr.git-diff-row').length
    expect(inlineRenderedRows).toBeGreaterThan(0)
    expect(inlineRenderedRows).toBeLessThan(100)
    expect(container.querySelectorAll('tr.git-diff-spacer-row').length).toBeGreaterThan(0)
    expect(spanSpy.mock.calls.length).toBeLessThan(100)
    spanSpy.mockRestore()
  })

  it('updates visible window on scroll, preserves scrollTop across viewMode toggle, and resets scrollTop on file change', () => {
    const resizeObserver = installResizeObserverStub()
    try {
      const fileARequest: GitDiffRequest = { kind: 'unstaged', path: 'src/fileA.ts', status: 'M' }
      const fileAPatch = makeLargePatch(500, 'src/fileA.ts', 'alpha')
      const fileBRequest: GitDiffRequest = { kind: 'unstaged', path: 'src/fileB.ts', status: 'M' }
      const fileBPatch = makeLargePatch(500, 'src/fileB.ts', 'beta')

      const { rerender } = render(
        <GitDiffViewer
          request={fileARequest}
          viewMode="side-by-side"
          state={{
            status: 'loaded',
            diff: makeDiff({ path: 'src/fileA.ts', rawPatch: fileAPatch })
          }}
          onChangeViewMode={vi.fn()}
          onOpenFile={vi.fn()}
        />
      )

      const scrollEl = screen.getByTestId('diff-side-by-side')
      const scrollStub = installScrollContainerStub(scrollEl, {
        clientHeight: 220,
        initialScrollTop: 0,
        getScrollHeight: () => 501 * 22
      })
      resizeObserver.trigger()

      expect(screen.getByText(matchDiffLineText('const alpha_1 = 1'))).toBeTruthy()
      expect(screen.queryByText(matchDiffLineText('const alpha_250 = 250'))).toBeNull()

      // Scroll to middle of the diff
      act(() => {
        scrollStub.setScrollTop(5500)
        fireEvent.scroll(scrollEl)
      })

      expect(screen.getByText(matchDiffLineText('const alpha_250 = 250'))).toBeTruthy()
      expect(screen.queryByText(matchDiffLineText('const alpha_1 = 1'))).toBeNull()

      // Switching side-by-side <-> inline on the same file preserves scrollTop
      rerender(
        <GitDiffViewer
          request={fileARequest}
          viewMode="inline"
          state={{
            status: 'loaded',
            diff: makeDiff({ path: 'src/fileA.ts', rawPatch: fileAPatch })
          }}
          onChangeViewMode={vi.fn()}
          onOpenFile={vi.fn()}
        />
      )

      expect(screen.getByTestId('diff-inline').scrollTop).toBe(5500)
      expect(screen.getByText(matchDiffLineText('const alpha_250 = 250'))).toBeTruthy()

      // Switching to a different file resets scrollTop to 0
      rerender(
        <GitDiffViewer
          request={fileBRequest}
          viewMode="inline"
          state={{
            status: 'loaded',
            diff: makeDiff({ path: 'src/fileB.ts', rawPatch: fileBPatch })
          }}
          onChangeViewMode={vi.fn()}
          onOpenFile={vi.fn()}
        />
      )

      expect(scrollStub.getScrollTop()).toBe(0)
      expect(screen.getByText(matchDiffLineText('const beta_1 = 1'))).toBeTruthy()
    } finally {
      resizeObserver.restore()
    }
  })

  it('adjusts spacer heights from measured wrapped-row heights via ResizeObserver', () => {
    const resizeObserver = installResizeObserverStub()
    try {
      const lines = [
        'diff --git a/src/wrapped.ts b/src/wrapped.ts',
        '--- a/src/wrapped.ts',
        '+++ b/src/wrapped.ts',
        '@@ -1,300 +1,300 @@'
      ]
      for (let i = 1; i <= 300; i += 1) {
        lines.push(`+const wrappedLine${i} = "${'x'.repeat(20)}"`)
      }

      const { container } = render(
        <GitDiffViewer
          request={{ kind: 'unstaged', path: 'src/wrapped.ts', status: 'M' }}
          viewMode="side-by-side"
          state={{
            status: 'loaded',
            diff: makeDiff({ path: 'src/wrapped.ts', rawPatch: lines.join('\n') })
          }}
          onChangeViewMode={vi.fn()}
          onOpenFile={vi.fn()}
        />
      )

      const scrollEl = screen.getByTestId('diff-side-by-side')
      const scrollStub = installScrollContainerStub(scrollEl, {
        clientHeight: 220,
        initialScrollTop: 0,
        getScrollHeight: () => 301 * 22 + 35
      })
      resizeObserver.trigger()

      // Scroll down slightly so row 1 is above the viewport (inside overscan)
      act(() => {
        scrollStub.setScrollTop(100)
        fireEvent.scroll(scrollEl)
      })

      const row1 = container.querySelector('tr[data-row-index="1"]') as HTMLElement
      expect(row1).toBeTruthy()
      // Row 1 wraps to 57px (35px taller than default 22px)
      mockElementBoundingRect(row1, { width: 400, height: 57 })
      resizeObserver.trigger()

      // Scroll compensation should shift scrollTop by +35px to prevent visual jump
      expect(scrollStub.getScrollTop()).toBe(135)

      // Scroll further down past overscan so top spacer includes measured row 1
      act(() => {
        scrollStub.setScrollTop(2000)
        fireEvent.scroll(scrollEl)
      })

      const topSpacerTd = container.querySelector(
        'tr.git-diff-spacer-row td'
      ) as HTMLTableCellElement | null
      expect(topSpacerTd).toBeTruthy()
      // Top spacer height reflects the extra 35px from row 1 (35 mod 22 === 13)
      const spacerHeight = parseFloat(topSpacerTd!.style.height)
      expect(spacerHeight % 22).toBe(13)
      expect(spacerHeight).toBeGreaterThan(0)
    } finally {
      resizeObserver.restore()
    }
  })

  it('renders side-by-side split resizer only in side-by-side mode and supports drag, double-click reset, and keyboard arrows', () => {
    const resizeObserver = installResizeObserverStub()
    try {
      const onChangeSplitRatio = vi.fn()
      const { container, rerender } = render(
        <GitDiffViewer
          request={{ kind: 'staged', path: 'docs/guide.md', status: 'M' }}
          viewMode="side-by-side"
          state={{ status: 'loaded', diff: makeDiff() }}
          onChangeSplitRatio={onChangeSplitRatio}
          onChangeViewMode={vi.fn()}
          onOpenFile={vi.fn()}
        />
      )

      const scrollEl = screen.getByTestId('diff-side-by-side')
      mockElementBoundingRect(scrollEl, { width: 1000, height: 400 })
      const tableEl = container.querySelector('table.git-diff-table--split') as HTMLElement
      mockElementBoundingRect(tableEl, { width: 1000, height: 200 })
      resizeObserver.trigger()

      const resizer = screen.getByRole('separator', { name: 'Diff 좌우 비교 비율 조절' })
      expect(resizer.getAttribute('aria-valuenow')).toBe('50')

      const codeCols = container.querySelectorAll('col.git-diff-col-code')
      expect(codeCols).toHaveLength(2)
      expect((codeCols[0] as HTMLElement).style.width).toBe('calc(50% - 48px)')
      expect((codeCols[1] as HTMLElement).style.width).toBe('calc(50% - 48px)')

      // Mouse drag to 65%
      fireEvent.mouseDown(resizer, { clientX: 500 })
      fireEvent.mouseMove(window, { clientX: 650 })
      fireEvent.mouseUp(window)

      expect(onChangeSplitRatio).toHaveBeenLastCalledWith(0.65)
      expect(resizer.getAttribute('aria-valuenow')).toBe('65')
      expect((codeCols[0] as HTMLElement).style.width).toBe('calc(65% - 48px)')
      expect((codeCols[1] as HTMLElement).style.width).toBe('calc(35% - 48px)')

      // Keyboard ArrowRight (+5%) and ArrowLeft (-5%)
      fireEvent.keyDown(resizer, { key: 'ArrowRight' })
      expect(onChangeSplitRatio).toHaveBeenLastCalledWith(0.7)
      expect(resizer.getAttribute('aria-valuenow')).toBe('70')

      fireEvent.keyDown(resizer, { key: 'ArrowLeft' })
      expect(onChangeSplitRatio).toHaveBeenLastCalledWith(0.65)
      expect(resizer.getAttribute('aria-valuenow')).toBe('65')

      // Double-click resets to 50%
      fireEvent.doubleClick(resizer)
      expect(onChangeSplitRatio).toHaveBeenLastCalledWith(0.5)
      expect(resizer.getAttribute('aria-valuenow')).toBe('50')

      // Inline mode does not render the resizer
      rerender(
        <GitDiffViewer
          request={{ kind: 'staged', path: 'docs/guide.md', status: 'M' }}
          viewMode="inline"
          state={{ status: 'loaded', diff: makeDiff() }}
          onChangeSplitRatio={onChangeSplitRatio}
          onChangeViewMode={vi.fn()}
          onOpenFile={vi.fn()}
        />
      )
      expect(screen.queryByRole('separator', { name: 'Diff 좌우 비교 비율 조절' })).toBeNull()
    } finally {
      resizeObserver.restore()
    }
  })

  it('clamps split ratio to minimum side width on narrow containers', () => {
    const resizeObserver = installResizeObserverStub()
    try {
      const { container } = render(
        <GitDiffViewer
          request={{ kind: 'staged', path: 'docs/guide.md', status: 'M' }}
          viewMode="side-by-side"
          state={{ status: 'loaded', diff: makeDiff() }}
          onChangeViewMode={vi.fn()}
          onOpenFile={vi.fn()}
        />
      )

      const scrollEl = screen.getByTestId('diff-side-by-side')
      // 300px -> min side width 108px => [36%, 64%]
      mockElementBoundingRect(scrollEl, { width: 300, height: 400 })
      const tableEl = container.querySelector('table.git-diff-table--split') as HTMLElement
      mockElementBoundingRect(tableEl, { width: 300, height: 200 })
      resizeObserver.trigger()

      const resizer = screen.getByRole('separator', { name: 'Diff 좌우 비교 비율 조절' })
      expect(resizer.getAttribute('aria-valuemin')).toBe('36')
      expect(resizer.getAttribute('aria-valuemax')).toBe('64')

      fireEvent.mouseDown(resizer, { clientX: 150 })
      fireEvent.mouseMove(window, { clientX: 20 })
      fireEvent.mouseUp(window)

      expect(resizer.getAttribute('aria-valuenow')).toBe('36')
      const codeCols = container.querySelectorAll('col.git-diff-col-code')
      expect((codeCols[0] as HTMLElement).style.width).toBe('calc(36% - 48px)')
      expect((codeCols[1] as HTMLElement).style.width).toBe('calc(64% - 48px)')
    } finally {
      resizeObserver.restore()
    }
  })

  it('re-measures virtualized row heights when splitRatio changes without resetting scrollTop', () => {
    const resizeObserver = installResizeObserverStub()
    try {
      const patch = makeLargePatch(300, 'src/ratio-virtual.ts', 'ratioRow')
      const { container, rerender } = render(
        <GitDiffViewer
          request={{ kind: 'unstaged', path: 'src/ratio-virtual.ts', status: 'M' }}
          viewMode="side-by-side"
          splitRatio={0.5}
          state={{
            status: 'loaded',
            diff: makeDiff({ path: 'src/ratio-virtual.ts', rawPatch: patch })
          }}
          onChangeViewMode={vi.fn()}
          onOpenFile={vi.fn()}
        />
      )

      const scrollEl = screen.getByTestId('diff-side-by-side')
      const scrollStub = installScrollContainerStub(scrollEl, {
        clientHeight: 220,
        initialScrollTop: 0,
        getScrollHeight: () => 301 * 22
      })
      resizeObserver.trigger()

      act(() => {
        scrollStub.setScrollTop(100)
        fireEvent.scroll(scrollEl)
      })
      const row1Before = container.querySelector('tr[data-row-index="1"]') as HTMLElement
      expect(row1Before).toBeTruthy()
      mockElementBoundingRect(row1Before, { width: 400, height: 44 })
      resizeObserver.trigger()
      const scrollAfterInitialMeasure = scrollStub.getScrollTop()
      expect(scrollAfterInitialMeasure).toBe(122)

      // Changing splitRatio clears cached heights and re-measures without resetting scrollTop to 0
      rerender(
        <GitDiffViewer
          request={{ kind: 'unstaged', path: 'src/ratio-virtual.ts', status: 'M' }}
          viewMode="side-by-side"
          splitRatio={0.7}
          state={{
            status: 'loaded',
            diff: makeDiff({ path: 'src/ratio-virtual.ts', rawPatch: patch })
          }}
          onChangeViewMode={vi.fn()}
          onOpenFile={vi.fn()}
        />
      )

      expect(scrollStub.getScrollTop()).toBeGreaterThan(0)
    } finally {
      resizeObserver.restore()
    }
  })
})
