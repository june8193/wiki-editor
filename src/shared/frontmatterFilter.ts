import {
  type FrontmatterFieldDefinition,
  type FrontmatterFieldType,
  isValidIsoCalendarDate,
  type WorkspaceFrontmatterSchema
} from './frontmatterSchema'
import { IGNORED_WORKSPACE_ENTRY_NAMES, isMarkdownFileName } from './workspace'

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

export type FrontmatterValueComparator = (
  a: FrontmatterFieldValue | undefined,
  b: FrontmatterFieldValue | undefined
) => number

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

const DEFAULT_FALLBACK_SUMMARY_MAX_FIELDS = 3
const FRONTMATTER_EXCLUDED_SEGMENTS: ReadonlySet<string> = new Set([
  ...IGNORED_WORKSPACE_ENTRY_NAMES,
  '.wiki-editor'
])

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

function toFiniteNumberLiteral(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null
}

function toFiniteNumber(raw: unknown): number | null {
  const direct = toFiniteNumberLiteral(raw)
  if (direct !== null) {
    return direct
  }
  if (typeof raw === 'string') {
    if (raw.trim() === '') return null
    const parsed = Number(raw)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function toNonBlankString(raw: unknown): string | null {
  return typeof raw === 'string' && raw.trim().length > 0 ? raw : null
}

function toValidIsoDate(raw: unknown): string | null {
  return typeof raw === 'string' && isValidIsoCalendarDate(raw) ? raw : null
}

function toStrictBoolean(raw: unknown): boolean | null {
  return typeof raw === 'boolean' ? raw : null
}

function toBooleanValue(raw: unknown): boolean | null {
  const direct = toStrictBoolean(raw)
  if (direct !== null) return direct
  if (raw === 'true') return true
  if (raw === 'false') return false
  return null
}

function compareNumbers(a: number, b: number): number {
  return a - b
}

function compareIsoDates(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function normalizeTargetValues(values: readonly string[] | undefined): string[] {
  if (!Array.isArray(values)) return []
  return values.filter((item): item is string => typeof item === 'string')
}

export function compareLocaleStrings(a: string, b: string): number {
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

interface FieldTypeHandler<TNorm = unknown> {
  evaluate: (
    rawValue: FrontmatterFieldValue | undefined,
    condition: FrontmatterFilterCondition
  ) => boolean
  normalizeSortable: (rawValue: FrontmatterFieldValue | undefined) => TNorm | null
  createPairComparator: (
    field: FrontmatterFieldDefinition,
    direction: 'asc' | 'desc'
  ) => (a: TNorm, b: TNorm) => number
}

function defineFieldTypeHandler<TNorm>(handler: FieldTypeHandler<TNorm>): FieldTypeHandler {
  return handler as FieldTypeHandler
}

function createDirectedComparator<T>(
  direction: 'asc' | 'desc',
  compareAsc: (a: T, b: T) => number
): (a: T, b: T) => number {
  return direction === 'desc' ? (a, b) => -compareAsc(a, b) : compareAsc
}

function createOrderedRangeHandler<T>(options: {
  normalizeDocumentValue: (raw: unknown) => T | null
  parseConditionOperand: (raw: unknown) => T | null
  compare: (a: T, b: T) => number
}): FieldTypeHandler {
  return defineFieldTypeHandler<T>({
    evaluate: (rawValue, condition) =>
      evaluateOrderedRangeOperator(
        options.normalizeDocumentValue(rawValue),
        condition,
        options.parseConditionOperand,
        options.compare
      ),
    normalizeSortable: options.normalizeDocumentValue,
    createPairComparator: (_field, direction) => createDirectedComparator(direction, options.compare)
  })
}

const FIELD_TYPE_HANDLERS: Readonly<Record<FrontmatterFieldType, FieldTypeHandler>> = {
  select: defineFieldTypeHandler<string>({
    evaluate: (rawValue, condition) => {
      const actual = toNonBlankString(rawValue)
      const targets = new Set(normalizeTargetValues(condition.values))
      if (condition.operator === 'in') {
        return actual !== null && targets.has(actual)
      }
      if (condition.operator === 'not-in') {
        return actual === null || !targets.has(actual)
      }
      return false
    },
    normalizeSortable: toNonBlankString,
    createPairComparator: (field, direction) => {
      const orderMap = new Map(
        (field.options ?? []).map((option, index) => [option.value, index] as const)
      )
      const compareWithinGroup = createDirectedComparator<string>(direction, (a, b) => {
        const idxA = orderMap.get(a)
        return idxA !== undefined ? idxA - orderMap.get(b)! : compareLocaleStrings(a, b)
      })
      return (a, b) => {
        const hasA = orderMap.has(a)
        const hasB = orderMap.has(b)
        if (hasA !== hasB) {
          return hasA ? -1 : 1
        }
        return compareWithinGroup(a, b)
      }
    }
  }),
  'multi-select': defineFieldTypeHandler<string[]>({
    evaluate: (rawValue, condition) => {
      const actualSet = new Set(
        Array.isArray(rawValue)
          ? rawValue.filter((item): item is string => typeof item === 'string')
          : []
      )
      const targets = normalizeTargetValues(condition.values)
      switch (condition.operator) {
        case 'all-of':
          return targets.length > 0 && targets.every((target) => actualSet.has(target))
        case 'any-of':
          return targets.some((target) => actualSet.has(target))
        case 'none-of':
          return !targets.some((target) => actualSet.has(target))
        default:
          return false
      }
    },
    normalizeSortable: (rawValue) =>
      Array.isArray(rawValue) &&
      rawValue.length > 0 &&
      rawValue.every((item) => typeof item === 'string')
        ? rawValue
        : null,
    createPairComparator: (_field, direction) =>
      createDirectedComparator(direction, compareLocaleStringArrays)
  }),
  text: defineFieldTypeHandler<string>({
    evaluate: (rawValue, condition) => {
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
    },
    normalizeSortable: toNonBlankString,
    createPairComparator: (_field, direction) =>
      createDirectedComparator(direction, compareLocaleStrings)
  }),
  number: createOrderedRangeHandler({
    normalizeDocumentValue: toFiniteNumberLiteral,
    parseConditionOperand: toFiniteNumber,
    compare: compareNumbers
  }),
  date: createOrderedRangeHandler({
    normalizeDocumentValue: toValidIsoDate,
    parseConditionOperand: toValidIsoDate,
    compare: compareIsoDates
  }),
  boolean: defineFieldTypeHandler<boolean>({
    evaluate: (rawValue, condition) => {
      const actual = toStrictBoolean(rawValue)
      const target = toBooleanValue(condition.value)
      return actual !== null && target !== null && actual === target
    },
    normalizeSortable: toStrictBoolean,
    createPairComparator: (_field, direction) =>
      createDirectedComparator(direction, (a, b) => (a ? 1 : 0) - (b ? 1 : 0))
  })
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

  return FIELD_TYPE_HANDLERS[field.type].evaluate(rawValue, condition)
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

/**
 * Builds a reusable comparator for sorting values of `field`, caching schema option lookup order
 * and placing empty/invalid values last in both ascending and descending directions.
 */
export function createFrontmatterFieldComparator(
  field: FrontmatterFieldDefinition,
  direction: 'asc' | 'desc'
): FrontmatterValueComparator {
  const handler = FIELD_TYPE_HANDLERS[field.type]
  const comparePair = handler.createPairComparator(field, direction)

  return (rawA, rawB) => {
    const normA = handler.normalizeSortable(rawA)
    const normB = handler.normalizeSortable(rawB)
    if (normA === null && normB === null) return 0
    if (normA === null) return 1
    if (normB === null) return -1
    return comparePair(normA, normB)
  }
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
  const limit =
    explicitBadgeFields.length > 0 ? candidates.length : DEFAULT_FALLBACK_SUMMARY_MAX_FIELDS

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

export interface SelectableFieldOption {
  value: string
  color?: string
}

/**
 * Combines schema options (preserving declaration order), live custom workspace values (for
 * `allowCustom`), and any already-selected values into a deduplicated option list.
 */
export function buildSelectableFieldOptions(
  field: FrontmatterFieldDefinition,
  liveCustomValues?: readonly string[],
  currentValues?: readonly string[]
): SelectableFieldOption[] {
  const result: SelectableFieldOption[] = []
  const seen = new Set<string>()
  const colorByValue = new Map<string, string | undefined>()

  const pushUnique = (value: string): void => {
    if (!value || seen.has(value)) return
    seen.add(value)
    const color = colorByValue.get(value)
    result.push({ value, ...(color ? { color } : {}) })
  }

  for (const opt of field.options ?? []) {
    if (!opt.value) continue
    colorByValue.set(opt.value, opt.color)
    pushUnique(opt.value)
  }

  if (field.type === 'multi-select' && field.allowCustom && liveCustomValues) {
    for (const liveVal of liveCustomValues) {
      pushUnique(liveVal)
    }
  }

  for (const selectedVal of currentValues ?? []) {
    pushUnique(selectedVal)
  }

  return result
}
