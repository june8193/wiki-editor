import {
  GIT_BLOB_SNAPSHOT_MAX_BYTES,
  type GitBlobSnapshot,
  type GitBlobSnapshotRequest
} from '@shared/symbol'
import { decodeTextAuto, truncateBufferAtCharBoundary } from '../encoding/textEncoding'
import { assertValidGitCompareRef } from './gitCompare'
import {
  execGitStdoutCapped,
  inspectTargetFileState,
  type GitBufferResult,
  type GitDiffExecOptions
} from './gitDiff'
import { assertValidGitHash } from './gitObjectParsing'

export function assertValidSnapshotRef(ref: unknown, label: string): string {
  const valid = assertValidGitCompareRef(ref, label)
  if (valid.includes(':')) {
    throw new Error(`유효한 ${label} 형식이 아닙니다.`)
  }
  return valid
}

export type ValidatedGitBlobSnapshotScope =
  | { kind: 'git-index'; displayRef: string }
  | { kind: 'git-ref'; ref: string; displayRef: string; untrackedParentRef?: string }

export function validateBlobSnapshotRequest(request: GitBlobSnapshotRequest): {
  scope: ValidatedGitBlobSnapshotScope
} {
  if (!request || typeof request !== 'object' || !request.scope || typeof request.scope !== 'object') {
    throw new Error('유효하지 않은 스냅샷 요청 형식입니다.')
  }
  if (request.stashHash !== undefined) {
    assertValidGitHash(request.stashHash, 'Stash')
  }

  if (request.scope.kind === 'git-index') {
    if (typeof request.scope.displayRef !== 'string') {
      throw new Error('유효하지 않은 스냅샷 요청 형식입니다.')
    }
    return {
      scope: {
        kind: 'git-index',
        displayRef: request.scope.displayRef
      }
    }
  }

  if (request.scope.kind === 'git-ref') {
    if (typeof request.scope.displayRef !== 'string') {
      throw new Error('유효하지 않은 스냅샷 요청 형식입니다.')
    }
    const ref = assertValidSnapshotRef(request.scope.ref, '스냅샷 Ref')
    const untrackedParentRef =
      request.scope.untrackedParentRef !== undefined
        ? assertValidSnapshotRef(request.scope.untrackedParentRef, '미추적 부모 Ref')
        : undefined
    return {
      scope: {
        kind: 'git-ref',
        ref,
        displayRef: request.scope.displayRef,
        ...(untrackedParentRef !== undefined ? { untrackedParentRef } : {})
      }
    }
  }

  throw new Error('유효하지 않은 스냅샷 요청 형식입니다.')
}

async function readCatFileBlob(
  repoRoot: string,
  objectSpec: string,
  execOptions: GitDiffExecOptions
): Promise<GitBufferResult> {
  return execGitStdoutCapped({
    cwd: repoRoot,
    args: ['cat-file', '-p', objectSpec],
    execOptions,
    maxBytes: GIT_BLOB_SNAPSHOT_MAX_BYTES
  })
}

export interface ReadGitBlobSnapshotOptions {
  repoRoot: string
  workspaceRealRoot: string
  safePath: string
  scope: ValidatedGitBlobSnapshotScope
  execOptions: GitDiffExecOptions
}

export async function readGitBlobSnapshot({
  repoRoot,
  workspaceRealRoot,
  safePath,
  scope,
  execOptions
}: ReadGitBlobSnapshotOptions): Promise<GitBlobSnapshot> {
  const [{ existsInWorkspace }, blobResult] = await Promise.all([
    inspectTargetFileState(repoRoot, workspaceRealRoot, safePath),
    (async (): Promise<GitBufferResult> => {
      if (scope.kind === 'git-index') {
        return readCatFileBlob(repoRoot, `:${safePath}`, execOptions)
      }
      try {
        return await readCatFileBlob(repoRoot, `${scope.ref}:${safePath}`, execOptions)
      } catch (primaryError) {
        if (scope.untrackedParentRef) {
          return readCatFileBlob(
            repoRoot,
            `${scope.untrackedParentRef}:${safePath}`,
            execOptions
          )
        }
        throw primaryError
      }
    })()
  ])

  if (blobResult.hasNullByte || blobResult.buffer.includes(0)) {
    return {
      path: safePath,
      scope,
      isBinary: true,
      isTruncated: false,
      existsInWorkspace,
      encoding: 'utf-8',
      content: ''
    }
  }

  const isTruncated =
    blobResult.truncated || blobResult.buffer.byteLength > GIT_BLOB_SNAPSHOT_MAX_BYTES
  const boundedBuffer = truncateBufferAtCharBoundary(
    blobResult.buffer,
    GIT_BLOB_SNAPSHOT_MAX_BYTES,
    'auto'
  )
  const { content, encoding } = decodeTextAuto(boundedBuffer)

  return {
    path: safePath,
    scope,
    isBinary: false,
    isTruncated,
    existsInWorkspace,
    encoding,
    content
  }
}
