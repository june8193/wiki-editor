import {
  normalizeLineEndingsToLf,
  parseMarkdownHeadings
} from '../editor/MarkdownTocEngine'

export interface ManualTocItem {
  level: 2 | 3
  title: string
  slug: string
  line: number
}

export interface ManualSection {
  title: string
  slug: string
  markdown: string
  tocItems: ManualTocItem[]
}

export interface ParsedManualDocument {
  rawMarkdown: string
  preamble: string
  sections: ManualSection[]
  tocItems: ManualTocItem[]
}

export interface FilteredManualDocument {
  isFiltered: boolean
  markdown: string
  tocItems: ManualTocItem[]
  matchedSectionCount: number
  totalSectionCount: number
}

function toTocItems(markdown: string): ManualTocItem[] {
  return parseMarkdownHeadings(markdown)
    .filter((heading): heading is typeof heading & { level: 2 | 3 } => {
      return heading.level === 2 || heading.level === 3
    })
    .map((heading) => ({
      level: heading.level,
      title: heading.title,
      slug: heading.slug,
      line: heading.line
    }))
}

/**
 * Parses a Markdown manual into a preamble, level-2 sections, and h2/h3 TOC items.
 */
export function parseManualDocument(markdown: string): ParsedManualDocument {
  const normalized = normalizeLineEndingsToLf(markdown)
  const lines = normalized.split('\n')
  const tocItems = toTocItems(normalized)
  const level2Headings = tocItems.filter((item) => item.level === 2)

  if (level2Headings.length === 0) {
    return {
      rawMarkdown: normalized,
      preamble: normalized,
      sections: [],
      tocItems
    }
  }

  const firstSectionStartIndex = level2Headings[0].line - 1
  const preamble = lines.slice(0, firstSectionStartIndex).join('\n').trimEnd()

  const sections: ManualSection[] = level2Headings.map((heading, idx) => {
    const startLine = heading.line
    const nextHeading = level2Headings[idx + 1]
    const endLine = nextHeading ? nextHeading.line - 1 : lines.length
    const sectionMarkdown = lines.slice(startLine - 1, endLine).join('\n').trimEnd()
    const sectionTocItems = tocItems.filter(
      (item) => item.line >= startLine && item.line <= endLine
    )

    return {
      title: heading.title,
      slug: heading.slug,
      markdown: sectionMarkdown,
      tocItems: sectionTocItems
    }
  })

  return {
    rawMarkdown: normalized,
    preamble,
    sections,
    tocItems
  }
}

/**
 * Filters parsed manual sections case-insensitively by keyword and returns matching markdown and TOC items.
 */
export function filterManualDocument(
  parsed: ParsedManualDocument,
  query: string
): FilteredManualDocument {
  const trimmedQuery = query.trim()
  const totalSectionCount = parsed.sections.length

  if (!trimmedQuery) {
    return {
      isFiltered: false,
      markdown: parsed.rawMarkdown,
      tocItems: parsed.tocItems,
      matchedSectionCount: totalSectionCount,
      totalSectionCount
    }
  }

  const lowerQuery = trimmedQuery.toLowerCase()
  const matchedSections = parsed.sections.filter((section) =>
    section.markdown.toLowerCase().includes(lowerQuery)
  )
  const markdown = matchedSections.map((section) => section.markdown).join('\n\n')
  const tocItems = markdown ? toTocItems(markdown) : []

  return {
    isFiltered: true,
    markdown,
    tocItems,
    matchedSectionCount: matchedSections.length,
    totalSectionCount
  }
}
