import YAML, { type Document, type Pair } from 'yaml'
import type {
  FrontmatterFieldDefinition,
  WorkspaceFrontmatterSchema
} from './frontmatterSchema'

export {
  cloneFrontmatterSchema,
  createDefaultFrontmatterSchema,
  DEFAULT_FRONTMATTER_SCHEMA,
  FRONTMATTER_FIELD_TYPES,
  FRONTMATTER_SCHEMA_DIR,
  FRONTMATTER_SCHEMA_FILE,
  FRONTMATTER_SCHEMA_RELATIVE_PATH,
  FRONTMATTER_SCHEMA_VERSION,
  isValidFrontmatterFieldKey,
  parseFrontmatterSchema,
  parseFrontmatterSchemaJson,
  serializeFrontmatterSchema,
  type FrontmatterFieldDefinition,
  type FrontmatterFieldType,
  type FrontmatterOptionSpec,
  type FrontmatterSchemaLoadResult,
  type FrontmatterSchemaValidationResult,
  type WorkspaceFrontmatterSchema
} from './frontmatterSchema'

export type FrontmatterValidationCode =
  | 'yaml-syntax-error'
  | 'required-missing'
  | 'type-mismatch'
  | 'disallowed-option'
  | 'invalid-date-format'

export interface FrontmatterValidationIssue {
  key?: string
  code: FrontmatterValidationCode
  message: string
}

export type FrontmatterScalarValue = string | number | boolean
export type FrontmatterFieldValue = FrontmatterScalarValue | string[]

export interface ParsedFrontmatterDocument {
  hasFrontmatter: boolean
  rawBlock: string
  body: string
  bodyStartLine: number
  values: Record<string, FrontmatterFieldValue>
  unknownEntries: Array<{ key: string; rawValue: string }>
  issues: FrontmatterValidationIssue[]
}

export interface FrontmatterMutationOptions {
  createIfMissing?: boolean
}

export interface FrontmatterMutationResult {
  applied: boolean
  content: string
  error?: string
}

export interface FrontmatterBodySlice {
  body: string
  bodyStartLine: number
  bodyStartOffset: number
}

interface LineSpan {
  lineNumber: number
  start: number
  textEnd: number
  end: number
  text: string
  eol: '\r\n' | '\n' | '\r' | ''
}

interface FrontmatterSplit {
  hasBom: boolean
  hasOpeningDelimiter: boolean
  hasFrontmatter: boolean
  lineEnding: '\r\n' | '\n'
  openingDelimiter: string
  closingDelimiter: string
  yamlSource: string
  rawBlock: string
  body: string
  bodyStartLine: number
  bodyStartOffset: number
}

const OPENING_DELIMITER_RE = /^---[ \t]*$/
const CLOSING_DELIMITER_RE = /^(?:---|\.\.\.)[ \t]*$/
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/

export function isValidIsoCalendarDate(value: string): boolean {
  const match = ISO_DATE_RE.exec(value)
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) {
    return false
  }
  const date = new Date(Date.UTC(year, month - 1, day))
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  )
}

function toRepresentableFieldValue(raw: unknown): FrontmatterFieldValue | undefined {
  if (typeof raw === 'string' || typeof raw === 'boolean') {
    return raw
  }
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw
  }
  if (Array.isArray(raw) && raw.every((item) => typeof item === 'string')) {
    return [...raw]
  }
  return undefined
}

function requiredMissingIssue(field: FrontmatterFieldDefinition): FrontmatterValidationIssue | null {
  return field.required
    ? {
        key: field.key,
        code: 'required-missing',
        message: `필수 필드 "${field.label}" 값이 비어 있습니다.`
      }
    : null
}

