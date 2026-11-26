import { createElement } from 'react'
import { fireEvent, render, waitFor } from '@testing-library/react'
import { Editor } from '@tiptap/core'
import { EditorContent } from '@tiptap/react'
import { buildWikiAssetUrl } from '@shared/assets'
import { afterEach, describe, expect, it } from 'vitest'
import {
  addTableRowBeforeSafely,
  createWysiwygExtensions,
  deleteTableRowPreservingHeader,
  extractWysiwygHeadingCandidates,
  insertWysiwygImages,
  prepareMarkdownForTiptap,
  sanitizeHtmlWithRehype
} from './wysiwygMarkdown'

const createdEditors: Editor[] = []

afterEach(() => {
  while (createdEditors.length > 0) {
    const editor = createdEditors.pop()!
    if (!editor.isDestroyed) {
      editor.destroy()
    }
  }
})

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

  it('roundtrips mermaid fenced code blocks losslessly alongside standard markdown', () => {
    const sample = [
      '# Architecture',
      '',
      '```mermaid',
      'flowchart TD',
      '  A[Start] --> B[End]',
      '```',
      '',
      'After diagram'
    ].join('\n')

    const editor = createTestWysiwygEditor(sample)
    const exported = editor.getMarkdown()
    editor.destroy()

    expect(exported).toContain('# Architecture')
    expect(exported).toContain('```mermaid\nflowchart TD\n  A[Start] --> B[End]\n```')
    expect(exported).toContain('After diagram')
  })

  it('decorates code blocks with live syntax highlight spans, preserves untouched alias/custom fences, and updates decorations on language or code edits', async () => {
    const sample = [
      '```c',
      'int main() {',
      '  return 0;',
      '}',
      '```',
      '',
      '```py',
      'def greet():',
      '    return "hi"',
      '```',
      '',
      '```kotlin',
      'val answer = 42',
      '```',
      '',
      '```ts',
      'const value = 42',
      '```'
    ].join('\n')

    const editor = createTestWysiwygEditor(sample)
    render(createElement(EditorContent, { editor }))

    await waitFor(() => {
      expect(editor.view.dom.querySelectorAll('pre code')).toHaveLength(4)
    })

    // Alias and custom fence identifiers remain untouched on mount/roundtrip
    const initialRoundtrip = editor.getMarkdown()
    expect(initialRoundtrip).toContain('```py\ndef greet():\n    return "hi"\n```')
    expect(initialRoundtrip).toContain('```kotlin\nval answer = 42\n```')

    const codeEls = Array.from(editor.view.dom.querySelectorAll('pre code'))
    expect(codeEls[0].querySelector('span.tok-type')).toHaveTextContent('int')
    expect(codeEls[0].querySelector('span.tok-keyword')).toHaveTextContent('return')
    expect(codeEls[1].querySelector('span.tok-keyword')).toHaveTextContent('def')
    expect(codeEls[3].querySelector('span.tok-keyword')).toHaveTextContent('const')
    expect(codeEls[3].querySelector('span.tok-number')).toHaveTextContent('42')

    // Language attribute mutation to another non-null language updates highlight decorations
    editor.commands.setTextSelection(findTextPos(editor, 'const value'))
    expect(editor.commands.updateAttributes('codeBlock', { language: 'python' })).toBe(true)

    await waitFor(() => {
      const updatedCodeEls = Array.from(editor.view.dom.querySelectorAll('pre code'))
      expect(updatedCodeEls[3].querySelector('span.tok-keyword')).toBeNull()
    })

    // Editing code text inside the python block dynamically applies Python syntax highlighting
    const pythonTargetPos = findTextPos(editor, 'const value')
    editor.commands.insertContentAt(pythonTargetPos - 1, 'def f(): return ')

    await waitFor(() => {
      const editedCodeEls = Array.from(editor.view.dom.querySelectorAll('pre code'))
      expect(editedCodeEls[3].querySelector('span.tok-keyword')).toHaveTextContent('def')
    })

    // Clearing language removes decorations and serializes fence without info string
    editor.commands.setTextSelection(findTextPos(editor, 'def f():'))
    expect(editor.commands.updateAttributes('codeBlock', { language: null })).toBe(true)

    await waitFor(() => {
      const clearedCodeEls = Array.from(editor.view.dom.querySelectorAll('pre code'))
      expect(clearedCodeEls[3].querySelectorAll('span')).toHaveLength(0)
    })
    expect(editor.getMarkdown()).toContain('```\ndef f(): return const value = 42\n```')

    editor.destroy()
  })
})

