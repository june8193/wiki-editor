import { describe, expect, it } from 'vitest'
import type { WorkspaceEntry } from '@shared/workspace'
import {
  buildFileLinkCandidates,
  buildHeadingLinkCandidates,
  buildRawLinkEdit,
  computeRelativeMarkdownHref,
  detectLinkQuery,
  encodeMarkdownPathSegment,
  filterAndRankLinkCandidates,
  type LinkCandidate
} from './LinkAutocompleteEngine'

describe('detectLinkQuery', () => {
  it('빈 레이블 []( 및 일반 레이블 [텍스트]( 입력을 감지한다', () => {
    const emptyText = '본문 []('
    expect(detectLinkQuery(emptyText, emptyText.length)).toEqual({
      label: '',
      query: '',
      rangeFrom: 3,
      rangeTo: 6
    })

    const labeledText = '참고: [API 가이드](#api'
    expect(detectLinkQuery(labeledText, labeledText.length)).toEqual({
      label: 'API 가이드',
      query: '#api',
      rangeFrom: 4,
      rangeTo: labeledText.length
    })
  })

  it('인라인 코드가 완전히 닫힌 [`심볼`]( 패턴을 감지한다', () => {
    const text = '설명 [`parseMarkdownHeadings`](parse'
    expect(detectLinkQuery(text, text.length)).toEqual({
      label: '`parseMarkdownHeadings`',
      query: 'parse',
      rangeFrom: 3,
      rangeTo: text.length
    })
  })

  it('커서 바로 뒤에 )가 남아 있는 [텍스트](|) 상태도 감지한다', () => {
    const text = '링크 [개요]() 끝'
    const cursor = '링크 [개요]('.length
    expect(detectLinkQuery(text, cursor)).toEqual({
      label: '개요',
      query: '',
      rangeFrom: 3,
      rangeTo: cursor
    })
  })

  it('중첩 대괄호에서는 가장 안쪽 [를 링크 시작으로 잡는다', () => {
    const text = '[outer [inner](sec'
    expect(detectLinkQuery(text, text.length)).toEqual({
      label: 'inner',
      query: 'sec',
      rangeFrom: 7,
      rangeTo: text.length
    })
  })

  it('CRLF 줄바꿈 뒤에서도 정확한 오프셋을 계산한다', () => {
    const text = '# 제목\r\n본문 [섹션](#sec'
    expect(detectLinkQuery(text, text.length)).toEqual({
      label: '섹션',
      query: '#sec',
      rangeFrom: 9,
      rangeTo: text.length
    })
  })

  it('이미지 문법 ![alt]( 와 이스케이프된 \\[text]( 및 \\![alt]( 규칙을 구분한다', () => {
    const img = '![alt]('
    expect(detectLinkQuery(img, img.length)).toBeNull()

    const escapedBangImg = '\\![alt]('
    expect(detectLinkQuery(escapedBangImg, escapedBangImg.length)).toEqual({
      label: 'alt',
      query: '',
      rangeFrom: 2,
      rangeTo: escapedBangImg.length
    })

    const doubleEscapedImg = '\\\\![alt]('
    expect(detectLinkQuery(doubleEscapedImg, doubleEscapedImg.length)).toBeNull()

    const escapedBracket = '\\[text]('
    expect(detectLinkQuery(escapedBracket, escapedBracket.length)).toBeNull()
  })

  it('펜스드 코드 블록과 닫히지 않은 인라인 코드 백틱 내부에서는 감지하지 않는다', () => {
    const fenced = '```md\n[링크](\n```'
    const insideCursor = '```md\n[링크]('.length
    expect(detectLinkQuery(fenced, insideCursor)).toBeNull()

    const unclosedBefore = '`코드 [링크]('
    expect(detectLinkQuery(unclosedBefore, unclosedBefore.length)).toBeNull()

    const unclosedInLabel = '[`심볼]('
    expect(detectLinkQuery(unclosedInLabel, unclosedInLabel.length)).toBeNull()

    const multiBacktickUnclosed = '``코드 ` [링크]('
    expect(detectLinkQuery(multiBacktickUnclosed, multiBacktickUnclosed.length)).toBeNull()

    const closedBefore = '`done` [링크]('
    expect(detectLinkQuery(closedBefore, closedBefore.length)).toEqual({
      label: '링크',
      query: '',
      rangeFrom: 7,
      rangeTo: closedBefore.length
    })
  })

  it('공백, 줄바꿈, 닫는 괄호, 외부 URL 스킴 입력 시 감지하지 않는다', () => {
    expect(detectLinkQuery('[a](foo ', '[a](foo '.length)).toBeNull()
    expect(detectLinkQuery('[a](foo\n', '[a](foo\n'.length)).toBeNull()
    expect(detectLinkQuery('[a](foo)', '[a](foo)'.length)).toBeNull()
    expect(detectLinkQuery('[a](http:', '[a](http:'.length)).toBeNull()
    expect(detectLinkQuery('[a](HTTPS://example.com', '[a](HTTPS://example.com'.length)).toBeNull()
    expect(detectLinkQuery('[a](MailTo:a@b.c', '[a](MailTo:a@b.c'.length)).toBeNull()
    expect(detectLinkQuery('[a](http', '[a](http'.length)).toEqual({
      label: 'a',
      query: 'http',
      rangeFrom: 0,
      rangeTo: 8
    })
  })
})

