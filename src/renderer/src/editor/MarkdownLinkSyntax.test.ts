import { describe, expect, it } from 'vitest'
import { extractMarkdownLinkHrefAtOffset } from './MarkdownLinkSyntax'

describe('extractMarkdownLinkHrefAtOffset', () => {
  it('extracts href for inline markdown links at any offset inside [label](href)', () => {
    const content = 'See [API 가이드](#api-가이드) and [Guide](./sub/guide%20%281%29.md#intro).'
    const firstStart = content.indexOf('[API 가이드]')
    const firstEnd = content.indexOf(')') + 1
    expect(extractMarkdownLinkHrefAtOffset(content, firstStart)).toBe('#api-가이드')
    expect(extractMarkdownLinkHrefAtOffset(content, firstEnd - 2)).toBe('#api-가이드')

    const secondHrefPos = content.indexOf('./sub/guide')
    expect(extractMarkdownLinkHrefAtOffset(content, secondHrefPos)).toBe(
      './sub/guide%20%281%29.md#intro'
    )

    expect(extractMarkdownLinkHrefAtOffset(content, 0)).toBeNull()
  })

  it('supports inline code inside labels, angle-bracket destinations, and optional titles', () => {
    const content = 'Jump [`parseHeader`](#parseheader) or [Doc](<./my docs/readme.md> "Readme")'
    expect(extractMarkdownLinkHrefAtOffset(content, content.indexOf('parseHeader'))).toBe(
      '#parseheader'
    )
    expect(extractMarkdownLinkHrefAtOffset(content, content.indexOf('my docs'))).toBe(
      './my docs/readme.md'
    )
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

    expect(extractMarkdownLinkHrefAtOffset(content, content.indexOf('./pic.png'))).toBeNull()
    expect(extractMarkdownLinkHrefAtOffset(content, content.indexOf('./a.md'))).toBeNull()
    expect(extractMarkdownLinkHrefAtOffset(content, content.indexOf('./b.md'))).toBeNull()
    expect(extractMarkdownLinkHrefAtOffset(content, content.indexOf('./c.md'))).toBe('./c.md')
  })

  it('unescapes backslash-escaped destination characters and supports multi-line link labels inside a paragraph', () => {
    const escaped = 'See [Guide](./guide\\(1\\).md) and [Angle](<./a\\>b.md>)'
    expect(extractMarkdownLinkHrefAtOffset(escaped, escaped.indexOf('Guide'))).toBe(
      './guide(1).md'
    )
    expect(extractMarkdownLinkHrefAtOffset(escaped, escaped.indexOf('Angle'))).toBe('./a>b.md')

    const multiLine = 'See [first line\nsecond line](./doc.md) end'
    expect(extractMarkdownLinkHrefAtOffset(multiLine, multiLine.indexOf('first'))).toBe('./doc.md')
    expect(extractMarkdownLinkHrefAtOffset(multiLine, multiLine.indexOf('second'))).toBe('./doc.md')

    const splitBlank = '[first\n\nsecond](./doc.md)'
    expect(extractMarkdownLinkHrefAtOffset(splitBlank, splitBlank.indexOf('first'))).toBeNull()
    expect(extractMarkdownLinkHrefAtOffset(splitBlank, splitBlank.indexOf('second'))).toBeNull()
  })

  it('extracts <http(s)://...> autolinks and bare http(s)://... URLs while trimming trailing punctuation and preserving balanced parens', () => {
    const content = [
      'Angle <https://example.com/docs?q=1#top> and <http://localhost:3000/api>.',
      'Bare https://example.com/a, http://example.com/b! Visit https://example.com/c.',
      'Wiki https://en.wikipedia.org/wiki/Foo_(bar) and wrapped (https://en.wikipedia.org/wiki/Foo_(bar)).',
      'Quoted "https://example.com/q"; colon https://example.com/col: end'
    ].join('\n')

    expect(extractMarkdownLinkHrefAtOffset(content, content.indexOf('docs?q=1'))).toBe(
      'https://example.com/docs?q=1#top'
    )
    expect(extractMarkdownLinkHrefAtOffset(content, content.indexOf('localhost:3000'))).toBe(
      'http://localhost:3000/api'
    )
    expect(extractMarkdownLinkHrefAtOffset(content, content.indexOf('example.com/a'))).toBe(
      'https://example.com/a'
    )
    expect(extractMarkdownLinkHrefAtOffset(content, content.indexOf('example.com/b'))).toBe(
      'http://example.com/b'
    )
    expect(extractMarkdownLinkHrefAtOffset(content, content.indexOf('example.com/c'))).toBe(
      'https://example.com/c'
    )
    expect(extractMarkdownLinkHrefAtOffset(content, content.indexOf('Foo_(bar)'))).toBe(
      'https://en.wikipedia.org/wiki/Foo_(bar)'
    )
    const wrappedIdx = content.indexOf('(https://en.wikipedia.org/wiki/Foo_(bar))')
    expect(extractMarkdownLinkHrefAtOffset(content, wrappedIdx + 10)).toBe(
      'https://en.wikipedia.org/wiki/Foo_(bar)'
    )
    expect(extractMarkdownLinkHrefAtOffset(content, content.indexOf('example.com/q'))).toBe(
      'https://example.com/q'
    )
    expect(extractMarkdownLinkHrefAtOffset(content, content.indexOf('example.com/col'))).toBe(
      'https://example.com/col'
    )
  })

  it('ignores autolinks and bare URLs inside code fences, inline code, images, and escaped prefixes', () => {
    const content = [
      'Image ![alt](https://example.com/pic.png) and `<https://example.com/ic1>` and `https://example.com/ic2`',
      'Escaped \\<https://example.com/esc1> and \\https://example.com/esc2',
      '',
      '```ts',
      'const a = "https://example.com/fence"',
      '// <https://example.com/fence2>',
      '```'
    ].join('\n')

    expect(extractMarkdownLinkHrefAtOffset(content, content.indexOf('pic.png'))).toBeNull()
    expect(extractMarkdownLinkHrefAtOffset(content, content.indexOf('ic1'))).toBeNull()
    expect(extractMarkdownLinkHrefAtOffset(content, content.indexOf('ic2'))).toBeNull()
    expect(extractMarkdownLinkHrefAtOffset(content, content.indexOf('esc1'))).toBeNull()
    expect(extractMarkdownLinkHrefAtOffset(content, content.indexOf('esc2'))).toBeNull()
    expect(extractMarkdownLinkHrefAtOffset(content, content.indexOf('fence'))).toBeNull()
    expect(extractMarkdownLinkHrefAtOffset(content, content.indexOf('fence2'))).toBeNull()
  })
})