function createImageTestEditor(
  content: string,
  options: { documentPath?: string; contentType?: 'markdown' | 'html'; prepare?: boolean } = {}
): Editor {
  const { documentPath, contentType = 'markdown', prepare = true } = options
  const editor = new Editor({
    extensions: createWysiwygExtensions(
      documentPath ? { getDocumentPath: () => documentPath } : undefined
    ),
    content: contentType === 'markdown' && prepare ? prepareMarkdownForTiptap(content) : content,
    contentType
  })
  createdEditors.push(editor)
  return editor
}

describe('wysiwygMarkdown local image rendering and roundtrip', () => {
  it('renders relative images with wiki-asset display URLs while preserving original relative paths on getMarkdown and heading extraction', () => {
    const documentPath = 'C:\\vault\\docs\\guide\\intro.md'
    const markdown = [
      '# ![Logo](./assets/logo%20(1).png) Alpha',
      '',
      '![local](./assets/pic.png)',
      '',
      '![parent](../shared/diagram.svg)',
      '',
      '![parens](<./assets/my pic (1).png>)',
      '',
      '![external](https://example.com/banner.png)'
    ].join('\n')

    const editor = createImageTestEditor(markdown, { documentPath })

    const imgs = Array.from(editor.view.dom.querySelectorAll('img:not(.ProseMirror-separator)'))
    expect(imgs.map((img) => img.getAttribute('alt'))).toEqual([
      'Logo',
      'local',
      'parent',
      'parens',
      'external'
    ])
    expect(imgs[0]?.getAttribute('src')).toBe(
      buildWikiAssetUrl('C:\\vault\\docs\\guide\\assets\\logo (1).png')
    )
    expect(imgs[0]?.getAttribute('data-markdown-src')).toBe('./assets/logo%20(1).png')
    expect(imgs[1]?.getAttribute('src')).toBe(
      buildWikiAssetUrl('C:\\vault\\docs\\guide\\assets\\pic.png')
    )
    expect(imgs[1]?.getAttribute('data-markdown-src')).toBe('./assets/pic.png')
    expect(imgs[2]?.getAttribute('src')).toBe(
      buildWikiAssetUrl('C:\\vault\\docs\\shared\\diagram.svg')
    )
    expect(imgs[2]?.getAttribute('data-markdown-src')).toBe('../shared/diagram.svg')
    expect(imgs[3]?.getAttribute('src')).toBe(
      buildWikiAssetUrl('C:\\vault\\docs\\guide\\assets\\my pic (1).png')
    )
    expect(imgs[3]?.getAttribute('data-markdown-src')).toBe('./assets/my pic (1).png')
    expect(imgs[4]?.getAttribute('src')).toBe('https://example.com/banner.png')
    expect(imgs[4]?.getAttribute('data-markdown-src')).toBe('https://example.com/banner.png')

    expect(extractWysiwygHeadingCandidates(editor.state.doc)).toEqual([
      { level: 1, text: 'Logo Alpha', pos: 0, hasMedia: true }
    ])

    const roundtripped = editor.getMarkdown()
    expect(roundtripped).not.toContain('wiki-asset:')
    expect(roundtripped).toContain('# ![Logo](./assets/logo%20(1).png) Alpha')
    expect(roundtripped).toContain('![local](./assets/pic.png)')
    expect(roundtripped).toContain('![parent](../shared/diagram.svg)')
    expect(roundtripped).toContain('![parens](<./assets/my pic (1).png>)')
    expect(roundtripped).toContain('![external](https://example.com/banner.png)')

    // Ensure second-pass parsing still keeps ![parens](<...>) as an image node, not plain text
    const secondEditor = createImageTestEditor(roundtripped, { documentPath })
    expect(secondEditor.view.dom.querySelectorAll('img:not(.ProseMirror-separator)')).toHaveLength(5)
  })

  it('blocks wiki-asset, javascript, and data image URIs in markdown and preserves safe data-markdown-src across sanitized HTML paste', () => {
    const unsafeMarkdown = [
      '![proto](wiki-asset://local/asset?path=/vault/a.png)',
      '',
      '![js](javascript:alert(1))',
      '',
      '![data](data:text/html,<script>alert(1)</script>)'
    ].join('\n')

    const preparedEditor = createImageTestEditor(unsafeMarkdown)
    expect(preparedEditor.view.dom.querySelectorAll('img:not(.ProseMirror-separator)')).toHaveLength(0)
    expect(preparedEditor.getMarkdown()).not.toContain('wiki-asset:')

    const directEditor = createImageTestEditor(unsafeMarkdown, {
      documentPath: '/vault/docs/page.md',
      prepare: false
    })
    expect(directEditor.view.dom.querySelectorAll('img:not(.ProseMirror-separator)')).toHaveLength(0)

    const internalCopiedHtml =
      '<p><img src="wiki-asset://local/asset?path=%2Fvault%2Fdocs%2Fassets%2Fpic.png" data-markdown-src="./assets/pic.png" alt="copied"></p>'
    const sanitizedInternal = sanitizeHtmlWithRehype(internalCopiedHtml)
    expect(sanitizedInternal).not.toContain('wiki-asset:')
    expect(sanitizedInternal).toContain('data-markdown-src="./assets/pic.png"')

    const pasteEditor = createImageTestEditor(sanitizedInternal, {
      documentPath: '/vault/docs/page.md',
      contentType: 'html'
    })
    expect(pasteEditor.getMarkdown()).toBe('![copied](./assets/pic.png)')
    expect(
      pasteEditor.view.dom.querySelector('img:not(.ProseMirror-separator)')?.getAttribute('src')
    ).toBe(buildWikiAssetUrl('/vault/docs/assets/pic.png'))

    const untrustedHtml =
      '<p><img src="wiki-asset://local/asset?path=/vault/a.png" data-markdown-src="javascript:alert(1)" onerror="alert(2)" alt="bad"></p>'
    const sanitizedUntrusted = sanitizeHtmlWithRehype(untrustedHtml)
    expect(sanitizedUntrusted).not.toContain('wiki-asset:')
    expect(sanitizedUntrusted).not.toContain('javascript:')
    expect(sanitizedUntrusted).not.toContain('onerror')

    pasteEditor.commands.setContent(sanitizedUntrusted)
    expect(pasteEditor.getMarkdown()).not.toContain('wiki-asset:')
    expect(pasteEditor.view.dom.querySelectorAll('img:not(.ProseMirror-separator)')).toHaveLength(0)

    // Typing inputRule or calling setImage must also reject unsafe schemes and mailto:
    expect(pasteEditor.commands.setImage({ src: 'wiki-asset://local/asset?path=/a.png', alt: 'bad' })).toBe(false)
    expect(pasteEditor.commands.setImage({ src: 'javascript:alert(1)', alt: 'bad' })).toBe(false)
    expect(pasteEditor.commands.setImage({ src: 'mailto:user@example.com', alt: 'bad' })).toBe(false)

    const simulateInput = (prefixHtml: string, text: string): void => {
      pasteEditor.commands.setContent(prefixHtml)
      const endPos = pasteEditor.state.doc.content.size - 1
      pasteEditor.view.someProp('handleTextInput', (fn) =>
        fn(pasteEditor.view, endPos, endPos, text, () => pasteEditor.state.tr.insertText(text, endPos))
      )
    }

    simulateInput('<p>![bad](wiki-asset://local/asset?path=/a.png</p>', ')')
    expect(pasteEditor.state.doc.content.toString()).not.toContain('image')

    simulateInput('<p>![ok](./assets/typed.png</p>', ')')
    let insertedImageSrc: string | null = null
    pasteEditor.state.doc.descendants((node) => {
      if (node.type.name === 'image') {
        insertedImageSrc = node.attrs.src
      }
    })
    expect(insertedImageSrc).toBe('./assets/typed.png')
  })

  it('inserts single and multiple ingested images in order while preserving safe markdown paths', () => {
    const editor = createImageTestEditor('Hello world', {
      documentPath: '/vault/docs/guide.md'
    })
    const insertPos = findTextPos(editor, 'world')
    expect(
      insertWysiwygImages(
        editor,
        [{ markdownPath: './assets/one.png', altText: 'one', savedPath: '/vault/docs/assets/one.png' }],
        { from: insertPos, to: insertPos }
      )
    ).toBe(true)
    expect(editor.getMarkdown()).toContain('![one](./assets/one.png)')

    const multiEditor = createImageTestEditor('', {
      documentPath: '/vault/docs/guide.md'
    })
    expect(
      insertWysiwygImages(multiEditor, [
        {
          markdownPath: './assets/a%20%281%29.png',
          altText: 'a (1)',
          savedPath: '/vault/docs/assets/a (1).png'
        },
        {
          markdownPath: '../shared/b.svg',
          altText: 'b',
          savedPath: '/vault/shared/b.svg'
        }
      ])
    ).toBe(true)

    const markdown = multiEditor.getMarkdown()
    expect(markdown).toContain('![a (1)](./assets/a%20%281%29.png)')
    expect(markdown).toContain('![b](../shared/b.svg)')
    expect(markdown.indexOf('![a (1)](./assets/a%20%281%29.png)')).toBeLessThan(
      markdown.indexOf('![b](../shared/b.svg)')
    )
    expect(markdown).not.toContain('wiki-asset:')
  })
})

