import {
  FRONTMATTER_FIELD_TYPES,
  type FrontmatterFieldDefinition,
  type FrontmatterFieldType,
  isValidFrontmatterFieldKey,
  parseFrontmatterSchema,
  type WorkspaceFrontmatterSchema
} from '@shared/frontmatter'

export interface SchemaOptionDraft {
  id: string
  value: string
  color: string
}

export interface SchemaFieldDraft {
  id: string
  key: string
  label: string
  type: FrontmatterFieldType
  required: boolean
  placeholder: string
  options: SchemaOptionDraft[]
  allowCustom: boolean
  showInSearchBadge: boolean
}

export interface SchemaFieldValidationErrors {
  keyError?: string
  labelError?: string
  optionsError?: string
  optionErrors: Record<string, string>
}

export type SchemaDraftValidationResult =
  | {
      ok: true
      schema: WorkspaceFrontmatterSchema
      errorsByFieldId: Record<string, SchemaFieldValidationErrors>
    }
  | {
      ok: false
      summaryErrors: string[]
      errorsByFieldId: Record<string, SchemaFieldValidationErrors>
    }

const FIELD_TYPE_LABELS: Readonly<Record<FrontmatterFieldType, string>> = {
  text: 'text (텍스트)',
  number: 'number (숫자)',
  boolean: 'boolean (참/거짓)',
  date: 'date (날짜)',
  select: 'select (단일 선택)',
  'multi-select': 'multi-select (다중 선택)'
}

export const FRONTMATTER_FIELD_TYPE_OPTIONS: ReadonlyArray<{
  value: FrontmatterFieldType
  label: string
}> = FRONTMATTER_FIELD_TYPES.map((type) => ({
  value: type,
  label: FIELD_TYPE_LABELS[type]
}))

const HEX6_COLOR_RE = /^#[0-9a-fA-F]{6}$/
export const DEFAULT_OPTION_PICKER_COLOR = '#64748b'

/** Returns true when a frontmatter field type supports predefined choice options. */
export function isOptionBasedFieldType(type: FrontmatterFieldType): boolean {
  return type === 'select' || type === 'multi-select'
}

/** Normalizes an option color string to a 6-digit hex value safe for `<input type="color">`. */
export function normalizePickerHexColor(color: string): string {
  const trimmed = color.trim()
  return HEX6_COLOR_RE.test(trimmed) ? trimmed.toLowerCase() : DEFAULT_OPTION_PICKER_COLOR
}

/** Returns a new array with the item at `index` moved one slot up (`-1`) or down (`1`). */
export function moveArrayItem<T>(items: readonly T[], index: number, direction: -1 | 1): T[] {
  const targetIndex = index + direction
  if (index < 0 || index >= items.length || targetIndex < 0 || targetIndex >= items.length) {
    return [...items]
  }
  const next = [...items]
  const [moved] = next.splice(index, 1)
  next.splice(targetIndex, 0, moved)
  return next
}

export function createEmptySchemaOptionDraft(nextId: () => string): SchemaOptionDraft {
  return {
    id: nextId(),
    value: '',
    color: ''
  }
}

export function createEmptySchemaFieldDraft(nextId: () => string): SchemaFieldDraft {
  return {
    id: nextId(),
    key: '',
    label: '',
    type: 'text',
    required: false,
    placeholder: '',
    options: [],
    allowCustom: false,
    showInSearchBadge: false
  }
}

export function createSchemaDraftFields(
  schema: WorkspaceFrontmatterSchema | null,
  nextId: () => string
): SchemaFieldDraft[] {
  if (!schema) return []
  return schema.fields.map((field) => ({
    id: nextId(),
    key: field.key,
    label: field.label,
    type: field.type,
    required: Boolean(field.required),
    placeholder: field.placeholder ?? '',
    options: (field.options ?? []).map((opt) => ({
      id: nextId(),
      value: opt.value,
      color: opt.color ?? ''
    })),
    allowCustom: Boolean(field.allowCustom),
    showInSearchBadge: Boolean(field.showInSearchBadge)
  }))
}

