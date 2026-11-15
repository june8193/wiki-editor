import { useRef, useSyncExternalStore } from 'react'

const DEFAULT_FALLBACK_WIDTH = 1024

function subscribeWindowResize(callback: () => void): () => void {
  window.addEventListener('resize', callback)
  return () => window.removeEventListener('resize', callback)
}

function readValidWindowWidth(fallback: number): number {
  if (typeof window !== 'undefined' && Number.isFinite(window.innerWidth) && window.innerWidth > 0) {
    return window.innerWidth
  }
  return fallback
}

/**
 * Tracks `window.innerWidth` across resize events while ignoring transient non-positive values (e.g. minimized windows).
 */
export function useWindowWidth(fallbackWidth = DEFAULT_FALLBACK_WIDTH): number {
  const lastValidRef = useRef<number>(readValidWindowWidth(fallbackWidth))
  return useSyncExternalStore(subscribeWindowResize, () => {
    lastValidRef.current = readValidWindowWidth(lastValidRef.current)
    return lastValidRef.current
  })
}
