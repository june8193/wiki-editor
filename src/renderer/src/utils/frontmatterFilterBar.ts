import {
  isFrontmatterOperatorForType,
  isFrontmatterValueEmpty,
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
    return Boolean(field && isFrontmatterOperatorForType(field.type, cond.operator))
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

export interface SelectableFilterOption {
  value: string
  color?: string
}

/**
 * Combines schema options (preserving declaration order), live custom workspace values (for
 * `allowCustom`), and any already-selected values into a deduplicated option list.
 */
export function buildFilterSelectableOptions(
  field: FrontmatterFieldDefinition,
  fieldValuesByKey?: Readonly<Record<string, readonly string[]>>,
  currentValues?: readonly string[]
): SelectableFilterOption[] {
  const result: SelectableFilterOption[] = []
  const seen = new Set<string>()
  const colorByValue = new Map<string, string | undefined>()

  for (const opt of field.options ?? []) {
    if (!opt.value) continue
    colorByValue.set(opt.value, opt.color)
    if (!seen.has(opt.value)) {
      seen.add(opt.value)
      result.push({ value: opt.value, ...(opt.color ? { color: opt.color } : {}) })
    }
  }

  if (field.type === 'multi-select' && field.allowCustom && fieldValuesByKey) {
    for (const liveVal of fieldValuesByKey[field.key] ?? []) {
      if (!liveVal || seen.has(liveVal)) continue
      seen.add(liveVal)
      const color = colorByValue.get(liveVal)
      result.push({ value: liveVal, ...(color ? { color } : {}) })
    }
  }

  for (const selectedVal of currentValues ?? []) {
    if (!selectedVal || seen.has(selectedVal)) continue
    seen.add(selectedVal)
    const color = colorByValue.get(selectedVal)
    result.push({ value: selectedVal, ...(color ? { color } : {}) })
  }

  return result
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
      for (const item of raw) {
        if (!item) continue
        const color = field.options?.find((opt) => opt.value === item)?.color
        badges.push({
          id: `${field.key}:${item}`,
          field,
          badgeValue: item,
          displayText: item,
          ...(color ? { color } : {}),
          ariaLabel: `${field.label}: ${item} 필터 추가`,
          title: `${field.label}: ${item} (클릭하여 필터 추가)`
        })
      }
      continue
    }

    if (Array.isArray(raw)) {
      continue
    }

    if (field.type === 'select' && typeof raw === 'string') {
      const color = field.options?.find((opt) => opt.value === raw)?.color
      badges.push({
        id: `${field.key}:${raw}`,
        field,
        badgeValue: raw,
        displayText: raw,
        ...(color ? { color } : {}),
        ariaLabel: `${field.label}: ${raw} 필터 추가`,
        title: `${field.label}: ${raw} (클릭하여 필터 추가)`
      })
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
