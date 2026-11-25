import { FitAddon } from '@xterm/addon-fit'
import { Terminal, type ITheme } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'

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
  dispose(): void
}

export interface XtermInstanceOptions {
  sessionId: string
  theme: ITheme
  onData: (data: string) => void
  onResize: (cols: number, rows: number) => void
}

export type XtermInstanceFactory = (options: XtermInstanceOptions) => XtermInstance

/**
 * Creates a real xterm.js + FitAddon instance bound to a terminal session.
 */
export const createXtermInstance: XtermInstanceFactory = ({
  theme,
  onData,
  onResize
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
    dispose() {
      dataDisposable.dispose()
      resizeDisposable.dispose()
      terminal.dispose()
      openedContainer = null
    }
  }
}
