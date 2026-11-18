import { createContext, useCallback, useContext } from 'react'
import type { MermaidDiagramHeightMap } from '../stores/PaneTabStore'

export type MermaidHeightChangeHandler = (blockIndex: number, heightPx: number | null) => void

export interface MermaidHeightSessionContextValue {
  mermaidHeights?: MermaidDiagramHeightMap
  onMermaidHeightChange?: MermaidHeightChangeHandler
}

export const MermaidHeightSessionContext = createContext<MermaidHeightSessionContextValue>({})

/**
 * Updates or deletes a 0-based Mermaid block height entry in an immutable map,
 * returning `undefined` when the resulting map has no remaining entries.
 */
export function updateMermaidHeightMap(
  current: MermaidDiagramHeightMap | undefined,
  blockIndex: number,
  heightPx: number | null
): MermaidDiagramHeightMap | undefined {
  if (!Number.isInteger(blockIndex) || blockIndex < 0) {
    return current
  }
  const key = String(blockIndex)

  if (heightPx === null || !Number.isFinite(heightPx) || heightPx <= 0) {
    if (!current || !(key in current)) {
      return current
    }
    const next: Record<string, number> = {}
    let count = 0
    for (const [entryKey, entryHeight] of Object.entries(current)) {
      if (entryKey !== key) {
        next[entryKey] = entryHeight
        count += 1
      }
    }
    return count > 0 ? next : undefined
  }

  const rounded = Math.round(heightPx)
  if (current?.[key] === rounded) {
    return current
  }
  return {
    ...(current ?? {}),
    [key]: rounded
  }
}

/**
 * Reads the persisted session height in pixels for a 0-based Mermaid block index,
 * or `null` when unset or invalid.
 */
export function getPersistedMermaidHeight(
  mermaidHeights: MermaidDiagramHeightMap | undefined,
  blockIndex: number | undefined
): number | null {
  if (blockIndex === undefined || !Number.isInteger(blockIndex) || blockIndex < 0) {
    return null
  }
  const raw = mermaidHeights?.[String(blockIndex)]
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.round(raw) : null
}

/**
 * Resolves the tab-session persisted height and change callback for a single Mermaid block index.
 */
export function useMermaidSessionHeight(blockIndex: number | undefined): {
  persistedHeightPx: number | null
  onCustomHeightChange: ((nextHeightPx: number | null) => void) | undefined
} {
  const { mermaidHeights, onMermaidHeightChange } = useContext(MermaidHeightSessionContext)
  const persistedHeightPx = getPersistedMermaidHeight(mermaidHeights, blockIndex)
  const hasValidIndex = blockIndex !== undefined && Number.isInteger(blockIndex) && blockIndex >= 0

  const handleCustomHeightChange = useCallback(
    (nextHeightPx: number | null) => {
      if (!hasValidIndex || blockIndex === undefined) return
      onMermaidHeightChange?.(blockIndex, nextHeightPx)
    },
    [blockIndex, hasValidIndex, onMermaidHeightChange]
  )

  return {
    persistedHeightPx,
    onCustomHeightChange: hasValidIndex && onMermaidHeightChange ? handleCustomHeightChange : undefined
  }
}
