import { spawn } from 'node:child_process'
import { open, realpath, stat } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import {
  GIT_DIFF_MAX_BYTES,
  GIT_EMPTY_TREE_HASH,
  type GitChangedFile,
  type GitDiffRequest,
  type GitFileDiff
} from '@shared/git'
import { hasBlockedPathSegment, isMissingPathError, isPathInsideRoot } from '../fs/pathSecurity'
import { IGNORED_ENTRY_NAMES } from '../workspace/WorkspaceFsService'
import { assertValidGitHash } from './gitObjectParsing'
import { assertValidStashRef } from './gitStash'

export interface GitBufferResult {
  buffer: Buffer
  truncated: boolean
  hasNullByte: boolean
}

export interface GitDiffExecOptions {
  env: NodeJS.ProcessEnv
  timeoutMs: number
  onFailureMeta?: (error: unknown, cwd: string, args: string[]) => void
}

export interface GitDiffExecArgs {
  cwd: string
  args: readonly string[]
  execOptions: GitDiffExecOptions
}

function utf8SequenceLength(leadByte: number): number {
  if ((leadByte & 0x80) === 0) return 1
  if ((leadByte & 0xe0) === 0xc0) return 2
  if ((leadByte & 0xf0) === 0xe0) return 3
  if ((leadByte & 0xf8) === 0xf0) return 4
  return 1
}

export function truncateUtf8BufferToMaxBytes(
  buffer: Buffer,
  maxBytes: number = GIT_DIFF_MAX_BYTES
): { text: string; isTruncated: boolean } {
  if (buffer.length <= maxBytes) {
    return { text: buffer.toString('utf8'), isTruncated: false }
  }

  let charStart = maxBytes - 1
  while (charStart > 0 && (buffer[charStart] & 0xc0) === 0x80) {
    charStart -= 1
  }
  const seqLen = utf8SequenceLength(buffer[charStart])
  const charEnd = charStart + seqLen
  const end = charEnd <= maxBytes ? charEnd : charStart

  return {
    text: buffer.subarray(0, end).toString('utf8'),
    isTruncated: true
  }
}

export function isGitBinaryPatchOutput(patchText: string, hasNullByte: boolean): boolean {
  if (hasNullByte) {
    return true
  }
  let inHunk = false
  for (const rawLine of patchText.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (line.startsWith('diff --git ')) {
      inHunk = false
      continue
    }
    if (!inHunk && (line.startsWith('@@ ') || line.startsWith('@@@ '))) {
      inHunk = true
      continue
    }
    if (!inHunk && /^Binary files .+ and .+ differ$/.test(line)) {
      return true
    }
  }
  return false
}

export async function inspectTargetFileState(
  repoRoot: string,
  workspaceRealRoot: string,
  safeRelativePath: string
): Promise<{ existsOnDisk: boolean; existsInWorkspace: boolean }> {
  const candidate = resolve(repoRoot, safeRelativePath)
  try {
    const stats = await stat(candidate)
    if (!stats.isFile()) {
      return { existsOnDisk: false, existsInWorkspace: false }
    }
    const realCandidate = await realpath(candidate)
    const existsInWorkspace =
      isPathInsideRoot(workspaceRealRoot, candidate) &&
      isPathInsideRoot(workspaceRealRoot, realCandidate) &&
      !hasBlockedPathSegment(relative(workspaceRealRoot, realCandidate), IGNORED_ENTRY_NAMES)
    return { existsOnDisk: true, existsInWorkspace }
  } catch (error) {
    if (isMissingPathError(error)) {
      return { existsOnDisk: false, existsInWorkspace: false }
    }
    throw error
  }
}

