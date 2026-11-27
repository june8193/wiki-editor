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

  it('resolves valid http/https links (including hash fragments) as external, mailto as noop, and malformed http(s) or unsupported schemes as error', () => {
    expect(resolveMarkdownLinkTarget('https://example.com/docs', posixCtx)).toEqual({
      kind: 'external',
      url: 'https://example.com/docs'
    })
    expect(resolveMarkdownLinkTarget('HTTP://example.com', posixCtx)).toEqual({
      kind: 'external',
      url: 'HTTP://example.com'
    })
    expect(resolveMarkdownLinkTarget('https://example.com/docs#section-1', posixCtx)).toEqual({
      kind: 'external',
      url: 'https://example.com/docs#section-1'
    })
    expect(resolveMarkdownLinkTarget('mailto:team@example.com', posixCtx)).toEqual({
      kind: 'noop'
    })
    expect(resolveMarkdownLinkTarget('MAILTO:team@example.com', posixCtx)).toEqual({
      kind: 'noop'
    })

    for (const invalidHttp of ['https://', 'http:///path', 'https://example.com\n--evil']) {
      const result = resolveMarkdownLinkTarget(invalidHttp, posixCtx)
      expect(result.kind).toBe('error')
    }
    for (const unsupported of ['javascript:alert(1)', 'file:///C:/secret.md', 'ftp://example.com/file']) {
      const result = resolveMarkdownLinkTarget(unsupported, posixCtx)
      expect(result.kind).toBe('error')
    }
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

  it('rejects non-markdown relative workspace files while allowing .md/.markdown case-insensitively and prioritizing workspace escape checks', () => {
    expect(resolveMarkdownLinkTarget('./SPEC.MARKDOWN#intro', posixCtx)).toEqual({
      kind: 'workspace-file',
      targetPath: '/wiki/notes/docs/SPEC.MARKDOWN',
      slug: 'intro'
    })

    for (const nonMd of ['./image.png', './config.json', './notes.txt#sec']) {
      const result = resolveMarkdownLinkTarget(nonMd, posixCtx)
      expect(result.kind).toBe('error')
      if (result.kind === 'error') {
        expect(result.message).toMatch(/마크다운/)
      }
    }

    const escapedNonMd = resolveMarkdownLinkTarget('../../outside.png', posixCtx)
    expect(escapedNonMd.kind).toBe('error')
    if (escapedNonMd.kind === 'error') {
      expect(escapedNonMd.message).toMatch(/워크스페이스 루트 밖/)
    }
  })
})

describe('findMarkdownHeadingBySlug', () => {
  it('matches decoded slugs to headings with their line and 0-based index without double-decoding', () => {
    const content = ['# 개요', '', '## API 가이드', '', '### 세부 항목'].join('\n')

    const match1 = findMarkdownHeadingBySlug(content, 'api-가이드')
    expect(match1).not.toBeNull()
    expect(match1?.index).toBe(1)
    expect(match1?.heading.line).toBe(3)
    expect(match1?.heading.slug).toBe('api-가이드')

    const resolved = resolveMarkdownLinkTarget('#%EC%84%B8%EB%B6%80-%ED%95%AD%EB%AA%A9', {
      workspaceRootPath: '/wiki/notes',
      activeFilePath: '/wiki/notes/current.md'
    })
    expect(resolved).toEqual({ kind: 'same-doc-section', slug: '세부-항목' })
    const matchDecoded =
      resolved.kind === 'same-doc-section' ? findMarkdownHeadingBySlug(content, resolved.slug) : null
    expect(matchDecoded?.index).toBe(2)
    expect(matchDecoded?.heading.line).toBe(5)

    const doubleEncoded = resolveMarkdownLinkTarget('#api%252d%EA%B0%80%EC%9D%B4%EB%93%9C', {
      workspaceRootPath: '/wiki/notes',
      activeFilePath: '/wiki/notes/current.md'
    })
    expect(doubleEncoded).toEqual({ kind: 'same-doc-section', slug: 'api%2d가이드' })
    expect(
      doubleEncoded.kind === 'same-doc-section'
        ? findMarkdownHeadingBySlug(content, doubleEncoded.slug)
        : null
    ).toBeNull()

    expect(findMarkdownHeadingBySlug(content, 'missing-section')).toBeNull()
  })
})
