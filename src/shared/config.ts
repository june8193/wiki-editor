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

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function normalizeArrayField<T>(
  candidate: unknown,
  fallback: readonly T[],
  guard: (value: unknown) => value is T,
  cloneItem: (item: T) => T
): T[] {
  const source = Array.isArray(candidate) ? candidate.filter(guard) : fallback
  return source.map(cloneItem)
}

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
  const theme: ThemeMode = raw.theme === 'light' || raw.theme === 'dark' ? raw.theme : base.theme
  const autoSave = typeof raw.autoSave === 'boolean' ? raw.autoSave : base.autoSave
  const autoSaveDelayMs =
    typeof raw.autoSaveDelayMs === 'number' &&
    Number.isFinite(raw.autoSaveDelayMs) &&
    raw.autoSaveDelayMs > 0
      ? Math.round(raw.autoSaveDelayMs)
      : base.autoSaveDelayMs
  const showHeadingNumbers =
    typeof raw.showHeadingNumbers === 'boolean' ? raw.showHeadingNumbers : base.showHeadingNumbers

  return {
    version: 1,
    theme,
    autoSave,
    autoSaveDelayMs,
    showHeadingNumbers,
    favoriteWorkspaces: normalizeArrayField(
      raw.favoriteWorkspaces,
      base.favoriteWorkspaces,
      isFavoriteWorkspace,
      shallowClone
    ),
    recentWorkspaces: normalizeArrayField(
      raw.recentWorkspaces,
      base.recentWorkspaces,
      isString,
      (value) => value
    ),
    customCommands: normalizeArrayField(
      raw.customCommands,
      base.customCommands,
      isCustomCommandConfig,
      shallowClone
    )
  }
}

/**
 * Strictly validates a partial config update payload, throwing on invalid fields or types.
 */
export function validateConfigPatch(raw: unknown): Partial<AppConfig> {
  if (!isPlainRecord(raw)) {
    throw new Error('Config update payload must be a plain object')
  }

  const patch: Partial<AppConfig> = {}

  if ('version' in raw && raw.version !== undefined) {
    if (raw.version !== 1) {
      throw new Error('Invalid config version: expected 1')
    }
    patch.version = 1
  }

  if ('theme' in raw && raw.theme !== undefined) {
    if (raw.theme !== 'light' && raw.theme !== 'dark') {
      throw new Error('Invalid theme: expected "light" or "dark"')
    }
    patch.theme = raw.theme
  }

  if ('autoSave' in raw && raw.autoSave !== undefined) {
    if (typeof raw.autoSave !== 'boolean') {
      throw new Error('Invalid autoSave: expected boolean')
    }
    patch.autoSave = raw.autoSave
  }

  if ('autoSaveDelayMs' in raw && raw.autoSaveDelayMs !== undefined) {
    if (
      typeof raw.autoSaveDelayMs !== 'number' ||
      !Number.isFinite(raw.autoSaveDelayMs) ||
      raw.autoSaveDelayMs <= 0
    ) {
      throw new Error('Invalid autoSaveDelayMs: expected positive finite number')
    }
    patch.autoSaveDelayMs = Math.round(raw.autoSaveDelayMs)
  }

  if ('showHeadingNumbers' in raw && raw.showHeadingNumbers !== undefined) {
    if (typeof raw.showHeadingNumbers !== 'boolean') {
      throw new Error('Invalid showHeadingNumbers: expected boolean')
    }
    patch.showHeadingNumbers = raw.showHeadingNumbers
  }

  if ('favoriteWorkspaces' in raw && raw.favoriteWorkspaces !== undefined) {
    if (!Array.isArray(raw.favoriteWorkspaces) || !raw.favoriteWorkspaces.every(isFavoriteWorkspace)) {
      throw new Error('Invalid favoriteWorkspaces: expected FavoriteWorkspace[]')
    }
    patch.favoriteWorkspaces = raw.favoriteWorkspaces.map(shallowClone)
  }

  if ('recentWorkspaces' in raw && raw.recentWorkspaces !== undefined) {
    if (!Array.isArray(raw.recentWorkspaces) || !raw.recentWorkspaces.every(isString)) {
      throw new Error('Invalid recentWorkspaces: expected string[]')
    }
    patch.recentWorkspaces = [...raw.recentWorkspaces]
  }

  if ('customCommands' in raw && raw.customCommands !== undefined) {
    if (!Array.isArray(raw.customCommands) || !raw.customCommands.every(isCustomCommandConfig)) {
      throw new Error('Invalid customCommands: expected CustomCommandConfig[]')
    }
    patch.customCommands = raw.customCommands.map(shallowClone)
  }

  return patch
}