function validateSchemaFieldValue(
  field: FrontmatterFieldDefinition,
  hasEntry: boolean,
  rawValue: unknown
): FrontmatterValidationIssue | null {
  const isMissing = !hasEntry || rawValue === null || rawValue === undefined
  if (isMissing) {
    return requiredMissingIssue(field)
  }

  switch (field.type) {
    case 'text':
      if (typeof rawValue !== 'string') {
        return {
          key: field.key,
          code: 'type-mismatch',
          message: `필드 "${field.label}" 값은 문자열이어야 합니다.`
        }
      }
      if (rawValue.trim() === '') {
        return requiredMissingIssue(field)
      }
      return null

    case 'number':
      if (typeof rawValue !== 'number' || !Number.isFinite(rawValue)) {
        return {
          key: field.key,
          code: 'type-mismatch',
          message: `필드 "${field.label}" 값은 유효한 숫자여야 합니다.`
        }
      }
      return null

    case 'boolean':
      if (typeof rawValue !== 'boolean') {
        return {
          key: field.key,
          code: 'type-mismatch',
          message: `필드 "${field.label}" 값은 true 또는 false여야 합니다.`
        }
      }
      return null

    case 'date':
      if (typeof rawValue === 'string' && rawValue.trim() === '') {
        return requiredMissingIssue(field)
      }
      if (typeof rawValue !== 'string' || !isValidIsoCalendarDate(rawValue)) {
        return {
          key: field.key,
          code: 'invalid-date-format',
          message: `필드 "${field.label}" 날짜는 실존하는 YYYY-MM-DD 형식이어야 합니다.`
        }
      }
      return null

    case 'select': {
      if (typeof rawValue !== 'string') {
        return {
          key: field.key,
          code: 'type-mismatch',
          message: `필드 "${field.label}" 값은 문자열 선택지여야 합니다.`
        }
      }
      if (rawValue.trim() === '') {
        return requiredMissingIssue(field)
      }
      const allowed = new Set((field.options ?? []).map((opt) => opt.value))
      if (!allowed.has(rawValue)) {
        return {
          key: field.key,
          code: 'disallowed-option',
          message: `필드 "${field.label}"에 허용되지 않은 옵션("${rawValue}")이 지정되었습니다.`
        }
      }
      return null
    }

    case 'multi-select': {
      if (!Array.isArray(rawValue) || rawValue.some((item) => typeof item !== 'string')) {
        return {
          key: field.key,
          code: 'type-mismatch',
          message: `필드 "${field.label}" 값은 문자열 목록이어야 합니다.`
        }
      }
      if (rawValue.length === 0) {
        return requiredMissingIssue(field)
      }
      if (!field.allowCustom) {
        const allowed = new Set((field.options ?? []).map((opt) => opt.value))
        const disallowed = rawValue.filter((item) => !allowed.has(item))
        if (disallowed.length > 0) {
          return {
            key: field.key,
            code: 'disallowed-option',
            message: `필드 "${field.label}"에 허용되지 않은 옵션(${disallowed.join(', ')})이 포함되어 있습니다.`
          }
        }
      }
      return null
    }
  }
}

interface ParsedYamlMappingState {
  yamlLf: string
  doc: Document
  syntaxError?: string
  entries: Array<{ key: string; rawValue: string; jsValue: unknown; pair: Pair }>
}

function normalizeYamlLf(yamlSource: string): string {
  return yamlSource.replace(/\r\n|\r/g, '\n')
}

function readYamlNodeRange(node: unknown): [number, number, number] | undefined {
  return (node as { range?: [number, number, number] } | null)?.range
}

function extractPairKeyName(pair: Pair, yamlLf: string): string | null {
  if (YAML.isScalar(pair.key)) {
    const val = pair.key.value
    if (val !== null && val !== undefined) {
      return String(val)
    }
  }
  const range = readYamlNodeRange(pair.key)
  if (range) {
    const raw = yamlLf.slice(range[0], range[1]).trim()
    return raw || null
  }
  return null
}

function extractPairRawValue(pair: Pair, yamlLf: string): string {
  const range = readYamlNodeRange(pair.value)
  if (!range) return ''
  return yamlLf.slice(range[0], range[1]).trim()
}

function parseYamlMapping(yamlSource: string): ParsedYamlMappingState {
  const yamlLf = normalizeYamlLf(yamlSource)
  const doc = YAML.parseDocument(yamlLf, {
    keepSourceTokens: true,
    prettyErrors: false,
    uniqueKeys: true
  })

  if (doc.errors.length > 0) {
    return {
      yamlLf,
      doc,
      syntaxError: doc.errors[0].message,
      entries: []
    }
  }

  if (doc.contents === null) {
    return { yamlLf, doc, entries: [] }
  }

  if (!YAML.isMap(doc.contents)) {
    return {
      yamlLf,
      doc,
      syntaxError: '프론트매터 루트는 key: value 형식의 YAML 매핑이어야 합니다.',
      entries: []
    }
  }

  const entries: ParsedYamlMappingState['entries'] = []
  for (const item of doc.contents.items) {
    const key = extractPairKeyName(item, yamlLf)
    if (key === null) continue
    const rawValue = extractPairRawValue(item, yamlLf)
    const jsValue = item.value && YAML.isNode(item.value) ? item.value.toJS(doc) : null
    entries.push({ key, rawValue, jsValue, pair: item })
  }

  return { yamlLf, doc, entries }
}

