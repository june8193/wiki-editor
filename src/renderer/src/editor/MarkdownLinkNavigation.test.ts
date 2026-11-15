import { describe, expect, it } from 'vitest'
import { resolveMarkdownLinkTarget } from './MarkdownLinkNavigation'
import { findMarkdownHeadingBySlug } from './MarkdownTocEngine'

describe('resolveMarkdownLinkTarget', () => {
  const posixCtx = {
    workspaceRootPath: '/wiki/notes',
    activeFilePath: '/wiki/notes/docs/current.md'
  }
  const winCtx = {
    workspaceRootPath: 'C:\\wiki\\notes',
    activeFilePath: 'C:\\wiki\\notes\\docs\\current.md'
  }

  it('treats http, https, and mailto links as external without reading files', () => {
    expect(resolveMarkdownLinkTarget('https://example.com/docs', posixCtx)).toEqual({
      kind: 'external'
    })
    expect(resolveMarkdownLinkTarget('HTTP://example.com', posixCtx)).toEqual({
      kind: 'external'
    })
    expect(resolveMarkdownLinkTarget('mailto:team@example.com', posixCtx)).toEqual({
      kind: 'external'
    })
  })

  it('resolves same-document section links including percent-encoded slugs', () => {
    expect(resolveMarkdownLinkTarget('#section-1', posixCtx)).toEqual({
      kind: 'same-doc-section',
      slug: 'section-1'
    })
    expect(resolveMarkdownLinkTarget('#%EA%B0%9C%EC%9A%94-%EB%AA%A9%EC%B0%A8', posixCtx)).toEqual({
      kind: 'same-doc-section',
      slug: '개요-목차'
    })
  })

  it('resolves relative markdown file links and optional section fragments against activeFilePath', () => {
    expect(resolveMarkdownLinkTarget('./sibling.md', posixCtx)).toEqual({
      kind: 'workspace-file',
      targetPath: '/wiki/notes/docs/sibling.md',
      slug: null
    })

    expect(
      resolveMarkdownLinkTarget('../guide%20%281%29.md#%EC%84%A4%EC%A0%95', posixCtx)
    ).toEqual({
      kind: 'workspace-file',
      targetPath: '/wiki/notes/guide (1).md',
      slug: '설정'
    })

    expect(resolveMarkdownLinkTarget('../sub/target.md#intro', winCtx)).toEqual({
      kind: 'workspace-file',
      targetPath: 'C:\\wiki\\notes\\sub\\target.md',
      slug: 'intro'
    })
  })

  it('rejects paths escaping workspace root, absolute paths, and malformed links', () => {
    for (const badOutside of [
      resolveMarkdownLinkTarget('../../outside.md', posixCtx),
      resolveMarkdownLinkTarget('../../../secret.md', winCtx),
      resolveMarkdownLinkTarget('/etc/passwd.md', posixCtx),
      resolveMarkdownLinkTarget('D:\\other\\doc.md', winCtx)
    ]) {
      expect(badOutside.kind).toBe('error')
      if (badOutside.kind === 'error') {
        expect(badOutside.message).toMatch(/워크스페이스 루트 밖/)
      }
    }

    expect(resolveMarkdownLinkTarget('', posixCtx).kind).toBe('error')
    expect(resolveMarkdownLinkTarget('./bad%ZZ.md', posixCtx).kind).toBe('error')
  })
})

describe('findMarkdownHeadingBySlug', () => {
  it('matches decoded slugs to headings with their line and 0-based index', () => {
    const content = ['# 개요', '', '## API 가이드', '', '### 세부 항목'].join('\n')

    const match1 = findMarkdownHeadingBySlug(content, 'api-가이드')
    expect(match1).not.toBeNull()
    expect(match1?.index).toBe(1)
    expect(match1?.heading.line).toBe(3)
    expect(match1?.heading.slug).toBe('api-가이드')

    const matchEncoded = findMarkdownHeadingBySlug(content, '%EC%84%B8%EB%B6%80-%ED%95%AD%EB%AA%A9')
    expect(matchEncoded).not.toBeNull()
    expect(matchEncoded?.index).toBe(2)
    expect(matchEncoded?.heading.line).toBe(5)

    expect(findMarkdownHeadingBySlug(content, 'missing-section')).toBeNull()
  })
})
