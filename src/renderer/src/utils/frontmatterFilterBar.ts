import {
  isFrontmatterOperatorForType,
  isFrontmatterValueEmpty,
  isValidIsoCalendarDate,
  type FrontmatterFieldDefinition,
  type FrontmatterFieldType,
  type FrontmatterFieldValue,
  type FrontmatterFilterCondition,
  type FrontmatterFilterOperator,
  type WorkspaceFrontmatterSchema
} from '@shared/frontmatter'
import type { WorkspaceSearchSortSpec } from '@shared/search'

export const DEFAULT_WORKSPACE_SEARCH_SORT: WorkspaceSearchSortSpec = {
  by: 'path',
  direction: 'asc'
}

const OPERATOR_LABELS_BY_TYPE: Readonly<
  Record<FrontmatterFieldType, Partial<Record<FrontmatterFilterOperator, string>>>
> = {
  select: {
    in: '포함',
    'not-in': '제외',
    'is-empty': '비어 있음'
  },
  'multi-select': {
    'all-of': '모두 포함',
    'any-of': '하나라도 포함',
    'none-of': '제외',
    'is-empty': '비어 있음'
  },
  text: {
    contains: '포함',
    equals: '일치',
    'is-empty': '비어 있음'
  },
  number: {
    equals: '같음 (=)',
    gte: '이상 (>=)',
    lte: '이하 (<=)',
    between: '범위',
    'is-empty': '비어 있음'
  },
  date: {
    equals: '일치 (=)',
    gte: '이후 (>=)',
    lte: '이전 (<=)',
    between: '범위',
    'is-empty': '비어 있음'
  },
  boolean: {
    equals: '일치',
    'is-empty': '비어 있음'
  }
}

/** Returns the localized operator label for a given schema field type and operator. */
export function getFrontmatterOperatorLabel(
  fieldType: FrontmatterFieldType,
  operator: FrontmatterFilterOperator
): string {
  return OPERATOR_LABELS_BY_TYPE[fieldType][operator] ?? operator
}

/** Serializes a `WorkspaceSearchSortSpec` into a `<select>` option value string. */
export function serializeSearchSortSpec(sort: WorkspaceSearchSortSpec): string {
  if (sort.by === 'frontmatter' && sort.fieldKey) {
    return `frontmatter:${sort.direction}:${sort.fieldKey}`
  }
  return 'path:asc'
}

/** Parses a `<select>` option value back into a `WorkspaceSearchSortSpec`. */
export function parseSearchSortValue(rawValue: string): WorkspaceSearchSortSpec {
  if (rawValue.startsWith('frontmatter:asc:')) {
    const fieldKey = rawValue.slice('frontmatter:asc:'.length)
    if (fieldKey) {
      return { by: 'frontmatter', fieldKey, direction: 'asc' }
    }
  }
  if (rawValue.startsWith('frontmatter:desc:')) {
    const fieldKey = rawValue.slice('frontmatter:desc:'.length)
    if (fieldKey) {
      return { by: 'frontmatter', fieldKey, direction: 'desc' }
    }
  }
  return { ...DEFAULT_WORKSPACE_SEARCH_SORT }
}

/** Returns true when two `WorkspaceSearchSortSpec` values represent the same sort mode. */
export function areSearchSortsEqual(
  a: WorkspaceSearchSortSpec,
  b: WorkspaceSearchSortSpec
): boolean {
  return a.by === b.by && a.direction === b.direction && a.fieldKey === b.fieldKey
}

/** Drops frontmatter sort if its field was removed from the active workspace schema. */
export function reconcileSearchSortSpec(
  sort: WorkspaceSearchSortSpec,
  schema: WorkspaceFrontmatterSchema | null
): WorkspaceSearchSortSpec {
  if (sort.by !== 'frontmatter' || !sort.fieldKey || !schema) {
    return { ...DEFAULT_WORKSPACE_SEARCH_SORT }
  }
  const exists = schema.fields.some((field) => field.key === sort.fieldKey)
  return exists ? sort : { ...DEFAULT_WORKSPACE_SEARCH_SORT }
}

