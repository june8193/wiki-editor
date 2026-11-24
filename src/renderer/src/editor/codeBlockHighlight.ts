import { cppLanguage } from '@codemirror/lang-cpp'
import { cssLanguage } from '@codemirror/lang-css'
import { goLanguage } from '@codemirror/lang-go'
import { htmlLanguage } from '@codemirror/lang-html'
import { javaLanguage } from '@codemirror/lang-java'
import {
  javascriptLanguage,
  jsxLanguage,
  tsxLanguage,
  typescriptLanguage
} from '@codemirror/lang-javascript'
import { jsonLanguage } from '@codemirror/lang-json'
import { lessLanguage } from '@codemirror/lang-less'
import { markdownLanguage } from '@codemirror/lang-markdown'
import { phpLanguage } from '@codemirror/lang-php'
import { pythonLanguage } from '@codemirror/lang-python'
import { rustLanguage } from '@codemirror/lang-rust'
import { sass, sassLanguage } from '@codemirror/lang-sass'
import { StandardSQL } from '@codemirror/lang-sql'
import { xmlLanguage } from '@codemirror/lang-xml'
import { yamlLanguage } from '@codemirror/lang-yaml'
import { StreamLanguage } from '@codemirror/language'
import { json as legacyJson } from '@codemirror/legacy-modes/mode/javascript'
import { shell } from '@codemirror/legacy-modes/mode/shell'
import { highlightCode, tagHighlighter, tags } from '@lezer/highlight'

export interface CodeBlockLanguageOption {
  readonly value: string
  readonly label: string
  readonly aliases: readonly string[]
}

export interface CodeBlockHighlightSpan {
  readonly from: number
  readonly to: number
  readonly className: string
}

type HighlightTree = Parameters<typeof highlightCode>[1]

export interface CodeParser {
  parse(input: string): HighlightTree
}

interface LanguageSpec extends CodeBlockLanguageOption {
  readonly parser?: CodeParser
  readonly isPreset?: boolean
}

const shellParser: CodeParser = StreamLanguage.define(shell).parser
const jsoncParser: CodeParser = StreamLanguage.define({
  ...legacyJson,
  tokenTable: { property: tags.propertyName }
}).parser
const indentedSassParser: CodeParser = sass({ indented: true }).language.parser

const LANGUAGE_SPECS: readonly LanguageSpec[] = [
  { value: '', label: 'Plain Text', aliases: ['text', 'plaintext', 'txt', 'plain'], isPreset: true },
  { value: 'c', label: 'C', aliases: ['h'], parser: cppLanguage.parser, isPreset: true },
  {
    value: 'cpp',
    label: 'C++',
    aliases: ['c++', 'cc', 'cxx', 'hpp', 'hxx'],
    parser: cppLanguage.parser,
    isPreset: true
  },
  { value: 'python', label: 'Python', aliases: ['py'], parser: pythonLanguage.parser, isPreset: true },
  {
    value: 'javascript',
    label: 'JavaScript',
    aliases: ['js', 'mjs', 'cjs'],
    parser: javascriptLanguage.parser,
    isPreset: true
  },
  {
    value: 'typescript',
    label: 'TypeScript',
    aliases: ['ts', 'mts', 'cts'],
    parser: typescriptLanguage.parser,
    isPreset: true
  },
  { value: 'json', label: 'JSON', aliases: [], parser: jsonLanguage.parser, isPreset: true },
  { value: 'html', label: 'HTML', aliases: ['htm'], parser: htmlLanguage.parser, isPreset: true },
  {
    value: 'css',
    label: 'CSS',
    aliases: [],
    parser: cssLanguage.parser,
    isPreset: true
  },
  { value: 'yaml', label: 'YAML', aliases: ['yml'], parser: yamlLanguage.parser, isPreset: true },
  {
    value: 'markdown',
    label: 'Markdown',
    aliases: ['md', 'mkd'],
    parser: markdownLanguage.parser,
    isPreset: true
  },
  { value: 'mermaid', label: 'Mermaid', aliases: [], isPreset: true },
  { value: 'jsx', label: 'JSX', aliases: [], parser: jsxLanguage.parser },
  { value: 'tsx', label: 'TSX', aliases: [], parser: tsxLanguage.parser },
  { value: 'scss', label: 'SCSS', aliases: [], parser: sassLanguage.parser },
  { value: 'sass', label: 'Sass', aliases: [], parser: indentedSassParser },
  { value: 'less', label: 'LESS', aliases: [], parser: lessLanguage.parser },
  { value: 'jsonc', label: 'JSONC', aliases: [], parser: jsoncParser },
  { value: 'bash', label: 'Bash', aliases: ['sh', 'shell'], parser: shellParser },
  { value: 'zsh', label: 'Zsh', aliases: [], parser: shellParser },
  { value: 'sql', label: 'SQL', aliases: [], parser: StandardSQL.language.parser },
  { value: 'java', label: 'Java', aliases: [], parser: javaLanguage.parser },
  { value: 'go', label: 'Go', aliases: ['golang'], parser: goLanguage.parser },
  { value: 'rust', label: 'Rust', aliases: ['rs'], parser: rustLanguage.parser },
  { value: 'xml', label: 'XML', aliases: ['svg'], parser: xmlLanguage.parser },
  { value: 'php', label: 'PHP', aliases: [], parser: phpLanguage.parser }
]