async function execGitStdoutCapped({
  cwd,
  args,
  execOptions
}: GitDiffExecArgs): Promise<GitBufferResult> {
  const { env, timeoutMs, onFailureMeta } = execOptions
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('git', [...args], {
      cwd,
      env,
      windowsHide: true
    })

    const stdoutChunks: Buffer[] = []
    let collectedBytes = 0
    let truncated = false
    let hasNullByte = false
    let timedOut = false
    let settled = false
    const stderrChunks: Buffer[] = []
    let stderrBytes = 0
    const MAX_STDERR_BYTES = 16 * 1024

    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutMs)

    const finishError = (err: unknown): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      onFailureMeta?.(err, cwd, [...args])
      rejectPromise(err)
    }

    child.on('error', finishError)

    child.stdout.on('data', (chunk: Buffer) => {
      if (settled || truncated) return
      if (chunk.includes(0)) {
        hasNullByte = true
      }
      const remaining = GIT_DIFF_MAX_BYTES + 1 - collectedBytes
      if (chunk.length >= remaining) {
        if (remaining > 0) {
          stdoutChunks.push(chunk.subarray(0, remaining))
          collectedBytes += remaining
        }
        truncated = true
        child.kill()
        return
      }
      stdoutChunks.push(chunk)
      collectedBytes += chunk.length
    })

    child.stderr.on('data', (chunk: Buffer) => {
      if (stderrBytes >= MAX_STDERR_BYTES) return
      const slice = chunk.subarray(0, MAX_STDERR_BYTES - stderrBytes)
      stderrChunks.push(slice)
      stderrBytes += slice.length
    })

    child.on('close', (code, signal) => {
      if (settled) return
      clearTimeout(timer)

      if (truncated) {
        settled = true
        resolvePromise({
          buffer: Buffer.concat(stdoutChunks, collectedBytes),
          truncated: true,
          hasNullByte
        })
        return
      }

      if (timedOut) {
        finishError(
          Object.assign(new Error(`Git command timed out after ${timeoutMs}ms`), {
            killed: true,
            signal: signal ?? undefined,
            stderr: Buffer.concat(stderrChunks, stderrBytes).toString('utf8')
          })
        )
        return
      }

      if (code !== 0) {
        finishError(
          Object.assign(new Error(`Git command failed with exit code ${code ?? 'unknown'}`), {
            code: code ?? undefined,
            signal: signal ?? undefined,
            stderr: Buffer.concat(stderrChunks, stderrBytes).toString('utf8')
          })
        )
        return
      }

      settled = true
      resolvePromise({
        buffer: Buffer.concat(stdoutChunks, collectedBytes),
        truncated: false,
        hasNullByte
      })
    })
  })
}

function buildUntrackedUnifiedPatch(safePath: string, text: string): string {
  if (text.length === 0) {
    return ''
  }

  const normalized = text.replace(/\r\n/g, '\n')
  const hasTrailingNewline = normalized.endsWith('\n')
  const bodyLines = (hasTrailingNewline ? normalized.slice(0, -1) : normalized).split('\n')
  const header = [
    `diff --git a/${safePath} b/${safePath}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${safePath}`,
    `@@ -0,0 +1,${bodyLines.length} @@`
  ]
  const patchLines = [...header, ...bodyLines.map((line) => `+${line}`)]
  if (!hasTrailingNewline) {
    patchLines.push('\\ No newline at end of file')
  }
  return `${patchLines.join('\n')}\n`
}

function buildUntrackedBlobDiffResult(
  safePath: string,
  result: GitBufferResult,
  existsInWorkspace: boolean
): GitFileDiff {
  if (result.hasNullByte || result.buffer.includes(0)) {
    return {
      path: safePath,
      status: '?',
      isBinary: true,
      isTruncated: false,
      existsInWorkspace,
      rawPatch: ''
    }
  }

  const { text, isTruncated: textTruncated } = truncateUtf8BufferToMaxBytes(
    result.buffer,
    GIT_DIFF_MAX_BYTES
  )
  const fullPatch = buildUntrackedUnifiedPatch(safePath, text)
  const patchBuffer = Buffer.from(fullPatch, 'utf8')
  const { text: boundedPatch, isTruncated: patchExceeded } = truncateUtf8BufferToMaxBytes(
    patchBuffer,
    GIT_DIFF_MAX_BYTES
  )

  return {
    path: safePath,
    status: '?',
    isBinary: false,
    isTruncated: result.truncated || textTruncated || patchExceeded,
    existsInWorkspace,
    rawPatch: boundedPatch
  }
}

async function readUntrackedFileDiff(
  repoRoot: string,
  safePath: string,
  existsOnDisk: boolean,
  existsInWorkspace: boolean
): Promise<GitFileDiff> {
  if (!existsOnDisk) {
    return {
      path: safePath,
      status: '?',
      isBinary: false,
      isTruncated: false,
      existsInWorkspace: false,
      rawPatch: ''
    }
  }

  const handle = await open(resolve(repoRoot, safePath), 'r')
  let totalRead = 0
  const buffer = Buffer.allocUnsafe(GIT_DIFF_MAX_BYTES + 1)
  try {
    while (totalRead < buffer.length) {
      const { bytesRead } = await handle.read(buffer, totalRead, buffer.length - totalRead, totalRead)
      if (bytesRead === 0) break
      totalRead += bytesRead
    }
  } finally {
    await handle.close()
  }

  return buildUntrackedBlobDiffResult(
    safePath,
    {
      buffer: buffer.subarray(0, totalRead),
      truncated: totalRead > GIT_DIFF_MAX_BYTES,
      hasNullByte: false
    },
    existsInWorkspace
  )
}

async function readStashUntrackedFileDiff(
  repoRoot: string,
  validatedStashHash: string,
  safePath: string,
  existsInWorkspace: boolean,
  execOptions: GitDiffExecOptions
): Promise<GitFileDiff> {
  const result = await execGitStdoutCapped({
    cwd: repoRoot,
    args: ['cat-file', '-p', `${validatedStashHash}^3:${safePath}`],
    execOptions
  })
  return buildUntrackedBlobDiffResult(safePath, result, existsInWorkspace)
}

