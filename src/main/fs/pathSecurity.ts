import { lstat, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'

export const WORKSPACE_OUTSIDE_ERROR_MESSAGE = '워크스페이스 루트 밖의 경로에는 접근할 수 없습니다.'
export const WORKSPACE_SYMLINK_ERROR_MESSAGE =
  '유효하지 않거나 워크스페이스 루트 밖을 가리키는 심볼릭 링크에는 접근할 수 없습니다.'

export interface ResolveRealPathOptions {
  outsideMessage?: string
  danglingSymlinkMessage?: string
  assertResolved?: (resolvedReal: string) => void
}

/**
 * Checks whether an unknown error carries the specified Node errno code.
 */
export function isErrnoCode(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException)?.code === code
}

/**
 * Returns true when an fs lookup fails because the path is absent or traverses a non-directory file.
 */
export function isMissingPathError(error: unknown): boolean {
  return isErrnoCode(error, 'ENOENT') || isErrnoCode(error, 'ENOTDIR')
}

/**
 * Returns true if targetPath is equal to or nested inside rootPath lexically.
 */
export function isPathInsideRoot(rootPath: string, targetPath: string): boolean {
  const rel = relative(rootPath, targetPath)
  return (
    rel === '' ||
    (rel !== '..' &&
      !rel.startsWith(`..${sep}`) &&
      !rel.startsWith('../') &&
      !isAbsolute(rel))
  )
}

/**
 * Returns true if any segment of relativePath matches an entry in blockedNames.
 */
export function hasBlockedPathSegment(
  relativePath: string,
  blockedNames: ReadonlySet<string>
): boolean {
  if (!relativePath) return false
  return relativePath
    .split(/[\\/]/)
    .filter(Boolean)
    .some((segment) => blockedNames.has(segment))
}

/**
 * Resolves a target path by walking up to its nearest existing ancestor, blocking dangling symlinks.
 */
export async function resolveRealPathWithAncestor(
  candidate: string,
  options: ResolveRealPathOptions = {}
): Promise<{ resolvedReal: string; exists: boolean }> {
  const outsideMessage = options.outsideMessage ?? '루트 밖의 경로에는 접근할 수 없습니다.'
  const danglingSymlinkMessage =
    options.danglingSymlinkMessage ?? '유효하지 않은 심볼릭 링크 경로입니다.'
  const tailSegments: string[] = []
  let cursor = candidate

  while (true) {
    try {
      const realAncestor = await realpath(cursor)
      const resolvedReal =
        tailSegments.length > 0 ? join(realAncestor, ...tailSegments.slice().reverse()) : realAncestor
      options.assertResolved?.(resolvedReal)
      return { resolvedReal, exists: tailSegments.length === 0 }
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw error
      }
      const linkStats = await lstat(cursor).catch((statErr) => {
        if (isMissingPathError(statErr)) return null
        throw statErr
      })
      if (linkStats?.isSymbolicLink()) {
        throw new Error(danglingSymlinkMessage)
      }
      const parent = dirname(cursor)
      if (parent === cursor) {
        throw new Error(outsideMessage)
      }
      tailSegments.push(basename(cursor))
      cursor = parent
    }
  }
}
