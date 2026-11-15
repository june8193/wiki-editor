import { describe, expect, it } from 'vitest'
import {
  extractMarkdownLinkAtOffset,
  findMarkdownHeadingBySlug,
  isLinkNavigationClick,
  resolveMarkdownLinkTarget
} from './MarkdownLinkNavigation'

describe('isLinkNavigationClick', () => {
  it('allows normal primary click in Preview mode', () => {
    expect(
      isLinkNavigationClick('preview', {
        button: 0,
        ctrlKey: false,
        metaKey: false,
        altKey: false
      })
    ).toBe(true)

    expect(
      isLinkNavigationClick('preview', {
        button: 1,
        ctrlKey: false,
        metaKey: false,
        altKey: false
      })
    ).toBe(false)
  })

  it('requires Ctrl+click or Meta+click in Raw and WYSIWYG modes', () => {
    for (const mode of ['raw', 'wysiwyg'] as const) {
      expect(
        isLinkNavigationClick(mode, {
          button: 0,
          ctrlKey: false,
          metaKey: false,
          altKey: false
        })
      ).toBe(false)

      expect(
        isLinkNavigationClick(mode, {
          button: 0,
          ctrlKey: true,
          metaKey: false,
          altKey: false
        })
      ).toBe(true)

      expect(
        isLinkNavigationClick(mode, {
          button: 0,
          ctrlKey: false,
          metaKey: true,
          altKey: false
        })
      ).toBe(true)

      expect(
        isLinkNavigationClick(mode, {
          button: 0,
          ctrlKey: true,
          metaKey: false,
          altKey: true
        })
      ).toBe(false)
    }
  })

  it('never triggers for unsupported editor mode', () => {
    expect(
      isLinkNavigationClick('unsupported', {
        button: 0,
        ctrlKey: true,
        metaKey: true,
        altKey: false
      })
    ).toBe(false)
  })
})

