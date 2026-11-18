import { act } from '@testing-library/react'
import { vi } from 'vitest'

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
