import type { ITheme } from '@xterm/xterm'
import type { ThemeMode } from '@shared/config'

const LIGHT_TERMINAL_THEME: ITheme = {
  background: '#ffffff',
  foreground: '#1f2328',
  cursor: '#0969da',
  cursorAccent: '#ffffff',
  selectionBackground: 'rgba(9, 105, 218, 0.22)',
  black: '#24292f',
  red: '#cf222e',
  green: '#116329',
  yellow: '#4d2d00',
  blue: '#0969da',
  magenta: '#8250df',
  cyan: '#1b7c83',
  white: '#6e7781',
  brightBlack: '#57606a',
  brightRed: '#a40e26',
  brightGreen: '#1a7f37',
  brightYellow: '#633c01',
  brightBlue: '#218bff',
  brightMagenta: '#a475f9',
  brightCyan: '#3192aa',
  brightWhite: '#8c959f'
}

const DARK_TERMINAL_THEME: ITheme = {
  background: '#161b22',
  foreground: '#e6edf3',
  cursor: '#4493f8',
  cursorAccent: '#0d1117',
  selectionBackground: 'rgba(68, 147, 248, 0.3)',
  black: '#484f58',
  red: '#ff7b72',
  green: '#3fb950',
  yellow: '#d29922',
  blue: '#58a6ff',
  magenta: '#bc8cff',
  cyan: '#39c5cf',
  white: '#b1bac4',
  brightBlack: '#6e7681',
  brightRed: '#ffa198',
  brightGreen: '#56d364',
  brightYellow: '#e3b341',
  brightBlue: '#79c0ff',
  brightMagenta: '#d2a8ff',
  brightCyan: '#56d4dd',
  brightWhite: '#f0f6fc'
}

/**
 * Returns the xterm.js color palette matching the active application light/dark theme.
 */
export function getTerminalXtermTheme(theme: ThemeMode): ITheme {
  return theme === 'dark' ? DARK_TERMINAL_THEME : LIGHT_TERMINAL_THEME
}
