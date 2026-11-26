import { LanguageDescription } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import {
  highlightCodeWithParser,
  resolveCodeBlockParser,
  type CodeBlockHighlightSpan,
  type CodeParser
} from '../editor/codeBlockHighlight'

const MAX_SYNTAX_HIGHLIGHT_LINE_LENGTH = 2000
const MAX_CACHED_SYNTAX_LINES_PER_PARSER = 2000

const loadedParserCache = new Map<string, CodeParser | null>()
const pendingParserLoads = new Map<string, Promise<CodeParser | null>>()
const lineSyntaxSpanCache = new WeakMap<CodeParser, Map<string, CodeBlockHighlightSpan[]>>()

export interface DiffLanguageParserResolution {
  parser: CodeParser | null
  needsAsyncLoad: boolean
}

function getExtensionFromPath(filePath: string): string {
  const baseName = filePath.split(/[/\\]/).pop() ?? ''
  const dotIndex = baseName.lastIndexOf('.')
  if (dotIndex <= 0 || dotIndex === baseName.length - 1) {
    return ''
  }
  return baseName.slice(dotIndex + 1).toLowerCase()
}

/**
 * Synchronously resolves a bundled or already-cached language parser for the given file path.
 */
export function resolveDiffLanguageParserSync(filePath: string): DiffLanguageParserResolution {
  const ext = getExtensionFromPath(filePath)
  const bundledParser = ext ? resolveCodeBlockParser(ext) : null
  if (bundledParser) {
    return { parser: bundledParser, needsAsyncLoad: false }
  }

  const desc = LanguageDescription.matchFilename(languages, filePath)
  if (!desc) {
    return { parser: null, needsAsyncLoad: false }
  }
  if (loadedParserCache.has(desc.name)) {
    return { parser: loadedParserCache.get(desc.name) ?? null, needsAsyncLoad: false }
  }
  return { parser: null, needsAsyncLoad: true }
}

/**
 * Loads a Lezer parser for the given file path via `@codemirror/language-data`, caching results.
 */
export async function loadDiffLanguageParser(filePath: string): Promise<CodeParser | null> {
  const desc = LanguageDescription.matchFilename(languages, filePath)
  if (!desc) {
    return null
  }
  if (loadedParserCache.has(desc.name)) {
    return loadedParserCache.get(desc.name) ?? null
  }
  const existing = pendingParserLoads.get(desc.name)
  if (existing) {
    return existing
  }

  const promise = desc
    .load()
    .then((support) => {
      const parser = support.language.parser as CodeParser
      loadedParserCache.set(desc.name, parser)
      return parser
    })
    .catch(() => {
      loadedParserCache.set(desc.name, null)
      return null
    })
    .finally(() => {
      pendingParserLoads.delete(desc.name)
    })

  pendingParserLoads.set(desc.name, promise)
  return promise
}

/**
 * Computes syntax-highlight spans for a single diff line, falling back to plain text on
 * unsupported extensions, uncached async parsers, or abnormally long lines.
 */
export function getDiffLineSyntaxSpans(
  line: string,
  filePath: string,
  loadedParser?: CodeParser | null
): CodeBlockHighlightSpan[] {
  if (!line || line.length > MAX_SYNTAX_HIGHLIGHT_LINE_LENGTH) {
    return []
  }
  const parser =
    loadedParser !== undefined ? loadedParser : resolveDiffLanguageParserSync(filePath).parser
  if (!parser) {
    return []
  }

  let parserLineCache = lineSyntaxSpanCache.get(parser)
  if (parserLineCache) {
    const cached = parserLineCache.get(line)
    if (cached) {
      parserLineCache.delete(line)
      parserLineCache.set(line, cached)
      return cached
    }
  } else {
    parserLineCache = new Map<string, CodeBlockHighlightSpan[]>()
    lineSyntaxSpanCache.set(parser, parserLineCache)
  }

  const spans = highlightCodeWithParser(line, parser)
  if (parserLineCache.size >= MAX_CACHED_SYNTAX_LINES_PER_PARSER) {
    const oldestKey = parserLineCache.keys().next().value
    if (oldestKey !== undefined) {
      parserLineCache.delete(oldestKey)
    }
  }
  parserLineCache.set(line, spans)
  return spans
}
