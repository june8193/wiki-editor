import { describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import { buildHeadingLinkCandidates } from './LinkAutocompleteEngine'
import {
  applyWysiwygCtrlK,
  createWysiwygExtensions,
  detectProseMirrorLinkQuery,
  insertWysiwygSectionLink
} from './wysiwygMarkdown'

function createMarkdownEditor(markdown = ''): Editor {
  return new Editor({
    extensions: createWysiwygExtensions(),
    content: markdown,
    contentType: 'markdown'
  })
}

function getParagraphPosAtText(editor: Editor, snippet: string): number {
  let found = -1
  editor.state.doc.descendants((node, pos) => {
    if (found === -1 && node.isText && node.text?.includes(snippet)) {
      found = pos + node.text.indexOf(snippet)
      return false
    }
    return true
  })
  return found
}

describe('wysiwygMarkdown link extensions & helpers', () => {
  it('Code 와 Link 마크가 공존하고 Link 마크는 inclusive=false 로 동작한다', () => {
    const editor = createMarkdownEditor('# API\n\n[`sym`](#api) and [plain](#api) text')
    try {
      expect(editor.getMarkdown()).toContain('[`sym`](#api) and [plain](#api) text')

      const linkPos = getParagraphPosAtText(editor, 'sym')
      expect(linkPos).toBeGreaterThan(0)
      const $pos = editor.state.doc.resolve(linkPos + 1)
      const markNames = $pos.marks().map((m) => m.type.name)
      expect(markNames).toContain('code')
      expect(markNames).toContain('link')

      const plainPos = getParagraphPosAtText(editor, 'plain')
      editor.commands.setTextSelection(plainPos + 'plain'.length)
      editor.commands.insertContent('!')
      expect(editor.getMarkdown()).toContain('[plain](#api)! text')
    } finally {
      editor.destroy()
    }
  })

  it('detectProseMirrorLinkQuery 는 [텍스트](, [](, [`심볼`](, 테이블 셀을 감지하고 코드블록/이미지/닫힌괄호/외부URL은 제외한다', () => {
    const editor = createMarkdownEditor('# 개요\n\n본문')
    try {
      const endPos = editor.state.doc.content.size - 1
      editor.commands.setTextSelection(endPos)
      editor.commands.insertContent(' [개요](#개')
      const match = detectProseMirrorLinkQuery(editor.state)
      expect(match?.label).toBe('개요')
      expect(match?.query).toBe('#개')

      editor.commands.setContent('본문 [](', { contentType: 'markdown' })
      editor.commands.focus('end')
      expect(detectProseMirrorLinkQuery(editor.state)?.label).toBe('')

      editor.commands.setContent('', { contentType: 'markdown' })
      editor.commands.focus('end')
      editor.commands.insertContent('[')
      editor.commands.toggleCode()
      editor.commands.insertContent('심볼')
      editor.commands.toggleCode()
      editor.commands.insertContent('](')
      const codeMatch = detectProseMirrorLinkQuery(editor.state)
      expect(codeMatch?.label).toBe('`심볼`')
      expect(codeMatch?.query).toBe('')

      editor.commands.setContent('| 항목 | 링크 |\n| --- | --- |\n| test | \\[]( |', {
        contentType: 'markdown'
      })
      const cellPos = getParagraphPosAtText(editor, '[](')
      editor.commands.setTextSelection(cellPos + 3)
      expect(detectProseMirrorLinkQuery(editor.state)?.label).toBe('')

      editor.commands.setContent('![alt](', { contentType: 'markdown' })
      editor.commands.focus('end')
      expect(detectProseMirrorLinkQuery(editor.state)).toBeNull()

      editor.commands.setContent('`unclosed [a](', { contentType: 'markdown' })
      editor.commands.focus('end')
      expect(detectProseMirrorLinkQuery(editor.state)).toBeNull()

      editor.commands.setContent('[a](https://example.com', { contentType: 'markdown' })
      editor.commands.focus('end')
      expect(detectProseMirrorLinkQuery(editor.state)).toBeNull()

      editor.commands.setContent('```md\n[a](\n```', { contentType: 'markdown' })
      const codeBlockPos = getParagraphPosAtText(editor, '[a](')
      editor.commands.setTextSelection(codeBlockPos + 4)
      expect(detectProseMirrorLinkQuery(editor.state)).toBeNull()
    } finally {
      editor.destroy()
    }
  })

  it('insertWysiwygSectionLink 는 [`심볼`] 코드 마크를 보존하고, []( 자동 채움과 커서 마크 이탈을 보장한다', () => {
    const md = ['# 1.1. 개요', '', '## `parseMarkdownHeadings`', '', '## A | B 표기'].join('\n')
    const candidates = buildHeadingLinkCandidates(md)
    const editor = createMarkdownEditor(md)

    try {
      editor.commands.setContent(`${md}\n\n`, { contentType: 'markdown' })
      editor.commands.focus('end')
      editor.commands.insertContent('[')
      editor.commands.toggleCode()
      editor.commands.insertContent('parseMarkdownHeadings')
      editor.commands.toggleCode()
      editor.commands.insertContent('](')

      const codeMatch = detectProseMirrorLinkQuery(editor.state)!
      expect(codeMatch).not.toBeNull()
      expect(insertWysiwygSectionLink(editor, candidates[1], codeMatch)).toBe(true)

      editor.commands.insertContent(' 다음')
      expect(editor.getMarkdown()).toContain('[`parseMarkdownHeadings`](#parsemarkdownheadings) 다음')

      editor.commands.insertContent('\n\n[]()')
      const parenPos = getParagraphPosAtText(editor, '[]()')
      editor.commands.setTextSelection(parenPos + 3)
      const emptyMatch = detectProseMirrorLinkQuery(editor.state)!
      expect(insertWysiwygSectionLink(editor, candidates[0], emptyMatch)).toBe(true)
      editor.commands.insertContent(' 확인')
      expect(editor.getMarkdown()).toContain('[개요](#11-개요) 확인')

      editor.commands.setContent(`${md}\n\n| 항목 | 링크 |\n| --- | --- |\n| row | cell |`, {
        contentType: 'markdown'
      })
      const tableCellPos = getParagraphPosAtText(editor, 'cell')
      editor.commands.setTextSelection({ from: tableCellPos, to: tableCellPos + 4 })
      editor.commands.insertContent('[](')
      const tableMatch = detectProseMirrorLinkQuery(editor.state)!
      expect(insertWysiwygSectionLink(editor, candidates[2], tableMatch)).toBe(true)
      expect(editor.getMarkdown()).toContain('[A \\| B 표기](#a-b-표기)')
    } finally {
      editor.destroy()
    }
  })

  it('applyWysiwygCtrlK 는 선택 감싸기(코드 마크 보존), 빈 커서 삽입, 기존 링크 1회 언두 가능 언랩, 다중줄/코드블록 무시를 수행한다', () => {
    const editor = createMarkdownEditor('첫째 줄 `심볼` 끝\n\n둘째 줄')
    try {
      const symPos = getParagraphPosAtText(editor, '심볼')
      editor.commands.setTextSelection({ from: symPos, to: symPos + '심볼'.length })
      expect(applyWysiwygCtrlK(editor)).toBe(true)
      const wrapMatch = detectProseMirrorLinkQuery(editor.state)
      expect(wrapMatch?.label).toBe('`심볼`')

      editor.commands.setContent('문단 [기존](https://old.dev) 뒤', { contentType: 'markdown' })
      const linkStart = getParagraphPosAtText(editor, '기존')
      editor.commands.setTextSelection(linkStart + 1)
      expect(applyWysiwygCtrlK(editor)).toBe(true)
      const unwrappedMatch = detectProseMirrorLinkQuery(editor.state)
      expect(unwrappedMatch?.label).toBe('기존')
      expect(unwrappedMatch?.query).toBe('')

      editor.commands.undo()
      expect(editor.getMarkdown()).toContain('[기존](https://old.dev)')

      editor.commands.setContent('빈 커서', { contentType: 'markdown' })
      editor.commands.focus('end')
      expect(applyWysiwygCtrlK(editor)).toBe(true)
      expect(detectProseMirrorLinkQuery(editor.state)?.label).toBe('')

      editor.commands.setContent('첫째\n\n둘째', { contentType: 'markdown' })
      const firstPos = getParagraphPosAtText(editor, '첫째')
      const secondPos = getParagraphPosAtText(editor, '둘째')
      editor.commands.setTextSelection({ from: firstPos, to: secondPos + 2 })
      expect(applyWysiwygCtrlK(editor)).toBe(false)

      editor.commands.setContent('```ts\nconst x = 1\n```', { contentType: 'markdown' })
      const cbPos = getParagraphPosAtText(editor, 'const')
      editor.commands.setTextSelection(cbPos)
      expect(applyWysiwygCtrlK(editor)).toBe(false)
    } finally {
      editor.destroy()
    }
  })
})