describe('buildHeadingLinkCandidates & filterAndRankLinkCandidates', () => {
  const sampleMarkdown = [
    '# 1.1. 개요',
    '## API 가이드',
    '### `parseMarkdownHeadings`',
    '## 전체 개요 및 비교',
    '## A | B 표기',
    '## API'
  ].join('\n')

  it('parseMarkdownHeadings 기반으로 문서 헤딩 후보를 만들고 선행 번호가 제거된 title과 slug를 보관한다', () => {
    const candidates = buildHeadingLinkCandidates(sampleMarkdown)
    expect(candidates.map((c) => ({ title: c.title, slug: c.slug }))).toEqual([
      { title: '개요', slug: '11-개요' },
      { title: 'API 가이드', slug: 'api-가이드' },
      { title: 'parseMarkdownHeadings', slug: 'parsemarkdownheadings' },
      { title: '전체 개요 및 비교', slug: '전체-개요-및-비교' },
      { title: 'A | B 표기', slug: 'a-b-표기' },
      { title: 'API', slug: 'api' }
    ])
  })

  it('빈 쿼리에서 []( 는 문서 순서를 유지하고, [텍스트]( 는 일치 헤딩(정확 -> 접두 -> 부분, 인라인 마크다운 제거, 대소문자 무시)을 상단에 우선 배치한다', () => {
    const candidates = buildHeadingLinkCandidates(sampleMarkdown)

    expect(filterAndRankLinkCandidates(candidates, '', '').map((c) => c.title)).toEqual([
      '개요',
      'API 가이드',
      'parseMarkdownHeadings',
      '전체 개요 및 비교',
      'A | B 표기',
      'API'
    ])

    expect(filterAndRankLinkCandidates(candidates, 'api', '').map((c) => c.title)).toEqual([
      'API',
      'API 가이드',
      '개요',
      'parseMarkdownHeadings',
      '전체 개요 및 비교',
      'A | B 표기'
    ])

    expect(filterAndRankLinkCandidates(candidates, '개요', '#').map((c) => c.title)).toEqual([
      '개요',
      '전체 개요 및 비교',
      'API 가이드',
      'parseMarkdownHeadings',
      'A | B 표기',
      'API'
    ])

    expect(
      filterAndRankLinkCandidates(candidates, '`parseMarkdownHeadings`', '').map((c) => c.title)[0]
    ).toBe('parseMarkdownHeadings')
  })

  it('# 접두사 유무와 무관하게 ( 뒤 쿼리로 실시간 필터링한다', () => {
    const candidates = buildHeadingLinkCandidates(sampleMarkdown)

    expect(filterAndRankLinkCandidates(candidates, '참고', '#api').map((c) => c.title)).toEqual([
      'API',
      'API 가이드'
    ])
    expect(filterAndRankLinkCandidates(candidates, '', '개요').map((c) => c.title)).toEqual([
      '개요',
      '전체 개요 및 비교'
    ])
    expect(filterAndRankLinkCandidates(candidates, '', '없음')).toEqual([])
  })
})

