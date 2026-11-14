import { Editor } from '@tiptap/core'
import { afterEach, describe, expect, it } from 'vitest'
import {
  addTableRowBeforeSafely,
  createWysiwygExtensions,
  deleteTableRowPreservingHeader,
  prepareMarkdownForTiptap,
  sanitizeHtmlWithRehype
} from './wysiwygMarkdown'

const createdEditors: Editor[] = []

function createTestWysiwygEditor(markdown: string): Editor {
  const editor = new Editor({
    extensions: createWysiwygExtensions(),
    content: prepareMarkdownForTiptap(markdown),
    contentType: 'markdown'
  })
  createdEditors.push(editor)
  return editor
}

function findTextPos(editor: Editor, snippet: string): number {
  let foundPos = 0
  editor.state.doc.descendants((node, pos) => {
    if (node.isText && node.text?.includes(snippet)) {
      foundPos = pos + 1
      return false
    }
    return true
  })
  return foundPos
}

describe('wysiwygMarkdown (TipTap v3 + @tiptap/markdown)', () => {
  afterEach(() => {
    while (createdEditors.length > 0) {
      const editor = createdEditors.pop()!
      if (!editor.isDestroyed) {
        editor.destroy()
      }
    }
  })

  it('roundtrips headings, formatting, code blocks, blockquotes, links, lists, task lists, and tables', () => {
    const sample = [
      '# Title',
      '',
      'Text with **bold**, *italic*, `code`, and [link](https://example.com).',
      '',
      '> Quoted note',
      '',
      '```ts',
      'const value = 42',
      '```',
      '',
      '- item 1',
      '- item 2',
      '',
      '1. first',
      '2. second',
      '',
      '| Name | Status |',
      '| --- | --- |',
      '| Alpha | Done |',
      '',
      '- [x] Checked task',
      '- [ ] Open task'
    ].join('\n')

    const editor = createTestWysiwygEditor(sample)
    const exported = editor.getMarkdown()
    editor.destroy()

    expect(exported).toContain('# Title')
    expect(exported).toContain('**bold**')
    expect(exported).toContain('*italic*')
    expect(exported).toContain('`code`')
    expect(exported).toContain('[link](https://example.com)')
    expect(exported).toContain('> Quoted note')
    expect(exported).toContain('```ts\nconst value = 42\n```')
    expect(exported).toContain('Alpha')
    expect(exported).toContain('Done')
    expect(exported).toContain('[x] Checked task')
    expect(exported).toContain('[ ] Open task')
  })

  it('preserves trailing task list at EOF without trailing newline', () => {
    const noTrailingNewline = '- [x] First\n- [ ] Last'
    const editor = createTestWysiwygEditor(noTrailingNewline)
    const exported = editor.getMarkdown()
    editor.destroy()

    expect(exported).toContain('[x] First')
    expect(exported).toContain('[ ] Last')
  })

  it('sanitizes XSS HTML fragments and dangerous URI schemes via rehype-sanitize', () => {
    expect(sanitizeHtmlWithRehype('<script>alert(1)</script><p onclick="bad()">Safe</p>')).toBe(
      '<p>Safe</p>'
    )

    const malicious = [
      '# Title',
      '',
      '<script>alert(1)</script>',
      '',
      '<img src="x" onerror="alert(2)" />',
      '',
      '<iframe src="https://evil.test"></iframe>',
      '',
      '[Bad](javascript:alert(3)) [Ftp](ftp://evil.test) [Ok](https://example.com)',
      '',
      '[RefBad][badref]',
      '',
      '[badref]: javascript:alert(4)',
      '',
      '*   kept   spacing'
    ].join('\n')

    const prepared = prepareMarkdownForTiptap(malicious)
    expect(prepared).not.toContain('<script')
    expect(prepared).not.toContain('onerror')
    expect(prepared).not.toContain('<iframe')
    expect(prepared).not.toContain('javascript:')
    expect(prepared).not.toContain('ftp://')
    expect(prepared).toContain('[Ok](https://example.com)')
    expect(prepared).toContain('*   kept   spacing')

    const editor = createTestWysiwygEditor(malicious)
    const jsonStr = JSON.stringify(editor.getJSON())
    expect(jsonStr).not.toContain('javascript:')
    expect(jsonStr).not.toContain('ftp://')
    expect(editor.getMarkdown()).toContain('[Ok](https://example.com)')
    editor.destroy()
  })

  it('deletes header row in a single transaction while promoting new top row and supporting single-step undo', () => {
    const initial = [
      '| Col 1 | Col 2 |',
      '| --- | --- |',
      '| R1A | R1B |',
      '| R2A | R2B |'
    ].join('\n')

    const editor = createTestWysiwygEditor(initial)

    // Position cursor inside header cell "Col 1"
    editor.commands.setTextSelection(findTextPos(editor, 'Col 1'))

    let updateCount = 0
    editor.on('update', () => {
      updateCount += 1
    })

    expect(deleteTableRowPreservingHeader(editor)).toBe(true)
    expect(updateCount).toBe(1)

    const afterDelete = editor.getMarkdown().trim().split('\n')
    expect(afterDelete).toHaveLength(3) // R1 header + separator + R2 body
    expect(afterDelete[0]).toContain('R1A')

    // Single undo restores the deleted header row cleanly
    expect(editor.commands.undo()).toBe(true)
    expect(editor.getMarkdown()).toContain('Col 1')
    editor.destroy()
  })

  it('supports table insertion and row/column addition and deletion with clean GFM markdown output', () => {
    const initial = [
      '| Col 1 | Col 2 |',
      '| --- | --- |',
      '| A1 | A2 |'
    ].join('\n')

    const editor = createTestWysiwygEditor(initial)
    const a1Pos = findTextPos(editor, 'A1')
    expect(a1Pos).toBeGreaterThan(0)
    editor.commands.setTextSelection(a1Pos)
    expect(editor.isActive('table')).toBe(true)

    expect(editor.commands.addRowAfter()).toBe(true)
    expect(editor.commands.addColumnAfter()).toBe(true)

    const afterAdd = editor.getMarkdown()
    const afterAddLines = afterAdd.trim().split('\n')
    expect(afterAddLines).toHaveLength(4)
    expect(afterAddLines[0].split('|').slice(1, -1)).toHaveLength(3)
    expect(afterAddLines[1].split('|').slice(1, -1)).toHaveLength(3)

    expect(editor.commands.goToNextCell()).toBe(true)
    expect(editor.commands.deleteColumn()).toBe(true)
    expect(editor.commands.goToNextCell()).toBe(true)
    expect(editor.commands.deleteRow()).toBe(true)

    const afterDelete = editor.getMarkdown()
    expect(afterDelete).toContain('A1')
    expect(afterDelete).toContain('A2')
    expect(afterDelete.trim().split('\n')).toHaveLength(3)

    expect(editor.commands.deleteTable()).toBe(true)
    expect(editor.isActive('table')).toBe(false)
    expect(editor.getMarkdown().trim()).toBe('')

    expect(editor.commands.insertTable({ rows: 2, cols: 3, withHeaderRow: true })).toBe(true)
    expect(editor.isActive('table')).toBe(true)
    const insertedLines = editor.getMarkdown().trim().split('\n')
    expect(insertedLines).toHaveLength(3)
    expect(insertedLines[0].split('|').slice(1, -1)).toHaveLength(3)

    editor.destroy()
  })

  it('addTableRowBeforeSafely keeps a single header row from row 0 and inserts above body rows otherwise', () => {
    const editor = createTestWysiwygEditor(
      ['| Col 1 | Col 2 |', '| --- | --- |', '| R1A | R1B |', '| R2A | R2B |'].join('\n')
    )

    editor.commands.setTextSelection(findTextPos(editor, 'Col 1'))
    expect(addTableRowBeforeSafely(editor)).toBe(true)

    const afterHeaderAction = editor.getMarkdown().trim().split('\n')
    expect(afterHeaderAction).toHaveLength(5)
    expect(afterHeaderAction[0]).toContain('Col 1')
    expect(afterHeaderAction[2]).toMatch(/\|\s*\|\s*\|/)
    expect(afterHeaderAction[3]).toContain('R1A')

    editor.commands.setTextSelection(findTextPos(editor, 'R2A'))
    expect(addTableRowBeforeSafely(editor)).toBe(true)

    const afterBodyAction = editor.getMarkdown().trim().split('\n')
    expect(afterBodyAction).toHaveLength(6)
    expect(afterBodyAction[3]).toContain('R1A')
    expect(afterBodyAction[4]).toMatch(/\|\s*\|\s*\|/)
    expect(afterBodyAction[5]).toContain('R2A')

    editor.destroy()
  })
})