export const CODE_BLOCK_LANGUAGE_OPTIONS: readonly CodeBlockLanguageOption[] = LANGUAGE_SPECS
  .filter((spec) => spec.isPreset)
  .map(({ value, label, aliases }) => ({ value, label, aliases }))

const SPEC_BY_LOOKUP = new Map<string, LanguageSpec>()

for (const spec of LANGUAGE_SPECS) {
  const keys = [spec.value, spec.label, ...spec.aliases]
    .map((key) => key.toLowerCase())
    .filter(Boolean)

  for (const key of keys) {
    SPEC_BY_LOOKUP.set(key, spec)
  }
}

const codeTagHighlighter = tagHighlighter([
  {
    tag: [
      tags.function(tags.variableName),
      tags.function(tags.propertyName),
      tags.function(tags.definition(tags.variableName)),
      tags.standard(tags.function(tags.variableName))
    ],
    class: 'tok-function'
  },
  {
    tag: [
      tags.keyword,
      tags.controlKeyword,
      tags.definitionKeyword,
      tags.moduleKeyword,
      tags.operatorKeyword,
      tags.modifier
    ],
    class: 'tok-keyword'
  },
  {
    tag: [tags.string, tags.special(tags.string), tags.attributeValue, tags.regexp],
    class: 'tok-string'
  },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], class: 'tok-number' },
  {
    tag: [
      tags.comment,
      tags.lineComment,
      tags.blockComment,
      tags.docComment,
      tags.meta,
      tags.processingInstruction
    ],
    class: 'tok-comment'
  },
  {
    tag: [tags.typeName, tags.className, tags.standard(tags.typeName), tags.tagName, tags.namespace],
    class: 'tok-type'
  },
  {
    tag: [tags.propertyName, tags.attributeName, tags.labelName, tags.definition(tags.propertyName)],
    class: 'tok-property'
  },
  {
    tag: [tags.variableName, tags.definition(tags.variableName), tags.special(tags.variableName)],
    class: 'tok-variable'
  },
  {
    tag: [
      tags.operator,
      tags.compareOperator,
      tags.logicOperator,
      tags.arithmeticOperator,
      tags.updateOperator
    ],
    class: 'tok-operator'
  },
  {
    tag: [
      tags.heading,
      tags.heading1,
      tags.heading2,
      tags.heading3,
      tags.heading4,
      tags.heading5,
      tags.heading6
    ],
    class: 'tok-heading'
  }
])

function resolveParser(language: string | null | undefined): CodeParser | null {
  if (!language) {
    return null
  }
  const normalized = language.trim().toLowerCase()
  if (!normalized) {
    return null
  }
  return SPEC_BY_LOOKUP.get(normalized)?.parser ?? null
}

/**
 * Returns whether a fence language identifier designates a Mermaid diagram block.
 */
export function isMermaidLanguage(language: string | null | undefined): boolean {
  return typeof language === 'string' && language.trim().toLowerCase() === 'mermaid'
}

/**
 * Filters preset code block language options matching a user search query.
 */
export function filterCodeBlockLanguageOptions(
  query: string
): readonly CodeBlockLanguageOption[] {
  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery) {
    return CODE_BLOCK_LANGUAGE_OPTIONS
  }
  return CODE_BLOCK_LANGUAGE_OPTIONS.filter(
    (option) =>
      option.label.toLowerCase().includes(normalizedQuery) ||
      option.value.toLowerCase().includes(normalizedQuery) ||
      option.aliases.some((alias) => alias.toLowerCase().includes(normalizedQuery))
  )
}

/**
 * Formats a Markdown code block language identifier into a human-friendly display label.
 */
export function formatCodeBlockLanguageLabel(language: string | null | undefined): string {
  const trimmed = typeof language === 'string' ? language.trim() : ''
  if (!trimmed) {
    return 'Plain Text'
  }
  const spec = SPEC_BY_LOOKUP.get(trimmed.toLowerCase())
  return spec ? spec.label : trimmed
}

/**
 * Resolves user-entered language text from the WYSIWYG combobox into a canonical Markdown fence identifier.
 */
export function resolveCanonicalLanguageInput(input: string): string {
  const trimmed = input.replace(/[`~]+/g, '').trim()
  if (!trimmed) {
    return ''
  }
  const normalized = trimmed.toLowerCase()
  const spec = SPEC_BY_LOOKUP.get(normalized)
  if (spec?.isPreset) {
    return spec.value
  }
  return normalized.replace(/\s+/g, '-')
}

/**
 * Computes syntax-highlight spans (`[from, to)`) for a code string using a Lezer parser.
 */
export function highlightCodeWithParser(
  code: string,
  parser: CodeParser
): CodeBlockHighlightSpan[] {
  if (!code) {
    return []
  }
  const tree = parser.parse(code)
  const spans: CodeBlockHighlightSpan[] = []
  let offset = 0

  highlightCode(
    code,
    tree,
    codeTagHighlighter,
    (text, classes) => {
      const from = offset
      const to = offset + text.length
      offset = to
      if (classes && to > from) {
        spans.push({ from, to, className: classes })
      }
    },
    () => {
      offset += 1
    }
  )

  return spans
}

/**
 * Computes syntax-highlight spans (`[from, to)`) for a code string in the specified language.
 */
export function getCodeBlockHighlightSpans(
  code: string,
  language: string | null | undefined
): CodeBlockHighlightSpan[] {
  if (!code) {
    return []
  }
  const parser = resolveParser(language)
  if (!parser) {
    return []
  }
  return highlightCodeWithParser(code, parser)
}
