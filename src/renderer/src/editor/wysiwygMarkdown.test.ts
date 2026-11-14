import { Editor } from '@tiptap/core'
import { describe, expect, it } from 'vitest'
import {
  createWysiwygExtensions,
  normalizeMarkdownForTiptap,
  serializeTiptapEditorToMarkdown
} from './wysiwygMarkdown'

function createTestWysiwygEditor(markdown: string): Editor {
  return new Editor({
    extensions: createWysiwygExtensions(),
    content: normalizeMarkdownForTiptap(markdown),
    contentType: 'markdown'
  })
}

describe('wysiwygMarkdown (TipTap v3 + @tiptap/markdown)', () => {
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
    const exported = serializeTiptapEditorToMarkdown(editor)
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
    const exported = serializeTiptapEditorToMarkdown(editor)
    editor.destroy()

    expect(exported).toContain('[x] First')
    expect(exported).toContain('[ ] Last')
  })

  it('supports table insertion and row/column addition and deletion with clean GFM markdown output', () => {
    const initial = [
      '| Col 1 | Col 2 |',
      '| --- | --- |',
      '| A1 | A2 |'
    ].join('\n')

    const editor = createTestWysiwygEditor(initial)
    // Place cursor inside cell "A1"
    const docText = editor.state.doc
    let a1Pos = 0
    docText.descendants((node, pos) => {
      if (node.isText && node.text?.includes('A1')) {
        a1Pos = pos + 1
        return false
      }
      return true
    })
    expect(a1Pos).toBeGreaterThan(0)
    editor.commands.setTextSelection(a1Pos)
    expect(editor.isActive('table')).toBe(true)

    // Add row below and column right, then move into the added cell before deleting them
    expect(editor.commands.addRowAfter()).toBe(true)
    expect(editor.commands.addColumnAfter()).toBe(true)

    const afterAdd = serializeTiptapEditorToMarkdown(editor)
    const afterAddLines = afterAdd.trim().split('\n')
    expect(afterAddLines).toHaveLength(4) // header + separator + 2 body rows
    expect(afterAddLines[0].split('|').slice(1, -1)).toHaveLength(3)
    expect(afterAddLines[1].split('|').slice(1, -1)).toHaveLength(3)

    // Move to the newly added empty column (to the right of A1) and delete it
    expect(editor.commands.goToNextCell()).toBe(true)
    expect(editor.commands.deleteColumn()).toBe(true)
    // Move to the newly added empty row (next row after A2) and delete it
    expect(editor.commands.goToNextCell()).toBe(true)
    expect(editor.commands.deleteRow()).toBe(true)

    const afterDelete = serializeTiptapEditorToMarkdown(editor)
    expect(afterDelete).toContain('A1')
    expect(afterDelete).toContain('A2')
    expect(afterDelete.trim().split('\n')).toHaveLength(3)

    // Delete table completely
    expect(editor.commands.deleteTable()).toBe(true)
    expect(editor.isActive('table')).toBe(false)
    expect(serializeTiptapEditorToMarkdown(editor).trim()).toBe('')

    // Insert a brand-new 2x3 table with header row
    expect(editor.commands.insertTable({ rows: 2, cols: 3, withHeaderRow: true })).toBe(true)
    expect(editor.isActive('table')).toBe(true)
    const insertedLines = serializeTiptapEditorToMarkdown(editor).trim().split('\n')
    expect(insertedLines).toHaveLength(3)
    expect(insertedLines[0].split('|').slice(1, -1)).toHaveLength(3)

    editor.destroy()
  })
})
