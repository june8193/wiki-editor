import YAML, { type Document, type Pair } from 'yaml'
import { isPlainRecord } from './config'

export type FrontmatterFieldType =
  | 'text'
  | 'number'
  | 'boolean'
  | 'date'
  | 'select'
  | 'multi-select'

export interface FrontmatterOptionSpec {
  value: string
  color?: string
}

export interface FrontmatterFieldDefinition {
  key: string
  label: string
  type: FrontmatterFieldType
  required?: boolean
  placeholder?: string
  options?: FrontmatterOptionSpec[]
  allowCustom?: boolean
  showInSearchBadge?: boolean
}

export interface WorkspaceFrontmatterSchema {
  version: 1
  fields: FrontmatterFieldDefinition[]
}

export interface FrontmatterSchemaLoadResult {
  exists: boolean
  path: string
  schema: WorkspaceFrontmatterSchema | null
  error?: string
}

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

function validateSchemaFieldValue(
  field: FrontmatterFieldDefinition,
  hasEntry: boolean,
  rawValue: unknown
): FrontmatterValidationIssue | null {
  const isMissing = !hasEntry || rawValue === null || rawValue === undefined
  if (isMissing) {
    return field.required
      ? {
          key: field.key,
          code: 'required-missing',
          message: `필수 필드 "${field.label}" 값이 비어 있습니다.`
        }
      : null
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
      if (field.required && rawValue.trim() === '') {
        return {
          key: field.key,
          code: 'required-missing',
          message: `필수 필드 "${field.label}" 값이 비어 있습니다.`
        }
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
        return field.required
          ? {
              key: field.key,
              code: 'required-missing',
              message: `필수 필드 "${field.label}" 값이 비어 있습니다.`
            }
          : null
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
        return field.required
          ? {
              key: field.key,
              code: 'required-missing',
              message: `필수 필드 "${field.label}" 값이 비어 있습니다.`
            }
          : null
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
        return field.required
          ? {
              key: field.key,
              code: 'required-missing',
              message: `필수 필드 "${field.label}" 값이 비어 있습니다.`
            }
          : null
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

function extractPairKeyName(pair: Pair, yamlLf: string): string | null {
  if (YAML.isScalar(pair.key)) {
    const val = pair.key.value
    if (val !== null && val !== undefined) {
      return String(val)
    }
  }
  const range = (pair.key as { range?: [number, number, number] } | null)?.range
  if (range) {
    const raw = yamlLf.slice(range[0], range[1]).trim()
    return raw || null
  }
  return null
}

function extractPairRawValue(pair: Pair, yamlLf: string): string {
  const range = (pair.value as { range?: [number, number, number] } | null)?.range
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

function splitFrontmatterRegion(markdown: string): FrontmatterSplit {
  const hasBom = markdown.startsWith('\uFEFF')
  const contentStart = hasBom ? 1 : 0
  const fallbackLineEnding: '\r\n' | '\n' = markdown.includes('\r\n') ? '\r\n' : '\n'

  if (contentStart >= markdown.length) {
    return {
      hasBom,
      hasOpeningDelimiter: false,
      hasFrontmatter: false,
      lineEnding: fallbackLineEnding,
      openingDelimiter: '---',
      closingDelimiter: '---',
      yamlSource: '',
      rawBlock: '',
      body: markdown,
      bodyStartLine: 1,
      bodyStartOffset: 0
    }
  }

  const firstLine = readLineSpan(markdown, contentStart, 1)
  if (!OPENING_DELIMITER_RE.test(firstLine.text)) {
    return {
      hasBom,
      hasOpeningDelimiter: false,
      hasFrontmatter: false,
      lineEnding: fallbackLineEnding,
      openingDelimiter: '---',
      closingDelimiter: '---',
      yamlSource: '',
      rawBlock: '',
      body: markdown,
      bodyStartLine: 1,
      bodyStartOffset: 0
    }
  }

  if (firstLine.eol === '') {
    return {
      hasBom,
      hasOpeningDelimiter: true,
      hasFrontmatter: false,
      lineEnding: fallbackLineEnding,
      openingDelimiter: firstLine.text,
      closingDelimiter: '---',
      yamlSource: '',
      rawBlock: '',
      body: markdown,
      bodyStartLine: 1,
      bodyStartOffset: 0
    }
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

  return {
    hasBom,
    hasOpeningDelimiter: true,
    hasFrontmatter: false,
    lineEnding: firstLine.eol === '\r\n' ? '\r\n' : fallbackLineEnding,
    openingDelimiter: firstLine.text,
    closingDelimiter: '---',
    yamlSource: '',
    rawBlock: '',
    body: markdown,
    bodyStartLine: 1,
    bodyStartOffset: 0
  }
}

/**
 * Parses top-of-document YAML frontmatter, separating body and 1-based bodyStartLine,
 * extracting schema-defined values, unknown entries, and non-blocking validation issues.
 */
export function parseFrontmatterDocument(
  markdown: string,
  schema?: WorkspaceFrontmatterSchema | null
): ParsedFrontmatterDocument {
  const split = splitFrontmatterRegion(markdown)
  if (!split.hasFrontmatter) {
    const issues: FrontmatterValidationIssue[] = split.hasOpeningDelimiter
      ? [
          {
            code: 'yaml-syntax-error',
            message: '프론트매터 닫는 구분선(`---` 또는 `...`)이 없습니다.'
          }
        ]
      : []

    return {
      hasFrontmatter: false,
      rawBlock: '',
      body: split.body,
      bodyStartLine: 1,
      values: {},
      unknownEntries: [],
      issues
    }
  }

  const parsedYaml = parseYamlMapping(split.yamlSource)
  if (parsedYaml.syntaxError) {
    return {
      hasFrontmatter: true,
      rawBlock: split.rawBlock,
      body: split.body,
      bodyStartLine: split.bodyStartLine,
      values: {},
      unknownEntries: [],
      issues: [
        {
          code: 'yaml-syntax-error',
          message: `YAML 구문 오류: ${parsedYaml.syntaxError}`
        }
      ]
    }
  }

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
  const keyRange = (pair.key as { range?: [number, number, number] } | null)?.range
  const valRange = (pair.value as { range?: [number, number, number] } | null)?.range
  const pairStart = keyRange?.[0] ?? 0
  const lineStart = lastNewlineIndex(yamlLf, pairStart) + 1
  const firstLineEnd = nextLineEnd(yamlLf, keyRange?.[1] ?? pairStart)
  const nodeEnd = valRange?.[2] ?? firstLineEnd
  const blockEnd =
    nodeEnd > lineStart && yamlLf[nodeEnd - 1] === '\n' ? nodeEnd : nextLineEnd(yamlLf, nodeEnd)

  if (nextVal === null || nextVal === undefined) {
    return { start: lineStart, end: blockEnd, replacement: '' }
  }

  const serializedPair = serializeYamlPair(key, nextVal)
  const isSerializedSingleLine = !serializedPair.slice(0, -1).includes('\n')
  const colonIdx = yamlLf.indexOf(':', keyRange?.[1] ?? pairStart)

  if (
    isSerializedSingleLine &&
    colonIdx !== -1 &&
    colonIdx < firstLineEnd &&
    valRange &&
    valRange[0] >= colonIdx &&
    valRange[1] <= firstLineEnd
  ) {
    const serializedVal = serializedPair.slice(serializedPair.indexOf(':') + 1, -1).trimStart()
    const trailingOnLine = yamlLf.slice(valRange[1], firstLineEnd - 1)
    if (trailingOnLine.trim().length > 0) {
      const gap = trailingOnLine.startsWith(' ') || trailingOnLine.startsWith('\t') ? '' : ' '
      return {
        start: colonIdx + 1,
        end: valRange[1],
        replacement: ` ${serializedVal}${gap}`
      }
    }
    return {
      start: colonIdx + 1,
      end: firstLineEnd,
      replacement: ` ${serializedVal}\n`
    }
  }

  if (
    !isSerializedSingleLine &&
    valRange &&
    valRange[0] >= firstLineEnd &&
    colonIdx !== -1 &&
    colonIdx < firstLineEnd
  ) {
    const firstSerializedLf = serializedPair.indexOf('\n')
    const serializedBlockBody =
      firstSerializedLf === -1 ? serializedPair : serializedPair.slice(firstSerializedLf + 1)
    return {
      start: firstLineEnd,
      end: blockEnd,
      replacement: serializedBlockBody
    }
  }

  return {
    start: lineStart,
    end: blockEnd,
    replacement: serializedPair
  }
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
  const split = splitFrontmatterRegion(markdown)
  if (!split.hasFrontmatter && split.hasOpeningDelimiter) {
    return {
      applied: false,
      content: markdown,
      error: '프론트매터 닫는 구분선(`---` 또는 `...`)이 없습니다.'
    }
  }

  const patchEntries = Object.entries(patch)
  if (!split.hasFrontmatter) {
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
    const prefix = split.hasBom ? '\uFEFF' : ''
    return {
      applied: true,
      content: `${prefix}---${split.lineEnding}${yamlBody}---${split.lineEnding}${bodyWithoutBom}`
    }
  }

  const parsedYaml = parseYamlMapping(split.yamlSource)
  if (parsedYaml.syntaxError) {
    return {
      applied: false,
      content: markdown,
      error: `YAML 구문 오류: ${parsedYaml.syntaxError}`
    }
  }

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

  const contentStart = split.hasBom ? 1 : 0
  const separatorAfterClosing = markdown.slice(
    contentStart + split.rawBlock.length,
    split.bodyStartOffset
  )
  const prefix = split.hasBom ? '\uFEFF' : ''
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
  const split = splitFrontmatterRegion(markdown)
  if (!split.hasFrontmatter && split.hasOpeningDelimiter) {
    return {
      applied: false,
      content: markdown,
      error: '프론트매터 닫는 구분선(`---` 또는 `...`)이 없습니다.'
    }
  }
  if (!split.hasFrontmatter) {
    return { applied: true, content: markdown }
  }

  const parsedYaml = parseYamlMapping(split.yamlSource)
  if (parsedYaml.syntaxError) {
    return {
      applied: false,
      content: markdown,
      error: `YAML 구문 오류: ${parsedYaml.syntaxError}`
    }
  }

  const prefix = split.hasBom ? '\uFEFF' : ''
  return {
    applied: true,
    content: `${prefix}${split.body}`
  }
}

/**
 * Recombines the original document's frontmatter prefix (including BOM and line endings)
 * with an updated markdown body.
 */
export function replaceFrontmatterBody(originalMarkdown: string, nextBody: string): string {
  const split = splitFrontmatterRegion(originalMarkdown)
  if (!split.hasFrontmatter) {
    if (split.hasBom && !nextBody.startsWith('\uFEFF')) {
      return `\uFEFF${nextBody}`
    }
    return nextBody
  }

  const contentStart = split.hasBom ? 1 : 0
  const separatorAfterClosing = originalMarkdown.slice(
    contentStart + split.rawBlock.length,
    split.bodyStartOffset
  )
  const effectiveSeparator =
    separatorAfterClosing || (nextBody.length > 0 ? split.lineEnding : '')
  const prefix = split.hasBom ? '\uFEFF' : ''
  return `${prefix}${split.rawBlock}${effectiveSeparator}${nextBody}`
}

export const FRONTMATTER_SCHEMA_DIR = '.wiki-editor'
export const FRONTMATTER_SCHEMA_FILE = 'frontmatter.json'
export const FRONTMATTER_SCHEMA_RELATIVE_PATH = `${FRONTMATTER_SCHEMA_DIR}/${FRONTMATTER_SCHEMA_FILE}`
export const FRONTMATTER_SCHEMA_VERSION = 1

export const FRONTMATTER_FIELD_TYPES: readonly FrontmatterFieldType[] = [
  'text',
  'number',
  'boolean',
  'date',
  'select',
  'multi-select'
]

const FRONTMATTER_FIELD_TYPE_SET = new Set<string>(FRONTMATTER_FIELD_TYPES)
const INVALID_FRONTMATTER_KEY_RE = /[\s:#[\]{},&*!|>'"%@`?\\\x00-\x1f\x7f]/
const RESERVED_FRONTMATTER_KEYS = new Set(['.', '..', '---', '...'])

export const DEFAULT_FRONTMATTER_SCHEMA: WorkspaceFrontmatterSchema = {
  version: 1,
  fields: [
    {
      key: 'status',
      label: '상태',
      type: 'select',
      required: true,
      options: [
        { value: 'todo', color: '#64748b' },
        { value: 'in-progress', color: '#2563eb' },
        { value: 'review', color: '#d97706' },
        { value: 'done', color: '#16a34a' }
      ],
      showInSearchBadge: true
    },
    {
      key: 'priority',
      label: '우선순위',
      type: 'select',
      options: [
        { value: 'highest', color: '#dc2626' },
        { value: 'high', color: '#ea580c' },
        { value: 'medium', color: '#ca8a04' },
        { value: 'low', color: '#2563eb' },
        { value: 'lowest', color: '#64748b' }
      ],
      showInSearchBadge: true
    },
    {
      key: 'labels',
      label: '라벨',
      type: 'multi-select',
      options: [
        { value: 'docs', color: '#0284c7' },
        { value: 'backend', color: '#7c3aed' },
        { value: 'frontend', color: '#db2777' },
        { value: 'security', color: '#dc2626' }
      ],
      allowCustom: true,
      showInSearchBadge: true
    },
    {
      key: 'assignee',
      label: '담당자',
      type: 'text',
      placeholder: '이름 또는 @핸들'
    },
    {
      key: 'dueDate',
      label: '마감일',
      type: 'date'
    }
  ]
}

function buildCanonicalFieldDefinition(
  field: FrontmatterFieldDefinition
): FrontmatterFieldDefinition {
  return {
    key: field.key,
    label: field.label,
    type: field.type,
    ...(field.required !== undefined ? { required: field.required } : {}),
    ...(field.placeholder !== undefined ? { placeholder: field.placeholder } : {}),
    ...(field.options !== undefined
      ? {
          options: field.options.map((opt) => ({
            value: opt.value,
            ...(opt.color !== undefined ? { color: opt.color } : {})
          }))
        }
      : {}),
    ...(field.allowCustom !== undefined ? { allowCustom: field.allowCustom } : {}),
    ...(field.showInSearchBadge !== undefined
      ? { showInSearchBadge: field.showInSearchBadge }
      : {})
  }
}

export function cloneFrontmatterSchema(
  schema: WorkspaceFrontmatterSchema
): WorkspaceFrontmatterSchema {
  return {
    version: 1,
    fields: schema.fields.map(buildCanonicalFieldDefinition)
  }
}

export function createDefaultFrontmatterSchema(): WorkspaceFrontmatterSchema {
  return cloneFrontmatterSchema(DEFAULT_FRONTMATTER_SCHEMA)
}

export function isValidFrontmatterFieldKey(key: string): boolean {
  if (!key || key.trim() !== key) return false
  if (key.startsWith('-') || RESERVED_FRONTMATTER_KEYS.has(key)) return false
  return !INVALID_FRONTMATTER_KEY_RE.test(key)
}

export type FrontmatterSchemaValidationResult =
  | { ok: true; schema: WorkspaceFrontmatterSchema }
  | { ok: false; error: string }

function validateOptionalBoolean(
  record: Record<string, unknown>,
  propName: string,
  fieldKey: string
): boolean | undefined {
  const val = record[propName]
  if (val === undefined) return undefined
  if (typeof val !== 'boolean') {
    throw new Error(`필드 "${fieldKey}"의 ${propName} 값은 boolean이어야 합니다.`)
  }
  return val
}

function validateSchemaOptions(
  rawOptions: unknown,
  fieldKey: string,
  fieldType: FrontmatterFieldType,
  allowCustom: boolean | undefined
): FrontmatterOptionSpec[] | undefined {
  const requiresNonEmptyOptions =
    fieldType === 'select' || (fieldType === 'multi-select' && !allowCustom)

  if (rawOptions === undefined) {
    if (requiresNonEmptyOptions) {
      throw new Error(`필드 "${fieldKey}"(${fieldType})에는 1개 이상의 options가 필요합니다.`)
    }
    return undefined
  }

  if (!Array.isArray(rawOptions)) {
    throw new Error(`필드 "${fieldKey}"의 options는 배열이어야 합니다.`)
  }
  if (requiresNonEmptyOptions && rawOptions.length === 0) {
    throw new Error(`필드 "${fieldKey}"(${fieldType})에는 1개 이상의 options가 필요합니다.`)
  }

  const seenValues = new Set<string>()
  const options: FrontmatterOptionSpec[] = []
  for (let i = 0; i < rawOptions.length; i += 1) {
    const rawOpt = rawOptions[i]
    if (!isPlainRecord(rawOpt)) {
      throw new Error(`필드 "${fieldKey}"의 options[${i}]는 객체여야 합니다.`)
    }
    if (typeof rawOpt.value !== 'string' || rawOpt.value.trim().length === 0) {
      throw new Error(`필드 "${fieldKey}"의 options[${i}].value는 비어 있을 수 없습니다.`)
    }
    const value = rawOpt.value
    if (seenValues.has(value)) {
      throw new Error(`필드 "${fieldKey}"에 중복된 옵션 값("${value}")이 있습니다.`)
    }
    seenValues.add(value)

    if (
      rawOpt.color !== undefined &&
      (typeof rawOpt.color !== 'string' || rawOpt.color.trim().length === 0)
    ) {
      throw new Error(`필드 "${fieldKey}"의 옵션 "${value}" color는 비어 있지 않은 문자열이어야 합니다.`)
    }

    options.push({
      value,
      ...(rawOpt.color !== undefined ? { color: rawOpt.color } : {})
    })
  }
  return options
}

function validateSchemaField(
  rawField: unknown,
  index: number,
  seenKeys: Set<string>
): FrontmatterFieldDefinition {
  if (!isPlainRecord(rawField)) {
    throw new Error(`fields[${index}] 항목은 객체여야 합니다.`)
  }

  if (typeof rawField.key !== 'string' || !isValidFrontmatterFieldKey(rawField.key)) {
    throw new Error(`fields[${index}].key 값이 유효하지 않습니다.`)
  }
  const key = rawField.key
  if (seenKeys.has(key)) {
    throw new Error(`중복된 프론트매터 필드 키입니다: "${key}"`)
  }
  seenKeys.add(key)

  if (typeof rawField.label !== 'string' || rawField.label.trim().length === 0) {
    throw new Error(`필드 "${key}"의 label은 비어 있을 수 없습니다.`)
  }

  if (typeof rawField.type !== 'string' || !FRONTMATTER_FIELD_TYPE_SET.has(rawField.type)) {
    throw new Error(`필드 "${key}"의 type("${String(rawField.type)}")이 유효하지 않습니다.`)
  }
  const type = rawField.type as FrontmatterFieldType

  const required = validateOptionalBoolean(rawField, 'required', key)
  const allowCustom = validateOptionalBoolean(rawField, 'allowCustom', key)
  const showInSearchBadge = validateOptionalBoolean(rawField, 'showInSearchBadge', key)

  if (rawField.placeholder !== undefined && typeof rawField.placeholder !== 'string') {
    throw new Error(`필드 "${key}"의 placeholder는 문자열이어야 합니다.`)
  }

  const options = validateSchemaOptions(rawField.options, key, type, allowCustom)

  return buildCanonicalFieldDefinition({
    key,
    label: rawField.label.trim(),
    type,
    ...(required !== undefined ? { required } : {}),
    ...(rawField.placeholder !== undefined ? { placeholder: rawField.placeholder } : {}),
    ...(options !== undefined ? { options } : {}),
    ...(allowCustom !== undefined ? { allowCustom } : {}),
    ...(showInSearchBadge !== undefined ? { showInSearchBadge } : {})
  })
}

/**
 * Strictly validates an unknown value as a WorkspaceFrontmatterSchema (version: 1).
 */
export function parseFrontmatterSchema(raw: unknown): FrontmatterSchemaValidationResult {
  try {
    if (!isPlainRecord(raw)) {
      return { ok: false, error: '프론트매터 스키마는 JSON 객체여야 합니다.' }
    }
    if (raw.version !== FRONTMATTER_SCHEMA_VERSION) {
      return {
        ok: false,
        error: `지원하지 않는 스키마 version입니다: expected ${FRONTMATTER_SCHEMA_VERSION}`
      }
    }
    if (!Array.isArray(raw.fields)) {
      return { ok: false, error: '프론트매터 스키마의 fields는 배열이어야 합니다.' }
    }

    const seenKeys = new Set<string>()
    const fields = raw.fields.map((field, index) => validateSchemaField(field, index, seenKeys))
    return {
      ok: true,
      schema: {
        version: 1,
        fields
      }
    }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

/**
 * Parses raw UTF-8 JSON text and strictly validates it against WorkspaceFrontmatterSchema.
 */
export function parseFrontmatterSchemaJson(rawText: string): FrontmatterSchemaValidationResult {
  const cleanText = rawText.startsWith('\uFEFF') ? rawText.slice(1) : rawText
  let parsed: unknown
  try {
    parsed = JSON.parse(cleanText)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { ok: false, error: `frontmatter.json 구문 오류: ${reason}` }
  }
  return parseFrontmatterSchema(parsed)
}

export function serializeFrontmatterSchema(schema: WorkspaceFrontmatterSchema): string {
  return `${JSON.stringify(schema, null, 2)}\n`
}