describe('extractMarkdownLinkAtOffset', () => {
  it('extracts href and span for inline markdown links at any offset inside [label](href)', () => {
    const content = 'See [API 가이드](#api-가이드) and [Guide](./sub/guide%20%281%29.md#intro).'
    const firstStart = content.indexOf('[API 가이드]')
    const firstEnd = content.indexOf(')') + 1
    expect(extractMarkdownLinkAtOffset(content, firstStart)).toEqual({
      href: '#api-가이드',
      from: firstStart,
      to: firstEnd
    })
    expect(extractMarkdownLinkAtOffset(content, firstEnd - 2)).toEqual({
      href: '#api-가이드',
      from: firstStart,
      to: firstEnd
    })

    const secondStart = content.indexOf('[Guide]')
    const secondHrefPos = content.indexOf('./sub/guide')
    expect(extractMarkdownLinkAtOffset(content, secondHrefPos)).toEqual({
      href: './sub/guide%20%281%29.md#intro',
      from: secondStart,
      to: content.length - 1
    })

    expect(extractMarkdownLinkAtOffset(content, 0)).toBeNull()
  })

  it('supports inline code inside labels, angle-bracket destinations, and optional titles', () => {
    const content = 'Jump [`parseHeader`](#parseheader) or [Doc](<./my docs/readme.md> "Readme")'
    const firstPos = content.indexOf('parseHeader')
    expect(extractMarkdownLinkAtOffset(content, firstPos)?.href).toBe('#parseheader')

    const secondPos = content.indexOf('my docs')
    expect(extractMarkdownLinkAtOffset(content, secondPos)?.href).toBe('./my docs/readme.md')
  })

  it('ignores markdown images, inline code spans, and fenced code blocks', () => {
    const content = [
      'Image ![alt](./pic.png) and code `[not link](./a.md)`',
      '',
      '```markdown',
      '[fenced](./b.md)',
      '```',
      '',
      '[real](./c.md)'
    ].join('\n')

    expect(extractMarkdownLinkAtOffset(content, content.indexOf('./pic.png'))).toBeNull()
    expect(extractMarkdownLinkAtOffset(content, content.indexOf('./a.md'))).toBeNull()
    expect(extractMarkdownLinkAtOffset(content, content.indexOf('./b.md'))).toBeNull()
    expect(extractMarkdownLinkAtOffset(content, content.indexOf('./c.md'))?.href).toBe('./c.md')
  })
})

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
      kind: 'external',
      href: 'https://example.com/docs'
    })
    expect(resolveMarkdownLinkTarget('HTTP://example.com', posixCtx)).toEqual({
      kind: 'external',
      href: 'HTTP://example.com'
    })
    expect(resolveMarkdownLinkTarget('mailto:team@example.com', posixCtx)).toEqual({
      kind: 'external',
      href: 'mailto:team@example.com'
    })
  })

  it('resolves same-document section links including percent-encoded slugs', () => {
    expect(resolveMarkdownLinkTarget('#section-1', posixCtx)).toEqual({
      kind: 'same-doc-section',
      slug: 'section-1',
      rawHref: '#section-1'
    })
    expect(resolveMarkdownLinkTarget('#%EA%B0%9C%EC%9A%94-%EB%AA%A9%EC%B0%A8', posixCtx)).toEqual({
      kind: 'same-doc-section',
      slug: '개요-목차',
      rawHref: '#%EA%B0%9C%EC%9A%94-%EB%AA%A9%EC%B0%A8'
    })
  })

  it('resolves relative markdown file links and optional section fragments against activeFilePath', () => {
    expect(resolveMarkdownLinkTarget('./sibling.md', posixCtx)).toEqual({
      kind: 'workspace-file',
      targetPath: '/wiki/notes/docs/sibling.md',
      slug: null,
      rawHref: './sibling.md'
    })

    expect(
      resolveMarkdownLinkTarget('../guide%20%281%29.md#%EC%84%A4%EC%A0%95', posixCtx)
    ).toEqual({
      kind: 'workspace-file',
      targetPath: '/wiki/notes/guide (1).md',
      slug: '설정',
      rawHref: '../guide%20%281%29.md#%EC%84%A4%EC%A0%95'
    })

    expect(resolveMarkdownLinkTarget('../sub/target.md#intro', winCtx)).toEqual({
      kind: 'workspace-file',
      targetPath: 'C:\\wiki\\notes\\sub\\target.md',
      slug: 'intro',
      rawHref: '../sub/target.md#intro'
    })
  })

  it('rejects paths escaping workspace root, absolute paths, and malformed links', () => {
    const escapedPosix = resolveMarkdownLinkTarget('../../outside.md', posixCtx)
    expect(escapedPosix.kind).toBe('error')
    if (escapedPosix.kind === 'error') {
      expect(escapedPosix.reason).toBe('outside-workspace')
    }

    const escapedWin = resolveMarkdownLinkTarget('../../../secret.md', winCtx)
    expect(escapedWin.kind).toBe('error')
    if (escapedWin.kind === 'error') {
      expect(escapedWin.reason).toBe('outside-workspace')
    }

    const absUnix = resolveMarkdownLinkTarget('/etc/passwd.md', posixCtx)
    expect(absUnix.kind).toBe('error')
    if (absUnix.kind === 'error') {
      expect(absUnix.reason).toBe('outside-workspace')
    }

    const absWin = resolveMarkdownLinkTarget('D:\\other\\doc.md', winCtx)
    expect(absWin.kind).toBe('error')
    if (absWin.kind === 'error') {
      expect(absWin.reason).toBe('outside-workspace')
    }

    const emptyHref = resolveMarkdownLinkTarget('', posixCtx)
    expect(emptyHref.kind).toBe('error')

    const badPercent = resolveMarkdownLinkTarget('./bad%ZZ.md', posixCtx)
    expect(badPercent.kind).toBe('error')
    if (badPercent.kind === 'error') {
      expect(badPercent.reason).toBe('invalid-path')
    }
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
