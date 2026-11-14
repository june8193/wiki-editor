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
    typeof value.label === 'string' &&
    typeof value.template === 'string' &&
    (value.description === undefined || typeof value.description === 'string')
  )
}

export function cloneAppConfig(config: AppConfig): AppConfig {
  return {
    ...config,
    favoriteWorkspaces: config.favoriteWorkspaces.map((item) => ({ ...item })),
    recentWorkspaces: [...config.recentWorkspaces],
    customCommands: config.customCommands.map((item) => ({ ...item }))
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

  const favoriteWorkspaces = Array.isArray(raw.favoriteWorkspaces)
    ? raw.favoriteWorkspaces.filter(isFavoriteWorkspace).map((item) => ({ ...item }))
    : base.favoriteWorkspaces.map((item) => ({ ...item }))

  const recentWorkspaces = Array.isArray(raw.recentWorkspaces)
    ? raw.recentWorkspaces.filter((item): item is string => typeof item === 'string')
    : [...base.recentWorkspaces]

  const customCommands = Array.isArray(raw.customCommands)
    ? raw.customCommands.filter(isCustomCommandConfig).map((item) => ({ ...item }))
    : base.customCommands.map((item) => ({ ...item }))

  return {
    version: 1,
    theme,
    autoSave,
    autoSaveDelayMs,
    showHeadingNumbers,
    favoriteWorkspaces,
    recentWorkspaces,
    customCommands
  }
}