/** Returns true when `condition` has both a valid operator and compatible operand types for `field`. */
function isFrontmatterConditionValidForField(
  condition: FrontmatterFilterCondition,
  field: FrontmatterFieldDefinition
): boolean {
  if (!isFrontmatterOperatorForType(field.type, condition.operator)) {
    return false
  }
  if (condition.operator === 'is-empty') {
    return true
  }

  switch (field.type) {
    case 'select':
    case 'multi-select':
      return (
        Array.isArray(condition.values) &&
        condition.values.length > 0 &&
        condition.values.every((value) => typeof value === 'string')
      )
    case 'text':
      return typeof condition.value === 'string' && condition.value.trim().length > 0
    case 'number':
      if (condition.operator === 'between') {
        return (
          typeof condition.min === 'number' &&
          Number.isFinite(condition.min) &&
          typeof condition.max === 'number' &&
          Number.isFinite(condition.max)
        )
      }
      return typeof condition.value === 'number' && Number.isFinite(condition.value)
    case 'date':
      if (condition.operator === 'between') {
        return (
          typeof condition.min === 'string' &&
          isValidIsoCalendarDate(condition.min) &&
          typeof condition.max === 'string' &&
          isValidIsoCalendarDate(condition.max)
        )
      }
      return typeof condition.value === 'string' && isValidIsoCalendarDate(condition.value)
    case 'boolean':
      return typeof condition.value === 'boolean'
  }
}

/** Filters active filter conditions to those valid under `schema`. */
export function reconcileFilterConditions(
  conditions: readonly FrontmatterFilterCondition[],
  schema: WorkspaceFrontmatterSchema | null
): FrontmatterFilterCondition[] {
  if (!schema || conditions.length === 0) {
    return []
  }
  const fieldsByKey = new Map(schema.fields.map((field) => [field.key, field]))
  return conditions.filter((cond) => {
    const field = fieldsByKey.get(cond.fieldKey)
    return Boolean(field && isFrontmatterConditionValidForField(cond, field))
  })
}

/** Computes a deterministic signature for schema-dependent search/filter reconciliation. */
export function getSearchSchemaSignature(schema: WorkspaceFrontmatterSchema | null): string {
  if (!schema) return 'null'
  return JSON.stringify(schema)
}

/** Formats a concise human-readable label for an active filter chip. */
export function formatFilterChipLabel(
  condition: FrontmatterFilterCondition,
  field: FrontmatterFieldDefinition
): string {
  if (condition.operator === 'is-empty') {
    return `${field.label} · 비어 있음`
  }

  switch (field.type) {
    case 'select': {
      const vals = (condition.values ?? []).join(', ')
      return condition.operator === 'not-in'
        ? `${field.label} (제외): ${vals}`
        : `${field.label}: ${vals}`
    }
    case 'multi-select': {
      const vals = (condition.values ?? []).join(', ')
      const opTag =
        condition.operator === 'all-of'
          ? '모두'
          : condition.operator === 'any-of'
            ? '중 하나'
            : '제외'
      return `${field.label} (${opTag}): ${vals}`
    }
    case 'text': {
      const val = String(condition.value ?? '')
      return condition.operator === 'contains'
        ? `${field.label} 포함 "${val}"`
        : `${field.label} = "${val}"`
    }
    case 'number':
    case 'date': {
      if (condition.operator === 'between') {
        return `${field.label}: ${condition.min ?? ''} ~ ${condition.max ?? ''}`
      }
      const sym =
        condition.operator === 'gte' ? '>=' : condition.operator === 'lte' ? '<=' : '='
      return `${field.label} ${sym} ${condition.value ?? ''}`
    }
    case 'boolean':
      return `${field.label}: ${condition.value === true ? '예' : '아니오'}`
  }
}

export type SummaryBadgeValue = string | number | boolean

export interface DisplaySummaryBadge {
  id: string
  field: FrontmatterFieldDefinition
  badgeValue: SummaryBadgeValue
  displayText: string
  color?: string
  ariaLabel: string
  title: string
}

function createOptionSummaryBadge(
  field: FrontmatterFieldDefinition,
  optionValue: string
): DisplaySummaryBadge {
  const color = field.options?.find((opt) => opt.value === optionValue)?.color
  return {
    id: `${field.key}:${optionValue}`,
    field,
    badgeValue: optionValue,
    displayText: optionValue,
    ...(color ? { color } : {}),
    ariaLabel: `${field.label}: ${optionValue} 필터 추가`,
    title: `${field.label}: ${optionValue} (클릭하여 필터 추가)`
  }
}

/** Formats `frontmatterSummary` values in schema declaration order into clickable badge descriptors. */
export function extractDisplaySummaryBadges(
  summary: Readonly<Record<string, FrontmatterFieldValue>> | undefined,
  schema: WorkspaceFrontmatterSchema | null
): DisplaySummaryBadge[] {
  if (!summary || !schema) {
    return []
  }

  const badges: DisplaySummaryBadge[] = []
  for (const field of schema.fields) {
    const raw = summary[field.key]
    if (raw === undefined || isFrontmatterValueEmpty(raw)) {
      continue
    }

    if (field.type === 'multi-select' && Array.isArray(raw)) {
      const seenItems = new Set<string>()
      for (const item of raw) {
        if (!item || seenItems.has(item)) continue
        seenItems.add(item)
        badges.push(createOptionSummaryBadge(field, item))
      }
      continue
    }

    if (Array.isArray(raw)) {
      continue
    }

    if (field.type === 'select' && typeof raw === 'string') {
      badges.push(createOptionSummaryBadge(field, raw))
      continue
    }

    const formatted =
      field.type === 'boolean' ? (raw === true ? '예' : '아니오') : String(raw)
    badges.push({
      id: `${field.key}:${String(raw)}`,
      field,
      badgeValue: raw,
      displayText: `${field.label}: ${formatted}`,
      ariaLabel: `${field.label}: ${formatted} 필터 추가`,
      title: `${field.label}: ${formatted} (클릭하여 필터 추가)`
    })
  }

  return badges
}

