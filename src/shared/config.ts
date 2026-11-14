export interface CustomCommandConfig {
  /** 슬래시 명령어 트리거 (예: "function", "struct" -> /function, /struct) */
  trigger: string
  /** 자동완성 목록 표시 이름 */
  label: string
  /** 선택적 설명 */
  description?: string
  /** 삽입될 표준 마크다운 템플릿 ({{cursor}}, {{date}}, {{title}} 치환 지원) */
  template: string
}

export interface FavoriteWorkspace {
  path: string
  name: string
  pinnedAt: string // ISO-8601
}

export type ThemeMode = 'light' | 'dark'

export interface AppConfig {
  version: 1
  theme: ThemeMode
  autoSave: boolean
  autoSaveDelayMs: number
  showHeadingNumbers: boolean
  favoriteWorkspaces: FavoriteWorkspace[]
  recentWorkspaces: string[]
  customCommands: CustomCommandConfig[]
}

export const DEFAULT_TOC_COMMAND_TEMPLATE = '<!-- toc -->\n<!-- /toc -->'

export const DEFAULT_CUSTOM_COMMANDS: readonly CustomCommandConfig[] = [
  {
    trigger: 'function',
    label: 'Function 문서',
    description: '함수 시그니처와 매개변수/반환값 문서 템플릿',
    template:
      '### Function: {{cursor}}\n\n- **설명**:\n- **매개변수**:\n  - `param`: 설명\n- **반환값**:'
  },
  {
    trigger: 'struct',
    label: 'Struct 정의',
    description: '구조체/타입 정의 코드 블록 템플릿',
    template: '### Struct: {{cursor}}\n\n```c\ntypedef struct {\n  int id;\n} StructName;\n```'
  },
  {
    trigger: 'table',
    label: '마크다운 표',
    description: '3열 기본 GFM 마크다운 표 삽입',
    template: '| {{cursor}}열 1 | 열 2 | 열 3 |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |'
  },
  {
    trigger: 'mermaid',
    label: 'Mermaid 다이어그램',
    description: 'Mermaid 플로우차트 다이어그램 코드 블록 삽입',
    template: '```mermaid\nflowchart TD\n  {{cursor}}A[시작] --> B[끝]\n```'
  },
  {
    trigger: 'toc',
    label: '목차 (TOC)',
    description: '현재 문서 헤딩 기준 목차 블록 삽입',
    template: DEFAULT_TOC_COMMAND_TEMPLATE
  }
]

function cloneCustomCommand(command: CustomCommandConfig): CustomCommandConfig {
  return {
    trigger: command.trigger,
    label: command.label,
    ...(command.description !== undefined ? { description: command.description } : {}),
    template: command.template
  }
}

