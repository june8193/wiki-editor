import { Editor } from '@tiptap/core'
import { buildWikiAssetUrl } from '@shared/assets'
import type { CustomCommandConfig } from '@shared/config'
import { afterEach, describe, expect, it } from 'vitest'
import {
  addTableRowBeforeSafely,
  createWysiwygExtensions,
  deleteTableRowPreservingHeader,
  detectProseMirrorSlashQuery,
  extractWysiwygHeadingCandidates,
  insertWysiwygImages,
  insertWysiwygMarkdownWithCursor,
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

  it('preserves <!-- toc --> / <!-- /toc --> markers across WYSIWYG roundtrips while still sanitizing unsafe HTML comments/scripts', () => {
    const sample = [
      '# Guide',
      '',
      '<!-- toc -->',
      '- [Section](#section)',
      '<!-- /toc -->',
      '',
      '<!-- <script>alert(1)</script> -->',
      '<img src="x" onerror="alert(2)">',
      '',
      '## Section'
    ].join('\n')

    const editor = createTestWysiwygEditor(sample)
    const exported = editor.getMarkdown()
    editor.destroy()

    expect(exported).toContain('<!-- toc -->')
    expect(exported).toContain('<!-- /toc -->')
    expect(exported).toContain('- [Section](#section)')
    expect(exported).not.toContain('script')
    expect(exported).not.toContain('onerror')
  })

  it('detects ProseMirror slash queries outside code/URLs and inserts sanitized markdown with {{cursor}} placement', () => {
    const editor = createTestWysiwygEditor('# Guide\n\n/fun')
    const endOfPara = editor.state.doc.content.size - 1
    editor.commands.setTextSelection(endOfPara)

    const match = detectProseMirrorSlashQuery(editor.state)
    expect(match).not.toBeNull()
    expect(match?.query).toBe('fun')

    const cmd: CustomCommandConfig = {
      trigger: 'function',
      label: 'Function',
      template:
        '### Function: {{cursor}}()\n\n<script>alert(1)</script>Title: {{title}} ({{date}})\n[bad](javascript:alert(1))'
    }

    const applied = insertWysiwygMarkdownWithCursor(editor, cmd, match!, {
      title: 'arch-doc',
      date: '2026-11-14'
    })
    expect(applied).toBe(true)

    // Typing right after insertion lands at {{cursor}}
    editor.commands.insertContent('runTask')
    const md = editor.getMarkdown()
    expect(md).toContain('### Function: runTask()')
    expect(md).toContain('Title: arch-doc (2026-11-14)')
    expect(md).not.toContain('<script>')
    expect(md).not.toContain('javascript:')
    expect(md).not.toContain('WIKICURSOR')
    expect(md).not.toContain('/fun')

    // Code block and URL prefixes do NOT match slash queries
    const fencedEditor = createTestWysiwygEditor('```ts\n/fun\n```\n\nhttps://')
    const insideCodePos = findTextPos(fencedEditor, '/fun') + 3
    fencedEditor.commands.setTextSelection(insideCodePos)
    expect(detectProseMirrorSlashQuery(fencedEditor.state)).toBeNull()

    const urlEndPos = fencedEditor.state.doc.content.size - 1
    fencedEditor.commands.setTextSelection(urlEndPos)
    expect(detectProseMirrorSlashQuery(fencedEditor.state)).toBeNull()
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
  afterEach(() => {
    while (createdEditors.length > 0) {
      const editor = createdEditors.pop()!
      if (!editor.isDestroyed) {
        editor.destroy()
      }
    }
  })

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