function readLineSpan(text: string, start: number, lineNumber: number): LineSpan {
  let cursor = start
  while (cursor < text.length && text[cursor] !== '\n' && text[cursor] !== '\r') {
    cursor += 1
  }
  const textEnd = cursor
  let eol: LineSpan['eol'] = ''
  if (cursor < text.length) {
    if (text[cursor] === '\r') {
      if (cursor + 1 < text.length && text[cursor + 1] === '\n') {
        eol = '\r\n'
        cursor += 2
      } else {
        eol = '\r'
        cursor += 1
      }
    } else {
      eol = '\n'
      cursor += 1
    }
  }
  return {
    lineNumber,
    start,
    textEnd,
    end: cursor,
    text: text.slice(start, textEnd),
    eol
  }
}

function createNonFrontmatterSplit(
  markdown: string,
  hasBom: boolean,
  lineEnding: '\r\n' | '\n',
  hasOpeningDelimiter = false,
  openingDelimiter = '---'
): FrontmatterSplit {
  return {
    hasBom,
    hasOpeningDelimiter,
    hasFrontmatter: false,
    lineEnding,
    openingDelimiter,
    closingDelimiter: '---',
    yamlSource: '',
    rawBlock: '',
    body: markdown,
    bodyStartLine: 1,
    bodyStartOffset: 0
  }
}

function splitFrontmatterRegion(markdown: string): FrontmatterSplit {
  const hasBom = markdown.startsWith('\uFEFF')
  const contentStart = hasBom ? 1 : 0
  const fallbackLineEnding: '\r\n' | '\n' = markdown.includes('\r\n') ? '\r\n' : '\n'

  if (contentStart >= markdown.length) {
    return createNonFrontmatterSplit(markdown, hasBom, fallbackLineEnding)
  }

  const firstLine = readLineSpan(markdown, contentStart, 1)
  if (!OPENING_DELIMITER_RE.test(firstLine.text)) {
    return createNonFrontmatterSplit(markdown, hasBom, fallbackLineEnding)
  }

  if (firstLine.eol === '') {
    return createNonFrontmatterSplit(markdown, hasBom, fallbackLineEnding, true, firstLine.text)
  }

  const yamlStart = firstLine.end
  let cursor = yamlStart
  let lineNumber = 2

  while (cursor < markdown.length) {
    const line = readLineSpan(markdown, cursor, lineNumber)
    if (CLOSING_DELIMITER_RE.test(line.text)) {
      const yamlSource = markdown.slice(yamlStart, line.start)
      const rawBlock = markdown.slice(contentStart, line.textEnd)
      const bodyStartOffset = line.end
      const body = markdown.slice(bodyStartOffset)
      const detectedEol =
        firstLine.eol === '\r\n' || line.eol === '\r\n' || yamlSource.includes('\r\n')
          ? '\r\n'
          : '\n'

      return {
        hasBom,
        hasOpeningDelimiter: true,
        hasFrontmatter: true,
        lineEnding: detectedEol,
        openingDelimiter: firstLine.text,
        closingDelimiter: line.text,
        yamlSource,
        rawBlock,
        body,
        bodyStartLine: line.lineNumber + 1,
        bodyStartOffset
      }
    }
    cursor = line.end
    lineNumber += 1
  }

  return createNonFrontmatterSplit(
    markdown,
    hasBom,
    firstLine.eol === '\r\n' ? '\r\n' : fallbackLineEnding,
    true,
    firstLine.text
  )
}

type InspectedFrontmatterDocument =
  | { kind: 'no-frontmatter'; split: FrontmatterSplit }
  | { kind: 'unclosed'; split: FrontmatterSplit; error: string }
  | { kind: 'syntax-error'; split: FrontmatterSplit; error: string }
  | { kind: 'ready'; split: FrontmatterSplit; parsedYaml: ParsedYamlMappingState }

