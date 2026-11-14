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

export const DEFAULT_APP_CONFIG: AppConfig = {
  version: 1,
  theme: 'light',
  autoSave: false,
  autoSaveDelayMs: 1000,
  showHeadingNumbers: true,
  favoriteWorkspaces: [],
  recentWorkspaces: [],
  customCommands: []
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
    typeof value.name === 'string' &&
    typeof value.pinnedAt === 'string'
  )
}

function isCustomCommandConfig(value: unknown): value is CustomCommandConfig {
  return (
    isPlainRecord(value) &&
    typeof value.trigger === 'string' &&
    value.trigger.trim().length > 0 &&
    typeof value.label === 'string' &&
    value.label.trim().length > 0 &&
    typeof value.template === 'string' &&
    (value.description === undefined || typeof value.description === 'string')
  )
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
    parse: (value, strict) => parseTypedArray(value, isCustomCommandConfig, shallowClone, strict),
    errorMessage: 'Invalid customCommands: expected CustomCommandConfig[]'
  }
}

const CONFIG_KEYS = Object.keys(CONFIG_FIELD_SPECS) as Array<keyof AppConfig>

export function cloneAppConfig(config: AppConfig): AppConfig {
  return {
    ...config,
    favoriteWorkspaces: config.favoriteWorkspaces.map(shallowClone),
    recentWorkspaces: [...config.recentWorkspaces],
    customCommands: config.customCommands.map(shallowClone)
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
