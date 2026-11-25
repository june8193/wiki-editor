export const TERMINAL_DEFAULT_COLS = 80
export const TERMINAL_DEFAULT_ROWS = 24
export const TERMINAL_MIN_COLS = 1
export const TERMINAL_MAX_COLS = 1000
export const TERMINAL_MIN_ROWS = 1
export const TERMINAL_MAX_ROWS = 500

export interface TerminalShellProfile {
  id: string
  label: string
  executable: string
  args: string[]
  isDefault: boolean
}

export interface TerminalCreateRequest {
  profileId?: string
  cols: number
  rows: number
}

export interface TerminalSessionInfo {
  id: string
  profileId: string
  title: string
  cwd: string
  pid: number
  isRunning: boolean
}

export interface TerminalDataEvent {
  sessionId: string
  data: string
}

export interface TerminalExitEvent {
  sessionId: string
  exitCode: number | null
  signal?: number
}
