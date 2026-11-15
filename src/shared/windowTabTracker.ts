import type { BufferKeyRemap, SyncWindowTabsOptions } from './documentBuffer'

/** Counts open tab occurrences per buffer key, ignoring empty keys. */
export function countBufferKeys(keys: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const key of keys) {
    if (!key) continue
    counts[key] = (counts[key] ?? 0) + 1
  }
  return counts
}

function areTabCountMapsEqual(
  left: Readonly<Record<string, number>>,
  right: Readonly<Record<string, number>>
): boolean {
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  if (leftKeys.length !== rightKeys.length) return false
  for (const key of leftKeys) {
    if (left[key] !== right[key]) return false
  }
  return true
}

/**
 * Tracks per-window tab reference counts and pending async open claims across renderer windows
 * so shared buffers stay alive until every window reference and pending open finishes.
 */
export class WindowTabTracker {
  private readonly windowTabs = new Map<number, Record<string, number>>()
  private readonly pendingOpenWindows = new Map<string, Set<number>>()
  private tabCounts: Record<string, number> = {}

  private computeTabCounts(): Record<string, number> {
    const nextCounts: Record<string, number> = {}
    for (const perWindow of this.windowTabs.values()) {
      for (const [key, count] of Object.entries(perWindow)) {
        if (count > 0) {
          nextCounts[key] = (nextCounts[key] ?? 0) + count
        }
      }
    }
    return nextCounts
  }

  getTabCountsSnapshot(): Record<string, number> {
    return { ...this.tabCounts }
  }

  getWindowTabCountsSnapshot(): Record<number, Record<string, number>> {
    const result: Record<number, Record<string, number>> = {}
    for (const [windowId, counts] of this.windowTabs.entries()) {
      result[windowId] = { ...counts }
    }
    return result
  }

  registerPendingOpenOwner(key: string, windowId?: number): void {
    if (windowId === undefined || (this.windowTabs.get(windowId)?.[key] ?? 0) > 0) return
    let owners = this.pendingOpenWindows.get(key)
    if (!owners) {
      owners = new Set<number>()
      this.pendingOpenWindows.set(key, owners)
    }
    owners.add(windowId)
  }

  removePendingOpenOwner(key: string, windowId: number): boolean {
    const owners = this.pendingOpenWindows.get(key)
    if (!owners || !owners.delete(windowId)) return false
    if (owners.size === 0) {
      this.pendingOpenWindows.delete(key)
      return true
    }
    return false
  }

  private releasePendingOwnersForWindow(windowId: number): string[] {
    const depletedPendingKeys: string[] = []
    for (const key of [...this.pendingOpenWindows.keys()]) {
      if (this.removePendingOpenOwner(key, windowId)) {
        depletedPendingKeys.push(key)
      }
    }
    return depletedPendingKeys
  }

  clearPendingForKeys(keys: Iterable<string>): void {
    for (const key of keys) {
      this.pendingOpenWindows.delete(key)
    }
  }

  hasActiveOrPendingOwner(key: string): boolean {
    return (this.tabCounts[key] ?? 0) > 0 || (this.pendingOpenWindows.get(key)?.size ?? 0) > 0
  }

  syncWindowTabs(
    windowId: number,
    bufferKeys: readonly string[],
    options?: SyncWindowTabsOptions
  ): {
    prevCounts: Record<string, number>
    depletedPendingKeys: string[]
    countsChanged: boolean
  } {
    const perWindow = countBufferKeys(bufferKeys)
    for (const key of Object.keys(perWindow)) {
      this.removePendingOpenOwner(key, windowId)
    }

    const depletedPendingKeys = options?.releasePending
      ? this.releasePendingOwnersForWindow(windowId)
      : []

    const prevCounts = this.tabCounts
    this.windowTabs.set(windowId, perWindow)
    this.tabCounts = this.computeTabCounts()
    return {
      prevCounts,
      depletedPendingKeys,
      countsChanged: !areTabCountMapsEqual(prevCounts, this.tabCounts)
    }
  }

  unregisterWindow(windowId: number): {
    prevCounts: Record<string, number>
    depletedPendingKeys: string[]
    countsChanged: boolean
  } {
    this.windowTabs.delete(windowId)
    const prevCounts = this.tabCounts
    const depletedPendingKeys = this.releasePendingOwnersForWindow(windowId)

    this.tabCounts = this.computeTabCounts()
    return {
      prevCounts,
      depletedPendingKeys,
      countsChanged: !areTabCountMapsEqual(prevCounts, this.tabCounts)
    }
  }

  collectOrphanKeys(
    prevCounts: Readonly<Record<string, number>>,
    extraCandidateKeys: Iterable<string> = []
  ): string[] {
    const orphanKeys = new Set<string>()
    for (const candidateKey of extraCandidateKeys) {
      if (!this.hasActiveOrPendingOwner(candidateKey)) {
        orphanKeys.add(candidateKey)
      }
    }
    for (const [key, prevCount] of Object.entries(prevCounts)) {
      if (prevCount > 0 && !this.hasActiveOrPendingOwner(key)) {
        orphanKeys.add(key)
      }
    }
    return [...orphanKeys]
  }

  pruneKeys(removedKeys: ReadonlySet<string>): void {
    if (removedKeys.size === 0) return
    for (const perWindow of this.windowTabs.values()) {
      for (const key of removedKeys) {
        delete perWindow[key]
      }
    }
    this.tabCounts = this.computeTabCounts()
  }

  remapKeys(remappings: readonly BufferKeyRemap[]): void {
    const remapLookup = new Map<string, string>()
    for (const { oldKey, newKey } of remappings) {
      if (oldKey !== newKey) {
        remapLookup.set(oldKey, newKey)
      }
    }
    if (remapLookup.size === 0) return

    for (const perWindow of this.windowTabs.values()) {
      for (const [oldKey, newKey] of remapLookup.entries()) {
        const count = perWindow[oldKey]
        if (count !== undefined) {
          delete perWindow[oldKey]
          perWindow[newKey] = (perWindow[newKey] ?? 0) + count
        }
      }
    }
    this.tabCounts = this.computeTabCounts()

    for (const [oldKey, newKey] of remapLookup.entries()) {
      const pending = this.pendingOpenWindows.get(oldKey)
      if (!pending) continue
      this.pendingOpenWindows.delete(oldKey)
      const target = this.pendingOpenWindows.get(newKey) ?? new Set<number>()
      for (const ownerId of pending) {
        target.add(ownerId)
      }
      this.pendingOpenWindows.set(newKey, target)
    }
  }

  clear(): void {
    this.windowTabs.clear()
    this.pendingOpenWindows.clear()
    this.tabCounts = {}
  }
}
