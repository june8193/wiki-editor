import type { GitChangedFile, GitFileStatusCode } from '@shared/git'

const GIT_HASH_PATTERN = /^[0-9a-f]{7,64}$/i

/**
 * Validates that a Git object reference is strictly a 7–64 character hexadecimal hash,
 * preventing Git CLI option injection and symbolic ref ambiguity.
 */
export function assertValidGitHash(hash: unknown, label = '커밋'): string {
  if (typeof hash !== 'string' || !GIT_HASH_PATTERN.test(hash)) {
    throw new Error(`유효한 ${label} 해시 형식이 아닙니다.`)
  }
  return hash
}

function mapNameStatusCode(code: string): GitFileStatusCode {
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
        status: mapNameStatusCode(code)
      })
    }
    i += 1
  }
  return files
}