function inspectFrontmatter(markdown: string): InspectedFrontmatterDocument {
  const split = splitFrontmatterRegion(markdown)
  if (!split.hasFrontmatter && split.hasOpeningDelimiter) {
    return {
      kind: 'unclosed',
      split,
      error: '프론트매터 닫는 구분선(`---` 또는 `...`)이 없습니다.'
    }
  }
  if (!split.hasFrontmatter) {
    return { kind: 'no-frontmatter', split }
  }

  const parsedYaml = parseYamlMapping(split.yamlSource)
  if (parsedYaml.syntaxError) {
    return {
      kind: 'syntax-error',
      split,
      error: `YAML 구문 오류: ${parsedYaml.syntaxError}`
    }
  }
  return { kind: 'ready', split, parsedYaml }
}

/**
 * Parses top-of-document YAML frontmatter, separating body and 1-based bodyStartLine,
 * extracting schema-defined values, unknown entries, and non-blocking validation issues.
 */
export function parseFrontmatterDocument(
  markdown: string,
  schema?: WorkspaceFrontmatterSchema | null
): ParsedFrontmatterDocument {
  const inspected = inspectFrontmatter(markdown)
  if (inspected.kind === 'no-frontmatter' || inspected.kind === 'unclosed') {
    return {
      hasFrontmatter: false,
      rawBlock: '',
      body: inspected.split.body,
      bodyStartLine: 1,
      values: {},
      unknownEntries: [],
      issues:
        inspected.kind === 'unclosed'
          ? [{ code: 'yaml-syntax-error', message: inspected.error }]
          : []
    }
  }

  if (inspected.kind === 'syntax-error') {
    return {
      hasFrontmatter: true,
      rawBlock: inspected.split.rawBlock,
      body: inspected.split.body,
      bodyStartLine: inspected.split.bodyStartLine,
      values: {},
      unknownEntries: [],
      issues: [{ code: 'yaml-syntax-error', message: inspected.error }]
    }
  }

  const { split, parsedYaml } = inspected

  const entriesByKey = new Map<string, ParsedYamlMappingState['entries'][number]>()
  for (const entry of parsedYaml.entries) {
    entriesByKey.set(entry.key, entry)
  }

  const fields = schema?.fields ?? []
  const schemaKeySet = new Set(fields.map((field) => field.key))
  const values: Record<string, FrontmatterFieldValue> = {}
  const issues: FrontmatterValidationIssue[] = []

  for (const field of fields) {
    const entry = entriesByKey.get(field.key)
    const hasEntry = entry !== undefined
    const rawValue = entry?.jsValue
    if (hasEntry && rawValue !== null && rawValue !== undefined) {
      const representable = toRepresentableFieldValue(rawValue)
      if (representable !== undefined) {
        values[field.key] = representable
      }
    }
    const issue = validateSchemaFieldValue(field, hasEntry, rawValue)
    if (issue) {
      issues.push(issue)
    }
  }

  const unknownEntries: Array<{ key: string; rawValue: string }> = []
  for (const entry of parsedYaml.entries) {
    if (!schemaKeySet.has(entry.key)) {
      unknownEntries.push({ key: entry.key, rawValue: entry.rawValue })
    }
  }

  return {
    hasFrontmatter: true,
    rawBlock: split.rawBlock,
    body: split.body,
    bodyStartLine: split.bodyStartLine,
    values,
    unknownEntries,
    issues
  }
}

function convertLfToLineEnding(textLf: string, lineEnding: '\r\n' | '\n'): string {
  return lineEnding === '\r\n' ? textLf.replace(/\n/g, '\r\n') : textLf
}

function areFieldValuesEqual(existing: unknown, next: FrontmatterFieldValue): boolean {
  if (Array.isArray(next)) {
    return (
      Array.isArray(existing) &&
      existing.length === next.length &&
      existing.every((item, index) => item === next[index])
    )
  }
  return existing === next
}

function serializeYamlPair(key: string, value: FrontmatterFieldValue): string {
  const serialized = YAML.stringify({ [key]: value }, { lineWidth: 0 })
  return serialized.endsWith('\n') ? serialized : `${serialized}\n`
}

interface CstTokenLike {
  type?: string
  source?: string
}

