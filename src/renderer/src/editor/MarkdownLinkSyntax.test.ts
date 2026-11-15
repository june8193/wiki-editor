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
})
