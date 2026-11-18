import { createContext, createElement, type ReactElement, type ReactNode, useCallback, useContext, useMemo } from 'react'
import type { MermaidDiagramHeightMap } from '../stores/PaneTabStore'
import { normalizeMermaidHeightPx } from './mermaidContainFit'

export type MermaidHeightChangeHandler = (blockIndex: number, heightPx: number | null) => void

export interface MermaidHeightSessionContextValue {
  mermaidHeights?: MermaidDiagramHeightMap
  onMermaidHeightChange?: MermaidHeightChangeHandler
}

export interface MermaidHeightSessionProviderProps extends MermaidHeightSessionContextValue {
  children: ReactNode
}

const MermaidHeightSessionContext = createContext<MermaidHeightSessionContextValue>({})

/**
 * Provides tab-session Mermaid diagram height state and change notification to descendant blocks.
 */
export function MermaidHeightSessionProvider({
  mermaidHeights,
  onMermaidHeightChange,
  children
}: MermaidHeightSessionProviderProps): ReactElement {
  const value = useMemo(
    () => ({ mermaidHeights, onMermaidHeightChange }),
    [mermaidHeights, onMermaidHeightChange]
  )
  return createElement(MermaidHeightSessionContext.Provider, { value }, children)
}

function isValidMermaidBlockIndex(blockIndex: number | undefined): blockIndex is number {
  return blockIndex !== undefined && Number.isInteger(blockIndex) && blockIndex >= 0
}

/**
 * Updates or deletes a 0-based Mermaid block height entry in an immutable map,
 * returning `undefined` when the resulting map has no remaining entries.
 */
export function updateMermaidHeightMap(
  current: MermaidDiagramHeightMap | undefined,
  blockIndex: number,
  heightPx: number | null
): MermaidDiagramHeightMap | undefined {
  if (!isValidMermaidBlockIndex(blockIndex)) {
    return current
  }
  const key = String(blockIndex)
  const normalizedHeight = normalizeMermaidHeightPx(heightPx)

  if (normalizedHeight === null) {
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

  if (current?.[key] === normalizedHeight) {
    return current
  }
  return {
    ...(current ?? {}),
    [key]: normalizedHeight
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
  if (!isValidMermaidBlockIndex(blockIndex)) {
    return null
  }
  return normalizeMermaidHeightPx(mermaidHeights?.[String(blockIndex)])
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
  const hasValidIndex = isValidMermaidBlockIndex(blockIndex)

  const handleCustomHeightChange = useCallback(
    (nextHeightPx: number | null) => {
      if (!hasValidIndex) return
      onMermaidHeightChange?.(blockIndex, nextHeightPx)
    },
    [blockIndex, hasValidIndex, onMermaidHeightChange]
  )

  return {
    persistedHeightPx,
    onCustomHeightChange: hasValidIndex && onMermaidHeightChange ? handleCustomHeightChange : undefined
  }
}
