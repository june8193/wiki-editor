import { describe, expect, it } from 'vitest'
import manualMarkdown from '../../../../docs/manual.md?raw'
import { filterManualDocument, parseManualDocument } from './manualDocument'

const SAMPLE_MANUAL = `# Wiki Editor 사용자 매뉴얼

> 플랫폼 안내

## 단축키 모음

### 앱 · 탐색

| 단축키 | 동작 |
| --- | --- |
| Ctrl+O | 폴더 열기 |

### 에디터

| 단축키 | 동작 |
| --- | --- |
| Ctrl+S | 저장 |

## Mermaid 다이어그램

\`\`\`markdown
## 코드 블록 안의 가짜 헤딩
\`\`\`

다이어그램을 Ctrl+휠로 확대할 수 있습니다.

## Git 버전 관리

### 스테이징

변경 파일을 스테이징합니다.
`

describe('parseManualDocument', () => {
  it('extracts h2/h3 TOC items with slugs and ignores headings inside fenced code blocks', () => {
    const parsed = parseManualDocument(SAMPLE_MANUAL)

    expect(parsed.tocItems.map((item) => ({ level: item.level, title: item.title, slug: item.slug }))).toEqual([
      { level: 2, title: '단축키 모음', slug: '단축키-모음' },
      { level: 3, title: '앱 · 탐색', slug: '앱-탐색' },
      { level: 3, title: '에디터', slug: '에디터' },
      { level: 2, title: 'Mermaid 다이어그램', slug: 'mermaid-다이어그램' },
      { level: 2, title: 'Git 버전 관리', slug: 'git-버전-관리' },
      { level: 3, title: '스테이징', slug: '스테이징' }
    ])
  })

  it('splits preamble and level-2 sections accurately', () => {
    const parsed = parseManualDocument(SAMPLE_MANUAL)

    expect(parsed.preamble).toContain('# Wiki Editor 사용자 매뉴얼')
    expect(parsed.sections).toHaveLength(3)
    expect(parsed.sections[0].title).toBe('단축키 모음')
    expect(parsed.sections[1].title).toBe('Mermaid 다이어그램')
    expect(parsed.sections[2].title).toBe('Git 버전 관리')
    expect(parsed.sections[1].markdown).toContain('## 코드 블록 안의 가짜 헤딩')
  })

  it('parses the bundled docs/manual.md with 단축키 모음 as the first section', () => {
    const parsed = parseManualDocument(manualMarkdown)

    expect(parsed.sections.length).toBeGreaterThan(1)
    expect(parsed.sections[0].title).toBe('단축키 모음')
    expect(parsed.tocItems.length).toBeGreaterThan(0)
  })
})

describe('filterManualDocument', () => {
  it('returns the full markdown and all TOC items when query is empty or whitespace', () => {
    const parsed = parseManualDocument(SAMPLE_MANUAL)
    const filtered = filterManualDocument(parsed, '   ')

    expect(filtered.isFiltered).toBe(false)
    expect(filtered.markdown).toBe(parsed.rawMarkdown)
    expect(filtered.tocItems).toEqual(parsed.tocItems)
    expect(filtered.matchedSectionCount).toBe(3)
    expect(filtered.totalSectionCount).toBe(3)
  })

  it('filters sections case-insensitively across title and body and updates TOC items', () => {
    const parsed = parseManualDocument(SAMPLE_MANUAL)
    const filtered = filterManualDocument(parsed, 'mermaid')

    expect(filtered.isFiltered).toBe(true)
    expect(filtered.matchedSectionCount).toBe(1)
    expect(filtered.totalSectionCount).toBe(3)
    expect(filtered.markdown).toContain('## Mermaid 다이어그램')
    expect(filtered.markdown).not.toContain('## 단축키 모음')
    expect(filtered.markdown).not.toContain('## Git 버전 관리')
    expect(filtered.tocItems.map((item) => item.title)).toEqual(['Mermaid 다이어그램'])
  })

  it('includes matching subsections in TOC when a parent section matches on body text', () => {
    const parsed = parseManualDocument(SAMPLE_MANUAL)
    const filtered = filterManualDocument(parsed, '스테이징')

    expect(filtered.isFiltered).toBe(true)
    expect(filtered.matchedSectionCount).toBe(1)
    expect(filtered.tocItems.map((item) => item.title)).toEqual(['Git 버전 관리', '스테이징'])
  })

  it('returns empty markdown and empty TOC when nothing matches', () => {
    const parsed = parseManualDocument(SAMPLE_MANUAL)
    const filtered = filterManualDocument(parsed, '존재하지않는키워드')

    expect(filtered.isFiltered).toBe(true)
    expect(filtered.matchedSectionCount).toBe(0)
    expect(filtered.totalSectionCount).toBe(3)
    expect(filtered.markdown).toBe('')
    expect(filtered.tocItems).toEqual([])
  })
})