function createClipboardData(entries: Record<string, string>) {
  return {
    types: Object.keys(entries),
    files: [] as File[],
    items: [] as DataTransferItem[],
    getData: (type: string) => entries[type] ?? ''
  }
}

describe('wysiwygMarkdown external plain-text Markdown paste and indented block handling', () => {
  it('parses 4-space and tab indented blocks as sanitized paragraphs while preserving explicit fenced code blocks', () => {
    const sample = [
      '    const a = 1;',
      '    const b = 2;',
      '',
      '\tconst c = 3;',
      '',
      '    ```ts',
      '    const indentedFence = true',
      '    ```',
      '',
      '    <script>alert(1)</script>[bad](javascript:alert(2)) **bold**',
      '',
      '    [multiline](\n    javascript:alert(3))',
      '',
      '```ts',
      'const fenced = true',
      '```',
      '',
      '~~~py',
      'print(1)',
      '~~~'
    ].join('\n')

    const editor = createTestWysiwygEditor(sample)
    const codeBlockLanguages: Array<string | null> = []
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'codeBlock') {
        codeBlockLanguages.push((node.attrs.language as string | null) ?? null)
      }
      return true
    })

    expect(codeBlockLanguages).toEqual(['ts', 'py'])

    const markdown = editor.getMarkdown()
    expect(markdown).toContain('const a = 1;')
    expect(markdown).toContain('const b = 2;')
    expect(markdown).toContain('const c = 3;')
    expect(markdown).toContain('const indentedFence = true')
    expect(markdown).toContain('bad **bold**')
    expect(markdown).toContain('multiline')
    expect(markdown).not.toContain('<script')
    expect(markdown).not.toContain('javascript:')
    expect(markdown).toContain('```ts\nconst fenced = true\n```')
    expect(markdown).toContain('```py\nprint(1)\n```')
  })

  it('ignores vscode-editor-data and external text/html on paste and parses text/plain as Markdown without creating indented code blocks', () => {
    const vsCodeEditor = createTestWysiwygEditor('')
    vsCodeEditor.commands.setTextSelection(1)
    fireEvent.paste(vsCodeEditor.view.dom, {
      clipboardData: createClipboardData({
        'vscode-editor-data': JSON.stringify({ version: 1, mode: 'typescript' }),
        'text/html': '<div style="white-space:pre"><span>const a = 1;</span></div>',
        'text/plain': '    if (ok) {\n        run();\n    }'
      })
    })

    let vsCodeBlockCount = 0
    vsCodeEditor.state.doc.descendants((node) => {
      if (node.type.name === 'codeBlock') vsCodeBlockCount += 1
      return true
    })
    expect(vsCodeBlockCount).toBe(0)
    expect(vsCodeEditor.state.doc.textContent).toContain('if (ok) {')
    expect(vsCodeEditor.state.doc.textContent).toContain('run();')
    expect(vsCodeEditor.getMarkdown()).not.toContain('```')

    const mdPasteEditor = createTestWysiwygEditor('')
    mdPasteEditor.commands.setTextSelection(1)
    fireEvent.paste(mdPasteEditor.view.dom, {
      clipboardData: createClipboardData({
        'text/html': '<b>ignored external html</b><p>different content</p>',
        'text/plain': '## Section\n\n- item 1\n- item 2'
      })
    })

    const mdOutput = mdPasteEditor.getMarkdown()
    expect(mdOutput).toContain('## Section')
    expect(mdOutput).toContain('- item 1')
    expect(mdOutput).toContain('- item 2')
    expect(mdOutput).not.toContain('ignored external html')
    expect(mdOutput).not.toContain('different content')

    const fencedPasteEditor = createTestWysiwygEditor('')
    fencedPasteEditor.commands.setTextSelection(1)
    fireEvent.paste(fencedPasteEditor.view.dom, {
      clipboardData: createClipboardData({
        'text/plain': '```ts\nconst x = 1\n```'
      })
    })
    let fencedCodeLang: string | null = null
    fencedPasteEditor.state.doc.descendants((node) => {
      if (node.type.name === 'codeBlock') {
        fencedCodeLang = (node.attrs.language as string | null) ?? null
      }
      return true
    })
    expect(fencedCodeLang).toBe('ts')
  })

  it('merges single-line Markdown paste inline inside a paragraph and preserves internal data-pm-slice paste', () => {
    const inlineEditor = createTestWysiwygEditor('Hello world')
    const helloStart = findTextPos(inlineEditor, 'Hello') - 1
    inlineEditor.commands.setTextSelection(helloStart + 'Hello '.length)

    fireEvent.paste(inlineEditor.view.dom, {
      clipboardData: createClipboardData({
        'text/html': '<i>ignored</i>',
        'text/plain': '**bold** snippet'
      })
    })

    expect(inlineEditor.state.doc.childCount).toBe(1)
    expect(inlineEditor.getMarkdown()).toBe('Hello **bold** snippetworld')

    const internalEditor = createTestWysiwygEditor('Prefix ')
    const prefixStart = findTextPos(internalEditor, 'Prefix') - 1
    internalEditor.commands.setTextSelection(prefixStart + 'Prefix '.length)

    fireEvent.paste(internalEditor.view.dom, {
      clipboardData: createClipboardData({
        'text/html': '<p data-pm-slice="1 1 []"><strong>rich</strong> copy</p>',
        'text/plain': 'rich copy'
      })
    })

    expect(internalEditor.getMarkdown()).toContain('**rich** copy')
  })

  it('inserts literal text/plain without Markdown parsing when cursor is inside a codeBlock or inline code mark', () => {
    const codeBlockEditor = createTestWysiwygEditor('```ts\nconst x = 1;\n```')
    codeBlockEditor.commands.setTextSelection(findTextPos(codeBlockEditor, 'const x = 1;'))
    fireEvent.paste(codeBlockEditor.view.dom, {
      clipboardData: createClipboardData({
        'vscode-editor-data': JSON.stringify({ version: 1, mode: 'markdown' }),
        'text/html': '<h1>Ignored</h1>',
        'text/plain': '# Not a heading\n- Not a list'
      })
    })

    const nonEmptyBlockTypes: string[] = []
    codeBlockEditor.state.doc.forEach((node) => {
      if (node.type.name !== 'paragraph' || node.textContent.length > 0) {
        nonEmptyBlockTypes.push(node.type.name)
      }
    })
    expect(nonEmptyBlockTypes).toEqual(['codeBlock'])
    expect(codeBlockEditor.state.doc.firstChild?.textContent).toContain('# Not a heading')
    expect(codeBlockEditor.state.doc.firstChild?.textContent).toContain('- Not a list')
    expect(codeBlockEditor.getMarkdown()).toContain('```ts')
    expect(codeBlockEditor.getMarkdown()).toContain('# Not a heading')
    expect(codeBlockEditor.getMarkdown()).toContain('- Not a list')

    const inlineCodeEditor = createTestWysiwygEditor('Use `foo` here')
    inlineCodeEditor.commands.setTextSelection(findTextPos(inlineCodeEditor, 'foo'))
    fireEvent.paste(inlineCodeEditor.view.dom, {
      clipboardData: createClipboardData({
        'text/html': '<b>IgnoredHtml</b>',
        'text/plain': '**notBold** # notHeading'
      })
    })

    let hasHeadingOrBold = false
    inlineCodeEditor.state.doc.descendants((node) => {
      if (node.type.name === 'heading' || node.marks.some((mark) => mark.type.name === 'bold')) {
        hasHeadingOrBold = true
      }
      return true
    })
    expect(hasHeadingOrBold).toBe(false)
    expect(inlineCodeEditor.getMarkdown()).toContain('`f**notBold** # notHeadingoo`')
    expect(inlineCodeEditor.getMarkdown()).not.toContain('IgnoredHtml')

    const inlineCodePasteRulesEditor = createTestWysiwygEditor('Use `foo` here')
    const fooStart = findTextPos(inlineCodePasteRulesEditor, 'foo') - 1
    inlineCodePasteRulesEditor.commands.setTextSelection({
      from: fooStart,
      to: fooStart + 'foo'.length
    })
    fireEvent.paste(inlineCodePasteRulesEditor.view.dom, {
      clipboardData: createClipboardData({
        'text/html': '<a href="https://evil.example">https://example.com</a>',
        'text/plain': '`bar` https://example.com'
      })
    })

    let hasLinkMark = false
    inlineCodePasteRulesEditor.state.doc.descendants((node) => {
      if (node.marks.some((mark) => mark.type.name === 'link')) {
        hasLinkMark = true
      }
      return true
    })
    expect(hasLinkMark).toBe(false)
    expect(inlineCodePasteRulesEditor.getMarkdown()).toContain('`` `bar` https://example.com ``')
  })

  it('ignores HTML-only external clipboards, strips unsafe-only payloads, preserves escaped Markdown, and handles block NodeSelections', () => {
    const htmlOnlyEditor = createTestWysiwygEditor('Keep')
    htmlOnlyEditor.commands.focus('end')
    fireEvent.paste(htmlOnlyEditor.view.dom, {
      clipboardData: createClipboardData({
        'text/html': '<b>Should be ignored</b>'
      })
    })
    expect(htmlOnlyEditor.getMarkdown()).toBe('Keep')

    const unsafeOnlyEditor = createTestWysiwygEditor('Safe')
    unsafeOnlyEditor.commands.focus('end')
    fireEvent.paste(unsafeOnlyEditor.view.dom, {
      clipboardData: createClipboardData({
        'text/plain': '<script>alert(1)</script>'
      })
    })
    expect(unsafeOnlyEditor.getMarkdown()).toBe('Safe')
    expect(unsafeOnlyEditor.state.doc.textContent).toBe('Safe')

    const escapedEditor = createTestWysiwygEditor('')
    escapedEditor.commands.setTextSelection(1)
    fireEvent.paste(escapedEditor.view.dom, {
      clipboardData: createClipboardData({
        'text/plain': '\\*literal\\*'
      })
    })
    expect(escapedEditor.getMarkdown()).toBe('\\*literal\\*')

    const hrEditor = createTestWysiwygEditor('---\n\nAfter')
    hrEditor.commands.setNodeSelection(0)
    fireEvent.paste(hrEditor.view.dom, {
      clipboardData: createClipboardData({
        'text/plain': '## Replaced'
      })
    })
    expect(hrEditor.state.doc.firstChild?.type.name).toBe('heading')
    expect(hrEditor.getMarkdown()).toContain('## Replaced')

    const selectionLinkEditor = createTestWysiwygEditor('Replace me')
    const replaceStart = findTextPos(selectionLinkEditor, 'Replace me') - 1
    selectionLinkEditor.commands.setTextSelection({
      from: replaceStart,
      to: replaceStart + 'Replace me'.length
    })
    fireEvent.paste(selectionLinkEditor.view.dom, {
      clipboardData: createClipboardData({
        'text/html': 'https://evil.example',
        'text/plain': 'https://example.com'
      })
    })
    expect(selectionLinkEditor.getMarkdown()).toBe('[https://example.com](https://example.com)')
    expect(selectionLinkEditor.getMarkdown()).not.toContain('Replace me')
    expect(selectionLinkEditor.getMarkdown()).not.toContain('evil.example')
  })
})

