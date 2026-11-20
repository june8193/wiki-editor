/**
 * Shared multi-window `<App />` test helpers: suite lifecycle isolation/cleanup,
 * cross-window drag/DataTransfer stubs, deferred buffer IPC gates,
 * and window/tab UI drivers.
 */
import { fireEvent, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, vi } from 'vitest'
import type { AppConfig } from '@shared/config'
import type { AppMenuCommand } from '@shared/ipc'
import {
  createMultiWindowWikiHarness,
  type InMemoryWindowHandle,
  type MultiWindowWikiHarness,
  triggerMenuCommand,
  type VirtualFsOptions
} from './inMemoryWikiHarness'

export interface CrossWindowDataTransferStub {
  dropEffect: string
  effectAllowed: string
  readonly types: string[]
  setData: (mime: string, value: string) => void
  getData: (mime: string) => string
}

export interface MultiWindowTestLifecycle {
  createHarness: (
    initialOverrides?: Partial<AppConfig>,
    fsOptions?: VirtualFsOptions
  ) => MultiWindowWikiHarness
  trackDisposer: (...disposers: Array<() => void>) => void
}

/**
 * Registers Vitest `beforeEach` / `afterEach` isolation hooks for multi-window `<App />` suites,
 * resetting `data-theme`, `document.title`, and real timers before each test and disposing all
 * tracked harnesses and cleanup callbacks after each test.
 */
export function registerMultiWindowLifecycle(): MultiWindowTestLifecycle {
  const activeDisposers: Array<() => void> = []

  beforeEach(() => {
    document.documentElement.removeAttribute('data-theme')
    document.title = ''
    vi.useRealTimers()
  })

  afterEach(() => {
    for (const dispose of activeDisposers.splice(0)) {
      dispose()
    }
  })

  return {
    createHarness: (initialOverrides, fsOptions) => {
      const harness = createMultiWindowWikiHarness(initialOverrides, fsOptions)
      activeDisposers.push(() => harness.dispose())
      return harness
    },
    trackDisposer: (...disposers) => {
      activeDisposers.push(...disposers)
    }
  }
}

/**
 * Dispatches a `dragend` MouseEvent carrying `screenX`/`screenY` coordinates
 * because jsdom omits the native `DragEvent` constructor.
 */
export function dispatchDragEndAtScreenPoint(
  target: Element,
  screenX: number,
  screenY: number
): void {
  // Chromium DragEvent subclasses MouseEvent; jsdom omits DragEvent so dispatch MouseEvent to preserve screenX/screenY
  const event = new MouseEvent('dragend', {
    bubbles: true,
    cancelable: false,
    screenX,
    screenY
  })
  fireEvent(target, event)
}

/**
 * Creates an in-memory `DataTransfer` stub for cross-window tab drag-and-drop tests,
 * optionally hiding `getData()` output when simulating MIME-only `dragenter`/`dragover` phases.
 */
export function createCrossWindowDataTransfer(options?: {
  allowGetData?: boolean
}): CrossWindowDataTransferStub {
  const store = new Map<string, string>()
  return {
    dropEffect: 'move',
    effectAllowed: 'move',
    get types() {
      return Array.from(store.keys())
    },
    setData(mime: string, value: string) {
      store.set(mime, value)
    },
    getData(mime: string) {
      return options?.allowGetData === false ? '' : (store.get(mime) ?? '')
    }
  }
}

/**
 * Intercepts a `WikiBufferApi` method (`syncWindowTabs` or `updateContent`) so callers can
 * hold IPC calls in flight and flush all pending invocations deterministically.
 */
export function deferBufferMethod<K extends 'syncWindowTabs' | 'updateContent'>(
  bufferApi: InMemoryWindowHandle['api']['buffer'],
  method: K
): { count: () => number; flushAll: () => void } {
  const original = bufferApi[method].bind(bufferApi) as (...args: unknown[]) => Promise<unknown>
  const deferred: Array<() => void> = []
  bufferApi[method] = ((...args: unknown[]) =>
    new Promise((resolve) => {
      deferred.push(() => {
        void original(...args).then(resolve)
      })
    })) as InMemoryWindowHandle['api']['buffer'][K]
  return {
    count: () => deferred.length,
    flushAll: () => {
      bufferApi[method] = original as InMemoryWindowHandle['api']['buffer'][K]
      for (const flush of deferred.splice(0)) {
        flush()
      }
    }
  }
}

/**
 * Triggers `open-folder` in a rendered window, clicks `fileName` in its Folder Tree,
 * and returns the mounted Document Editor element.
 */
export async function openFolderAndNoteInWindow(
  user: ReturnType<typeof userEvent.setup>,
  container: HTMLElement,
  emitMenuCommand: (command: AppMenuCommand) => void,
  fileName: string
): Promise<HTMLElement> {
  await triggerMenuCommand(emitMenuCommand, 'open-folder')
  const sidebar = await within(container).findByLabelText('워크스페이스 탐색기')
  await user.click(await within(sidebar).findByText(fileName))
  return within(container).findByTestId('document-editor')
}

/**
 * Opens the Settings Panel via menu command and clicks `'설정 파일 직접 열기'` inside `container`.
 */
export async function openConfigFromSettings(
  user: ReturnType<typeof userEvent.setup>,
  container: HTMLElement,
  emitMenuCommand: (command: AppMenuCommand) => void
): Promise<void> {
  await triggerMenuCommand(emitMenuCommand, 'toggle-settings')
  await user.click(
    await within(container).findByRole('button', { name: '설정 파일 직접 열기' })
  )
}

/**
 * Opens the tab context menu for the matching tab inside `container` and selects `'새 창으로 이동'`.
 */
export async function detachTabViaContextMenu(
  user: ReturnType<typeof userEvent.setup>,
  container: HTMLElement,
  tabNamePattern: RegExp
): Promise<void> {
  fireEvent.contextMenu(within(container).getByRole('tab', { name: tabNamePattern }))
  const menu = await within(container).findByRole('menu', { name: '탭 작업 메뉴' })
  await user.click(within(menu).getByRole('menuitem', { name: '새 창으로 이동' }))
}
