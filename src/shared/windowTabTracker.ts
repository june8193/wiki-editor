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

function addPendingOwner(
  pendingMap: Map<string, Set<number>>,
  key: string,
  windowId: number
): void {
  let owners = pendingMap.get(key)
  if (!owners) {
    owners = new Set<number>()
    pendingMap.set(key, owners)
  }
  owners.add(windowId)
}

function removePendingOwner(
  pendingMap: Map<string, Set<number>>,
  key: string,
  windowId: number
): boolean {
  const owners = pendingMap.get(key)
  if (!owners || !owners.delete(windowId)) return false
  if (owners.size === 0) {
    pendingMap.delete(key)
    return true
  }
  return false
}

function releasePendingOwnersForWindowInMap(
  pendingMap: Map<string, Set<number>>,
  windowId: number
): string[] {
  const depletedKeys: string[] = []
  for (const key of [...pendingMap.keys()]) {
    if (removePendingOwner(pendingMap, key, windowId)) {
      depletedKeys.push(key)
    }
  }
  return depletedKeys
}

function remapPendingOwnersInMap(
  pendingMap: Map<string, Set<number>>,
  remapLookup: ReadonlyMap<string, string>
): void {
  for (const [oldKey, newKey] of remapLookup.entries()) {
    const pending = pendingMap.get(oldKey)
    if (!pending) continue
    pendingMap.delete(oldKey)
    const target = pendingMap.get(newKey) ?? new Set<number>()
    for (const ownerId of pending) {
      target.add(ownerId)
    }
    pendingMap.set(newKey, target)
  }
}

export interface TabCountChange {
  prevCounts: Record<string, number>
  depletedPendingKeys: string[]
  countsChanged: boolean
}

/**
 * Tracks per-window tab reference counts and pending async open/transfer claims across renderer windows
 * so shared buffers stay alive until every window reference, pending open, and detached transfer completes.
 */
export class WindowTabTracker {
  private readonly windowTabs = new Map<number, Record<string, number>>()
  private readonly pendingOpenWindows = new Map<string, Set<number>>()
  private readonly pendingTransferWindows = new Map<string, Set<number>>()
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

  getWindowTotalTabCount(windowId: number): number {
    const perWindow = this.windowTabs.get(windowId)
    if (!perWindow) return 0
    let total = 0
    for (const count of Object.values(perWindow)) {
      total += count
    }
    return total
  }

  registerPendingOpenOwner(key: string, windowId?: number): void {
    if (windowId === undefined || (this.windowTabs.get(windowId)?.[key] ?? 0) > 0) return
    addPendingOwner(this.pendingOpenWindows, key, windowId)
  }

  /**
   * Reserves ownership of a buffer for an auxiliary window spawned by tab detach.
   * Unlike pendingOpenWindows, transfer reservations survive initial StrictMode effect cleanup
   * until the destination window syncs the tab or closes.
   */
  registerPendingTransferOwner(key: string, windowId?: number): void {
    if (!key || windowId === undefined || (this.windowTabs.get(windowId)?.[key] ?? 0) > 0) return
    addPendingOwner(this.pendingTransferWindows, key, windowId)
  }

  removePendingOpenOwner(key: string, windowId: number): boolean {
    return removePendingOwner(this.pendingOpenWindows, key, windowId)
  }

  clearPendingForKeys(keys: Iterable<string>): void {
    for (const key of keys) {
      this.pendingOpenWindows.delete(key)
      this.pendingTransferWindows.delete(key)
    }
  }

  hasActiveOrPendingOwner(key: string): boolean {
    return (
      (this.tabCounts[key] ?? 0) > 0 ||
      (this.pendingOpenWindows.get(key)?.size ?? 0) > 0 ||
      (this.pendingTransferWindows.get(key)?.size ?? 0) > 0
    )
  }

  private finalizeTabCountChange(depletedPendingKeys: string[] = []): TabCountChange {
    const prevCounts = this.tabCounts
    this.tabCounts = this.computeTabCounts()
    return {
      prevCounts,
      depletedPendingKeys,
      countsChanged: !areTabCountMapsEqual(prevCounts, this.tabCounts)
    }
  }

  syncWindowTabs(
    windowId: number,
    bufferKeys: readonly string[],
    options?: SyncWindowTabsOptions
  ): TabCountChange {
    const perWindow = countBufferKeys(bufferKeys)
    for (const key of Object.keys(perWindow)) {
      removePendingOwner(this.pendingOpenWindows, key, windowId)
      removePendingOwner(this.pendingTransferWindows, key, windowId)
    }

    const depletedPendingKeys = options?.releasePending
      ? releasePendingOwnersForWindowInMap(this.pendingOpenWindows, windowId)
      : []

    this.windowTabs.set(windowId, perWindow)
    return this.finalizeTabCountChange(depletedPendingKeys)
  }

  unregisterWindow(windowId: number): TabCountChange {
    this.windowTabs.delete(windowId)
    const depletedPendingKeys = Array.from(
      new Set([
        ...releasePendingOwnersForWindowInMap(this.pendingOpenWindows, windowId),
        ...releasePendingOwnersForWindowInMap(this.pendingTransferWindows, windowId)
      ])
    )
    return this.finalizeTabCountChange(depletedPendingKeys)
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

    remapPendingOwnersInMap(this.pendingOpenWindows, remapLookup)
    remapPendingOwnersInMap(this.pendingTransferWindows, remapLookup)
  }

  clear(): void {
    this.windowTabs.clear()
    this.pendingOpenWindows.clear()
    this.pendingTransferWindows.clear()
    this.tabCounts = {}
  }
}
