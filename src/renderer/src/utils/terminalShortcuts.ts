import { isKeyboardEventComposing, type KeyboardEventLike } from './workspaceSearch'

function isBackquoteKey(event: KeyboardEventLike & { code?: string }): boolean {
  return event.code === 'Backquote' || event.key === '`' || event.key === '~'
}

function isTerminalShortcut(
  event: KeyboardEventLike & { code?: string },
  requireShift: boolean
): boolean {
  return (
    (event.ctrlKey || event.metaKey) &&
    event.shiftKey === requireShift &&
    !event.altKey &&
    !isKeyboardEventComposing(event) &&
    isBackquoteKey(event)
  )
}

/**
 * Returns true when a keyboard event matches the terminal toggle shortcut (`Ctrl+`` / `Cmd+``).
 */
export function isTerminalToggleShortcut(event: KeyboardEventLike & { code?: string }): boolean {
  return isTerminalShortcut(event, false)
}

/**
 * Returns true when a keyboard event matches the new terminal shortcut (`Ctrl+Shift+`` / `Cmd+Shift+``).
 */
export function isNewTerminalShortcut(event: KeyboardEventLike & { code?: string }): boolean {
  return isTerminalShortcut(event, true)
}
