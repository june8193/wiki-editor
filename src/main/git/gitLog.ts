import type { GitGraphCommit, GitRefBadge, GitRefKind } from '@shared/git'

const REMOTE_HEAD_PATTERN = /^refs\/remotes\/[^/]+\/HEAD$/

function getRefPriority(badge: GitRefBadge): number {
  if (badge.kind === 'head') return 0
  if (badge.kind === 'local-branch') return badge.isCurrentHead ? 1 : 2
  if (badge.kind === 'remote-branch') return 3
  return 4
}

/**
 * Parses `git for-each-ref` lines into a commit-hash lookup table of GitRefBadge items,
 * excluding remote symbolic HEAD aliases (such as `refs/remotes/origin/HEAD`).
 */
export function parseForEachRefOutput(
  raw: string,
  headRefName: string | null
): Map<string, GitRefBadge[]> {
  const refsByHash = new Map<string, GitRefBadge[]>()

  for (const line of raw.split(/\r?\n/)) {
    if (!line) continue
    const [objectName = '', peeledObjectName = '', refname = '', shortName = '', symref = ''] =
      line.split('\t')
    if (!objectName || !refname || !shortName) continue
    if (symref || REMOTE_HEAD_PATTERN.test(refname)) continue

    let kind: GitRefKind
    let isCurrentHead = false
    if (refname.startsWith('refs/heads/')) {
      kind = 'local-branch'
      isCurrentHead = headRefName !== null && refname === headRefName
    } else if (refname.startsWith('refs/remotes/')) {
      kind = 'remote-branch'
    } else if (refname.startsWith('refs/tags/')) {
      kind = 'tag'
    } else {
      continue
    }

    const targetHash = peeledObjectName || objectName
    const badge: GitRefBadge = isCurrentHead
      ? { name: shortName, kind, isCurrentHead: true }
      : { name: shortName, kind }

    const existing = refsByHash.get(targetHash)
    if (existing) {
      existing.push(badge)
    } else {
      refsByHash.set(targetHash, [badge])
    }
  }

  return refsByHash
}

function buildCommitRefs(
  hash: string,
  refsByHash: ReadonlyMap<string, readonly GitRefBadge[]>,
  headHash: string | null
): GitRefBadge[] {
  const result: GitRefBadge[] = []
  if (headHash !== null && hash === headHash) {
    result.push({ name: 'HEAD', kind: 'head', isCurrentHead: true })
  }

  const refBadges = refsByHash.get(hash)
  if (!refBadges || refBadges.length === 0) {
    return result
  }

  const sorted = [...refBadges].sort((a, b) => {
    const priorityDiff = getRefPriority(a) - getRefPriority(b)
    return priorityDiff !== 0 ? priorityDiff : a.name.localeCompare(b.name)
  })
  return [...result, ...sorted]
}

/**
 * Builds shared commit identity fields (`hash`, `shortHash`, `parents`) from Git format tokens.
 */
export function parseCommitIdentityFields(
  hash: string,
  shortHash: string,
  parentsRaw: string
): Pick<GitGraphCommit, 'hash' | 'shortHash' | 'parents'> {
  return {
    hash,
    shortHash: shortHash || hash.slice(0, 7),
    parents: parentsRaw ? parentsRaw.split(' ').filter(Boolean) : []
  }
}

/**
 * Parses NUL-delimited `git log` records formatted with `\x1f` unit separators into GitGraphCommit entries.
 */
export function parseGitLogOutput(
  raw: string,
  refsByHash: ReadonlyMap<string, readonly GitRefBadge[]>,
  headHash: string | null
): GitGraphCommit[] {
  const commits: GitGraphCommit[] = []
  for (const record of raw.split('\0')) {
    const normalized = record.replace(/^\r?\n+/, '')
    if (!normalized) continue
    const [
      hash = '',
      shortHash = '',
      parentsRaw = '',
      subject = '',
      authorName = '',
      committedAt = ''
    ] = normalized.split('\x1f')
    if (!hash) continue

    commits.push({
      ...parseCommitIdentityFields(hash, shortHash, parentsRaw),
      subject,
      authorName,
      committedAt,
      refs: buildCommitRefs(hash, refsByHash, headHash)
    })
  }
  return commits
}