describe('buildRawLinkEdit (sections)', () => {
  it('사용자 입력 [텍스트] 및 [`심볼`] 을 그대로 유지하고 커서 직후 ) 가 있으면 중복 닫기 없이 치환한다', () => {
    const md = '# 1.1. 개요\n\n참고 [`parseMarkdownHeadings`](|) 끝\n## `parseMarkdownHeadings`'
    const cursor = md.indexOf('|)')
    const cleaned = md.replace('|)', ')')
    const match = detectLinkQuery(cleaned, cursor)!
    const candidate = buildHeadingLinkCandidates(cleaned)[1]

    const edit = buildRawLinkEdit(cleaned, match, candidate)
    expect(edit).toEqual({
      from: cleaned.indexOf('[`parseMarkdownHeadings`]'),
      to: cleaned.indexOf(')') + 1,
      text: '[`parseMarkdownHeadings`](#parsemarkdownheadings)',
      cursorOffset:
        cleaned.indexOf('[`parseMarkdownHeadings`]') +
        '[`parseMarkdownHeadings`](#parsemarkdownheadings)'.length
    })
  })

  it('빈 레이블 []( 완성 시 선행 번호 제거 제목으로 채우고 테이블 셀 내부에서는 | 를 \\| 로 이스케이프한다', () => {
    const md = '# 1.1. 개요\n\n## A | B 표기\n\n| 항목 | 링크 |\n| --- | --- |\n| test | []( |'
    const docBeforePipe = md.slice(0, md.lastIndexOf(' |'))
    const match = detectLinkQuery(md, docBeforePipe.length)!
    const candidates = buildHeadingLinkCandidates(md)

    const editHeading1 = buildRawLinkEdit(md, match, candidates[0])
    expect(editHeading1.text).toBe('[개요](#11-개요)')

    const editPipeHeading = buildRawLinkEdit(md, match, candidates[1])
    expect(editPipeHeading.text).toBe('[A \\| B 표기](#a-b-표기)')
  })
})

describe('encodeMarkdownPathSegment, computeRelativeMarkdownHref & buildFileLinkCandidates', () => {
  it('경로 세그먼트 내 공백/괄호/특수문자를 percent-encode 하고 한글 등 일반 유니코드는 가독성을 위해 유지한다', () => {
    expect(encodeMarkdownPathSegment('my (guide) #1?.md')).toBe('my%20%28guide%29%20%231%3F.md')
    expect(encodeMarkdownPathSegment('가이드 [v1]%20.md')).toBe('가이드%20%5Bv1%5D%2520.md')
    expect(encodeMarkdownPathSegment('가이드.md')).toBe('가이드.md')
  })

  it('현재 활성 문서 폴더 기준 POSIX 상대 경로(./, ./sub/, ../)를 계산한다', () => {
    expect(
      computeRelativeMarkdownHref('C:\\wiki\\docs\\a.md', {
        path: 'C:\\wiki\\docs\\b.md',
        relativePath: 'docs/b.md'
      })
    ).toBe('./b.md')

    expect(
      computeRelativeMarkdownHref('c:/wiki/root.md', {
        path: 'C:\\Wiki\\docs\\api\\spec.markdown',
        relativePath: 'docs/api/spec.markdown'
      })
    ).toBe('./docs/api/spec.markdown')

    expect(
      computeRelativeMarkdownHref('/wiki/docs/api/spec.md', {
        path: '/wiki/root.md',
        relativePath: 'root.md'
      })
    ).toBe('../../root.md')

    expect(
      computeRelativeMarkdownHref('C:\\wiki\\guides\\start.md', {
        path: 'C:\\wiki\\my docs\\note (1).md',
        relativePath: 'my docs/note (1).md'
      })
    ).toBe('../my%20docs/note%20%281%29.md')

    expect(
      computeRelativeMarkdownHref(null, {
        path: 'C:\\wiki\\docs\\guide.md',
        relativePath: 'docs/guide.md'
      })
    ).toBe('./docs/guide.md')
  })

  it('현재 활성 문서를 제외하고 relativePath 오름차순으로 FileLinkCandidate 목록을 생성한다', () => {
    const entries: WorkspaceEntry[] = [
      {
        name: 'active.md',
        path: 'C:\\Wiki\\docs\\active.md',
        relativePath: 'docs/active.md',
        kind: 'file'
      },
      {
        name: 'zebra.MarkDown',
        path: 'C:\\Wiki\\zebra.MarkDown',
        relativePath: 'zebra.MarkDown',
        kind: 'file'
      },
      {
        name: 'guide (2).MD',
        path: 'C:\\Wiki\\docs\\sub\\guide (2).MD',
        relativePath: 'docs/sub/guide (2).MD',
        kind: 'file'
      },
      {
        name: 'image.png',
        path: 'C:\\Wiki\\docs\\image.png',
        relativePath: 'docs/image.png',
        kind: 'file'
      },
      {
        name: 'sub',
        path: 'C:\\Wiki\\docs\\sub',
        relativePath: 'docs/sub',
        kind: 'directory'
      }
    ]

    expect(buildFileLinkCandidates(entries, 'c:/wiki/docs/ACTIVE.md')).toEqual([
      {
        kind: 'file',
        id: 'file:docs/sub/guide (2).MD',
        name: 'guide (2).MD',
        path: 'C:\\Wiki\\docs\\sub\\guide (2).MD',
        relativePath: 'docs/sub/guide (2).MD',
        href: './sub/guide%20%282%29.MD',
        displayName: 'guide (2)'
      },
      {
        kind: 'file',
        id: 'file:zebra.MarkDown',
        name: 'zebra.MarkDown',
        path: 'C:\\Wiki\\zebra.MarkDown',
        relativePath: 'zebra.MarkDown',
        href: '../zebra.MarkDown',
        displayName: 'zebra'
      }
    ])
  })
})

