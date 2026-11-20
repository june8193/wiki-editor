import {
  collectGitStagedPaths,
  collectGitStatusPaths,
  collectGitUnstagedPaths,
  type GitChangedFile,
  type GitStashEntry,
  type GitStatus
} from '@shared/git'

const STASH_REF_PATTERN = /^stash@\{\d+\}$/
const STASH_LIST_HEADER_TOKENS = ['%gd', '%H', '%gs', '%cI'] as const
const STASH_REFLOG_PREFIX_RE = /^(On|WIP on) ([^:]+): ([\s\S]*)$/

/**
 * Git `--format` flag for `git stash list`, co-located with {@link parseStashListOutput}
 * so field order and delimiters stay coupled in one place.
 */
export const GIT_STASH_LIST_FORMAT = `--format=${STASH_LIST_HEADER_TOKENS.join('%x1f')}%x1e`

/**
 * Builds the `git stash push` argument list with optional `--include-untracked`,
 * `--keep-index`, `--message=...`, and `-- <pathspecs>`.
 */
export function buildStashPushArgs(options: {
  includeUntracked: boolean
  keepIndex?: boolean
  message: string
  pathspecs?: readonly string[]
}): string[] {
  const args = ['stash', 'push']
  if (options.keepIndex) {
    args.push('--keep-index')
  }
  if (options.includeUntracked) {
    args.push('--include-untracked')
  }
  if (options.message) {
    args.push(`--message=${options.message}`)
  }
  if (options.pathspecs && options.pathspecs.length > 0) {
    args.push('--', ...options.pathspecs)
  }
  return args
}

/**
 * Collects unique repo-relative paths for `Changes` (`unstaged` + optional `untracked`)
 * and determines whether any target overlaps `Staged Changes`.
 */
export function resolveUnstagedStashTargets(
  status: GitStatus,
  includeUntracked: boolean
): { targetPaths: string[]; overlapsStaged: boolean } {
  const targetPaths = collectGitUnstagedPaths(status, includeUntracked)
  const stagedPaths = new Set(collectGitStagedPaths(status))
  const overlapsStaged = targetPaths.some((path) => stagedPaths.has(path))
  return { targetPaths, overlapsStaged }
}

/**
 * Returns true when `status` contains at least one change eligible for `scope: 'all'`.
 */
export function hasAllScopeStashTargets(status: GitStatus, includeUntracked: boolean): boolean {
  return collectGitStatusPaths(status, includeUntracked).length > 0
}

/**
 * Returns true when at least one validated path matches a stashable entry in `status`.
 */
export function hasMatchingPathStashTargets(
  status: GitStatus,
  validatedPaths: readonly string[],
  includeUntracked: boolean
): boolean {
  const stashable = collectGitStatusPaths(status, includeUntracked)
  return validatedPaths.some((target) =>
    stashable.some((candidate) => candidate === target || candidate.startsWith(`${target}/`))
  )
}

/**
 * Validates that a stash reference strictly matches `stash@{<index>}`,
 * blocking revision expressions and CLI option injection.
 */
export function assertValidStashRef(stashRef: unknown): string {
  if (typeof stashRef !== 'string' || !STASH_REF_PATTERN.test(stashRef)) {
    throw new Error('유효한 Stash 참조 형식이 아닙니다.')
  }
  return stashRef
}

/**
 * Parses NUL-delimited `git ls-tree -r -z --name-only <hash>^3` output into untracked (`?`) entries.
 */
export function parseStashUntrackedTreeOutput(raw: string): GitChangedFile[] {
  if (!raw) {
    return []
  }
  const files: GitChangedFile[] = []
  for (const filePath of raw.split('\0')) {
    if (filePath) {
      files.push({ path: filePath, status: '?' })
    }
  }
  return files
}

function parseStashSubject(rawSubject: string): { branch: string | null; message: string } {
  const trimmed = rawSubject.trim()
  const match = STASH_REFLOG_PREFIX_RE.exec(trimmed)
  if (!match) {
    return { branch: null, message: trimmed }
  }
  const kind = match[1]
  const rawBranch = match[2].trim()
  const rest = match[3].trim()
  const branch = rawBranch && rawBranch !== '(no branch)' ? rawBranch : null
  if (kind === 'On') {
    return { branch, message: rest || trimmed }
  }
  return { branch, message: trimmed }
}

/**
 * Parses `\x1e`/`\x1f`-delimited `git stash list` output into structured GitStashEntry records.
 */
export function parseStashListOutput(raw: string): GitStashEntry[] {
  if (!raw.trim()) {
    return []
  }

  const entries: GitStashEntry[] = []
  for (const record of raw.split('\x1e')) {
    const normalized = record.replace(/^(?:\r?\n)+/, '')
    if (!normalized) continue
    const [ref = '', hash = '', rawSubject = '', createdAt = ''] = normalized.split('\x1f')
    if (!ref || !hash) continue
    const { branch, message } = parseStashSubject(rawSubject)
    entries.push({
      ref,
      hash,
      branch,
      message,
      createdAt: createdAt.trim()
    })
  }
  return entries
}
