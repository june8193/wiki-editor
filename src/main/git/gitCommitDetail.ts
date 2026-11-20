import type { GitChangedFile, GitCommitDetail, GitFileStatusCode } from '@shared/git'
import { parseCommitIdentityFields } from './gitLog'

const COMMIT_DETAIL_HEADER_TOKENS = ['%H', '%h', '%P', '%s', '%an', '%ae', '%cI'] as const

/**
 * Git `--format` flag for `git show --name-status -z`, co-located with {@link parseCommitDetailOutput}
 * so field order and delimiters stay coupled in one place.
 */
export const GIT_COMMIT_DETAIL_FORMAT = `--format=${COMMIT_DETAIL_HEADER_TOKENS.join('%x1f')}%x1f%b%x1e`

const COMMIT_HASH_PATTERN = /^[0-9a-f]{7,64}$/i

/**
 * Validates that a Git object reference is strictly a 7–64 character hexadecimal hash,
 * preventing Git CLI option injection and symbolic ref ambiguity.
 */
export function assertValidGitHash(hash: unknown, label = '커밋'): string {
  if (typeof hash !== 'string' || !COMMIT_HASH_PATTERN.test(hash)) {
    throw new Error(`유효한 ${label} 해시 형식이 아닙니다.`)
  }
  return hash
}

/**
 * Validates that a commit reference is strictly a 7–64 character hexadecimal hash,
 * preventing Git CLI option injection and symbolic ref ambiguity.
 */
export function assertValidCommitHash(commitHash: unknown): string {
  return assertValidGitHash(commitHash, '커밋')
}

function mapCommitStatusCode(code: string): GitFileStatusCode {
  if (code === 'A' || code === 'M' || code === 'D' || code === 'U') {
    return code
  }
  return 'M'
}

/**
 * Parses NUL-delimited `git diff --name-status -z` or `git show --name-status -z` file records.
 */
export function parseGitNameStatusZ(filesSection: string): GitChangedFile[] {
  const trimmed = filesSection.replace(/^(?:\0|\r?\n)+/, '')
  if (!trimmed) {
    return []
  }

  const tokens = trimmed.split('\0')
  const files: GitChangedFile[] = []
  for (let i = 0; i < tokens.length; i += 1) {
    const statusToken = tokens[i]
    if (!statusToken) continue

    const code = statusToken[0]
    if (code === 'R' || code === 'C') {
      const origPath = tokens[i + 1]
      const nextPath = tokens[i + 2]
      if (origPath && nextPath) {
        files.push({
          path: nextPath,
          origPath,
          status: code
        })
      }
      i += 2
      continue
    }

    const filePath = tokens[i + 1]
    if (filePath) {
      files.push({
        path: filePath,
        status: mapCommitStatusCode(code)
      })
    }
    i += 1
  }
  return files
}

/**
 * Parses NUL-delimited `git show --name-status -z` output with `\x1f`/`\x1e` header delimiters
 * into a structured GitCommitDetail.
 */
export function parseCommitDetailOutput(raw: string): GitCommitDetail {
  const recordSepIdx = raw.indexOf('\x1e')
  if (recordSepIdx === -1) {
    throw new Error('커밋 상세 정보를 파싱하지 못했습니다.')
  }

  const header = raw.slice(0, recordSepIdx)
  const filesSection = raw.slice(recordSepIdx + 1)

  const fields: string[] = []
  let cursor = 0
  for (let i = 0; i < COMMIT_DETAIL_HEADER_TOKENS.length; i += 1) {
    const sepIdx = header.indexOf('\x1f', cursor)
    if (sepIdx === -1) {
      throw new Error('커밋 상세 정보를 파싱하지 못했습니다.')
    }
    fields.push(header.slice(cursor, sepIdx))
    cursor = sepIdx + 1
  }

  const [hash, shortHash, parentsRaw, subject, authorName, authorEmail, committedAt] = fields
  if (!hash) {
    throw new Error('커밋 상세 정보를 파싱하지 못했습니다.')
  }
  const body = header.slice(cursor).replace(/(?:\r?\n)+$/, '')

  return {
    ...parseCommitIdentityFields(hash, shortHash, parentsRaw),
    subject,
    body,
    authorName,
    authorEmail,
    committedAt,
    files: parseGitNameStatusZ(filesSection)
  }
}