describe('filterAndRankLinkCandidates & buildRawLinkEdit (headings + workspace files)', () => {
  const sampleMarkdown = [
    '# 개요',
    '## API',
    '## `Setup Guide`'
  ].join('\n')

  const activeFilePath = 'C:\\wiki\\docs\\current.md'
  const workspaceFiles: WorkspaceEntry[] = [
    {
      name: 'intro.md',
      path: 'C:\\wiki\\docs\\intro.md',
      relativePath: 'docs/intro.md',
      kind: 'file'
    },
    {
      name: 'api.markdown',
      path: 'C:\\wiki\\docs\\sub\\api.markdown',
      relativePath: 'docs/sub/api.markdown',
      kind: 'file'
    },
    {
      name: 'sub-note.md',
      path: 'C:\\wiki\\other\\sub\\sub-note.md',
      relativePath: 'other/sub/sub-note.md',
      kind: 'file'
    },
    {
      name: 'setup (1).md',
      path: 'C:\\wiki\\root\\setup (1).md',
      relativePath: 'root/setup (1).md',
      kind: 'file'
    }
  ]

  const buildMixedCandidates = (): LinkCandidate[] => [
    ...buildHeadingLinkCandidates(sampleMarkdown),
    ...buildFileLinkCandidates(workspaceFiles, activeFilePath)
  ]

  it('빈 쿼리 []( 는 현재 문서 헤딩 후 relativePath 순 파일 목록을 반환하고, [label]( 는 양쪽 일치를 최상단에 올린다', () => {
    const candidates = buildMixedCandidates()

    expect(filterAndRankLinkCandidates(candidates, '', '').map((c) => c.id)).toEqual([
      'heading:1:개요',
      'heading:2:api',
      'heading:3:setup-guide',
      'file:docs/intro.md',
      'file:docs/sub/api.markdown',
      'file:other/sub/sub-note.md',
      'file:root/setup (1).md'
    ])

    // [api]( -> exact heading beats exact displayName file; remaining headings -> remaining files
    expect(filterAndRankLinkCandidates(candidates, 'api', '').map((c) => c.id)).toEqual([
      'heading:2:api',
      'file:docs/sub/api.markdown',
      'heading:1:개요',
      'heading:3:setup-guide',
      'file:docs/intro.md',
      'file:other/sub/sub-note.md',
      'file:root/setup (1).md'
    ])
  })

  it('# 접두사는 헤딩만, ./ 와 ../ 접두사는 해당 상대 경로 방향의 파일만 필터링한다', () => {
    const candidates = buildMixedCandidates()

    expect(filterAndRankLinkCandidates(candidates, '개요', '#').map((c) => c.id)).toEqual([
      'heading:1:개요',
      'heading:2:api',
      'heading:3:setup-guide'
    ])
    expect(filterAndRankLinkCandidates(candidates, '', '#api').map((c) => c.id)).toEqual([
      'heading:2:api'
    ])

    // ./ excludes ../ files and headings
    expect(filterAndRankLinkCandidates(candidates, 'sub', './').map((c) => c.id)).toEqual([
      'file:docs/sub/api.markdown',
      'file:docs/intro.md'
    ])
    // ./sub must NOT accidentally match ../other/sub/sub-note.md
    expect(filterAndRankLinkCandidates(candidates, '', './sub').map((c) => c.id)).toEqual([
      'file:docs/sub/api.markdown'
    ])
    // ../ only returns parent/sibling files
    expect(filterAndRankLinkCandidates(candidates, '', '../').map((c) => c.id)).toEqual([
      'file:other/sub/sub-note.md',
      'file:root/setup (1).md'
    ])
    expect(filterAndRankLinkCandidates(candidates, '', '../other').map((c) => c.id)).toEqual([
      'file:other/sub/sub-note.md'
    ])
  })

  it('일반 쿼리는 헤딩과 파일을 통합 필터링·랭킹하고 일치 항목이 없으면 빈 배열을 반환한다', () => {
    const candidates = buildMixedCandidates()

    // 'intro' matches exact displayName 'intro.md' even though headings exist
    expect(filterAndRankLinkCandidates(candidates, '', 'intro').map((c) => c.id)).toEqual([
      'file:docs/intro.md'
    ])
    // 'api' matches both heading 'API' and file 'api.markdown', heading wins tie
    expect(filterAndRankLinkCandidates(candidates, '', 'api').map((c) => c.id)).toEqual([
      'heading:2:api',
      'file:docs/sub/api.markdown'
    ])
    expect(filterAndRankLinkCandidates(candidates, '', 'nonexistent')).toEqual([])
  })

  it('buildRawLinkEdit 로 파일 링크 완성 시 사용자 레이블 유지, 빈 레이블 자동 채움, 인코딩 경로, 테이블 파이프 이스케이프를 처리한다', () => {
    const candidates = buildFileLinkCandidates(
      [
        {
          name: 'A | B.markdown',
          path: 'C:\\wiki\\docs\\A | B.markdown',
          relativePath: 'docs/A | B.markdown',
          kind: 'file'
        },
        {
          name: 'guide (1).md',
          path: 'C:\\wiki\\other\\guide (1).md',
          relativePath: 'other/guide (1).md',
          kind: 'file'
        }
      ],
      activeFilePath
    )
    const tablePipeCandidate = candidates[0]
    const siblingEncodedCandidate = candidates[1]

    const labeledDoc = '참고: [내 문서](|)'
    const labeledMatch = detectLinkQuery(labeledDoc.replace('|)', ')'), labeledDoc.indexOf('|)'))!
    const labeledEdit = buildRawLinkEdit(
      labeledDoc.replace('|)', ')'),
      labeledMatch,
      siblingEncodedCandidate
    )
    expect(labeledEdit.text).toBe('[내 문서](../other/guide%20%281%29.md)')

    const emptyDoc = '바로가기 []('
    const emptyMatch = detectLinkQuery(emptyDoc, emptyDoc.length)!
    expect(buildRawLinkEdit(emptyDoc, emptyMatch, siblingEncodedCandidate).text).toBe(
      '[guide (1)](../other/guide%20%281%29.md)'
    )

    const tableDoc = '| 이름 | 링크 |\n| --- | --- |\n| doc | []( |'
    const tableMatch = detectLinkQuery(tableDoc, tableDoc.lastIndexOf(' |'))!
    expect(buildRawLinkEdit(tableDoc, tableMatch, tablePipeCandidate).text).toBe(
      '[A \\| B](./A%20%7C%20B.markdown)'
    )
  })
})