function dispatchCodeBlockKey(
  editor: Editor,
  key: 'Tab' | 'Enter',
  options: { shiftKey?: boolean } = {}
): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key,
    shiftKey: options.shiftKey ?? false,
    bubbles: true,
    cancelable: true
  })
  editor.view.dom.dispatchEvent(event)
  return event
}

function findCodeBlockContentStart(editor: Editor): number {
  let contentStart = -1
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === 'codeBlock') {
      contentStart = pos + 1
      return false
    }
    return true
  })
  return contentStart
}

describe('wysiwygMarkdown code block Tab / Shift+Tab / Enter indentation', () => {
  it('inserts 2 spaces on Tab for empty selection in empty, mid-line, and end-of-line positions', () => {
    const emptyEditor = createTestWysiwygEditor('```ts\n\n```')
    const emptyStart = findCodeBlockContentStart(emptyEditor)
    emptyEditor.commands.setTextSelection(emptyStart)
    const emptyEvent = dispatchCodeBlockKey(emptyEditor, 'Tab')
    expect(emptyEvent.defaultPrevented).toBe(true)
    expect(emptyEditor.state.doc.textContent).toBe('  ')
    expect(emptyEditor.state.selection.from).toBe(emptyStart + 2)

    const lineEditor = createTestWysiwygEditor('```ts\nconst x = 1\n```')
    const lineStart = findCodeBlockContentStart(lineEditor)
    lineEditor.commands.setTextSelection(lineStart + 'const'.length)
    dispatchCodeBlockKey(lineEditor, 'Tab')
    expect(lineEditor.state.doc.textContent).toBe('const   x = 1')
    expect(lineEditor.state.selection.from).toBe(lineStart + 'const  '.length)

    lineEditor.commands.setTextSelection(lineStart + 'const   x = 1'.length)
    dispatchCodeBlockKey(lineEditor, 'Tab')
    expect(lineEditor.state.doc.textContent).toBe('const   x = 1  ')
  })

  it('indents line start by 2 spaces on Tab for single-line partial selection and preserves selection', () => {
    const editor = createTestWysiwygEditor('```ts\nconst alpha = 1\n```')
    const start = findCodeBlockContentStart(editor)
    const selFrom = start + 'const '.length
    const selTo = selFrom + 'alpha'.length
    editor.commands.setTextSelection({ from: selFrom, to: selTo })

    const event = dispatchCodeBlockKey(editor, 'Tab')
    expect(event.defaultPrevented).toBe(true)
    expect(editor.state.doc.textContent).toBe('  const alpha = 1')
    expect(editor.state.selection.from).toBe(selFrom + 2)
    expect(editor.state.selection.to).toBe(selTo + 2)
    expect(
      editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to)
    ).toBe('alpha')
  })

  it('indents all spanned lines on Tab for multi-line selection, preserves direction, and excludes trailing col-0 line', () => {
    const editor = createTestWysiwygEditor('```ts\nline1\nline2\nline3\n```')
    const start = findCodeBlockContentStart(editor)
    // Backward selection spanning line1..line2
    const anchor = start + 'line1\nli'.length
    const head = start + 2
    editor.commands.setTextSelection({ from: anchor, to: head })

    dispatchCodeBlockKey(editor, 'Tab')
    expect(editor.state.doc.textContent).toBe('  line1\n  line2\nline3')
    expect(editor.state.selection.anchor).toBe(anchor + 4)
    expect(editor.state.selection.head).toBe(head + 2)

    // Selection ending at column 0 of line3 should not indent line3
    const editor2 = createTestWysiwygEditor('```ts\nline1\nline2\nline3\n```')
    const start2 = findCodeBlockContentStart(editor2)
    const from2 = start2
    const to2 = start2 + 'line1\nline2\n'.length
    editor2.commands.setTextSelection({ from: from2, to: to2 })

    dispatchCodeBlockKey(editor2, 'Tab')
    expect(editor2.state.doc.textContent).toBe('  line1\n  line2\nline3')
    expect(editor2.state.selection.from).toBe(from2 + 2)
    expect(editor2.state.selection.to).toBe(to2 + 4)
  })

  it('outdents up to 2 spaces or 1 tab on Shift+Tab for single caret and multi-line selection, and consumes event even at 0 indent', () => {
    const editor = createTestWysiwygEditor('```ts\n    a\n b\n\tc\nd\n```')
    const start = findCodeBlockContentStart(editor)
    const from = start + 2
    const to = start + '    a\n b\n\tc\nd'.length
    editor.commands.setTextSelection({ from, to })

    const event = dispatchCodeBlockKey(editor, 'Tab', { shiftKey: true })
    expect(event.defaultPrevented).toBe(true)
    expect(editor.state.doc.textContent).toBe('  a\nb\nc\nd')
    expect(editor.state.selection.from).toBe(start)
    expect(editor.state.selection.to).toBe(start + '  a\nb\nc\nd'.length)

    // Single caret at 0 indent still prevents default (does not blur)
    const noIndentEditor = createTestWysiwygEditor('```ts\nplain\n```')
    const noIndentStart = findCodeBlockContentStart(noIndentEditor)
    noIndentEditor.commands.setTextSelection(noIndentStart + 2)
    const noIndentEvent = dispatchCodeBlockKey(noIndentEditor, 'Tab', { shiftKey: true })
    expect(noIndentEvent.defaultPrevented).toBe(true)
    expect(noIndentEditor.state.doc.textContent).toBe('plain')
    expect(noIndentEditor.state.selection.from).toBe(noIndentStart + 2)
  })

  it('preserves leading spaces and tabs on Enter, copies only prefix before caret, replaces selection, and preserves exitOnTripleEnter', () => {
    const editor = createTestWysiwygEditor('```ts\n    const a = 1\n```')
    const start = findCodeBlockContentStart(editor)
    editor.commands.setTextSelection(start + '    const a = 1'.length)
    const enterEvent = dispatchCodeBlockKey(editor, 'Enter')
    expect(enterEvent.defaultPrevented).toBe(true)
    expect(editor.state.doc.textContent).toBe('    const a = 1\n    ')

    // Caret in the middle of leading spaces copies only spaces before caret
    const midIndentEditor = createTestWysiwygEditor('```ts\n    code\n```')
    const midStart = findCodeBlockContentStart(midIndentEditor)
    midIndentEditor.commands.setTextSelection(midStart + 2)
    dispatchCodeBlockKey(midIndentEditor, 'Enter')
    expect(midIndentEditor.state.doc.textContent).toBe('  \n    code')

    // Tab-indented line + range selection replacement
    const tabIndentEditor = createTestWysiwygEditor('```ts\n\tlet x = 1\n```')
    const tabStart = findCodeBlockContentStart(tabIndentEditor)
    tabIndentEditor.commands.setTextSelection({
      from: tabStart + '\tlet '.length,
      to: tabStart + '\tlet x'.length
    })
    dispatchCodeBlockKey(tabIndentEditor, 'Enter')
    expect(tabIndentEditor.state.doc.textContent).toBe('\tlet \n\t = 1')

    // No leading indent falls through to TipTap default Enter (exitOnTripleEnter)
    const exitEditor = createTestWysiwygEditor('```ts\nline1\n```')
    const exitStart = findCodeBlockContentStart(exitEditor)
    exitEditor.commands.setTextSelection(exitStart + 'line1'.length)
    dispatchCodeBlockKey(exitEditor, 'Enter')
    dispatchCodeBlockKey(exitEditor, 'Enter')
    dispatchCodeBlockKey(exitEditor, 'Enter')
    expect(exitEditor.state.doc.lastChild?.type.name).toBe('paragraph')
  })

  it('prioritizes code block Tab/Shift+Tab over nested list item indentation and roundtrips markdown', () => {
    const listWithCode = '- item\n\n  ```ts\n    const x = 1\n  ```'
    const editor = createTestWysiwygEditor(listWithCode)
    const codeStart = findCodeBlockContentStart(editor)
    expect(codeStart).toBeGreaterThan(0)
    editor.commands.setTextSelection(codeStart)

    const tabEvent = dispatchCodeBlockKey(editor, 'Tab')
    expect(tabEvent.defaultPrevented).toBe(true)
    expect(editor.state.doc.textBetween(codeStart, codeStart + 4)).toBe('    ')

    const shiftTabEvent = dispatchCodeBlockKey(editor, 'Tab', { shiftKey: true })
    expect(shiftTabEvent.defaultPrevented).toBe(true)
    expect(editor.getMarkdown()).toContain('  ```ts\n    const x = 1\n  ```')
  })

  it('leaves Tab, Shift+Tab, and Enter outside code blocks unaffected', () => {
    const editor = createTestWysiwygEditor('  paragraph')
    const pPos = findTextPos(editor, 'paragraph')
    editor.commands.setTextSelection(pPos + 'paragraph'.length)

    const tabEvent = dispatchCodeBlockKey(editor, 'Tab')
    expect(tabEvent.defaultPrevented).toBe(false)

    const enterEvent = dispatchCodeBlockKey(editor, 'Enter')
    expect(enterEvent.defaultPrevented).toBe(true)
    expect(editor.state.doc.childCount).toBe(2)
  })
})
