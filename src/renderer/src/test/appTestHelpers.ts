import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { type Mock, vi } from 'vitest'
import themeCss from '../styles/theme.css?raw'

export type ActivityBarButtonLabel = '탐색기' | '검색' | 'Git' | '워크스페이스'
export type PaneEditorModeLabel = 'Raw' | 'Split' | 'Preview' | '위지윅'

export interface MermaidMockState {
  initialize: Mock<(cfg?: { theme?: string }) => void>
  render: Mock<(id: string, text: string) => Promise<{ svg: string }>>
  reset: () => void
}

/**
 * Creates a theme-aware Mermaid module mock state with `SYNTAX_ERROR` failure simulation
 * and per-test reset support for `<App />` integration suites.
 */
export function createMermaidMockState(): MermaidMockState {
  let activeTheme = 'default'
  const initialize = vi.fn((cfg?: { theme?: string }) => {
    activeTheme = cfg?.theme ?? 'default'
  })
  const render = vi.fn(async (_id: string, text: string) => {
    if (text.includes('SYNTAX_ERROR')) {
      throw new Error('Syntax error in Mermaid graph')
    }
    return {
      svg: `<svg viewBox="0 0 240 120" width="100%" style="max-width: 240px;" data-mermaid-theme="${activeTheme}" data-code="${text.trim()}"><g><text>DiagramOK</text></g></svg>`
    }
  })
  return {
    initialize,
    render,
    reset: () => {
      activeTheme = 'default'
      initialize.mockClear()
      render.mockClear()
    }
  }
}

/**
 * Stubs `HTMLElement.prototype.scrollIntoView` with a Vitest spy and returns a restorer
 * that reinstates the original property descriptor.
 */
export function mockPrototypeScrollIntoView(): {
  mock: Mock
  restore: () => void
} {
  const mock = vi.fn()
  const origDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView')
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    writable: true,
    value: mock
  })
  return {
    mock,
    restore: () => {
      if (origDescriptor) {
        Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', origDescriptor)
      } else {
        delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView
      }
    }
  }
}

/**
 * Clicks an Activity Bar navigation button by its accessible label.
 */
export async function clickActivityBarButton(
  user: ReturnType<typeof userEvent.setup>,
  label: ActivityBarButtonLabel
): Promise<void> {
  const activityBar = screen.getByRole('navigation', { name: '액티비티 바' })
  await user.click(within(activityBar).getByRole('button', { name: label }))
}

/**
 * Opens the Workspace View from the Activity Bar and selects a workspace matching the pattern.
 */
export async function switchWorkspaceFromView(
  user: ReturnType<typeof userEvent.setup>,
  workspaceNamePattern: RegExp
): Promise<void> {
  await clickActivityBarButton(user, '워크스페이스')
  await user.click(
    within(screen.getByRole('region', { name: '워크스페이스 뷰' })).getByRole('button', {
      name: workspaceNamePattern
    })
  )
}

/**
 * Switches the Editor Mode (`Raw`, `Split`, `Preview`, or `위지윅`) within a target Pane.
 */
export async function switchPaneEditorMode(
  user: ReturnType<typeof userEvent.setup>,
  pane: HTMLElement,
  modeLabel: PaneEditorModeLabel
): Promise<void> {
  await user.click(
    within(within(pane).getByRole('group', { name: '에디터 모드 전환' })).getByRole('button', {
      name: modeLabel
    })
  )
}

/**
 * Injects `theme.css` into `document.head` and mounts a `#root` element in `document.body`
 * for layout and computed-style assertions, returning a cleanup callback.
 */
export function mountThemeStylesAndRoot(): { rootEl: HTMLDivElement; cleanup: () => void } {
  const styleEl = document.createElement('style')
  styleEl.setAttribute('data-test-theme', 'true')
  styleEl.textContent = themeCss
  document.head.appendChild(styleEl)

  const rootEl = document.createElement('div')
  rootEl.id = 'root'
  document.body.appendChild(rootEl)

  return {
    rootEl,
    cleanup: () => {
      rootEl.remove()
      styleEl.remove()
    }
  }
}
