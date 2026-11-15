import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

const EMPTY_DOM_RECT: DOMRect = {
  x: 0,
  y: 0,
  top: 0,
  left: 0,
  bottom: 0,
  right: 0,
  width: 0,
  height: 0,
  toJSON: () => ({})
}

function createEmptyDOMRectList(): DOMRectList {
  return {
    length: 0,
    item: () => null,
    [Symbol.iterator]: function* () {}
  } as DOMRectList
}

if (typeof Range !== 'undefined') {
  if (typeof Range.prototype.getBoundingClientRect !== 'function') {
    Range.prototype.getBoundingClientRect = () => EMPTY_DOM_RECT
  }
  if (typeof Range.prototype.getClientRects !== 'function') {
    Range.prototype.getClientRects = createEmptyDOMRectList
  }
}

if (typeof Element !== 'undefined' && typeof Element.prototype.getClientRects !== 'function') {
  Element.prototype.getClientRects = createEmptyDOMRectList
}

if (typeof document !== 'undefined' && typeof document.elementFromPoint !== 'function') {
  document.elementFromPoint = () => null
}

if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
}

afterEach(() => {
  cleanup()
})
