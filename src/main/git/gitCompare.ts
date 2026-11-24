import { basename } from 'node:path'
import type {
  GitChangedFile,
  GitCompareChangedFile,
  GitCompareMode,
  GitCompareRef,
  GitCompareRefList
} from '@shared/git'
import { isSameWorkspacePath } from '@shared/workspace'

const REMOTE_HEAD_PATTERN = /^refs\/remotes\/[^/]+\/HEAD$/
const UNBORN_HASH_PATTERN = /^0+$/
const CONTROL_OR_WHITESPACE_PATTERN = /[\s\x00-\x1f\x7f]/

/**
 * Validates a single Git revision/ref string against option injection (`-`),
 * range operators (`..`), whitespace, and control/NUL characters.
 */
export function assertValidGitCompareRef(ref: unknown, label = 'Ref'): string {
  if (
    typeof ref !== 'string' ||
    ref.length === 0 ||
    ref.startsWith('-') ||
    CONTROL_OR_WHITESPACE_PATTERN.test(ref) ||
    ref.includes('..')
  ) {
    throw new Error(`유효한 ${label} 형식이 아닙니다.`)
  }
  return ref
}

/**
 * Validates a GitCompareMode value.
 */
export function assertValidGitCompareMode(mode: unknown): GitCompareMode {
  if (mode !== 'three-dot' && mode !== 'two-dot') {
    throw new Error('유효한 비교 모드(three-dot 또는 two-dot)가 아닙니다.')
  }
  return mode
}

/**
 * Parses `git worktree list --porcelain` output into `GitCompareRef` entries.
 * Bare or unborn worktrees without a committed HEAD are omitted.
 */
export function parseWorktreeListPorcelain(raw: string, currentRepoRoot: string): GitCompareRef[] {
  const worktrees: GitCompareRef[] = []
  const stanzas = raw.trim().split(/\r?\n\r?\n/)

  for (const stanza of stanzas) {
    if (!stanza.trim()) continue

    let worktreePath = ''
    let headHash = ''
    let branchName: string | null = null
    let isDetached = false
    let isBare = false

    for (const line of stanza.split(/\r?\n/)) {
      if (line.startsWith('worktree ')) {
        worktreePath = line.slice('worktree '.length)
      } else if (line.startsWith('HEAD ')) {
        headHash = line.slice('HEAD '.length).trim()
      } else if (line.startsWith('branch ')) {
        const fullRef = line.slice('branch '.length).trim()
        branchName = fullRef.startsWith('refs/heads/')
          ? fullRef.slice('refs/heads/'.length)
          : fullRef
      } else if (line === 'detached') {
        isDetached = true
      } else if (line === 'bare') {
        isBare = true
      }
    }

    if (!worktreePath || isBare || !headHash || UNBORN_HASH_PATTERN.test(headHash)) {
      continue
    }

    const worktreeName = basename(worktreePath) || worktreePath
    const shortHash = headHash.slice(0, 7)
    const isCurrent = isSameWorkspacePath(currentRepoRoot, worktreePath)
    const resolvedBranch = isDetached || !branchName ? null : branchName

    worktrees.push({
      id: `worktree:${worktreePath}`,
      kind: 'worktree',
      ref: resolvedBranch ?? shortHash,
      displayName: resolvedBranch
        ? `${worktreeName} (${resolvedBranch})`
        : `${worktreeName} (detached @ ${shortHash})`,
      worktreeName,
      branchName: resolvedBranch,
      shortHash,
      isDetached: resolvedBranch === null,
      isCurrent
    })
  }

  return worktrees
}

/**
 * Builds a `git diff` revision range expression (`three-dot` when a merge-base exists, `two-dot` otherwise).
 */
export function buildCompareDiffRange(
  baseRef: string,
  compareRef: string,
  mode: GitCompareMode,
  hasMergeBase: boolean
): string {
  return mode === 'three-dot' && hasMergeBase
    ? `${baseRef}...${compareRef}`
    : `${baseRef}..${compareRef}`
}

/**
 * Parses `git for-each-ref` output for `refs/heads` and `refs/remotes` into local/remote compare refs
 * and extracts the symbolic target of `refs/remotes/origin/HEAD` if present.
 */
