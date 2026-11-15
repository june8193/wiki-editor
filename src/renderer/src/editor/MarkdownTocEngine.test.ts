import { describe, expect, it } from 'vitest'
import {
  createHeadingSlugTracker,
  formatOutlineHeadingTitle,
  parseMarkdownHeadings,
  slugifyHeading
} from './MarkdownTocEngine'

describe('MarkdownTocEngine', () => {
  it('parses ATX headings (# to ######) with hierarchical numbers while ignoring # inside fenced code blocks', () => {
    const md = [
      '# Introduction',
      '',
      '```bash',
      '# This is a shell comment, not a heading',
      '## Neither is this',
      '```',
      '',
      '~~~markdown',
      '# Ignored inside tilde fence',
      '```',
      '## Still inside tilde fence because backticks do not close tildes',
      '~~~',
      '',
      '````markdown',
      '```',
      '# Still inside 4-backtick fence',
      '```',
      '````',
      '',
      '## Getting Started',
      '### Installation',
      '### Configuration ##',
      '## Advanced Usage',
      '# Summary'
    ].join('\n')

    const headings = parseMarkdownHeadings(md)

    expect(headings.map((h) => ({ level: h.level, depth: h.depth, number: h.number, title: h.title, line: h.line }))).toEqual([
      { level: 1, depth: 0, number: '1.', title: 'Introduction', line: 1 },
      { level: 2, depth: 1, number: '1.1.', title: 'Getting Started', line: 20 },
      { level: 3, depth: 2, number: '1.1.1.', title: 'Installation', line: 21 },
      { level: 3, depth: 2, number: '1.1.2.', title: 'Configuration', line: 22 },
      { level: 2, depth: 1, number: '1.2.', title: 'Advanced Usage', line: 23 },
      { level: 1, depth: 0, number: '2.', title: 'Summary', line: 24 }
    ])
  })

  it('handles skipped heading levels and avoids double-numbering already numbered headings', () => {
    const md = [
      '## Preface',
      '#### Deep Note',
      '# 1. Chapter One',
      '### Direct Subtopic',
      '## Regular Subtopic',
      '### Nested Item'
    ].join('\n')

    const headings = parseMarkdownHeadings(md)

    expect(headings.map((h) => ({ number: h.number, title: h.title, depth: h.depth }))).toEqual([
      { number: '1.', title: 'Preface', depth: 0 },
      { number: '1.1.', title: 'Deep Note', depth: 1 },
      { number: '2.', title: 'Chapter One', depth: 0 },
      { number: '2.1.', title: 'Direct Subtopic', depth: 1 },
      { number: '2.2.', title: 'Regular Subtopic', depth: 1 },
      { number: '2.2.1.', title: 'Nested Item', depth: 2 }
    ])
  })

  it('generates Unicode-safe anchor slugs with duplicate disambiguation', () => {
    expect(slugifyHeading('시작하기 (Getting Started)')).toBe('시작하기-getting-started')
    expect(slugifyHeading('API `v2` & **Guide**')).toBe('api-v2-guide')

    const tracker = createHeadingSlugTracker()
    expect([
      tracker.next('Overview'),
      tracker.next('Setup'),
      tracker.next('Details'),
      tracker.next('Overview'),
      tracker.next('Setup')
    ]).toEqual(['overview', 'setup', 'details', 'overview-1', 'setup-1'])
  })

  it('formats Outline heading titles consistently with showHeadingNumbers toggle and explicit prefixes', () => {
    const headings = parseMarkdownHeadings([
      '# Plain Heading',
      '## 9. **Explicit** Prefix'
    ].join('\n'))

    expect(formatOutlineHeadingTitle(headings[0], true)).toBe('Plain Heading')
    expect(formatOutlineHeadingTitle(headings[0], false)).toBe('Plain Heading')
    expect(formatOutlineHeadingTitle(headings[1], true)).toBe('Explicit Prefix')
    expect(formatOutlineHeadingTitle(headings[1], false)).toBe('9. Explicit Prefix')
  })
})

describe('MarkdownTocEngine inline image alt with parentheses', () => {
  it('preserves alt text cleanly when heading contains inline image URLs with parentheses or linked images', () => {
    const markdown = [
      '# ![Logo](./assets/logo%20(1).png) Alpha',
      '## ![Icon](<./assets/icon (2).svg>) Beta',
      '### [![Badge](./assets/badge.png)](https://example.com) Gamma',
      '#### [![Shield](./assets/shield (1).png)](https://example.com/a_(b)) Delta'
    ].join('\n')

    const headings = parseMarkdownHeadings(markdown)
    expect(headings.map((item) => item.title)).toEqual([
      'Logo Alpha',
      'Icon Beta',
      'Badge Gamma',
      'Shield Delta'
    ])
    expect(headings.map((item) => item.slug)).toEqual([
      'logo-alpha',
      'icon-beta',
      'badge-gamma',
      'shield-delta'
    ])
  })
})
