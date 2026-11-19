import { describe, expect, it } from 'vitest'
import {
  compareWorkspaceSearchFileResults,
  compileSearchMatcher,
  DEFAULT_SEARCH_MATCH_OPTIONS,
  extractLineSnippet,
  type SearchMatchOptions,
  type TextMatchSpan,
  type WorkspaceSearchFileResult
} from './search'

function findTextMatches(
  text: string,
  query: string,
  options?: Partial<SearchMatchOptions>
): TextMatchSpan[] {
  const compiled = compileSearchMatcher(query, options)
  return compiled.ok ? compiled.matcher.findMatches(text) : []
}

describe('shared search matching engine', () => {
  it('performs case-insensitive substring matching by default including 1-char queries and UTF-16 offsets', () => {
    const matches = findTextMatches('Alpha alpha ALPHA a', 'a')
    expect(matches).toEqual([
      { start: 0, end: 1 },
      { start: 4, end: 5 },
      { start: 6, end: 7 },
      { start: 10, end: 11 },
      { start: 12, end: 13 },
      { start: 16, end: 17 },
      { start: 18, end: 19 }
    ])

    // Surrogate-pair emoji occupies 2 UTF-16 code units; offsets after emoji stay exact UTF-16 indices
    const emojiLine = '😀 hello 😀 HELLO'
    expect(findTextMatches(emojiLine, 'hello')).toEqual([
      { start: 3, end: 8 },
      { start: 12, end: 17 }
    ])
    expect(emojiLine.slice(3, 8)).toBe('hello')
    expect(emojiLine.slice(12, 17)).toBe('HELLO')

    // Empty query produces no matches
    expect(findTextMatches('anything', '')).toEqual([])
  })

  it('supports caseSensitive (Aa) and treats regex metacharacters literally when useRegex is false', () => {
    expect(
      findTextMatches('Wiki wiki WIKI', 'Wiki', {
        ...DEFAULT_SEARCH_MATCH_OPTIONS,
        caseSensitive: true
      })
    ).toEqual([{ start: 0, end: 4 }])

    expect(
      findTextMatches('file.md fileXmd (a+b) [1]', 'file.md', DEFAULT_SEARCH_MATCH_OPTIONS)
    ).toEqual([{ start: 0, end: 7 }])

    expect(
      findTextMatches('sum (a+b) equals (a+b)', '(a+b)', DEFAULT_SEARCH_MATCH_OPTIONS)
    ).toEqual([
      { start: 4, end: 9 },
      { start: 17, end: 22 }
    ])
  })

  it('enforces wholeWord (ab) boundaries across English, digits, underscore, and Korean/Unicode letters', () => {
    const english = 'cat catalog scatter _cat cat_ cat1 1cat (cat) cat-dog'
    expect(
      findTextMatches(english, 'cat', {
        caseSensitive: false,
        wholeWord: true,
        useRegex: false
      })
    ).toEqual([
      { start: 0, end: 3 },
      { start: 41, end: 44 },
      { start: 46, end: 49 }
    ])

    const korean = '검색 검색어 문서검색 "검색" (검색) 검색1 1검색 검색_키'
    const koreanMatches = findTextMatches(korean, '검색', {
      caseSensitive: false,
      wholeWord: true,
      useRegex: false
    })
    expect(koreanMatches.map((span) => [span.start, span.end, korean.slice(span.start, span.end)])).toEqual([
      [0, 2, '검색'],
      [13, 15, '검색'],
      [18, 20, '검색']
    ])

    // Surrogate-pair CJK Extension B letter (𠀀) adjacent to target should prevent wholeWord false match
    const extB = '𠀀word word 𠀀'
    const extBMatches = findTextMatches(extB, 'word', {
      caseSensitive: false,
      wholeWord: true,
      useRegex: false
    })
    expect(extBMatches).toEqual([{ start: 7, end: 11 }])
    expect(extB.slice(extBMatches[0].start, extBMatches[0].end)).toBe('word')
  })

  it('supports regex mode (.*), combined regex + wholeWord, and structured errors for invalid regexes', () => {
    const compiledValid = compileSearchMatcher('item-\\d+', {
      caseSensitive: true,
      wholeWord: false,
      useRegex: true
    })
    expect(compiledValid.ok).toBe(true)
    if (compiledValid.ok) {
      expect(compiledValid.matcher.findMatches('item-1 ITEM-2 item-42')).toEqual([
        { start: 0, end: 6 },
        { start: 14, end: 21 }
      ])
    }

    // Regex alternation with wholeWord prefers longest valid branch instead of failing on shorter prefix
    expect(
      findTextMatches('catfish cat', 'cat|catfish', {
        caseSensitive: false,
        wholeWord: true,
        useRegex: true
      })
    ).toEqual([
      { start: 0, end: 7 },
      { start: 8, end: 11 }
    ])

    // Combined caseSensitive + wholeWord + useRegex
    expect(
      findTextMatches('Task_1 task_1 Task_10', 'Task_\\d', {
        caseSensitive: true,
        wholeWord: true,
        useRegex: true
      })
    ).toEqual([{ start: 0, end: 6 }])

    // Invalid regex must not throw and must not bypass parenthesis wrapping
    for (const badPattern of ['(unclosed', '[abc', '*', 'a)|(?:b']) {
      const result = compileSearchMatcher(badPattern, {
        caseSensitive: false,
        wholeWord: true,
        useRegex: true
      })
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.length).toBeGreaterThan(0)
      }
    }
  })

  it('terminates safely without infinite loops on empty-matching regexes (.*, ^, a*)', () => {
    expect(
      findTextMatches('hello', '.*', {
        caseSensitive: false,
        wholeWord: false,
        useRegex: true
      })
    ).toEqual([{ start: 0, end: 5 }])

    expect(
      findTextMatches('', '.*', {
        caseSensitive: false,
        wholeWord: false,
        useRegex: true
      })
    ).toEqual([{ start: 0, end: 0 }])

    expect(
      findTextMatches('first\nsecond', '^', {
        caseSensitive: false,
        wholeWord: false,
        useRegex: true
      })
    ).toEqual([
      { start: 0, end: 0 },
      { start: 6, end: 6 }
    ])

    const aStarSurrogate = findTextMatches('😀b', 'a*', {
      caseSensitive: false,
      wholeWord: false,
      useRegex: true
    })
    expect(aStarSurrogate).toEqual([
      { start: 0, end: 0 },
      { start: 2, end: 2 },
      { start: 3, end: 3 }
    ])

    // WholeWord + empty-matching regex should not produce empty-string matches at spaces
    expect(
      findTextMatches('a b', 'a*', {
        caseSensitive: false,
        wholeWord: true,
        useRegex: true
      })
    ).toEqual([{ start: 0, end: 1 }])
  })

  it('extracts bounded snippets on long lines preserving column = lineOffset + span.start and surrogate integrity', () => {
    const shortLine = 'short line target here'
    expect(extractLineSnippet(shortLine, [{ start: 11, end: 17 }])).toEqual({
      lineText: shortLine,
      lineOffset: 0,
      matches: [{ start: 11, end: 17 }]
    })

    const prefix = 'x'.repeat(280)
    const suffix = 'y'.repeat(200)
    const longLine = `${prefix}TARGET${suffix}`
    const snippet = extractLineSnippet(longLine, [{ start: 280, end: 286 }])

    expect(snippet.lineText.length).toBeLessThanOrEqual(240)
    expect(snippet.lineOffset).toBe(220)
    expect(snippet.matches).toEqual([{ start: 60, end: 66 }])
    const restoredColumn = snippet.lineOffset + snippet.matches[0].start
    expect(restoredColumn).toBe(280)
    expect(longLine.slice(restoredColumn, snippet.lineOffset + snippet.matches[0].end)).toBe(
      'TARGET'
    )
    expect(snippet.lineText.slice(snippet.matches[0].start, snippet.matches[0].end)).toBe('TARGET')

    // Surrogate boundary near sliceStart (200 - 60 = 140 lands in surrogate at 139..140)
    const emojiLongLine = `${'😀'.repeat(69)}a😀${'z'.repeat(59)}HIT${'w'.repeat(200)}`
    const emojiSnippet = extractLineSnippet(emojiLongLine, [{ start: 200, end: 203 }])
    expect(emojiSnippet.lineText.charCodeAt(0)).not.toBe(0xde00)
    const hitStart = emojiSnippet.lineOffset + emojiSnippet.matches[0].start
    expect(hitStart).toBe(200)
    expect(
      emojiSnippet.lineText.slice(emojiSnippet.matches[0].start, emojiSnippet.matches[0].end)
    ).toBe('HIT')

    // Matches beyond snippet window end (40..280) are excluded while in-window spans stay bounded
    const multiHitLine = `${'m'.repeat(100)}HIT${'n'.repeat(217)}HIT${'p'.repeat(40)}`
    const multiHitSnippet = extractLineSnippet(multiHitLine, [
      { start: 100, end: 103 },
      { start: 320, end: 323 }
    ])
    expect(multiHitSnippet.matches).toEqual([{ start: 60, end: 63 }])

    // Surrogate pair straddling (line.length - 240) with anchor at the very end must not drop the anchor
    const tailStraddleLine = `${'a'.repeat(59)}😀${'b'.repeat(238)}X`
    expect(tailStraddleLine.length).toBe(300)
    const tailSnippet = extractLineSnippet(tailStraddleLine, [{ start: 299, end: 300 }])
    expect(tailSnippet.lineText.length).toBeLessThanOrEqual(240)
    expect(tailSnippet.lineText.charCodeAt(0)).not.toBe(0xde00)
    expect(tailSnippet.matches).toHaveLength(1)
    expect(tailSnippet.lineOffset + tailSnippet.matches[0].start).toBe(299)
    expect(
      tailSnippet.lineText.slice(tailSnippet.matches[0].start, tailSnippet.matches[0].end)
    ).toBe('X')

    const eolZeroWidthSnippet = extractLineSnippet(tailStraddleLine, [{ start: 300, end: 300 }])
    expect(eolZeroWidthSnippet.matches).toHaveLength(1)
    expect(eolZeroWidthSnippet.lineOffset + eolZeroWidthSnippet.matches[0].start).toBe(300)
  })

  it('sorts file results with nameMatches first, then by relativePath ascending', () => {
    const makeResult = (
      relativePath: string,
      hasNameMatch: boolean
    ): WorkspaceSearchFileResult => ({
      path: `/wiki/${relativePath}`,
      relativePath,
      name: relativePath.split('/').pop() ?? relativePath,
      nameMatches: hasNameMatch ? [{ start: 0, end: 1 }] : [],
      lineMatches: [],
      totalMatchCount: 1,
      truncatedInFile: false
    })

    const sorted = [
      makeResult('a-body-only.md', false),
      makeResult('z-name-match.md', true),
      makeResult('docs/b-name-match.md', true),
      makeResult('b-body-only.md', false)
    ].sort(compareWorkspaceSearchFileResults)

    expect(sorted.map((item) => item.relativePath)).toEqual([
      'docs/b-name-match.md',
      'z-name-match.md',
      'a-body-only.md',
      'b-body-only.md'
    ])
  })
})
