import { describe, expect, it } from 'vitest'
import { parseMarkdownHeadings } from './MarkdownTocEngine'
import {
  resolveActiveHeadingIndexByLine,
  resolveActiveHeadingIndexByOffsets
} from './outlineScrollSpy'

describe('outlineScrollSpy', () => {
  it('resolves active heading index from pixel offsets across preface, baseline threshold, non-scrolling short docs, and bottom reach', () => {
    expect(
      resolveActiveHeadingIndexByOffsets({
        headingTopOffsets: [],
        scrollTop: 0,
        scrollHeight: 400,
        clientHeight: 400
      })
    ).toBeNull()

    // Preface before the first heading returns null (boundary at 24px vs 24.1px)
    expect(
      resolveActiveHeadingIndexByOffsets({
        headingTopOffsets: [24.1, 180],
        scrollTop: 0,
        scrollHeight: 1200,
        clientHeight: 500
      })
    ).toBeNull()

    expect(
      resolveActiveHeadingIndexByOffsets({
        headingTopOffsets: [24, 180],
        scrollTop: 0,
        scrollHeight: 1200,
        clientHeight: 500
      })
    ).toBe(0)

    // Last heading whose top passed the top baseline wins
    expect(
      resolveActiveHeadingIndexByOffsets({
        headingTopOffsets: [-320, -12, 24, 210],
        scrollTop: 340,
        scrollHeight: 1600,
        clientHeight: 500
      })
    ).toBe(2)

    // Non-scrolling short document (scrollTop === 0) must NOT jump to last heading
    expect(
      resolveActiveHeadingIndexByOffsets({
        headingTopOffsets: [16, 120, 220],
        scrollTop: 0,
        scrollHeight: 300,
        clientHeight: 500
      })
    ).toBe(0)

    expect(
      resolveActiveHeadingIndexByOffsets({
        headingTopOffsets: [60, 180],
        scrollTop: 0,
        scrollHeight: 300,
        clientHeight: 500
      })
    ).toBeNull()

    // Manually scrolled to bottom (within 2px tolerance) highlights the last short section
    expect(
      resolveActiveHeadingIndexByOffsets({
        headingTopOffsets: [-500, -140, 140],
        scrollTop: 598,
        scrollHeight: 1000,
        clientHeight: 400
      })
    ).toBe(2)

    // 3px short of bottom falls back to the top baseline rule
    expect(
      resolveActiveHeadingIndexByOffsets({
        headingTopOffsets: [-500, -140, 140],
        scrollTop: 597,
        scrollHeight: 1000,
        clientHeight: 400
      })
    ).toBe(1)
  })

  it('resolves active heading index from 1-based top line across preface, fenced code comments, short docs, and bottom reach', () => {
    const md = [
      'Preface line 1',
      'Preface line 2',
      '# First Heading',
      'Body line',
      '```bash',
      '# Code comment',
      '```',
      '## Second Heading',
      'More text',
      '### Third Heading'
    ].join('\n')
    const headings = parseMarkdownHeadings(md)

    expect(
      resolveActiveHeadingIndexByLine({
        headings: [],
        topLine: 1,
        scrollTop: 0,
        scrollHeight: 200,
        clientHeight: 400
      })
    ).toBeNull()

    // Preface lines before first heading (line 3) return null
    expect(
      resolveActiveHeadingIndexByLine({
        headings,
        topLine: 2,
        scrollTop: 0,
        scrollHeight: 900,
        clientHeight: 400
      })
    ).toBeNull()

    // Exact heading line and lines spanning code-fence comments resolve correctly
    expect(
      resolveActiveHeadingIndexByLine({
        headings,
        topLine: 3,
        scrollTop: 40,
        scrollHeight: 900,
        clientHeight: 400
      })
    ).toBe(0)

    expect(
      resolveActiveHeadingIndexByLine({
        headings,
        topLine: 6,
        scrollTop: 120,
        scrollHeight: 900,
        clientHeight: 400
      })
    ).toBe(0)

    expect(
      resolveActiveHeadingIndexByLine({
        headings,
        topLine: 9,
        scrollTop: 260,
        scrollHeight: 900,
        clientHeight: 400
      })
    ).toBe(1)

    // Non-scrolling short document (scrollTop === 0) keeps line-based selection rather than jumping to last
    expect(
      resolveActiveHeadingIndexByLine({
        headings,
        topLine: 3,
        scrollTop: 0,
        scrollHeight: 220,
        clientHeight: 400
      })
    ).toBe(0)

    // Manually scrolled to bottom (within 2px tolerance) highlights the last heading
    expect(
      resolveActiveHeadingIndexByLine({
        headings,
        topLine: 8,
        scrollTop: 499,
        scrollHeight: 900,
        clientHeight: 400
      })
    ).toBe(2)
  })
})
