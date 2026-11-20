import {
  type FrontmatterFieldDefinition,
  type FrontmatterFieldType,
  isValidIsoCalendarDate,
  type WorkspaceFrontmatterSchema
} from './frontmatterSchema'
import { compareWorkspaceEntriesByRelativePath, isMarkdownFileName } from './workspace'

export type FrontmatterScalarValue = string | number | boolean
export type FrontmatterFieldValue = FrontmatterScalarValue | string[]

export type FrontmatterFilterOperator =
  | 'in'
  | 'not-in'
  | 'all-of'
  | 'any-of'
  | 'none-of'
  | 'contains'
  | 'equals'
  | 'gte'
  | 'lte'
  | 'between'
  | 'is-empty'

export interface FrontmatterFilterCondition {
  fieldKey: string
  operator: FrontmatterFilterOperator
  values?: string[]
  value?: string | number | boolean
  min?: string | number
  max?: string | number
}

export interface WorkspaceFrontmatterFieldValuesResponse {
  valuesByField: Record<string, string[]>
}

export interface WorkspaceSearchSortSpec {
  by: 'path' | 'frontmatter'
  fieldKey?: string
  direction: 'asc' | 'desc'
}

export interface FrontmatterSortableEntry {
  relativePath: string
  hasNameMatch?: boolean
  values?: Readonly<Record<string, FrontmatterFieldValue | undefined>>
}

const DEFAULT_FALLBACK_SUMMARY_MAX_FIELDS = 3
const FRONTMATTER_EXCLUDED_SEGMENTS: ReadonlySet<string> = new Set([
  '.wiki-editor',
  '.git',
  'node_modules',
  '.hg',
  '.svn',
  '.DS_Store',
  'Thumbs.db'
])

export const FRONTMATTER_OPERATORS_BY_TYPE: Readonly<
  Record<FrontmatterFieldType, readonly FrontmatterFilterOperator[]>
> = {
  select: ['in', 'not-in', 'is-empty'],
  'multi-select': ['all-of', 'any-of', 'none-of', 'is-empty'],
  text: ['contains', 'equals', 'is-empty'],
  number: ['equals', 'gte', 'lte', 'between', 'is-empty'],
  date: ['equals', 'gte', 'lte', 'between', 'is-empty'],
  boolean: ['equals', 'is-empty']
}

/** Returns true when `operator` is supported for `fieldType`. */
export function isFrontmatterOperatorForType(
  fieldType: FrontmatterFieldType,
  operator: FrontmatterFilterOperator
): boolean {
  return FRONTMATTER_OPERATORS_BY_TYPE[fieldType].includes(operator)
}

/** Returns true when a frontmatter field value is unset, blank, non-finite, or an empty list. */
export function isFrontmatterValueEmpty(value: FrontmatterFieldValue | undefined): boolean {
  if (value === undefined || value === null) return true
  if (typeof value === 'string') return value.trim().length === 0
  if (typeof value === 'number') return !Number.isFinite(value)
  if (typeof value === 'boolean') return false
  if (Array.isArray(value)) return value.length === 0
  return true
}