/**
 * Adds or merges a clicked summary badge `(field, value)` condition into existing active filters,
 * avoiding duplicate filters while keeping AND semantics intact.
 */
export function upsertBadgeFilterCondition(
  existingConditions: readonly FrontmatterFilterCondition[],
  field: FrontmatterFieldDefinition,
  badgeValue: SummaryBadgeValue
): { nextConditions: FrontmatterFilterCondition[]; changed: boolean } {
  if (field.type === 'select') {
    const target = String(badgeValue)
    const existingIdx = existingConditions.findIndex(
      (cond) => cond.fieldKey === field.key && cond.operator === 'in'
    )
    if (existingIdx >= 0) {
      const prevValues = existingConditions[existingIdx].values ?? []
      if (prevValues.length === 1 && prevValues[0] === target) {
        return { nextConditions: [...existingConditions], changed: false }
      }
      const nextConditions = existingConditions.map((cond, idx) =>
        idx === existingIdx ? { ...cond, values: [target] } : cond
      )
      return { nextConditions, changed: true }
    }
    return {
      nextConditions: [
        ...existingConditions,
        { fieldKey: field.key, operator: 'in', values: [target] }
      ],
      changed: true
    }
  }

  if (field.type === 'multi-select') {
    const target = String(badgeValue)
    const existingIdx = existingConditions.findIndex(
      (cond) => cond.fieldKey === field.key && cond.operator === 'all-of'
    )
    if (existingIdx >= 0) {
      const prevValues = existingConditions[existingIdx].values ?? []
      if (prevValues.includes(target)) {
        return { nextConditions: [...existingConditions], changed: false }
      }
      const nextConditions = existingConditions.map((cond, idx) =>
        idx === existingIdx ? { ...cond, values: [...prevValues, target] } : cond
      )
      return { nextConditions, changed: true }
    }
    return {
      nextConditions: [
        ...existingConditions,
        { fieldKey: field.key, operator: 'all-of', values: [target] }
      ],
      changed: true
    }
  }

  const alreadyExists = existingConditions.some(
    (cond) =>
      cond.fieldKey === field.key &&
      cond.operator === 'equals' &&
      cond.value === badgeValue
  )
  if (alreadyExists) {
    return { nextConditions: [...existingConditions], changed: false }
  }
  return {
    nextConditions: [
      ...existingConditions,
      { fieldKey: field.key, operator: 'equals', value: badgeValue }
    ],
    changed: true
  }
}

export type FilterPopoverStep = 'field' | 'operator' | 'value'

export interface FilterPopoverDraft {
  mode: 'add' | 'edit'
  editIndex: number | null
  step: FilterPopoverStep
  fieldKey: string | null
  fieldType: FrontmatterFieldType | null
  operator: FrontmatterFilterOperator | null
  selectedValues: string[]
  textValue: string
  minValue: string
  maxValue: string
}

/** Creates an initial draft for adding a new frontmatter filter condition. */
export function createInitialFilterAddDraft(): FilterPopoverDraft {
  return {
    mode: 'add',
    editIndex: null,
    step: 'field',
    fieldKey: null,
    fieldType: null,
    operator: null,
    selectedValues: [],
    textValue: '',
    minValue: '',
    maxValue: ''
  }
}

/** Creates a clean operator-step draft for the selected schema field, clearing prior field values. */
export function createFilterFieldDraft(field: FrontmatterFieldDefinition): FilterPopoverDraft {
  return {
    ...createInitialFilterAddDraft(),
    step: 'operator',
    fieldKey: field.key,
    fieldType: field.type
  }
}

