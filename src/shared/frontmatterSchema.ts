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

export type FrontmatterSchemaValidationResult =
  | { ok: true; schema: WorkspaceFrontmatterSchema }
  | { ok: false; error: string }

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

/** Returns true when a field type requires at least one predefined schema option. */
export function requiresFrontmatterFieldOptions(
  fieldType: FrontmatterFieldType,
  allowCustom?: boolean
): boolean {
  return fieldType === 'select' || (fieldType === 'multi-select' && !allowCustom)
}

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
  const requiresNonEmptyOptions = requiresFrontmatterFieldOptions(fieldType, allowCustom)

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
    required,
    placeholder: rawField.placeholder as string | undefined,
    options,
    allowCustom,
    showInSearchBadge
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