export function parseCompareForEachRefOutput(
  raw: string,
  headRefName: string | null
): {
  localBranches: GitCompareRef[]
  remoteBranches: GitCompareRef[]
  originHeadTarget: string | null
} {
  const localBranches: GitCompareRef[] = []
  const remoteBranches: GitCompareRef[] = []
  let originHeadTarget: string | null = null

  for (const line of raw.split(/\r?\n/)) {
    if (!line) continue
    const [objectName = '', refname = '', shortName = '', symref = ''] = line.split('\t')
    if (!objectName || !refname || !shortName) continue

    if (refname === 'refs/remotes/origin/HEAD' && symref.startsWith('refs/remotes/')) {
      originHeadTarget = symref.slice('refs/remotes/'.length)
      continue
    }
    if (symref || REMOTE_HEAD_PATTERN.test(refname)) continue

    const shortHash = objectName.slice(0, 7)
    if (refname.startsWith('refs/heads/')) {
      const isCurrent = headRefName !== null && refname === headRefName
      localBranches.push({
        id: `local-branch:${shortName}`,
        kind: 'local-branch',
        ref: shortName,
        displayName: shortName,
        branchName: shortName,
        shortHash,
        isCurrent
      })
    } else if (refname.startsWith('refs/remotes/')) {
      remoteBranches.push({
        id: `remote-branch:${shortName}`,
        kind: 'remote-branch',
        ref: shortName,
        displayName: shortName,
        branchName: shortName,
        shortHash
      })
    }
  }

  return { localBranches, remoteBranches, originHeadTarget }
}

/**
 * Resolves the default base ref: `origin/HEAD` target -> `main` -> `master` -> first local/remote branch.
 */
export function resolveDefaultBaseRef(
  originHeadTarget: string | null,
  localBranches: readonly GitCompareRef[],
  remoteBranches: readonly GitCompareRef[]
): string | null {
  if (originHeadTarget && remoteBranches.some((r) => r.ref === originHeadTarget)) {
    return originHeadTarget
  }
  if (localBranches.some((b) => b.ref === 'main')) {
    return 'main'
  }
  if (localBranches.some((b) => b.ref === 'master')) {
    return 'master'
  }
  return localBranches[0]?.ref ?? remoteBranches[0]?.ref ?? null
}

export function buildEmptyCompareRefList(): GitCompareRefList {
  return {
    defaultBaseRef: null,
    currentRef: null,
    worktrees: [],
    localBranches: [],
    remoteBranches: []
  }
}

export interface NumstatEntry {
  additions: number | null
  deletions: number | null
  isBinary: boolean
}

/**
 * Parses `git diff --numstat -z` output into a map keyed by destination file path.
 * Note: For renames (`-M`), `-z` emits `added\tdeleted\0origPath\0newPath\0` when `-z` is used with `--numstat`:
 * specifically `added\tdeleted\t\0origPath\0newPath\0` (an empty field before the two NUL-separated paths).
 */
export function parseGitNumstatZ(raw: string): Map<string, NumstatEntry> {
  const stats = new Map<string, NumstatEntry>()
  if (!raw) return stats

  const tokens = raw.split('\0')
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (!token) continue

    const parts = token.split('\t')
    if (parts.length < 3) continue

    const [addedRaw, deletedRaw, pathPart] = parts
    const isBinary = addedRaw === '-' || deletedRaw === '-'
    const additions = isBinary ? null : Number.parseInt(addedRaw, 10)
    const deletions = isBinary ? null : Number.parseInt(deletedRaw, 10)
    const entry: NumstatEntry = {
      additions: additions !== null && Number.isFinite(additions) ? additions : null,
      deletions: deletions !== null && Number.isFinite(deletions) ? deletions : null,
      isBinary
    }

    if (pathPart === '') {
      // Rename/copy record in `--numstat -z`: `added\tdeleted\t\0origPath\0newPath\0`
      const newPath = tokens[i + 2]
      if (newPath) {
        stats.set(newPath, entry)
      }
      i += 2
    } else {
      stats.set(pathPart, entry)
    }
  }

  return stats
}

/**
 * Merges `--name-status -z -M` file entries with `--numstat -z` line counts and computes totals.
 */
export function mergeCompareFilesWithNumstat(
  files: readonly GitChangedFile[],
  numstatMap: ReadonlyMap<string, NumstatEntry>
): {
  files: GitCompareChangedFile[]
  totalAdditions: number
  totalDeletions: number
} {
  let totalAdditions = 0
  let totalDeletions = 0

  const merged: GitCompareChangedFile[] = files.map((file) => {
    const stat = numstatMap.get(file.path)
    const additions = stat?.additions ?? (stat?.isBinary ? null : 0)
    const deletions = stat?.deletions ?? (stat?.isBinary ? null : 0)
    const isBinary = stat?.isBinary ?? false

    if (!isBinary) {
      totalAdditions += additions ?? 0
      totalDeletions += deletions ?? 0
    }

    return {
      ...file,
      additions,
      deletions,
      isBinary
    }
  })

  return { files: merged, totalAdditions, totalDeletions }
}