/** Creates a pre-populated draft for editing an existing frontmatter filter condition. */
export function createFilterEditDraft(
  condition: FrontmatterFilterCondition,
  index: number,
  fieldType: FrontmatterFieldType | null = null
): FilterPopoverDraft {
  return {
    mode: 'edit',
    editIndex: index,
    step: condition.operator === 'is-empty' ? 'operator' : 'value',
    fieldKey: condition.fieldKey,
    fieldType,
    operator: condition.operator,
    selectedValues: condition.values ? [...condition.values] : [],
    textValue:
      condition.value !== undefined && condition.value !== null ? String(condition.value) : '',
    minValue: condition.min !== undefined ? String(condition.min) : '',
    maxValue: condition.max !== undefined ? String(condition.max) : ''
  }
}

/** Returns true when an active popover `draft` matches the schema `field` type and operator. */
export function isFilterDraftCompatibleWithField(
  draft: FilterPopoverDraft,
  field: FrontmatterFieldDefinition | undefined
): field is FrontmatterFieldDefinition {
  if (!field) return false
  if (draft.fieldType !== null && field.type !== draft.fieldType) return false
  if (draft.operator !== null && !isFrontmatterOperatorForType(field.type, draft.operator)) {
    return false
  }
  return true
}

/** Advances a cyclic listbox highlight index safely within `[0, totalCount - 1]`. */
export function cycleListboxIndex(
  currentIndex: number,
  totalCount: number,
  delta: 1 | -1
): number {
  if (totalCount <= 0) return -1
  const clamped = Math.max(0, Math.min(currentIndex, totalCount - 1))
  return (clamped + delta + totalCount) % totalCount
}

interface OrderedRangeDraftParser {
  parse: (raw: string) => number | string | null
  isEmpty: (raw: string) => boolean
  invalidFormatError: string
  invalidRangeError: string
}

const ORDERED_RANGE_PARSERS: Record<'number' | 'date', OrderedRangeDraftParser> = {
  number: {
    parse: (raw) => {
      const n = Number(raw)
      return Number.isFinite(n) ? n : null
    },
    isEmpty: (raw) => raw.trim() === '',
    invalidFormatError: '유효한 숫자를 입력하세요.',
    invalidRangeError: '최솟값은 최댓값보다 클 수 없습니다.'
  },
  date: {
    parse: (raw) => (isValidIsoCalendarDate(raw) ? raw : null),
    isEmpty: (raw) => raw === '',
    invalidFormatError: '유효한 YYYY-MM-DD 날짜를 입력하세요.',
    invalidRangeError: '시작일은 종료일보다 늦을 수 없습니다.'
  }
}

function buildOrderedRangeCondition(
  fieldKey: string,
  operator: FrontmatterFilterOperator,
  draft: FilterPopoverDraft,
  spec: OrderedRangeDraftParser
): { ok: true; condition: FrontmatterFilterCondition } | { ok: false; error?: string } {
  if (operator === 'between') {
    if (spec.isEmpty(draft.minValue) || spec.isEmpty(draft.maxValue)) {
      return { ok: false }
    }
    const min = spec.parse(draft.minValue)
    const max = spec.parse(draft.maxValue)
    if (min === null || max === null) {
      return { ok: false, error: spec.invalidFormatError }
    }
    const isInverted =
      typeof min === 'number' && typeof max === 'number' ? min > max : String(min) > String(max)
    if (isInverted) {
      return { ok: false, error: spec.invalidRangeError }
    }
    return {
      ok: true,
      condition: { fieldKey, operator, min, max }
    }
  }

  if (spec.isEmpty(draft.textValue)) {
    return { ok: false }
  }
  const parsed = spec.parse(draft.textValue)
  if (parsed === null) {
    return { ok: false, error: spec.invalidFormatError }
  }
  return {
    ok: true,
    condition: { fieldKey, operator, value: parsed }
  }
}

/** Validates and constructs a `FrontmatterFilterCondition` from a popover draft state. */
export function buildConditionFromDraft(
  field: FrontmatterFieldDefinition,
  draft: FilterPopoverDraft
): { ok: true; condition: FrontmatterFilterCondition } | { ok: false; error?: string } {
  const operator = draft.operator
  if (!operator) return { ok: false }
  if (operator === 'is-empty') {
    return { ok: true, condition: { fieldKey: field.key, operator } }
  }

  switch (field.type) {
    case 'select':
    case 'multi-select':
      if (draft.selectedValues.length === 0) {
        return { ok: false }
      }
      return {
        ok: true,
        condition: {
          fieldKey: field.key,
          operator,
          values: [...draft.selectedValues]
        }
      }

    case 'text': {
      const trimmed = draft.textValue.trim()
      if (!trimmed) return { ok: false }
      return {
        ok: true,
        condition: {
          fieldKey: field.key,
          operator,
          value: trimmed
        }
      }
    }

    case 'number':
    case 'date':
      return buildOrderedRangeCondition(field.key, operator, draft, ORDERED_RANGE_PARSERS[field.type])

    case 'boolean':
      return { ok: false }
  }
}