function findFirstLineCommentInTokens(tokens: readonly CstTokenLike[] | undefined): string {
  if (!tokens) return ''
  let precedingSpace = ''
  for (const token of tokens) {
    if (token.type === 'newline') break
    if (token.type === 'space') {
      precedingSpace = token.source ?? ''
      continue
    }
    if (token.type === 'comment' && token.source) {
      return `${precedingSpace || ' '}${token.source}`
    }
    precedingSpace = ''
  }
  return ''
}

function extractPairTrailingComment(
  pair: Pair,
  yamlLf: string,
  valRange: [number, number, number] | undefined
): string {
  const pairToken = pair as { srcToken?: { sep?: CstTokenLike[] } }
  const valToken = (pair.value as { srcToken?: { props?: CstTokenLike[] } } | null)?.srcToken
  const headerComment =
    findFirstLineCommentInTokens(pairToken.srcToken?.sep) ||
    findFirstLineCommentInTokens(valToken?.props)
  if (headerComment) {
    return headerComment
  }

  if (valRange && valRange[1] > 0 && yamlLf[valRange[1] - 1] !== '\n') {
    const valLineEnd = nextLineEnd(yamlLf, valRange[1])
    const textEnd = valLineEnd > 0 && yamlLf[valLineEnd - 1] === '\n' ? valLineEnd - 1 : valLineEnd
    const trailing = yamlLf.slice(valRange[1], textEnd)
    if (trailing.trim().length > 0) {
      const gap = trailing.startsWith(' ') || trailing.startsWith('\t') ? '' : ' '
      return `${gap}${trailing}`
    }
  }
  return ''
}

function lastNewlineIndex(text: string, beforeOffset: number): number {
  const clamped = Math.max(0, Math.min(beforeOffset, text.length))
  return clamped === 0 ? -1 : text.lastIndexOf('\n', clamped - 1)
}

function nextLineEnd(text: string, offset: number): number {
  const clamped = Math.max(0, Math.min(offset, text.length))
  const lfIdx = text.indexOf('\n', clamped)
  return lfIdx === -1 ? text.length : lfIdx + 1
}

interface TextEdit {
  start: number
  end: number
  replacement: string
}

function buildPairUpdateEdit(
  yamlLf: string,
  pair: Pair,
  key: string,
  nextVal: FrontmatterFieldValue | null | undefined
): TextEdit {
  const keyRange = readYamlNodeRange(pair.key)
  const valRange = readYamlNodeRange(pair.value)
  const pairStart = keyRange?.[0] ?? 0
  const lineStart = lastNewlineIndex(yamlLf, pairStart) + 1
  const firstLineEnd = nextLineEnd(yamlLf, keyRange?.[1] ?? pairStart)
  // Use valRange[1] (value end) rather than valRange[2] (node end): yaml attaches
  // subsequent standalone `# comment` lines onto empty/null scalars in range[2].
  const valueEnd = valRange && valRange[1] > firstLineEnd ? valRange[1] : firstLineEnd
  const blockEnd =
    valueEnd > lineStart && yamlLf[valueEnd - 1] === '\n' ? valueEnd : nextLineEnd(yamlLf, valueEnd)

  if (nextVal === null || nextVal === undefined) {
    return { start: lineStart, end: blockEnd, replacement: '' }
  }

  const colonIdx = yamlLf.indexOf(':', keyRange?.[1] ?? pairStart)
  if (colonIdx === -1 || colonIdx >= firstLineEnd) {
    return { start: lineStart, end: blockEnd, replacement: serializeYamlPair(key, nextVal) }
  }

  const preservedKeyAndColon = yamlLf.slice(lineStart, colonIdx + 1)
  // Prefix '_v:' is 3 ASCII chars, so slicing past it extracts the formatted value cleanly.
  const valueAfterColon = serializeYamlPair('_v', nextVal).slice(3)
  const commentSuffix = extractPairTrailingComment(pair, yamlLf, valRange)
  const firstValLf = valueAfterColon.slice(0, -1).indexOf('\n')

  if (firstValLf === -1) {
    return {
      start: lineStart,
      end: blockEnd,
      replacement: `${preservedKeyAndColon}${valueAfterColon.slice(0, -1)}${commentSuffix}\n`
    }
  }

  const headerSuffix = valueAfterColon.slice(0, firstValLf)
  const trimmedHeader = headerSuffix.trim()
  if (trimmedHeader === '' || trimmedHeader.startsWith('|') || trimmedHeader.startsWith('>')) {
    const blockBody = valueAfterColon.slice(firstValLf + 1)
    return {
      start: lineStart,
      end: blockEnd,
      replacement: `${preservedKeyAndColon}${headerSuffix}${commentSuffix}\n${blockBody}`
    }
  }

  return { start: lineStart, end: blockEnd, replacement: serializeYamlPair(key, nextVal) }
}

