import type { GitDiffRequest, GitFileDiff } from '@shared/git'
import type { GitDiffContentState } from '../components/GitDiffViewer'

export const IMMUTABLE_DIFF_MAX_ENTRIES = 40
export const IMMUTABLE_DIFF_MAX_BYTES = 12 * 1024 * 1024

interface CachedImmutableDiffEntry {
  diff: GitFileDiff
  byteSize: number
  stashHash?: string
}

export interface ImmutableDiffSetOptions {
  openKeys?: ReadonlySet<string>
  stashHash?: string
}

export interface ReconcileDiffEntry {
  tabKey: string
  request: GitDiffRequest
}

export interface ReconcileDiffMapResult<TEntry extends ReconcileDiffEntry> {
  nextDiffs: Record<string, GitDiffContentState>
  changed: boolean
  toFetch: TEntry[]
}

/**
 * Returns true when a diff request targets an immutable Git object or comparison
 * (`branch-compare`, `commit`, or `stash`) whose patch can be safely cached in memory.
 */
export function isImmutableDiffKind(kind: GitDiffRequest['kind']): boolean {
  return kind === 'branch-compare' || kind === 'commit' || kind === 'stash'
}

/**
 * Bounded LRU cache for loaded immutable Git file diffs, enforcing both entry count
 * and total `rawPatch` byte budgets while protecting currently open Diff tabs from eviction.
 */
export class ImmutableDiffLruCache {
  private readonly entries = new Map<string, CachedImmutableDiffEntry>()
  private totalBytesCount = 0

  get(key: string): GitFileDiff | undefined {
    const existing = this.entries.get(key)
    if (!existing) {
      return undefined
    }
    this.entries.delete(key)
    this.entries.set(key, existing)
    return existing.diff
  }

  touch(key: string): void {
    const existing = this.entries.get(key)
    if (!existing) {
      return
    }
    this.entries.delete(key)
    this.entries.set(key, existing)
  }

  set(key: string, diff: GitFileDiff, options: ImmutableDiffSetOptions = {}): void {
    const previous = this.entries.get(key)
    if (previous) {
      this.entries.delete(key)
      this.totalBytesCount -= previous.byteSize
    }

    const byteSize = diff.rawPatch.length
    this.entries.set(key, {
      diff,
      byteSize,
      ...(options.stashHash ? { stashHash: options.stashHash } : {})
    })
    this.totalBytesCount += byteSize

    this.evictIfNeeded(key, options.openKeys)
  }

  storeIfImmutable(
    key: string,
    request: GitDiffRequest,
    diff: GitFileDiff,
    openKeys: ReadonlySet<string>
  ): void {
    if (!isImmutableDiffKind(request.kind)) {
      return
    }
    this.set(key, diff, {
      openKeys,
      stashHash: request.kind === 'stash' ? request.stashHash : undefined
    })
  }

  pruneStashes(activeStashHashes: ReadonlySet<string>): void {
    for (const [key, entry] of this.entries) {
      if (entry.stashHash !== undefined && !activeStashHashes.has(entry.stashHash)) {
        this.entries.delete(key)
        this.totalBytesCount -= entry.byteSize
      }
    }
  }

  clear(): void {
    this.entries.clear()
    this.totalBytesCount = 0
  }

  private evictIfNeeded(protectedKey: string, openKeys?: ReadonlySet<string>): void {
    while (
      this.entries.size > IMMUTABLE_DIFF_MAX_ENTRIES ||
      this.totalBytesCount > IMMUTABLE_DIFF_MAX_BYTES
    ) {
      let evicted = false
      for (const [key, entry] of this.entries) {
        if (key === protectedKey || openKeys?.has(key)) {
          continue
        }
        this.entries.delete(key)
        this.totalBytesCount -= entry.byteSize
        evicted = true
        break
      }
      if (!evicted) {
        break
      }
    }
  }
}

/**
 * Reconciles `prevDiffs` against the currently open diff entries in a single pass:
 * prunes closed entries, touches/hydrates immutable LRU cache hits, and marks
 * fetchable misses as `'loading'` without emitting intermediate snapshots.
 */
export function reconcileDiffMapWithCache<TEntry extends ReconcileDiffEntry>(params: {
  prevDiffs: Readonly<Record<string, GitDiffContentState>>
  entries: Iterable<TEntry>
  openKeys: ReadonlySet<string>
  cache: ImmutableDiffLruCache
  canStartFetch: (entry: TEntry) => boolean
}): ReconcileDiffMapResult<TEntry> {
  const { prevDiffs, entries, openKeys, cache, canStartFetch } = params
  const nextDiffs: Record<string, GitDiffContentState> = {}
  let changed = false

  for (const [key, value] of Object.entries(prevDiffs)) {
    if (openKeys.has(key)) {
      nextDiffs[key] = value
    } else {
      changed = true
    }
  }

  const toFetch: TEntry[] = []
  for (const entry of entries) {
    const existing = nextDiffs[entry.tabKey]
    if (existing) {
      if (existing.status === 'loaded' && isImmutableDiffKind(entry.request.kind)) {
        cache.touch(entry.tabKey)
      }
      continue
    }

    if (isImmutableDiffKind(entry.request.kind)) {
      const cachedDiff = cache.get(entry.tabKey)
      if (cachedDiff) {
        nextDiffs[entry.tabKey] = { status: 'loaded', diff: cachedDiff }
        changed = true
        continue
      }
    }

    if (canStartFetch(entry)) {
      nextDiffs[entry.tabKey] = { status: 'loading' }
      changed = true
      toFetch.push(entry)
    }
  }

  return { nextDiffs, changed, toFetch }
}
