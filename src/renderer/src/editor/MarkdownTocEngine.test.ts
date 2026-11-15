import { describe, expect, it } from 'vitest'
import {
  applyHeadingNumbers,
  generateTocMarkdown,
  insertOrUpdateTocBlock,
  parseMarkdownHeadings,
  slugifyHeading,
  stripHeadingNumbers
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

  it('generates Unicode-safe anchor slugs with duplicate disambiguation and nested /toc markdown', () => {
    expect(slugifyHeading('시작하기 (Getting Started)')).toBe('시작하기-getting-started')
    expect(slugifyHeading('API `v2` & **Guide**')).toBe('api-v2-guide')

    const md = [
      '# Overview',
      '## Setup',
      '### Details',
      '# Overview',
      '## Setup'
    ].join('\n')

    expect(generateTocMarkdown(md)).toBe(
      [
        '- [Overview](#overview)',
        '  - [Setup](#setup)',
        '    - [Details](#details)',
        '- [Overview](#overview-1)',
        '  - [Setup](#setup-1)'
      ].join('\n')
    )

    expect(generateTocMarkdown(md, { includeNumbers: true })).toBe(
      [
        '- [1. Overview](#overview)',
        '  - [1.1. Setup](#setup)',
        '    - [1.1.1. Details](#details)',
        '- [2. Overview](#overview-1)',
        '  - [2.1. Setup](#setup-1)'
      ].join('\n')
    )
  })

  it('inserts a /toc block at cursor or after the first H1 and updates an existing TOC block in place', () => {
    const md = [
      '# Main Title',
      '',
      '/toc',
      '',
      '## First Section',
      '### Child',
      '## Second Section'
    ].join('\n')

    const inserted = insertOrUpdateTocBlock(md, 3)
    expect(inserted).toBe(
      [
        '# Main Title',
        '',
        '<!-- toc -->',
        '- [Main Title](#main-title)',
        '  - [First Section](#first-section)',
        '    - [Child](#child)',
        '  - [Second Section](#second-section)',
        '<!-- /toc -->',
        '',
        '## First Section',
        '### Child',
        '## Second Section'
      ].join('\n')
    )

    // Add a new heading and update existing <!-- toc --> block in place without duplicating it
    const edited = inserted.replace('## Second Section', '## Second Section\n### New Sub')
    const updated = insertOrUpdateTocBlock(edited)

    expect(updated.match(/<!-- toc -->/g)).toHaveLength(1)
    expect(updated).toContain('    - [New Sub](#new-sub)')
  })

  it('does not treat <!-- toc --> markers inside fenced code blocks as the active TOC block', () => {
    const md = [
      '# Guide',
      '',
      '```markdown',
      '<!-- toc -->',
      '- fake',
      '<!-- /toc -->',
      '```',
      '',
      '## Real Section'
    ].join('\n')

    const result = insertOrUpdateTocBlock(md)
    expect(result).toBe(
      [
        '# Guide',
        '',
        '<!-- toc -->',
        '- [Guide](#guide)',
        '  - [Real Section](#real-section)',
        '<!-- /toc -->',
        '',
        '```markdown',
        '<!-- toc -->',
        '- fake',
        '<!-- /toc -->',
        '```',
        '',
        '## Real Section'
      ].join('\n')
    )
  })

  it('applies and strips hierarchical heading numbers only outside code blocks while preserving CRLF and trailing whitespace', () => {
    const crlfMd = [
      '# Intro  ',
      '```python',
      '# keep this comment untouched',
      '## keep this too',
      '```',
      '##   Details   ',
      '### Sub-item',
      '# 9. Old Numbered Title  '
    ].join('\r\n')

    const numbered = applyHeadingNumbers(crlfMd)
    expect(numbered).toBe(
      [
        '# 1. Intro  ',
        '```python',
        '# keep this comment untouched',
        '## keep this too',
        '```',
        '##   1.1. Details   ',
        '### 1.1.1. Sub-item',
        '# 2. Old Numbered Title  '
      ].join('\r\n')
    )

    // Idempotent when applied twice
    expect(applyHeadingNumbers(numbered)).toBe(numbered)

    const stripped = stripHeadingNumbers(numbered)
    expect(stripped).toBe(
      [
        '# Intro  ',
        '```python',
        '# keep this comment untouched',
        '## keep this too',
        '```',
        '##   Details   ',
        '### Sub-item',
        '# Old Numbered Title  '
      ].join('\r\n')
    )
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
