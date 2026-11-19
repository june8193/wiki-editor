import { describe, expect, it } from 'vitest'
import {
  compileSearchMatcher,
  DEFAULT_SEARCH_MATCH_OPTIONS,
  extractLineSnippet,
  findTextMatches,
  sortWorkspaceSearchFileResults,
  type WorkspaceSearchFileResult
} from './search'

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

    const prefix = 'x'.repeat(200)
    const suffix = 'y'.repeat(200)
    const longLine = `${prefix}TARGET${suffix}`
    const snippet = extractLineSnippet(longLine, [{ start: 200, end: 206 }], {
      maxLength: 100,
      leadContext: 20
    })

    expect(snippet.lineText.length).toBeLessThanOrEqual(100)
    expect(snippet.lineOffset).toBe(180)
    expect(snippet.matches).toEqual([{ start: 20, end: 26 }])
    const restoredColumn = snippet.lineOffset + snippet.matches[0].start
    expect(restoredColumn).toBe(200)
    expect(longLine.slice(restoredColumn, snippet.lineOffset + snippet.matches[0].end)).toBe(
      'TARGET'
    )
    expect(snippet.lineText.slice(snippet.matches[0].start, snippet.matches[0].end)).toBe('TARGET')

    // Surrogate boundary near sliceStart should not split a UTF-16 surrogate pair
    const emojiPrefix = '😀'.repeat(15) // 30 UTF-16 code units
    const emojiLongLine = `${emojiPrefix}${'z'.repeat(40)}HIT${'w'.repeat(100)}`
    const emojiSnippet = extractLineSnippet(emojiLongLine, [{ start: 70, end: 73 }], {
      maxLength: 80,
      leadContext: 41 // 70 - 41 = 29, which lands inside the 15th 😀 (indices 28..29)
    })
    expect(emojiSnippet.lineText.charCodeAt(0)).not.toBe(0xde00)
    const hitStart = emojiSnippet.lineOffset + emojiSnippet.matches[0].start
    expect(hitStart).toBe(70)
    expect(
      emojiSnippet.lineText.slice(emojiSnippet.matches[0].start, emojiSnippet.matches[0].end)
    ).toBe('HIT')

    // Matches beyond snippet window end are excluded while in-window spans stay bounded
    const multiHitSnippet = extractLineSnippet(
      emojiLongLine,
      [
        { start: 70, end: 73 },
        { start: 160, end: 163 }
      ],
      { maxLength: 80, leadContext: 20 }
    )
    expect(multiHitSnippet.matches).toEqual([{ start: 20, end: 23 }])
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

    const sorted = sortWorkspaceSearchFileResults([
      makeResult('a-body-only.md', false),
      makeResult('z-name-match.md', true),
      makeResult('docs/b-name-match.md', true),
      makeResult('b-body-only.md', false)
    ])

    expect(sorted.map((item) => item.relativePath)).toEqual([
      'docs/b-name-match.md',
      'z-name-match.md',
      'a-body-only.md',
      'b-body-only.md'
    ])
  })
})