export type ValidatedGitDiffTarget =
  | { kind: 'staged' }
  | { kind: 'unstaged'; isUntracked: boolean }
  | { kind: 'commit'; commitHash: string }
  | { kind: 'stash'; stashHash: string; isUntracked: boolean }

/**
 * Validates target identifiers on a GitDiffRequest once before resolving repository paths.
 */
export function validateGitDiffTarget(request: GitDiffRequest): ValidatedGitDiffTarget {
  if (!request || typeof request !== 'object') {
    throw new Error('유효하지 않은 Diff 요청 형식입니다.')
  }
  switch (request.kind) {
    case 'staged':
      return { kind: 'staged' }
    case 'unstaged':
      return { kind: 'unstaged', isUntracked: request.status === '?' }
    case 'commit':
      return { kind: 'commit', commitHash: assertValidGitHash(request.commitHash, '커밋') }
    case 'stash':
      assertValidStashRef(request.stashRef)
      return {
        kind: 'stash',
        stashHash: assertValidGitHash(request.stashHash, 'Stash'),
        isUntracked: request.status === '?'
      }
    default:
      throw new Error('유효하지 않은 Diff 요청 형식입니다.')
  }
}

export interface ComputeGitDiffOptions {
  repoRoot: string
  workspaceRealRoot: string
  target: ValidatedGitDiffTarget
  status: GitChangedFile['status']
  safePath: string
  safeOrigPath?: string
  hasHeadCommit: boolean
  execOptions: GitDiffExecOptions
}

export async function computeGitDiff({
  repoRoot,
  workspaceRealRoot,
  target,
  status,
  safePath,
  safeOrigPath,
  hasHeadCommit,
  execOptions
}: ComputeGitDiffOptions): Promise<GitFileDiff> {
  const { existsOnDisk, existsInWorkspace } = await inspectTargetFileState(
    repoRoot,
    workspaceRealRoot,
    safePath
  )

  const pathArgs = safeOrigPath ? [safeOrigPath, safePath] : [safePath]
  let gitArgs: string[]

  switch (target.kind) {
    case 'staged': {
      const baseTree = hasHeadCommit ? 'HEAD' : GIT_EMPTY_TREE_HASH
      gitArgs = [
        '-c',
        'core.quotePath=false',
        'diff',
        '--cached',
        '-M',
        '--find-renames',
        '--unified=3',
        baseTree,
        '--',
        ...pathArgs
      ]
      break
    }
    case 'unstaged': {
      if (target.isUntracked) {
        return readUntrackedFileDiff(repoRoot, safePath, existsOnDisk, existsInWorkspace)
      }
      gitArgs = ['-c', 'core.quotePath=false', 'diff', '--unified=3', '--', ...pathArgs]
      break
    }
    case 'commit': {
      gitArgs = [
        '-c',
        'core.quotePath=false',
        'show',
        '--first-parent',
        '-m',
        '--root',
        '-M',
        '--format=',
        '--unified=3',
        `${target.commitHash}^{commit}`,
        '--',
        ...pathArgs
      ]
      break
    }
    case 'stash': {
      if (target.isUntracked) {
        return readStashUntrackedFileDiff(
          repoRoot,
          target.stashHash,
          safePath,
          existsInWorkspace,
          execOptions
        )
      }
      gitArgs = [
        '-c',
        'core.quotePath=false',
        'diff',
        '-M',
        '--find-renames',
        '--unified=3',
        `${target.stashHash}^1`,
        target.stashHash,
        '--',
        ...pathArgs
      ]
      break
    }
  }

  const { buffer, truncated, hasNullByte } = await execGitStdoutCapped({
    cwd: repoRoot,
    args: gitArgs,
    execOptions
  })

  const preliminaryText = buffer.toString('utf8')
  const isBinary = isGitBinaryPatchOutput(preliminaryText, hasNullByte)
  if (isBinary) {
    return {
      path: safePath,
      ...(safeOrigPath ? { origPath: safeOrigPath } : {}),
      status,
      isBinary: true,
      isTruncated: false,
      existsInWorkspace,
      rawPatch: ''
    }
  }

  const { text: boundedPatch, isTruncated: utf8Truncated } = truncateUtf8BufferToMaxBytes(
    buffer,
    GIT_DIFF_MAX_BYTES
  )

  return {
    path: safePath,
    ...(safeOrigPath ? { origPath: safeOrigPath } : {}),
    status,
    isBinary: false,
    isTruncated: truncated || utf8Truncated,
    existsInWorkspace,
    rawPatch: boundedPatch
  }
}
