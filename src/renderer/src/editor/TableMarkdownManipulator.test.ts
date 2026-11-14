import { describe, expect, it } from 'vitest'
import {
  addTableColumn,
  addTableRow,
  deleteTable,
  deleteTableColumn,
  deleteTableRow,
  detectTableAtOffset,
  formatTableAtOffset,
  insertMarkdownTable
} from './TableMarkdownManipulator'

describe('TableMarkdownManipulator', () => {
  it('detects GFM tables at cursor offset while ignoring tables inside fenced code blocks', () => {
    const md = [
      '# Doc',
      '',
      '```markdown',
      '| Fake | Header |',
      '| --- | --- |',
      '| a | b |',
      '```',
      '',
      '| Name | Role | Note |',
      '| :--- | :---: | ---: |',
      '| Alice | Admin | first |',
      '| Bob | `a | b` | second\\|pipe |'
    ].join('\n')

    const fakeOffset = md.indexOf('Fake')
    expect(detectTableAtOffset(md, fakeOffset)).toBeNull()

    const aliceOffset = md.indexOf('Alice')
    const ctx = detectTableAtOffset(md, aliceOffset)
    expect(ctx).not.toBeNull()
    expect(ctx).toMatchObject({
      section: 'body',
      bodyRowIndex: 0,
      colIndex: 0,
      columnCount: 3,
      alignments: ['left', 'center', 'right']
    })

    const noteCellOffset = md.indexOf('second\\|pipe') + 2
    const pipeCtx = detectTableAtOffset(md, noteCellOffset)
    expect(pipeCtx).toMatchObject({
      section: 'body',
      bodyRowIndex: 1,
      colIndex: 2,
      columnCount: 3
    })

    const inlineCodeCellOffset = md.indexOf('`a | b`') + 3
    const inlinePipeCtx = detectTableAtOffset(md, inlineCodeCellOffset)
    expect(inlinePipeCtx).toMatchObject({
      section: 'body',
      bodyRowIndex: 1,
      colIndex: 1,
      columnCount: 3
    })
  })

  it('inserts a vertically aligned GFM table template with clean blank line separation', () => {
    const md = '# Title\nParagraph'
    const offset = md.length
    const result = insertMarkdownTable(md, offset)

    expect(result.content).toBe(
      [
        '# Title',
        'Paragraph',
        '',
        '| 열 1 | 열 2 | 열 3 |',
        '| ---- | ---- | ---- |',
        '|      |      |      |',
        '|      |      |      |'
      ].join('\n')
    )
    const detected = detectTableAtOffset(result.content, result.cursorOffset)
    expect(detected).not.toBeNull()
    expect(detected?.section).toBe('header')
    expect(detected?.colIndex).toBe(0)
  })

  it('adds rows above and below the current body row and safely inserts first body row from header', () => {
    const md = [
      '| Col A | Col B |',
      '| ----- | ----: |',
      '| r1a   |   r1b |',
      '| r2a   |   r2b |'
    ].join('\n')

    // Add row above second body row (r2)
    const r2Offset = md.indexOf('r2b')
    const above = addTableRow(md, r2Offset, 'above')
    expect(above?.content).toBe(
      [
        '| Col A | Col B |',
        '| ----- | ----: |',
        '| r1a   |   r1b |',
        '|       |       |',
        '| r2a   |   r2b |'
      ].join('\n')
    )

    // Add row below first body row (r1)
    const r1Offset = md.indexOf('r1a')
    const below = addTableRow(md, r1Offset, 'below')
    expect(below?.content).toBe(
      [
        '| Col A | Col B |',
        '| ----- | ----: |',
        '| r1a   |   r1b |',
        '|       |       |',
        '| r2a   |   r2b |'
      ].join('\n')
    )

    // Requesting add row above while cursor is in header safely adds first body row below separator
    const headerOffset = md.indexOf('Col A')
    const fromHeader = addTableRow(md, headerOffset, 'above')
    expect(fromHeader?.content).toBe(
      [
        '| Col A | Col B |',
        '| ----- | ----: |',
        '|       |       |',
        '| r1a   |   r1b |',
        '| r2a   |   r2b |'
      ].join('\n')
    )
  })

  it('adds columns left and right while preserving column alignments and vertical pipe padding', () => {
    const md = [
      '| Name | Score |',
      '| :--- | ----: |',
      '| Kim  |   100 |'
    ].join('\n')

    const leftRes = addTableColumn(md, md.indexOf('Score'), 'left')
    expect(leftRes?.content).toBe(
      [
        '| Name | 열  | Score |',
        '| :--- | --- | ----: |',
        '| Kim  |     |   100 |'
      ].join('\n')
    )

    const rightRes = addTableColumn(md, md.indexOf('Score'), 'right')
    expect(rightRes?.content).toBe(
      [
        '| Name | Score | 열  |',
        '| :--- | ----: | --- |',
        '| Kim  |   100 |     |'
      ].join('\n')
    )
  })

  it('deletes current body row safely while guarding header and separator rows', () => {
    const md = [
      '| H1  | H2  |',
      '| --- | --- |',
      '| a1  | a2  |',
      '| b1  | b2  |'
    ].join('\n')

    // Guard header & separator rows
    expect(deleteTableRow(md, md.indexOf('H1'))).toBeNull()
    expect(deleteTableRow(md, md.indexOf('---'))).toBeNull()

    // Delete first body row
    const deletedFirst = deleteTableRow(md, md.indexOf('a2'))
    expect(deletedFirst?.content).toBe(
      [
        '| H1  | H2  |',
        '| --- | --- |',
        '| b1  | b2  |'
      ].join('\n')
    )
  })

  it('deletes current column while preserving remaining alignments and guarding single-column tables', () => {
    const md = [
      '| A    |   B   |    C |',
      '| :--- | :---: | ---: |',
      '| 1    |   2   |    3 |'
    ].join('\n')

    const res = deleteTableColumn(md, md.indexOf('B'))
    expect(res?.content).toBe(
      [
        '| A    |    C |',
        '| :--- | ---: |',
        '| 1    |    3 |'
      ].join('\n')
    )

    const singleCol = [
      '| Only |',
      '| ---- |',
      '| val  |'
    ].join('\n')
    expect(deleteTableColumn(singleCol, singleCol.indexOf('val'))).toBeNull()
  })

  it('aligns column pipes visually when formatting tables and deletes entire table cleanly', () => {
    const unaligned = [
      'Before',
      '| Name|Description|',
      '|:---|---:|',
      '|A|Longer value|',
      'After'
    ].join('\n')

    const formatted = formatTableAtOffset(unaligned, unaligned.indexOf('Longer'))
    expect(formatted?.content).toBe(
      [
        'Before',
        '| Name |  Description |',
        '| :--- | -----------: |',
        '| A    | Longer value |',
        'After'
      ].join('\n')
    )

    const removed = deleteTable(formatted!.content, formatted!.content.indexOf('Longer'))
    expect(removed?.content).toBe('Before\nAfter')
  })

  it('preserves CRLF line endings across table edits and handles deleting the last body row', () => {
    const crlfDoc = '# Note\r\n\r\nAfter'
    const inserted = insertMarkdownTable(crlfDoc, '# Note'.length, 1, 2)
    expect(inserted.content).toBe(
      ['# Note', '', '| 열 1 | 열 2 |', '| ---- | ---- |', '|      |      |', '', 'After'].join('\r\n')
    )

    const bodyOffset = inserted.content.lastIndexOf('|      |') + 2
    const added = addTableRow(inserted.content, bodyOffset, 'below')!
    expect(added.content.split('\r\n').filter((line) => line.startsWith('|'))).toHaveLength(4)

    // Delete single remaining body row safely and move cursor back to header
    const deletedLastBody = deleteTableRow(inserted.content, bodyOffset)!
    expect(deletedLastBody.content).toBe(
      ['# Note', '', '| 열 1 | 열 2 |', '| ---- | ---- |', '', 'After'].join('\r\n')
    )
    expect(deletedLastBody.cursorOffset).toBe(deletedLastBody.content.indexOf('열 2'))

    const removed = deleteTable(deletedLastBody.content, deletedLastBody.cursorOffset)!
    expect(removed.content).toBe('# Note\r\n\r\nAfter')
  })
})
