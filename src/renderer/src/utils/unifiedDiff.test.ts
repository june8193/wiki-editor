import { describe, expect, it } from 'vitest'
import {
  buildInlineDiffRows,
  buildSideBySideDiffRows,
  parseUnifiedDiff
} from './unifiedDiff'

describe('unifiedDiff parser and row alignment', () => {
  it('parses hunk headers, single-line counts, line numbers, Markdown dashes, and no-newline markers', () => {
    const patch = [
      'diff --git a/doc.md b/doc.md',
      'index 1111111..2222222 100644',
      '--- a/doc.md',
      '+++ b/doc.md',
      '@@ -1 +1 @@',
      '-old title',
      '+new title',
      '@@ -10,4 +10,5 @@ ## Section',
      ' ---',
      '-removed line',
      '+added line 1',
      '+added line 2',
      ' tail context',
      '\\ No newline at end of file'
    ].join('\n')

    const parsed = parseUnifiedDiff(patch)
    expect(parsed.hunks).toHaveLength(2)

    expect(parsed.hunks[0]).toMatchObject({
      oldStart: 1,
      oldCount: 1,
      newStart: 1,
      newCount: 1,
      lines: [
        { type: 'delete', oldLineNumber: 1, newLineNumber: null, content: 'old title' },
        { type: 'add', oldLineNumber: null, newLineNumber: 1, content: 'new title' }
      ]
    })

    expect(parsed.hunks[1]).toMatchObject({
      oldStart: 10,
      oldCount: 4,
      newStart: 10,
      newCount: 5,
      lines: [
        { type: 'context', oldLineNumber: 10, newLineNumber: 10, content: '---' },
        { type: 'delete', oldLineNumber: 11, newLineNumber: null, content: 'removed line' },
        { type: 'add', oldLineNumber: null, newLineNumber: 11, content: 'added line 1' },
        { type: 'add', oldLineNumber: null, newLineNumber: 12, content: 'added line 2' },
        { type: 'context', oldLineNumber: 12, newLineNumber: 13, content: 'tail context' },
        { type: 'note', oldLineNumber: null, newLineNumber: null, content: 'No newline at end of file' }
      ]
    })
  })

  it('builds paired side-by-side rows aligning consecutive delete/add blocks and inline rows', () => {
    const patch = [
      'diff --git a/notes.md b/notes.md',
      '--- a/notes.md',
      '+++ b/notes.md',
      '@@ -3,4 +3,5 @@',
      ' keep 1',
      '-del 1',
      '+add 1',
      '+add 2',
      ' keep 2'
    ].join('\n')

    const parsed = parseUnifiedDiff(patch)
    const inlineRows = buildInlineDiffRows(parsed)
    expect(inlineRows).toEqual([
      { kind: 'hunk', header: '@@ -3,4 +3,5 @@' },
      { kind: 'line', lineType: 'context', marker: ' ', oldLineNumber: 3, newLineNumber: 3, content: 'keep 1' },
      { kind: 'line', lineType: 'delete', marker: '-', oldLineNumber: 4, newLineNumber: null, content: 'del 1' },
      { kind: 'line', lineType: 'add', marker: '+', oldLineNumber: null, newLineNumber: 4, content: 'add 1' },
      { kind: 'line', lineType: 'add', marker: '+', oldLineNumber: null, newLineNumber: 5, content: 'add 2' },
      { kind: 'line', lineType: 'context', marker: ' ', oldLineNumber: 5, newLineNumber: 6, content: 'keep 2' }
    ])

    const sideBySideRows = buildSideBySideDiffRows(parsed)
    expect(sideBySideRows).toEqual([
      { kind: 'hunk', header: '@@ -3,4 +3,5 @@' },
      {
        kind: 'pair',
        rowKind: 'context',
        oldCell: { type: 'context', marker: ' ', lineNumber: 3, content: 'keep 1' },
        newCell: { type: 'context', marker: ' ', lineNumber: 3, content: 'keep 1' }
      },
      {
        kind: 'pair',
        rowKind: 'change',
        oldCell: { type: 'delete', marker: '-', lineNumber: 4, content: 'del 1' },
        newCell: { type: 'add', marker: '+', lineNumber: 4, content: 'add 1' }
      },
      {
        kind: 'pair',
        rowKind: 'add',
        oldCell: null,
        newCell: { type: 'add', marker: '+', lineNumber: 5, content: 'add 2' }
      },
      {
        kind: 'pair',
        rowKind: 'context',
        oldCell: { type: 'context', marker: ' ', lineNumber: 5, content: 'keep 2' },
        newCell: { type: 'context', marker: ' ', lineNumber: 6, content: 'keep 2' }
      }
    ])
  })

  it('returns empty hunks and rows for empty patches or rename-only headers', () => {
    const emptyParsed = parseUnifiedDiff('')
    expect(emptyParsed.hunks).toEqual([])
    expect(buildInlineDiffRows(emptyParsed)).toEqual([])
    expect(buildSideBySideDiffRows(emptyParsed)).toEqual([])

    const renameOnly = parseUnifiedDiff(
      [
        'diff --git a/old.md b/new.md',
        'similarity index 100%',
        'rename from old.md',
        'rename to new.md',
        ''
      ].join('\n')
    )
    expect(renameOnly.hunks).toEqual([])
    expect(buildInlineDiffRows(renameOnly)).toEqual([])
    expect(buildSideBySideDiffRows(renameOnly)).toEqual([])
  })
})