function buildFieldDefinitionFromDraft(draft: SchemaFieldDraft): FrontmatterFieldDefinition {
  const trimmedPlaceholder = draft.placeholder.trim()
  const hasOptionSupport = isOptionBasedFieldType(draft.type)
  const canonicalOptions = hasOptionSupport
    ? draft.options.map((opt) => {
        const trimmedColor = opt.color.trim()
        return {
          value: opt.value.trim(),
          ...(trimmedColor ? { color: trimmedColor } : {})
        }
      })
    : undefined

  return {
    key: draft.key,
    label: draft.label.trim(),
    type: draft.type,
    ...(draft.required ? { required: true } : {}),
    ...(trimmedPlaceholder ? { placeholder: trimmedPlaceholder } : {}),
    ...(canonicalOptions && canonicalOptions.length > 0 ? { options: canonicalOptions } : {}),
    ...(draft.type === 'multi-select' && draft.allowCustom ? { allowCustom: true } : {}),
    ...(draft.showInSearchBadge ? { showInSearchBadge: true } : {})
  }
}

function countOccurrences(values: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const val of values) {
    if (!val) continue
    counts.set(val, (counts.get(val) ?? 0) + 1)
  }
  return counts
}

/**
 * Validates draft schema fields and options, producing per-field inline errors and
 * a canonical `WorkspaceFrontmatterSchema` matching backend strict validation rules.
 */
export function validateAndBuildSchemaDraft(
  fields: readonly SchemaFieldDraft[]
): SchemaDraftValidationResult {
  const errorsByFieldId: Record<string, SchemaFieldValidationErrors> = {}
  const summaryErrors: string[] = []
  const keyCounts = countOccurrences(fields.map((field) => field.key))

  let hasErrors = false
  for (const field of fields) {
    const fieldError: SchemaFieldValidationErrors = { optionErrors: {} }

    if (field.key.length === 0) {
      fieldError.keyError = '필드 키를 입력하세요.'
    } else if (!isValidFrontmatterFieldKey(field.key)) {
      fieldError.keyError =
        '유효하지 않은 키입니다. 공백, 특수문자(:, #, [, ], {, } 등), 선행 하이픈(-)은 사용할 수 없습니다.'
    } else if ((keyCounts.get(field.key) ?? 0) > 1) {
      fieldError.keyError = `중복된 필드 키입니다: "${field.key}"`
    }

    if (field.label.trim().length === 0) {
      fieldError.labelError = '필드 라벨을 입력하세요.'
    }

    if (isOptionBasedFieldType(field.type)) {
      const requiresOptions =
        field.type === 'select' || (field.type === 'multi-select' && !field.allowCustom)
      if (requiresOptions && field.options.length === 0) {
        fieldError.optionsError = '최소 1개 이상의 옵션을 추가하세요.'
      }

      const optionCounts = countOccurrences(field.options.map((opt) => opt.value.trim()))
      for (const opt of field.options) {
        const trimmedVal = opt.value.trim()
        if (trimmedVal.length === 0) {
          fieldError.optionErrors[opt.id] = '옵션 값을 입력하세요.'
        } else if ((optionCounts.get(trimmedVal) ?? 0) > 1) {
          fieldError.optionErrors[opt.id] = `중복된 옵션 값입니다: "${trimmedVal}"`
        }
      }
    }

    if (
      fieldError.keyError ||
      fieldError.labelError ||
      fieldError.optionsError ||
      Object.keys(fieldError.optionErrors).length > 0
    ) {
      hasErrors = true
    }
    errorsByFieldId[field.id] = fieldError
  }

  if (hasErrors) {
    summaryErrors.push('입력값을 확인한 뒤 다시 저장해 주세요.')
    return { ok: false, summaryErrors, errorsByFieldId }
  }

  const candidateSchema: WorkspaceFrontmatterSchema = {
    version: 1,
    fields: fields.map(buildFieldDefinitionFromDraft)
  }
  const strictCheck = parseFrontmatterSchema(candidateSchema)
  if (!strictCheck.ok) {
    return {
      ok: false,
      summaryErrors: [strictCheck.error],
      errorsByFieldId
    }
  }

  return {
    ok: true,
    schema: strictCheck.schema,
    errorsByFieldId
  }
}
