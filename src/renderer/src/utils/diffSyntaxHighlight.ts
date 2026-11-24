import { LanguageDescription } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import {
  getCodeBlockHighlightSpans,
  highlightCodeWithParser,
  type CodeBlockHighlightSpan,
  type CodeParser
} from '../editor/codeBlockHighlight'

const MAX_SYNTAX_HIGHLIGHT_LINE_LENGTH = 2000

const loadedParserCache = new Map<string, CodeParser | null>()
const pendingParserLoads = new Map<string, Promise<CodeParser | null>>()

function getExtensionFromPath(filePath: string): string {
  const baseName = filePath.split(/[/\\]/).pop() ?? ''
  const dotIndex = baseName.lastIndexOf('.')
  if (dotIndex <= 0 || dotIndex === baseName.length - 1) {
    return ''
  }
  return baseName.slice(dotIndex + 1).toLowerCase()
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
 * unsupported extensions or abnormally long lines.
 */
export function getDiffLineSyntaxSpans(
  line: string,
  filePath: string,
  loadedParser?: CodeParser | null
): CodeBlockHighlightSpan[] {
  if (!line || line.length > MAX_SYNTAX_HIGHLIGHT_LINE_LENGTH) {
    return []
  }
  if (loadedParser) {
    return highlightCodeWithParser(line, loadedParser)
  }
  const ext = getExtensionFromPath(filePath)
  if (!ext) {
    return []
  }
  return getCodeBlockHighlightSpans(line, ext)
}