export const DEFAULT_APP_CONFIG: AppConfig = {
  version: 1,
  theme: 'light',
  autoSave: false,
  autoSaveDelayMs: 1000,
  showHeadingNumbers: true,
  favoriteWorkspaces: [],
  recentWorkspaces: [],
  customCommands: DEFAULT_CUSTOM_COMMANDS.map(cloneCustomCommand)
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function shallowClone<T extends object>(item: T): T {
  return { ...item }
}

function isFavoriteWorkspace(value: unknown): value is FavoriteWorkspace {
  return (
    isPlainRecord(value) &&
    typeof value.path === 'string' &&
    value.path.trim().length > 0 &&
    typeof value.name === 'string' &&
    value.name.trim().length > 0 &&
    typeof value.pinnedAt === 'string'
  )
}

const CUSTOM_COMMAND_TRIGGER_RE = /^[\p{L}\p{N}_-]+$/u

/**
 * Validates a custom slash command trigger against empty, whitespace, slash, syntax, and uniqueness rules.
 * Returns null when valid, or a descriptive error message when invalid.
 */
export function validateCustomCommandTrigger(
  trigger: string,
  existingTriggers?: Iterable<string>
): string | null {
  if (trigger.length === 0) {
    return '트리거명을 입력하세요.'
  }
  if (/\s/.test(trigger)) {
    return '트리거명에는 공백을 포함할 수 없습니다.'
  }
  if (trigger.includes('/')) {
    return '트리거명에는 "/"를 포함할 수 없습니다.'
  }
  if (!CUSTOM_COMMAND_TRIGGER_RE.test(trigger)) {
    return '트리거명은 영문, 숫자, 한글, "_", "-"만 사용할 수 있습니다.'
  }
  if (existingTriggers) {
    const normalized = trigger.toLowerCase()
    for (const existing of existingTriggers) {
      if (existing.toLowerCase() === normalized) {
        return `이미 존재하는 트리거명입니다: /${trigger}`
      }
    }
  }
  return null
}

function isCustomCommandConfig(value: unknown): value is CustomCommandConfig {
  return (
    isPlainRecord(value) &&
    typeof value.trigger === 'string' &&
    validateCustomCommandTrigger(value.trigger) === null &&
    typeof value.label === 'string' &&
    value.label.trim().length > 0 &&
    typeof value.template === 'string' &&
    (value.description === undefined || typeof value.description === 'string')
  )
}

function parseCustomCommands(value: unknown, strict: boolean): CustomCommandConfig[] | null {
  if (!Array.isArray(value)) return null
  const seenTriggers = new Set<string>()
  const parsed: CustomCommandConfig[] = []

  for (const item of value) {
    if (!isCustomCommandConfig(item)) {
      if (strict) return null
      continue
    }
    const triggerKey = item.trigger.toLowerCase()
    if (seenTriggers.has(triggerKey)) {
      if (strict) return null
      continue
    }
    seenTriggers.add(triggerKey)
    parsed.push(cloneCustomCommand(item))
  }

  return parsed
}

function parseTypedArray<T>(
  value: unknown,
  guard: (item: unknown) => item is T,
  cloneItem: (item: T) => T,
  strict: boolean
): T[] | null {
  if (!Array.isArray(value)) return null
  if (strict && !value.every(guard)) return null
  return value.filter(guard).map(cloneItem)
}

interface FieldSpec<K extends keyof AppConfig> {
  parse: (value: unknown, strict: boolean) => AppConfig[K] | null
  errorMessage: string
}

const CONFIG_FIELD_SPECS: { [K in keyof AppConfig]: FieldSpec<K> } = {
  version: {
    parse: (value) => (value === 1 ? 1 : null),
    errorMessage: 'Invalid config version: expected 1'
  },
  theme: {
    parse: (value) => (value === 'light' || value === 'dark' ? value : null),
    errorMessage: 'Invalid theme: expected "light" or "dark"'
  },
  autoSave: {
    parse: (value) => (typeof value === 'boolean' ? value : null),
    errorMessage: 'Invalid autoSave: expected boolean'
  },
  autoSaveDelayMs: {
    parse: (value) => {
      if (typeof value !== 'number' || !Number.isFinite(value)) return null
      const rounded = Math.round(value)
      return rounded > 0 ? rounded : null
    },
    errorMessage: 'Invalid autoSaveDelayMs: expected positive finite number'
  },
  showHeadingNumbers: {
    parse: (value) => (typeof value === 'boolean' ? value : null),
    errorMessage: 'Invalid showHeadingNumbers: expected boolean'
  },
  favoriteWorkspaces: {
    parse: (value, strict) => parseTypedArray(value, isFavoriteWorkspace, shallowClone, strict),
    errorMessage: 'Invalid favoriteWorkspaces: expected FavoriteWorkspace[]'
  },
  recentWorkspaces: {
    parse: (value, strict) =>
      parseTypedArray(
        value,
        (item): item is string => typeof item === 'string',
        (item) => item,
        strict
      ),
    errorMessage: 'Invalid recentWorkspaces: expected string[]'
  },
  customCommands: {
    parse: (value, strict) => parseCustomCommands(value, strict),
    errorMessage:
      'Invalid customCommands: triggers must be unique, non-empty, contain no whitespace or slashes, and use valid characters'
  }
}

const CONFIG_KEYS = Object.keys(CONFIG_FIELD_SPECS) as Array<keyof AppConfig>

export function cloneAppConfig(config: AppConfig): AppConfig {
  return {
    ...config,
    favoriteWorkspaces: config.favoriteWorkspaces.map(shallowClone),
    recentWorkspaces: [...config.recentWorkspaces],
    customCommands: config.customCommands.map(cloneCustomCommand)
  }
}

export function normalizeAppConfig(
  raw: Record<string, unknown>,
  base: AppConfig = DEFAULT_APP_CONFIG
): AppConfig {
  const result = cloneAppConfig(base)
  for (const key of CONFIG_KEYS) {
    const parsed = CONFIG_FIELD_SPECS[key].parse(raw[key], false)
    if (parsed !== null) {
      ;(result as Record<keyof AppConfig, unknown>)[key] = parsed
    }
  }
  result.version = 1
  return result
}

/**
 * Strictly validates a partial config update payload, throwing on invalid fields or types.
 */
export function validateConfigPatch(raw: unknown): Partial<AppConfig> {
  if (!isPlainRecord(raw)) {
    throw new Error('Config update payload must be a plain object')
  }

  const patch: Partial<AppConfig> = {}
  for (const key of CONFIG_KEYS) {
    if (key in raw && raw[key] !== undefined) {
      const spec = CONFIG_FIELD_SPECS[key]
      const parsed = spec.parse(raw[key], true)
      if (parsed === null) {
        throw new Error(spec.errorMessage)
      }
      ;(patch as Record<keyof AppConfig, unknown>)[key] = parsed
    }
  }
  return patch
}

const CONFIG_KEY_SET = new Set<string>(CONFIG_KEYS)

/**
 * Parses and strictly validates raw config.json text against the AppConfig schema.
 */
export function validateConfigRaw(rawText: string): AppConfig {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawText)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`Invalid JSON syntax in config.json: ${reason}`)
  }

  if (!isPlainRecord(parsed)) {
    throw new Error('Config document must be a plain object')
  }

  for (const key of Object.keys(parsed)) {
    if (!CONFIG_KEY_SET.has(key)) {
      throw new Error(`Unknown config key: "${key}"`)
    }
  }

  const validatedPatch = validateConfigPatch(parsed)
  return normalizeAppConfig(validatedPatch, DEFAULT_APP_CONFIG)
}
