import type { GitRefBadge } from '@shared/git'

/**
 * Normalized commit-row ref badge model merging matching remote tracking refs into local branches
 * and suppressing redundant `HEAD` when a checked-out local branch exists on the same commit.
 */
export type GitGraphDisplayRef =
  | {
      kind: 'branch'
      name: string
      isCurrentHead: boolean
      syncedRemotes: string[]
    }
  | { kind: 'remote'; name: string }
  | { kind: 'head' }
  | { kind: 'tag'; name: string }

interface LocalBranchAccumulator {
  name: string
  isCurrentHead: boolean
  syncedRemotes: string[]
}

function splitRemoteTrackingRef(fullName: string): { remote: string; branch: string } | null {
  const slashIndex = fullName.indexOf('/')
  if (slashIndex <= 0 || slashIndex >= fullName.length - 1) {
    return null
  }
  return {
    remote: fullName.slice(0, slashIndex),
    branch: fullName.slice(slashIndex + 1)
  }
}

function pushUniqueString(list: string[], value: string): void {
  if (!list.includes(value)) {
    list.push(value)
  }
}

/**
 * Normalizes raw Git refs for a single commit into right-aligned VS Code Graph display badges.
 */
export function normalizeGitGraphRefs(refs: readonly GitRefBadge[]): GitGraphDisplayRef[] {
  if (refs.length === 0) {
    return []
  }

  let hasHeadRef = false
  const localBranches = new Map<string, LocalBranchAccumulator>()
  const remoteNames: string[] = []
  const tagNames: string[] = []

  for (const ref of refs) {
    if (ref.kind === 'head') {
      hasHeadRef = true
      continue
    }
    if (ref.kind === 'local-branch') {
      const existing = localBranches.get(ref.name)
      if (existing) {
        existing.isCurrentHead = existing.isCurrentHead || ref.isCurrentHead === true
      } else {
        localBranches.set(ref.name, {
          name: ref.name,
          isCurrentHead: ref.isCurrentHead === true,
          syncedRemotes: []
        })
      }
      continue
    }
    if (ref.kind === 'remote-branch') {
      pushUniqueString(remoteNames, ref.name)
      continue
    }
    pushUniqueString(tagNames, ref.name)
  }

  const standaloneRemotes: string[] = []
  for (const remoteFullName of remoteNames) {
    const parsed = splitRemoteTrackingRef(remoteFullName)
    const matchedBranch = parsed ? localBranches.get(parsed.branch) : undefined
    if (parsed && matchedBranch) {
      pushUniqueString(matchedBranch.syncedRemotes, parsed.remote)
    } else {
      standaloneRemotes.push(remoteFullName)
    }
  }

  const branchEntries = [...localBranches.values()]
  const hasCurrentLocalBranch = branchEntries.some((branch) => branch.isCurrentHead)
  const displayRefs: GitGraphDisplayRef[] = []

  if (hasHeadRef && !hasCurrentLocalBranch) {
    displayRefs.push({ kind: 'head' })
  }

  const sortedBranches = [
    ...branchEntries.filter((branch) => branch.isCurrentHead),
    ...branchEntries.filter((branch) => !branch.isCurrentHead)
  ]
  for (const branch of sortedBranches) {
    displayRefs.push({
      kind: 'branch',
      name: branch.name,
      isCurrentHead: branch.isCurrentHead,
      syncedRemotes: branch.syncedRemotes
    })
  }

  for (const remoteName of standaloneRemotes) {
    displayRefs.push({ kind: 'remote', name: remoteName })
  }

  for (const tagName of tagNames) {
    displayRefs.push({ kind: 'tag', name: tagName })
  }

  return displayRefs
}
