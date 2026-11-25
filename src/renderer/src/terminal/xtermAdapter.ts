import { FitAddon } from '@xterm/addon-fit'
import { Terminal, type IDisposable, type ITheme } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { findTerminalLineLinks } from './terminalLinks'

export interface XtermSize {
  cols: number
  rows: number
}

export interface XtermInstance {
  open(container: HTMLElement): void
  write(data: string): void
  fit(): XtermSize | null
  focus(): void
  setTheme(theme: ITheme): void
  hasSelection(): boolean
  getSelection(): string
  clearSelection(): void
  paste(data: string): void
  dispose(): void
}

export interface XtermInstanceOptions {
  sessionId: string
  theme: ITheme
  onData: (data: string) => void
  onResize: (cols: number, rows: number) => void
  onKeyEvent?: (event: KeyboardEvent) => boolean
  onActivateLink?: (text: string, event: MouseEvent) => void
}

export type XtermInstanceFactory = (options: XtermInstanceOptions) => XtermInstance

/**
 * Creates a real xterm.js + FitAddon instance bound to a terminal session.
 */
export const createXtermInstance: XtermInstanceFactory = ({
  theme,
  onData,
  onResize,
  onKeyEvent,
  onActivateLink
}) => {
  const terminal = new Terminal({
    cursorBlink: true,
    fontSize: 13,
    fontFamily: 'Consolas, "Cascadia Mono", "Courier New", monospace',
    theme,
    scrollback: 5000
  })
  const fitAddon = new FitAddon()
  terminal.loadAddon(fitAddon)

  if (onKeyEvent) {
    terminal.attachCustomKeyEventHandler(onKeyEvent)
  }

  let linkProviderDisposable: IDisposable | null = null
  if (onActivateLink) {
    linkProviderDisposable = terminal.registerLinkProvider({
      provideLinks(bufferLineNumber, callback) {
        const line = terminal.buffer.active.getLine(bufferLineNumber - 1)
        if (!line) {
          callback(undefined)
          return
        }
        const lineText = line.translateToString(true)
        const spans = findTerminalLineLinks(lineText)
        if (spans.length === 0) {
          callback(undefined)
          return
        }
        callback(
          spans.map((span) => ({
            range: {
              start: { x: span.startIndex + 1, y: bufferLineNumber },
              end: { x: span.endIndex, y: bufferLineNumber }
            },
            text: span.text,
            decorations: {
              pointerCursor: true,
              underline: true
            },
            activate(event, text) {
              onActivateLink(text, event)
            }
          }))
        )
      }
    })
  }

  const dataDisposable = terminal.onData(onData)
  const resizeDisposable = terminal.onResize(({ cols, rows }) => {
    onResize(cols, rows)
  })
  let openedContainer: HTMLElement | null = null

  return {
    open(container) {
      openedContainer = container
      terminal.open(container)
    },
    write(data) {
      terminal.write(data)
    },
    fit() {
      if (!openedContainer || openedContainer.clientWidth === 0 || openedContainer.clientHeight === 0) {
        return null
      }
      try {
        fitAddon.fit()
        return { cols: terminal.cols, rows: terminal.rows }
      } catch {
        return null
      }
    },
    focus() {
      terminal.focus()
    },
    setTheme(nextTheme) {
      terminal.options.theme = nextTheme
    },
    hasSelection() {
      return terminal.hasSelection()
    },
    getSelection() {
      return terminal.getSelection()
    },
    clearSelection() {
      terminal.clearSelection()
    },
    paste(data) {
      terminal.paste(data)
    },
    dispose() {
      dataDisposable.dispose()
      resizeDisposable.dispose()
      linkProviderDisposable?.dispose()
      terminal.dispose()
      openedContainer = null
    }
  }
}
