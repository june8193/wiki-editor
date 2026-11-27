import { describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import { buildFileLinkCandidates, buildHeadingLinkCandidates } from './LinkAutocompleteEngine'
import {
  applyWysiwygCtrlK,
  createWysiwygExtensions,
  detectProseMirrorLinkQuery,
  insertWysiwygLink
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

  it('insertWysiwygLink 는 [`심볼`] 코드 마크를 보존하고, []( 자동 채움과 커서 마크 이탈을 보장한다', () => {
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
      expect(insertWysiwygLink(editor, candidates[1], codeMatch)).toBe(true)

      editor.commands.insertContent(' 다음')
      expect(editor.getMarkdown()).toContain('[`parseMarkdownHeadings`](#parsemarkdownheadings) 다음')

      editor.commands.insertContent('\n\n[]()')
      const parenPos = getParagraphPosAtText(editor, '[]()')
      editor.commands.setTextSelection(parenPos + 3)
      const emptyMatch = detectProseMirrorLinkQuery(editor.state)!
      expect(insertWysiwygLink(editor, candidates[0], emptyMatch)).toBe(true)
      editor.commands.insertContent(' 확인')
      expect(editor.getMarkdown()).toContain('[개요](#11-개요) 확인')

      editor.commands.setContent(`${md}\n\n| 항목 | 링크 |\n| --- | --- |\n| row | cell |`, {
        contentType: 'markdown'
      })
      const tableCellPos = getParagraphPosAtText(editor, 'cell')
      editor.commands.setTextSelection({ from: tableCellPos, to: tableCellPos + 4 })
      editor.commands.insertContent('[](')
      const tableMatch = detectProseMirrorLinkQuery(editor.state)!
      expect(insertWysiwygLink(editor, candidates[2], tableMatch)).toBe(true)
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

  it('insertWysiwygLink 는 워크스페이스 파일 링크에 대해 라벨 보존, []( 확장자 제거 자동 채움, 인코딩 상대 경로 및 테이블 파이프 처리를 수행한다', () => {
    const fileCandidates = buildFileLinkCandidates(
      [
        {
          name: 'guide (1).md',
          path: 'C:\\wiki\\other\\guide (1).md',
          relativePath: 'other/guide (1).md',
          kind: 'file'
        },
        {
          name: 'A | B.markdown',
          path: 'C:\\wiki\\docs\\A | B.markdown',
          relativePath: 'docs/A | B.markdown',
          kind: 'file'
        }
      ],
      'C:\\wiki\\docs\\current.md'
    )
    const pipeCandidate = fileCandidates[0]
    const encodedCandidate = fileCandidates[1]
    const editor = createMarkdownEditor('')

    try {
      editor.commands.focus('end')
      editor.commands.insertContent('[참고 문서](../')
      const labeledMatch = detectProseMirrorLinkQuery(editor.state)!
      expect(insertWysiwygLink(editor, encodedCandidate, labeledMatch)).toBe(true)
      editor.commands.insertContent(' 뒤')
      expect(editor.getMarkdown()).toContain('[참고 문서](../other/guide%20%281%29.md) 뒤')

      editor.commands.insertContent('\n\n[]()')
      const parenPos = getParagraphPosAtText(editor, '[]()')
      editor.commands.setTextSelection(parenPos + 3)
      const emptyMatch = detectProseMirrorLinkQuery(editor.state)!
      expect(insertWysiwygLink(editor, encodedCandidate, emptyMatch)).toBe(true)
      editor.commands.insertContent(' 다음')
      expect(editor.getMarkdown()).toContain('[guide (1)](../other/guide%20%281%29.md) 다음')

      editor.commands.setContent('| 항목 | 링크 |\n| --- | --- |\n| row | cell |', {
        contentType: 'markdown'
      })
      const tableCellPos = getParagraphPosAtText(editor, 'cell')
      editor.commands.setTextSelection({ from: tableCellPos, to: tableCellPos + 4 })
      editor.commands.insertContent('[](')
      const tableMatch = detectProseMirrorLinkQuery(editor.state)!
      expect(insertWysiwygLink(editor, pipeCandidate, tableMatch)).toBe(true)
      expect(editor.getMarkdown()).toContain('[A \\| B](./A%20%7C%20B.markdown)')
    } finally {
      editor.destroy()
    }
  })

  it('[텍스트](URL) 입력 후 닫는 ) 를 타이핑하면 안전한 링크 마크로 즉시 변환되고 inclusive=false·비충돌 규칙을 지킨다', () => {
    const countLinkMarks = (editor: Editor): number => {
      let count = 0
      editor.state.doc.descendants((node) => {
        if (node.isText && node.marks.some((m) => m.type.name === 'link')) {
          count += 1
        }
        return true
      })
      return count
    }

    const typeText = (editor: Editor, text: string): void => {
      for (const ch of text) {
        const { from, to } = editor.state.selection
        const handled = editor.view.someProp('handleTextInput', (fn) =>
          fn(editor.view, from, to, ch, () => editor.state.tr.insertText(ch, from, to))
        )
        if (!handled) {
          editor.view.dispatch(editor.state.tr.insertText(ch, from, to))
        }
      }
    }

    const editor = createMarkdownEditor('')
    try {
      // 1) [텍스트](https://example.com) + 후속 타이핑에 링크 번짐 없음
      editor.commands.focus('end')
      typeText(editor, '[문서](https://example.com)')
      const linkPos = getParagraphPosAtText(editor, '문서')
      expect(linkPos).toBeGreaterThan(0)
      const linkMark = editor.state.doc
        .resolve(linkPos + 1)
        .marks()
        .find((m) => m.type.name === 'link')
      expect(linkMark?.attrs.href).toBe('https://example.com')

      typeText(editor, ' 뒤')
      expect(editor.getMarkdown()).toContain('[문서](https://example.com) 뒤')

      // 2) [텍스트](#섹션) 변환
      editor.commands.setContent('', { contentType: 'markdown' })
      editor.commands.focus('end')
      typeText(editor, '[섹션](#개요)')
      const secPos = getParagraphPosAtText(editor, '섹션')
      const secMark = editor.state.doc
        .resolve(secPos + 1)
        .marks()
        .find((m) => m.type.name === 'link')
      expect(secMark?.attrs.href).toBe('#개요')

      // 3) 위험 스킴(javascript:), 이미지 ![alt](...), 빈 라벨 [](), 인라인 코드, 코드 블록은 변환하지 않음
      editor.commands.setContent('', { contentType: 'markdown' })
      editor.commands.focus('end')
      typeText(editor, '[위험](javascript:alert(1)) ')
      typeText(editor, '![이미지](https://example.com/a.png) ')
      typeText(editor, '[](https://example.com) ')
      typeText(editor, '`[코드](https://example.com)`')
      expect(countLinkMarks(editor)).toBe(0)

      editor.commands.setContent('```md\n\n```', { contentType: 'markdown' })
      const cbPos = getParagraphPosAtText(editor, '')
      editor.commands.setTextSelection(cbPos > 0 ? cbPos : 1)
      typeText(editor, '[블록](https://example.com)')
      expect(countLinkMarks(editor)).toBe(0)

      // 4) Ctrl+K 로 [라벨]( 삽입 후 외부 URL과 ) 입력 시에도 링크 마크로 변환된다
      editor.commands.setContent('참고', { contentType: 'markdown' })
      const refPos = getParagraphPosAtText(editor, '참고')
      editor.commands.setTextSelection({ from: refPos, to: refPos + 2 })
      expect(applyWysiwygCtrlK(editor)).toBe(true)
      typeText(editor, 'https://example.com/k)')
      expect(editor.getMarkdown()).toContain('[참고](https://example.com/k)')
    } finally {
      editor.destroy()
    }
  })
})
