import { describe, expect, it } from 'vitest'
import { parseMarkdownHeadings } from './MarkdownTocEngine'
import {
  measureActiveHeadingIndexInContainer,
  measureActiveHeadingIndexInRawEditor,
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

  it('measures Raw CodeMirror viewport top line while excluding fenced # comments and unmeasured layout', () => {
    const markdown = [
      'Intro preface',
      '# First Heading',
      '```bash',
      '# shell comment inside fence',
      'echo hi',
      '```',
      '## Second Heading',
      'Closing text'
    ].join('\n')
    const headings = parseMarkdownHeadings(markdown)
    const lines = markdown.split('\n')
    const lineStarts: number[] = []
    let offset = 0
    for (const line of lines) {
      lineStarts.push(offset)
      offset += line.length + 1
    }

    const createViewportStub = (metrics: {
      scrollTop: number
      scrollHeight: number
      clientHeight: number
      paddingTop?: number
      lineHeight?: number
    }) => {
      const scrollDOM = document.createElement('div')
      const contentDOM = document.createElement('div')
      Object.defineProperties(scrollDOM, {
        scrollTop: { value: metrics.scrollTop, configurable: true },
        scrollHeight: { value: metrics.scrollHeight, configurable: true },
        clientHeight: { value: metrics.clientHeight, configurable: true }
      })
      const lineHeight = metrics.lineHeight ?? 20
      return {
        scrollDOM,
        contentDOM,
        documentPaddingTop: metrics.paddingTop ?? 16,
        lineCount: lines.length,
        lineNumberAt: (pos: number) => {
          let lineNumber = 1
          for (let i = 0; i < lineStarts.length; i += 1) {
            if (lineStarts[i] <= pos) {
              lineNumber = i + 1
            }
          }
          return lineNumber
        },
        lineBlockAtHeight: (height: number) => {
          const lineIdx = Math.max(0, Math.min(lines.length - 1, Math.floor(height / lineHeight)))
          return { from: lineStarts[lineIdx] }
        }
      }
    }

    // Empty headings -> null
    expect(
      measureActiveHeadingIndexInRawEditor(
        createViewportStub({ scrollTop: 0, scrollHeight: 800, clientHeight: 400 }),
        []
      )
    ).toBeNull()

    // Unmeasured jsdom box (zero geometry and zero scrollTop) -> null
    expect(
      measureActiveHeadingIndexInRawEditor(
        createViewportStub({ scrollTop: 0, scrollHeight: 0, clientHeight: 0 }),
        headings
      )
    ).toBeNull()

    // At top (preface line 1, baselineHeight = 0 + 24 - 16 = 8px -> line 1) -> null
    expect(
      measureActiveHeadingIndexInRawEditor(
        createViewportStub({ scrollTop: 0, scrollHeight: 800, clientHeight: 400 }),
        headings
      )
    ).toBeNull()

    // Scrolled onto fenced `# shell comment inside fence` (line 4): remains on `# First Heading` (index 0)
    expect(
      measureActiveHeadingIndexInRawEditor(
        createViewportStub({ scrollTop: 60, scrollHeight: 800, clientHeight: 400 }),
        headings
      )
    ).toBe(0)

    // Scrolled onto line 7 (`## Second Heading`): updates to index 1
    expect(
      measureActiveHeadingIndexInRawEditor(
        createViewportStub({ scrollTop: 120, scrollHeight: 800, clientHeight: 400 }),
        headings
      )
    ).toBe(1)

    // Scrolled to bottom (scrollHeight 800, clientHeight 400, scrollTop 399): selects last heading
    expect(
      measureActiveHeadingIndexInRawEditor(
        createViewportStub({ scrollTop: 399, scrollHeight: 800, clientHeight: 400 }),
        headings
      )
    ).toBe(1)

    // Collapsed DOM line blocks (zero height after unmeasured jsdom layout cycle) fall back to defaultLineHeight
    const collapsedViewport = {
      ...createViewportStub({ scrollTop: 42, scrollHeight: 800, clientHeight: 400 }),
      defaultLineHeight: 14,
      lineBlockAtHeight: () => ({ from: lineStarts[lines.length - 1], top: 14, bottom: 14 })
    }
    expect(measureActiveHeadingIndexInRawEditor(collapsedViewport, headings)).toBe(0)
  })

  it('matches un-id WYSIWYG container headings accurately when empty, blockquote, or Setext headings appear alongside dynamic numbering', () => {
    const markdown = ['# 1. Alpha', '', '## Beta'].join('\n')
    const headings = parseMarkdownHeadings(markdown)

    const container = document.createElement('div')
    const hAlpha = document.createElement('h1')
    const suppressedSpan = document.createElement('span')
    suppressedSpan.className = 'heading-number-suppressed'
    suppressedSpan.textContent = '1. '
    const numberSpan = document.createElement('span')
    numberSpan.className = 'heading-number'
    numberSpan.textContent = '1. '
    hAlpha.append(suppressedSpan, numberSpan, document.createTextNode('Alpha'))

    const hEmpty = document.createElement('h1')
    hEmpty.appendChild(document.createElement('br'))

    const quote = document.createElement('blockquote')
    const hQuoted = document.createElement('h1')
    hQuoted.textContent = 'Quoted Heading'
    quote.appendChild(hQuoted)

    const hSetext = document.createElement('h2')
    hSetext.textContent = 'Setext Only'

    const hBeta = document.createElement('h2')
    hBeta.textContent = 'Beta'

    container.append(hAlpha, hEmpty, quote, hSetext, hBeta)

    const stubRect = (top: number, height: number): DOMRect =>
      ({
        top,
        bottom: top + height,
        left: 0,
        right: 500,
        width: 500,
        height,
        x: 0,
        y: top,
        toJSON: () => ({})
      }) as DOMRect

    let scrollTop = 0
    Object.defineProperties(container, {
      scrollTop: { get: () => scrollTop, configurable: true },
      scrollHeight: { value: 1200, configurable: true },
      clientHeight: { value: 400, configurable: true }
    })

    container.getBoundingClientRect = () => stubRect(100, 400)
    hAlpha.getBoundingClientRect = () => stubRect(100 + 80 - scrollTop, 28)
    hEmpty.getBoundingClientRect = () => stubRect(100 + 220 - scrollTop, 28)
    hQuoted.getBoundingClientRect = () => stubRect(100 + 340 - scrollTop, 28)
    hSetext.getBoundingClientRect = () => stubRect(100 + 460 - scrollTop, 28)
    hBeta.getBoundingClientRect = () => stubRect(100 + 620 - scrollTop, 28)

    // Scrolled past Alpha, Empty, Quoted, Setext — right at Beta (offset 0 from container top)
    scrollTop = 620
    expect(measureActiveHeadingIndexInContainer(container, headings)).toBe(1)

    // Scrolled at Empty heading (Alpha already passed, Beta not reached) — stays on Alpha (0)
    scrollTop = 220
    expect(measureActiveHeadingIndexInContainer(container, headings)).toBe(0)
  })
})