function patchFlowRootDocument(
  doc: Document,
  patch: Record<string, FrontmatterFieldValue | null | undefined>
): string {
  for (const [key, nextVal] of Object.entries(patch)) {
    if (nextVal === null || nextVal === undefined) {
      doc.delete(key)
    } else {
      doc.set(key, nextVal)
    }
  }
  const rendered = doc.toString({ lineWidth: 0 })
  return rendered === '{}\n' || rendered === 'null\n' ? '' : rendered
}

function getBomPrefix(hasBom: boolean): string {
  return hasBom ? '\uFEFF' : ''
}

function sliceSeparatorAfterClosing(markdown: string, split: FrontmatterSplit): string {
  const contentStart = split.hasBom ? 1 : 0
  return markdown.slice(contentStart + split.rawBlock.length, split.bodyStartOffset)
}

type MutableFrontmatterGuard =
  | { ok: false; result: FrontmatterMutationResult }
  | {
      ok: true
      state: Extract<InspectedFrontmatterDocument, { kind: 'no-frontmatter' | 'ready' }>
    }

function inspectFrontmatterForMutation(markdown: string): MutableFrontmatterGuard {
  const state = inspectFrontmatter(markdown)
  if (state.kind === 'unclosed' || state.kind === 'syntax-error') {
    return {
      ok: false,
      result: {
        applied: false,
        content: markdown,
        error: state.error
      }
    }
  }
  return { ok: true, state }
}

/**
 * Non-destructively updates, adds, or removes frontmatter fields while preserving
 * unedited fields, unknown keys, YAML comments, nested values, BOM, and line endings.
 * Refuses to overwrite documents that contain YAML syntax errors.
 */
export function applyFrontmatterValues(
  markdown: string,
  patch: Record<string, FrontmatterFieldValue | null | undefined>,
  options: FrontmatterMutationOptions = {}
): FrontmatterMutationResult {
  const guard = inspectFrontmatterForMutation(markdown)
  if (!guard.ok) {
    return guard.result
  }
  const { state } = guard

  const patchEntries = Object.entries(patch)
  if (state.kind === 'no-frontmatter') {
    const { split } = state
    const additions = patchEntries.filter(
      (entry): entry is [string, FrontmatterFieldValue] =>
        entry[1] !== null && entry[1] !== undefined
    )
    if (additions.length === 0 && !options.createIfMissing) {
      return { applied: true, content: markdown }
    }
    const yamlLf = additions.map(([key, val]) => serializeYamlPair(key, val)).join('')
    const yamlBody = convertLfToLineEnding(yamlLf, split.lineEnding)
    const bodyWithoutBom = split.hasBom ? markdown.slice(1) : markdown
    const prefix = getBomPrefix(split.hasBom)
    return {
      applied: true,
      content: `${prefix}---${split.lineEnding}${yamlBody}---${split.lineEnding}${bodyWithoutBom}`
    }
  }

  const { split, parsedYaml } = state
  let nextYamlLf: string
  if (
    parsedYaml.doc.contents !== null &&
    YAML.isMap(parsedYaml.doc.contents) &&
    parsedYaml.doc.contents.flow === true
  ) {
    nextYamlLf = patchFlowRootDocument(parsedYaml.doc, patch)
  } else {
    const entriesByKey = new Map(parsedYaml.entries.map((entry) => [entry.key, entry]))
    const edits: TextEdit[] = []
    const additions: string[] = []

    for (const [key, nextVal] of patchEntries) {
      const existing = entriesByKey.get(key)
      if (!existing) {
        if (nextVal !== null && nextVal !== undefined) {
          additions.push(serializeYamlPair(key, nextVal))
        }
        continue
      }

      if (nextVal !== null && nextVal !== undefined && areFieldValuesEqual(existing.jsValue, nextVal)) {
        continue
      }

      edits.push(buildPairUpdateEdit(parsedYaml.yamlLf, existing.pair, key, nextVal))
    }

    if (edits.length === 0 && additions.length === 0) {
      return { applied: true, content: markdown }
    }

    let updated = parsedYaml.yamlLf
    for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
      updated = `${updated.slice(0, edit.start)}${edit.replacement}${updated.slice(edit.end)}`
    }

    if (additions.length > 0) {
      if (updated.length > 0 && !updated.endsWith('\n')) {
        updated += '\n'
      }
      updated += additions.join('')
    }

    nextYamlLf = updated
  }

  const separatorAfterClosing = sliceSeparatorAfterClosing(markdown, split)
  const prefix = getBomPrefix(split.hasBom)
  const nextYaml = convertLfToLineEnding(nextYamlLf, split.lineEnding)
  const nextRawBlock = `${split.openingDelimiter}${split.lineEnding}${nextYaml}${split.closingDelimiter}`
  return {
    applied: true,
    content: `${prefix}${nextRawBlock}${separatorAfterClosing}${split.body}`
  }
}

