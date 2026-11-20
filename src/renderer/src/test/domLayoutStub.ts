import { act } from '@testing-library/react'
import { vi } from 'vitest'
import themeCss from '../styles/theme.css?raw'

export interface ResizeObserverStub {
  trigger: () => void
  restore: () => void
}

/**
 * Installs an isolated JSDOM boundary stub for `globalThis.ResizeObserver`
 * so tests can deterministically trigger container resize callbacks and restore cleanly.
 */
export function installResizeObserverStub(): ResizeObserverStub {
  const OriginalResizeObserver = globalThis.ResizeObserver
  const observerCallbacks: Array<() => void> = []

  globalThis.ResizeObserver = class MockResizeObserver {
    constructor(callback: ResizeObserverCallback) {
      observerCallbacks.push(() => callback([], this as unknown as ResizeObserver))
    }
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver

  return {
    trigger: () => {
      act(() => {
        observerCallbacks.forEach((cb) => cb())
      })
    },
    restore: () => {
      globalThis.ResizeObserver = OriginalResizeObserver
    }
  }
}

/**
 * Stubs `getBoundingClientRect()` on a JSDOM element with deterministic layout dimensions.
 */
export function mockElementBoundingRect(
  element: HTMLElement,
  { left = 0, top = 0, width, height }: { left?: number; top?: number; width: number; height: number }
): void {
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    x: left,
    y: top,
    toJSON: () => ({})
  })
}

/**
 * Installs a reactive JSDOM scroll-container stub with clamping `scrollTop` setter
 * and bounding rect geometry for scroll-coordinate and edge auto-scroll tests.
 */
export function installScrollContainerStub(
  container: HTMLElement,
  options: {
    top?: number
    clientHeight: number
    initialScrollTop: number
    getScrollHeight: () => number
    getMaxScrollCeiling?: () => number | null
  }
) {
  let currentScrollTop = options.initialScrollTop
  const scrollWrites: number[] = []
  mockElementBoundingRect(container, {
    top: options.top ?? 0,
    width: 500,
    height: options.clientHeight
  })
  Object.defineProperties(container, {
    clientHeight: { configurable: true, value: options.clientHeight },
    scrollHeight: { configurable: true, get: options.getScrollHeight },
    scrollTop: {
      configurable: true,
      get: () => currentScrollTop,
      set: (value: number) => {
        const rawMax = Math.max(0, container.scrollHeight - container.clientHeight)
        const ceiling = options.getMaxScrollCeiling?.() ?? null
        const effectiveMax = ceiling === null ? rawMax : Math.min(rawMax, ceiling)
        currentScrollTop = Math.max(0, Math.min(effectiveMax, value))
        scrollWrites.push(currentScrollTop)
      }
    }
  })

  return {
    getScrollTop: () => currentScrollTop,
    setScrollTop: (value: number) => {
      currentScrollTop = value
    },
    getScrollWrites: () => scrollWrites,
    clearScrollWrites: () => {
      scrollWrites.length = 0
    }
  }
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
