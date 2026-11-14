import {
  createEmptyGitStatus,
  type GitChangedFile,
  type GitStagedStatus,
  type GitStatus,
  type GitUnstagedStatus
} from '@shared/git'

const STAGED_CODES: ReadonlySet<string> = new Set(['M', 'A', 'D', 'R', 'C', 'U'])
const UNSTAGED_CODES: ReadonlySet<string> = new Set(['M', 'D', 'U'])

function splitPorcelainFields(record: string, fieldsBeforePath: number): {
  fields: string[]
  rest: string
} {
  const fields: string[] = []
  let start = 0
  for (let i = 0; i < fieldsBeforePath; i += 1) {
    const spaceIdx = record.indexOf(' ', start)
    if (spaceIdx === -1) {
      fields.push(record.slice(start))
      return { fields, rest: '' }
    }
    fields.push(record.slice(start, spaceIdx))
    start = spaceIdx + 1
  }
  return { fields, rest: record.slice(start) }
}

function parseBranchHeader(status: GitStatus, token: string): void {
  if (token === '# branch.oid (initial)') {
    status.isUnborn = true
  } else if (token.startsWith('# branch.head ')) {
    const head = token.slice('# branch.head '.length)
    status.isDetached = head === '(detached)'
    status.branch = status.isDetached ? null : head
  } else if (token.startsWith('# branch.upstream ')) {
    status.hasUpstream = true
  } else if (token.startsWith('# branch.ab ')) {
    const match = /^# branch\.ab \+(\d+) -(\d+)$/.exec(token)
    if (match) {
      status.ahead = Number(match[1])
      status.behind = Number(match[2])
    }
  }
}

/**
 * Parses `git status --porcelain=v2 --branch -z` output into structured GitStatus.
 */
export function parsePorcelainV2Z(raw: string, repoRoot: string): GitStatus {
  const status = createEmptyGitStatus(true, repoRoot)
  const tokens = raw.split('\0')

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (!token) continue

    if (token.startsWith('# ')) {
      parseBranchHeader(status, token)
      continue
    }

    if (token.startsWith('1 ') || token.startsWith('2 ')) {
      const isRenameOrCopy = token.startsWith('2 ')
      const { fields, rest } = splitPorcelainFields(token, isRenameOrCopy ? 9 : 8)
      const xy = fields[1] ?? '..'
      const origPath = isRenameOrCopy ? tokens[i + 1] : undefined
      if (origPath !== undefined) {
        i += 1
      }

      const x = xy[0] ?? '.'
      const y = xy[1] ?? '.'
      if (STAGED_CODES.has(x)) {
        const entry: GitChangedFile = { path: rest, status: x as GitStagedStatus }
        if (origPath) {
          entry.origPath = origPath
        }
        status.staged.push(entry)
      }
      if (UNSTAGED_CODES.has(y)) {
        status.unstaged.push({ path: rest, status: y as GitUnstagedStatus })
      }
      continue
    }

    if (token.startsWith('u ')) {
      const { rest } = splitPorcelainFields(token, 10)
      status.hasConflicts = true
      status.unstaged.push({ path: rest, status: 'U' })
      continue
    }

    if (token.startsWith('? ')) {
      status.untracked.push({ path: token.slice(2), status: '?' })
    }
  }

  return status
}