/**
 * Removes a valid closed frontmatter block from a document while preserving BOM and body.
 * Refuses to overwrite documents that contain YAML syntax errors.
 */
export function removeFrontmatterBlock(markdown: string): FrontmatterMutationResult {
  const guard = inspectFrontmatterForMutation(markdown)
  if (!guard.ok) {
    return guard.result
  }
  if (guard.state.kind === 'no-frontmatter') {
    return { applied: true, content: markdown }
  }

  const prefix = getBomPrefix(guard.state.split.hasBom)
  return {
    applied: true,
    content: `${prefix}${guard.state.split.body}`
  }
}

const LEADING_BLANK_LINES_RE = /^(?:[ \t]*\r?\n)+/

/**
 * Splits top-of-document YAML frontmatter boundaries from markdown body without running full YAML AST parsing.
 */
export function extractFrontmatterBody(markdown: string): FrontmatterBodySlice {
  const split = splitFrontmatterRegion(markdown)
  return {
    body: split.body,
    bodyStartLine: split.bodyStartLine,
    bodyStartOffset: split.bodyStartOffset
  }
}

/**
 * Returns true when a 1-based line number falls inside a closed YAML frontmatter block.
 */
export function isLineInFrontmatter(markdown: string, lineNumber: number): boolean {
  if (lineNumber < 1) return false
  const split = splitFrontmatterRegion(markdown)
  return split.hasFrontmatter && lineNumber < split.bodyStartLine
}

/**
 * Returns true when a 0-based character offset falls inside a closed YAML frontmatter block.
 */
export function isOffsetInFrontmatter(markdown: string, offset: number): boolean {
  if (offset < 0) return false
  const split = splitFrontmatterRegion(markdown)
  return split.hasFrontmatter && offset < split.bodyStartOffset
}

/**
 * Recombines the original document's frontmatter prefix (BOM, rawBlock, comments, unknown keys,
 * closing delimiter, trailing separator, and leading body blank lines/line endings) with an updated body.
 */
export function replaceFrontmatterBody(originalMarkdown: string, nextBody: string): string {
  const split = splitFrontmatterRegion(originalMarkdown)
  const prefix = getBomPrefix(split.hasBom)
  if (!split.hasFrontmatter) {
    if (split.hasBom && !nextBody.startsWith('\uFEFF')) {
      return `\uFEFF${nextBody}`
    }
    return nextBody
  }

  if (nextBody === split.body) {
    return originalMarkdown
  }

  const separatorAfterClosing = sliceSeparatorAfterClosing(originalMarkdown, split)
  const effectiveSeparator =
    separatorAfterClosing || (nextBody.length > 0 ? split.lineEnding : '')

  if (nextBody.length === 0) {
    return `${prefix}${split.rawBlock}${effectiveSeparator}`
  }

  const bodyLineEnding: '\r\n' | '\n' = split.body.includes('\r\n')
    ? '\r\n'
    : split.body.includes('\n')
      ? '\n'
      : split.lineEnding
  const normalizedBody = convertLfToLineEnding(nextBody.replace(/\r\n?/g, '\n'), bodyLineEnding)
  const leadingBlankMatch = LEADING_BLANK_LINES_RE.exec(split.body)
  const leadingBlank =
    leadingBlankMatch && !LEADING_BLANK_LINES_RE.test(normalizedBody) ? leadingBlankMatch[0] : ''

  return `${prefix}${split.rawBlock}${effectiveSeparator}${leadingBlank}${normalizedBody}`
}