function toFiniteNumber(raw: unknown): number | null {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? raw : null
  }
  if (typeof raw === 'string') {
    if (raw.trim() === '') return null
    const parsed = Number(raw)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function toValidIsoDate(raw: unknown): string | null {
  return typeof raw === 'string' && isValidIsoCalendarDate(raw) ? raw : null
}

function toBooleanValue(raw: unknown): boolean | null {
  if (typeof raw === 'boolean') return raw
  if (raw === 'true') return true
  if (raw === 'false') return false
  return null
}

function normalizeTargetValues(values: readonly string[] | undefined): string[] {
  if (!Array.isArray(values)) return []
  return values.filter((item): item is string => typeof item === 'string')
}

function evaluateOrderedRangeOperator<T>(
  actual: T | null,
  condition: FrontmatterFilterCondition,
  parseOperand: (raw: unknown) => T | null,
  compare: (a: T, b: T) => number
): boolean {
  if (actual === null) return false

  switch (condition.operator) {
    case 'equals': {
      const target = parseOperand(condition.value)
      return target !== null && compare(actual, target) === 0
    }
    case 'gte': {
      const target = parseOperand(condition.value)
      return target !== null && compare(actual, target) >= 0
    }
    case 'lte': {
      const target = parseOperand(condition.value)
      return target !== null && compare(actual, target) <= 0
    }
    case 'between': {
      const min = parseOperand(condition.min)
      const max = parseOperand(condition.max)
      return (
        min !== null &&
        max !== null &&
        compare(min, max) <= 0 &&
        compare(actual, min) >= 0 &&
        compare(actual, max) <= 0
      )
    }
    default:
      return false
  }
}

function evaluateSelectCondition(
  rawValue: FrontmatterFieldValue | undefined,
  condition: FrontmatterFilterCondition
): boolean {
  const actual = typeof rawValue === 'string' && rawValue.trim().length > 0 ? rawValue : null
  const targets = new Set(normalizeTargetValues(condition.values))

  if (condition.operator === 'in') {
    return actual !== null && targets.has(actual)
  }
  if (condition.operator === 'not-in') {
    return actual === null || !targets.has(actual)
  }
  return false
}

function evaluateMultiSelectCondition(
  rawValue: FrontmatterFieldValue | undefined,
  condition: FrontmatterFilterCondition
): boolean {
  const actualSet = new Set(
    Array.isArray(rawValue)
      ? rawValue.filter((item): item is string => typeof item === 'string')
      : []
  )
  const targets = normalizeTargetValues(condition.values)

  switch (condition.operator) {
    case 'all-of':
      return targets.every((target) => actualSet.has(target))
    case 'any-of':
      return targets.some((target) => actualSet.has(target))
    case 'none-of':
      return !targets.some((target) => actualSet.has(target))
    default:
      return false
  }
}

function evaluateTextCondition(
  rawValue: FrontmatterFieldValue | undefined,
  condition: FrontmatterFilterCondition
): boolean {
  if (typeof rawValue !== 'string' || typeof condition.value !== 'string') {
    return false
  }
  if (condition.operator === 'contains') {
    return rawValue.toLowerCase().includes(condition.value.toLowerCase())
  }
  if (condition.operator === 'equals') {
    return rawValue === condition.value
  }
  return false
}

/**
 * Evaluates a single frontmatter filter condition against parsed document values for a schema field.
 */
export function evaluateFrontmatterCondition(
  values: Readonly<Record<string, FrontmatterFieldValue>>,
  condition: FrontmatterFilterCondition,
  field: FrontmatterFieldDefinition
): boolean {
  if (!isFrontmatterOperatorForType(field.type, condition.operator)) {
    return false
  }

  const rawValue = values[field.key]
  if (condition.operator === 'is-empty') {
    return isFrontmatterValueEmpty(rawValue)
  }

  switch (field.type) {
    case 'select':
      return evaluateSelectCondition(rawValue, condition)
    case 'multi-select':
      return evaluateMultiSelectCondition(rawValue, condition)
    case 'text':
      return evaluateTextCondition(rawValue, condition)
    case 'number':
      return evaluateOrderedRangeOperator(
        typeof rawValue === 'number' && Number.isFinite(rawValue) ? rawValue : null,
        condition,
        toFiniteNumber,
        (a, b) => a - b
      )
    case 'date':
      return evaluateOrderedRangeOperator(
        toValidIsoDate(rawValue),
        condition,
        toValidIsoDate,
        (a, b) => (a < b ? -1 : a > b ? 1 : 0)
      )
    case 'boolean': {
      const actual = typeof rawValue === 'boolean' ? rawValue : null
      const target = toBooleanValue(condition.value)
      return actual !== null && target !== null && actual === target
    }
  }
}

/**
 * Evaluates all frontmatter filter conditions with AND semantics against the workspace schema.
 */
export function matchesFrontmatterConditions(
  values: Readonly<Record<string, FrontmatterFieldValue>>,
  conditions: readonly FrontmatterFilterCondition[],
  schema: WorkspaceFrontmatterSchema | null | undefined
): boolean {
  if (conditions.length === 0) {
    return true
  }
  if (!schema) {
    return false
  }

  const fieldsByKey = new Map(schema.fields.map((field) => [field.key, field]))
  for (const condition of conditions) {
    const field = fieldsByKey.get(condition.fieldKey)
    if (!field || !evaluateFrontmatterCondition(values, condition, field)) {
      return false
    }
  }
  return true
}

function compareLocaleStrings(a: string, b: string): number {
  const baseOrder = a.localeCompare(b, undefined, { sensitivity: 'base' })
  return baseOrder !== 0 ? baseOrder : a.localeCompare(b)
}

function compareLocaleStringArrays(a: readonly string[], b: readonly string[]): number {
  const limit = Math.min(a.length, b.length)
  for (let i = 0; i < limit; i += 1) {
    const cmp = compareLocaleStrings(a[i], b[i])
    if (cmp !== 0) return cmp
  }
  return a.length - b.length
}

function normalizeSortableFieldValue(
  value: FrontmatterFieldValue | undefined,
  fieldType: FrontmatterFieldType
): string | number | boolean | string[] | null {
  if (value === undefined || value === null) return null

  switch (fieldType) {
    case 'select':
    case 'text':
      return typeof value === 'string' && value.trim().length > 0 ? value : null
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? value : null
    case 'date':
      return toValidIsoDate(value)
    case 'boolean':
      return typeof value === 'boolean' ? value : null
    case 'multi-select':
      return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string')
        ? value
        : null
  }
}

/**
 * Compares two values for a frontmatter field, placing empty/invalid values last in both directions
 * and sorting `select` values by declared schema option order before out-of-schema values.
 */
export function compareFrontmatterFieldValues(
  rawA: FrontmatterFieldValue | undefined,
  rawB: FrontmatterFieldValue | undefined,
  field: FrontmatterFieldDefinition,
  direction: 'asc' | 'desc',
  optionOrderMap?: ReadonlyMap<string, number>
): number {
  const normA = normalizeSortableFieldValue(rawA, field.type)
  const normB = normalizeSortableFieldValue(rawB, field.type)
  if (normA === null && normB === null) return 0
  if (normA === null) return 1
  if (normB === null) return -1

  let cmp = 0
  switch (field.type) {
    case 'select': {
      const orderMap =
        optionOrderMap ??
        new Map((field.options ?? []).map((option, index) => [option.value, index] as const))
      const idxA = orderMap.get(normA as string)
      const idxB = orderMap.get(normB as string)
      if (idxA !== undefined && idxB !== undefined) {
        cmp = idxA - idxB
        break
      }
      if (idxA !== undefined) return -1
      if (idxB !== undefined) return 1
      cmp = compareLocaleStrings(normA as string, normB as string)
      break
    }
    case 'number':
      cmp = (normA as number) - (normB as number)
      break
    case 'date':
      cmp = (normA as string) < (normB as string) ? -1 : (normA as string) > (normB as string) ? 1 : 0
      break
    case 'text':
      cmp = compareLocaleStrings(normA as string, normB as string)
      break
    case 'multi-select':
      cmp = compareLocaleStringArrays(normA as string[], normB as string[])
      break
    case 'boolean':
      cmp = (normA ? 1 : 0) - (normB ? 1 : 0)
      break
  }

  return direction === 'desc' ? -cmp : cmp
}

function compareDefaultSearchOrder(a: FrontmatterSortableEntry, b: FrontmatterSortableEntry): number {
  const aHasName = Boolean(a.hasNameMatch)
  const bHasName = Boolean(b.hasNameMatch)
  if (aHasName !== bHasName) {
    return aHasName ? -1 : 1
  }
  return compareWorkspaceEntriesByRelativePath(a, b)
}

/**
 * Compares search result entries by `WorkspaceSearchSortSpec`, falling back to `relativePath` asc on ties.
 */
export function compareWorkspaceSearchEntriesBySort(
  a: FrontmatterSortableEntry,
  b: FrontmatterSortableEntry,
  sort: WorkspaceSearchSortSpec | undefined,
  schema: WorkspaceFrontmatterSchema | null | undefined,
  optionOrderMap?: ReadonlyMap<string, number>
): number {
  if (!sort || (sort.by === 'path' && sort.direction === 'asc')) {
    return compareDefaultSearchOrder(a, b)
  }
  if (sort.by === 'path') {
    return compareWorkspaceEntriesByRelativePath(b, a)
  }

  const field = sort.fieldKey ? schema?.fields.find((item) => item.key === sort.fieldKey) : undefined
  if (!field) {
    return compareDefaultSearchOrder(a, b)
  }

  const cmp = compareFrontmatterFieldValues(
    a.values?.[field.key],
    b.values?.[field.key],
    field,
    sort.direction,
    optionOrderMap
  )
  return cmp !== 0 ? cmp : compareWorkspaceEntriesByRelativePath(a, b)
}

/**
 * Extracts compact frontmatter summary values for search results (`showInSearchBadge` fields, or up to
 * three non-excluded schema fields when none specify `showInSearchBadge`).
 */
export function extractFrontmatterSummary(
  values: Readonly<Record<string, FrontmatterFieldValue>>,
  schema: WorkspaceFrontmatterSchema | null | undefined
): Record<string, FrontmatterFieldValue> | undefined {
  if (!schema || schema.fields.length === 0) {
    return undefined
  }

  const explicitBadgeFields = schema.fields.filter((field) => field.showInSearchBadge === true)
  const candidates =
    explicitBadgeFields.length > 0
      ? explicitBadgeFields
      : schema.fields.filter((field) => field.showInSearchBadge !== false)
  const limit = explicitBadgeFields.length > 0 ? candidates.length : DEFAULT_FALLBACK_SUMMARY_MAX_FIELDS

  const summary: Record<string, FrontmatterFieldValue> = {}
  let count = 0
  for (const field of candidates) {
    const val = values[field.key]
    if (isFrontmatterValueEmpty(val) || val === undefined) {
      continue
    }
    summary[field.key] = Array.isArray(val) ? [...val] : val
    count += 1
    if (count >= limit) {
      break
    }
  }

  return count > 0 ? summary : undefined
}

/** Returns true when `fileName` is a markdown file or extensionless non-dotfile eligible for frontmatter. */
export function isFrontmatterDocumentFileName(fileName: string): boolean {
  if (isMarkdownFileName(fileName)) return true
  return fileName.length > 0 && !fileName.includes('.')
}

/** Returns true when `relativePath` traverses `.wiki-editor/` or ignored system directories. */
export function isExcludedFrontmatterRelativePath(relativePath: string): boolean {
  if (!relativePath) return false
  return relativePath
    .split(/[\\/]/)
    .filter(Boolean)
    .some((segment) => FRONTMATTER_EXCLUDED_SEGMENTS.has(segment))
}

/** Returns schema `allowCustom` `multi-select` fields, optionally narrowed to `requestedKeys`. */
export function collectAllowCustomMultiSelectFields(
  schema: WorkspaceFrontmatterSchema | null | undefined,
  requestedKeys?: readonly string[]
): FrontmatterFieldDefinition[] {
  if (!schema) return []
  const requestedSet =
    requestedKeys && requestedKeys.length > 0 ? new Set(requestedKeys) : undefined
  return schema.fields.filter(
    (field) =>
      field.type === 'multi-select' &&
      field.allowCustom === true &&
      (!requestedSet || requestedSet.has(field.key))
  )
}

/** Creates an incremental value-collection seed map pre-populated with schema options. */
export function createFrontmatterFieldValuesCollector(
  targetFields: readonly FrontmatterFieldDefinition[]
): Map<string, Set<string>> {
  const byField = new Map<string, Set<string>>()
  for (const field of targetFields) {
    const set = new Set<string>()
    for (const opt of field.options ?? []) {
      if (opt.value.trim().length > 0) {
        set.add(opt.value)
      }
    }
    byField.set(field.key, set)
  }
  return byField
}

/** Adds extracted document frontmatter values for `targetFields` into the collector map. */
export function appendDocumentValuesToFieldCollector(
  collector: ReadonlyMap<string, Set<string>>,
  docValues: Readonly<Record<string, FrontmatterFieldValue>>
): void {
  for (const [fieldKey, valueSet] of collector.entries()) {
    const raw = docValues[fieldKey]
    if (!Array.isArray(raw)) continue
    for (const item of raw) {
      if (typeof item === 'string' && item.trim().length > 0) {
        valueSet.add(item)
      }
    }
  }
}

/** Converts a field-values collector map into sorted deduplicated arrays per field. */
export function finalizeCollectedFrontmatterFieldValues(
  collector: ReadonlyMap<string, Set<string>>
): WorkspaceFrontmatterFieldValuesResponse {
  const valuesByField: Record<string, string[]> = {}
  for (const [fieldKey, valueSet] of collector.entries()) {
    valuesByField[fieldKey] = [...valueSet].sort(compareLocaleStrings)
  }
  return { valuesByField }
}

/** Collects deduplicated, sorted schema options and document values for `targetFields`. */
export function mergeCollectedFrontmatterFieldValues(
  targetFields: readonly FrontmatterFieldDefinition[],
  documentValuesList: ReadonlyArray<Readonly<Record<string, FrontmatterFieldValue>>>
): WorkspaceFrontmatterFieldValuesResponse {
  const collector = createFrontmatterFieldValuesCollector(targetFields)
  for (const docValues of documentValuesList) {
    appendDocumentValuesToFieldCollector(collector, docValues)
  }
  return finalizeCollectedFrontmatterFieldValues(collector)
}
