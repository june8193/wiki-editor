import { execFile } from 'node:child_process'
import { lstat, realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import {
  createEmptyGitStatus,
  type GitBranchInfo,
  type GitBranchList,
  type GitChangedFile,
  type GitStagedStatus,
  type GitStatus,
  type GitSyncResult,
  type GitUnstagedStatus
} from '@shared/git'

const execFileAsync = promisify(execFile)

const DEFAULT_LOCAL_TIMEOUT_MS = 30_000
const DEFAULT_MAX_BUFFER_BYTES = 10 * 1024 * 1024

export interface GitServiceOptions {
  env?: NodeJS.ProcessEnv
  localTimeoutMs?: number
  networkTimeoutMs?: number
}

interface ExecGitError extends Error {
  code?: string | number
  stdout?: string
  stderr?: string
  killed?: boolean
  signal?: NodeJS.Signals | null
}

function isErrnoCode(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException)?.code === code
}

function isPathInsideBase(baseDir: string, targetPath: string): boolean {
  const rel = relative(baseDir, targetPath)
  return (
    rel === '' ||
    (rel !== '..' &&
      !rel.startsWith(`..${sep}`) &&
      !rel.startsWith('../') &&
      !isAbsolute(rel))
  )
}

function hasGitMetadataSegment(relPath: string): boolean {
  if (!relPath) return false
  return relPath
    .split(/[\\/]/)
    .filter(Boolean)
    .some((segment) => segment === '.git')
}

function extractGitErrorDetail(error: unknown): string {
  const execErr = error as ExecGitError
  const stderr = typeof execErr?.stderr === 'string' ? execErr.stderr.trim() : ''
  const stdout = typeof execErr?.stdout === 'string' ? execErr.stdout.trim() : ''
  if (stderr) return stderr
  if (stdout) return stdout
  if (error instanceof Error && error.message) return error.message
  return '알 수 없는 Git 오류'
}

export function formatGitError(error: unknown): Error {
  if (error instanceof Error && (error as { isFormattedGitError?: boolean }).isFormattedGitError) {
    return error
  }

  const execErr = error as ExecGitError
  if (execErr?.code === 'ENOENT') {
    const formatted = new Error('시스템에 Git CLI가 설치되어 있지 않거나 PATH에서 찾을 수 없습니다.')
    ;(formatted as { isFormattedGitError?: boolean }).isFormattedGitError = true
    return formatted
  }

  if (execErr?.killed || execErr?.signal === 'SIGTERM') {
    const formatted = new Error('Git 명령 실행 시간이 초과되었습니다.')
    ;(formatted as { isFormattedGitError?: boolean }).isFormattedGitError = true
    return formatted
  }

  const detail = extractGitErrorDetail(error)
  const lower = detail.toLowerCase()

  let message: string
  if (lower.includes('not a git repository')) {
    message = '현재 워크스페이스는 Git 저장소가 아닙니다.'
  } else if (
    lower.includes('authentication failed') ||
    lower.includes('could not read username') ||
    lower.includes('terminal prompts disabled') ||
    lower.includes('permission denied (publickey)') ||
    lower.includes('invalid username or token')
  ) {
    message = `Git 인증에 실패했습니다. 시스템 자격 증명 또는 SSH 키를 확인하세요.\n${detail}`
  } else if (
    lower.includes('conflict') ||
    lower.includes('automatic merge failed') ||
    lower.includes('unmerged files') ||
    lower.includes('unresolved conflict')
  ) {
    message = `병합 충돌(Conflict)이 발생했습니다. 충돌 파일을 해결한 뒤 다시 시도하세요.\n${detail}`
  } else if (
    lower.includes('would be overwritten by') ||
    lower.includes('please commit your changes or stash them')
  ) {
    message = `커밋되지 않은 로컬 변경 사항이 있어 작업을 완료할 수 없습니다. 변경 사항을 커밋하거나 정리한 뒤 다시 시도하세요.\n${detail}`
  } else if (
    lower.includes('non-fast-forward') ||
    lower.includes('fetch first') ||
    lower.includes('failed to push some refs')
  ) {
    message = `원격 저장소에 새 커밋이 있어 Push가 거부되었습니다. 먼저 Pull 또는 Sync를 실행하세요.\n${detail}`
  } else if (lower.includes('has no upstream branch') || lower.includes('no tracking information')) {
    message = `현재 브랜치에 연결된 원격 추적(upstream) 브랜치가 없습니다.\n${detail}`
  } else if (
    lower.includes('unable to access') ||
    lower.includes('could not resolve host') ||
    lower.includes('connection refused') ||
    lower.includes('failed to connect')
  ) {
    message = `원격 저장소에 연결할 수 없습니다.\n${detail}`
  } else if (lower.includes('invalid reference:')) {
    message = `브랜치를 찾을 수 없습니다.\n${detail}`
  } else if (lower.includes('no configured push destination') || lower.includes('does not appear to be a git repository')) {
    message = `원격 저장소(remote)에 접근할 수 없습니다.\n${detail}`
  } else if (lower.includes('nothing to commit') || lower.includes('no changes added to commit')) {
    message = '커밋할 Staged 변경 사항이 없습니다.'
  } else {
    message = `Git 명령 실행 중 오류가 발생했습니다: ${detail}`
  }

  const formatted = new Error(message)
  ;(formatted as { isFormattedGitError?: boolean }).isFormattedGitError = true
  return formatted
}

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

function toStagedStatus(code: string): GitStagedStatus | null {
  switch (code) {
    case 'M':
    case 'A':
    case 'D':
    case 'R':
    case 'C':
    case 'U':
      return code
    default:
      return null
  }
}

function toUnstagedStatus(code: string): GitUnstagedStatus | null {
  switch (code) {
    case 'M':
    case 'D':
    case 'U':
      return code
    default:
      return null
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
      if (token === '# branch.oid (initial)') {
        status.isUnborn = true
      } else if (token.startsWith('# branch.head ')) {
        const head = token.slice('# branch.head '.length)
        if (head === '(detached)') {
          status.isDetached = true
          status.branch = null
        } else {
          status.isDetached = false
          status.branch = head
        }
      } else if (token.startsWith('# branch.upstream ')) {
        status.hasUpstream = true
      } else if (token.startsWith('# branch.ab ')) {
        const match = /^# branch\.ab \+(\d+) -(\d+)$/.exec(token)
        if (match) {
          status.ahead = Number(match[1])
          status.behind = Number(match[2])
        }
      }
      continue
    }

    if (token.startsWith('1 ')) {
      const { fields, rest } = splitPorcelainFields(token, 8)
      const xy = fields[1] ?? '..'
      const stagedCode = toStagedStatus(xy[0] ?? '.')
      const unstagedCode = toUnstagedStatus(xy[1] ?? '.')
      if (stagedCode) {
        status.staged.push({ path: rest, status: stagedCode })
      }
      if (unstagedCode) {
        status.unstaged.push({ path: rest, status: unstagedCode })
      }
      continue
    }

    if (token.startsWith('2 ')) {
      const { fields, rest } = splitPorcelainFields(token, 9)
      const xy = fields[1] ?? '..'
      const origPath = tokens[i + 1]
      if (origPath !== undefined) {
        i += 1
      }
      const stagedCode = toStagedStatus(xy[0] ?? '.')
      const unstagedCode = toUnstagedStatus(xy[1] ?? '.')
      if (stagedCode) {
        const entry: GitChangedFile = { path: rest, status: stagedCode }
        if (origPath) {
          entry.origPath = origPath
        }
        status.staged.push(entry)
      }
      if (unstagedCode) {
        status.unstaged.push({ path: rest, status: unstagedCode })
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

/**
 * Executes asynchronous Git CLI operations via argument arrays (execFile) for an open workspace.
 */
export class GitService {
  private readonly env: NodeJS.ProcessEnv | undefined
  private readonly localTimeoutMs: number
  private readonly networkTimeoutMs: number

  constructor(options: GitServiceOptions = {}) {
    this.env = options.env
    this.localTimeoutMs = options.localTimeoutMs ?? DEFAULT_LOCAL_TIMEOUT_MS
    this.networkTimeoutMs = options.networkTimeoutMs ?? DEFAULT_LOCAL_TIMEOUT_MS * 2
  }

  async status(workspacePath: string): Promise<GitStatus> {
    const resolvedDir = await this.resolveExistingDirectory(workspacePath)
    let repoRoot: string
    try {
      const topLevel = (await this.execGit(resolvedDir, ['rev-parse', '--show-toplevel'])).trim()
      repoRoot = await realpath(topLevel)
    } catch (error) {
      const detail = extractGitErrorDetail(error).toLowerCase()
      if (detail.includes('not a git repository')) {
        return createEmptyGitStatus(false, null)
      }
      throw formatGitError(error)
    }

    return this.statusForRepo(repoRoot)
  }

  async init(workspacePath: string): Promise<GitStatus> {
    const resolvedDir = await this.resolveExistingDirectory(workspacePath)
    try {
      await this.execGit(resolvedDir, ['init'])
    } catch (error) {
      throw formatGitError(error)
    }
    return this.status(resolvedDir)
  }

  async stage(workspacePath: string, paths: readonly string[]): Promise<GitStatus> {
    const { workspaceDir, repoRoot } = await this.requireRepoContext(workspacePath)
    const validatedPaths = await this.validateRepoRelativePaths(workspaceDir, repoRoot, paths)
    try {
      await this.execGit(repoRoot, ['add', '-A', '--', ...validatedPaths])
    } catch (error) {
      throw formatGitError(error)
    }
    return this.statusForRepo(repoRoot)
  }

  async stageAll(workspacePath: string): Promise<GitStatus> {
    const { workspaceDir, repoRoot } = await this.requireRepoContext(workspacePath)
    try {
      await this.execGit(workspaceDir, ['add', '-A', '--', '.'])
    } catch (error) {
      throw formatGitError(error)
    }
    return this.statusForRepo(repoRoot)
  }

  async unstage(workspacePath: string, paths: readonly string[]): Promise<GitStatus> {
    const { workspaceDir, repoRoot } = await this.requireRepoContext(workspacePath)
    const validatedPaths = await this.validateRepoRelativePaths(workspaceDir, repoRoot, paths)
    const hasHead = await this.hasHeadCommit(repoRoot)
    try {
      if (hasHead) {
        await this.execGit(repoRoot, ['reset', '-q', 'HEAD', '--', ...validatedPaths])
      } else {
        await this.execGit(repoRoot, [
          'rm',
          '--cached',
          '-r',
          '--ignore-unmatch',
          '--',
          ...validatedPaths
        ])
      }
    } catch (error) {
      throw formatGitError(error)
    }
    return this.statusForRepo(repoRoot)
  }

  async unstageAll(workspacePath: string): Promise<GitStatus> {
    const { workspaceDir, repoRoot } = await this.requireRepoContext(workspacePath)
    const hasHead = await this.hasHeadCommit(repoRoot)
    try {
      if (hasHead) {
        await this.execGit(workspaceDir, ['reset', '-q', 'HEAD', '--', '.'])
      } else {
        await this.execGit(workspaceDir, ['rm', '-r', '--cached', '--ignore-unmatch', '--', '.'])
      }
    } catch (error) {
      throw formatGitError(error)
    }
    return this.statusForRepo(repoRoot)
  }

  async commit(workspacePath: string, message: string): Promise<GitStatus> {
    const trimmed = message.trim()
    if (!trimmed) {
      throw new Error('커밋 메시지를 입력하세요.')
    }
    const { repoRoot } = await this.requireRepoContext(workspacePath)
    try {
      await this.execGit(repoRoot, ['commit', '-m', trimmed])
    } catch (error) {
      throw formatGitError(error)
    }
    return this.statusForRepo(repoRoot)
  }

  async branches(workspacePath: string): Promise<GitBranchList> {
    const { repoRoot } = await this.requireRepoContext(workspacePath)
    try {
      const raw = await this.execGit(repoRoot, [
        'for-each-ref',
        '--format=%(HEAD)%09%(refname:short)%09%(upstream:short)',
        'refs/heads'
      ])
      const branches: GitBranchInfo[] = []
      let current: string | null = null

      for (const line of raw.split(/\r?\n/)) {
        if (!line) continue
        const [headMarker = '', name = '', upstreamRaw = ''] = line.split('\t')
        if (!name) continue
        const isCurrent = headMarker === '*'
        if (isCurrent) {
          current = name
        }
        branches.push({
          name,
          current: isCurrent,
          upstream: upstreamRaw || null
        })
      }

      if (current !== null) {
        return { current, isDetached: false, branches }
      }

      try {
        const symbolicBranch = (
          await this.execGit(repoRoot, ['symbolic-ref', '--short', '--quiet', 'HEAD'])
        ).trim()
        return {
          current: symbolicBranch || null,
          isDetached: false,
          branches
        }
      } catch {
        return {
          current: null,
          isDetached: true,
          branches
        }
      }
    } catch (error) {
      throw formatGitError(error)
    }
  }

  async checkout(workspacePath: string, branchName: string): Promise<GitStatus> {
    const trimmed = branchName.trim()
    if (
      !trimmed ||
      trimmed !== branchName ||
      trimmed.startsWith('-') ||
      /[\s\0]/.test(trimmed) ||
      trimmed.includes('..')
    ) {
      throw new Error('유효한 브랜치 이름이 아닙니다.')
    }
    const { repoRoot } = await this.requireRepoContext(workspacePath)
    try {
      await this.execGit(repoRoot, ['switch', '--no-guess', trimmed])
    } catch (error) {
      throw formatGitError(error)
    }
    return this.statusForRepo(repoRoot)
  }

  async pull(workspacePath: string): Promise<GitStatus> {
    const { repoRoot } = await this.requireRepoContext(workspacePath)
    const currentStatus = await this.statusForRepo(repoRoot)
    await this.requireRemotes(repoRoot)
    if (currentStatus.isDetached) {
      throw new Error('Detached HEAD 상태에서는 Pull할 수 없습니다.')
    }
    if (!currentStatus.hasUpstream) {
      throw new Error('현재 브랜치에 연결된 원격 추적(upstream) 브랜치가 없습니다.')
    }
    try {
      await this.execPull(repoRoot, [])
    } catch (error) {
      throw formatGitError(error)
    }
    return this.statusForRepo(repoRoot)
  }

  async push(workspacePath: string): Promise<GitStatus> {
    const { repoRoot } = await this.requireRepoContext(workspacePath)
    const currentStatus = await this.statusForRepo(repoRoot)
    const remotes = await this.requireRemotes(repoRoot)
    if (currentStatus.isUnborn) {
      throw new Error('커밋된 내역이 없어 Push할 수 없습니다.')
    }
    if (currentStatus.isDetached || !currentStatus.branch) {
      throw new Error('Detached HEAD 상태에서는 Push할 수 없습니다.')
    }

    try {
      if (currentStatus.hasUpstream) {
        await this.execGit(repoRoot, ['push'], this.networkTimeoutMs)
      } else {
        const targetRemote = this.resolveTargetRemote(remotes)
        await this.execGit(
          repoRoot,
          ['push', '-u', targetRemote, currentStatus.branch],
          this.networkTimeoutMs
        )
      }
    } catch (error) {
      throw formatGitError(error)
    }
    return this.statusForRepo(repoRoot)
  }

  async sync(workspacePath: string): Promise<GitSyncResult> {
    const { repoRoot } = await this.requireRepoContext(workspacePath)
    const currentStatus = await this.statusForRepo(repoRoot)
    const remotes = await this.requireRemotes(repoRoot)
    if (currentStatus.isUnborn) {
      throw new Error('커밋된 내역이 없어 Sync할 수 없습니다.')
    }
    if (currentStatus.isDetached || !currentStatus.branch) {
      throw new Error('Detached HEAD 상태에서는 Sync할 수 없습니다.')
    }

    let pulled = false
    try {
      if (currentStatus.hasUpstream) {
        await this.execPull(repoRoot, [])
        pulled = true
        await this.execGit(repoRoot, ['push'], this.networkTimeoutMs)
      } else {
        const targetRemote = this.resolveTargetRemote(remotes)
        const hasRemoteHead = await this.remoteBranchExists(
          repoRoot,
          targetRemote,
          currentStatus.branch
        )
        if (hasRemoteHead) {
          await this.execPull(repoRoot, [targetRemote, currentStatus.branch])
          pulled = true
        }
        await this.execGit(
          repoRoot,
          ['push', '-u', targetRemote, currentStatus.branch],
          this.networkTimeoutMs
        )
      }
    } catch (error) {
      throw formatGitError(error)
    }

    const status = await this.statusForRepo(repoRoot)
    return {
      status,
      pulled,
      pushed: true,
      summary: pulled ? 'Pull 및 Push 동기화 완료' : '원격 브랜치 게시(Push) 완료'
    }
  }

  private async execPull(repoRoot: string, extraArgs: readonly string[]): Promise<void> {
    try {
      await this.execGit(repoRoot, ['pull', '--no-edit', ...extraArgs], this.networkTimeoutMs)
    } catch (error) {
      const detail = extractGitErrorDetail(error).toLowerCase()
      if (detail.includes('need to specify how to reconcile divergent branches')) {
        await this.execGit(
          repoRoot,
          ['pull', '--no-rebase', '--no-edit', ...extraArgs],
          this.networkTimeoutMs
        )
        return
      }
      throw error
    }
  }

  private async listRemotes(repoRoot: string): Promise<string[]> {
    const raw = await this.execGit(repoRoot, ['remote'])
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
  }

  private async requireRemotes(repoRoot: string): Promise<string[]> {
    const remotes = await this.listRemotes(repoRoot)
    if (remotes.length === 0) {
      throw new Error('원격 저장소(remote)가 설정되어 있지 않습니다.')
    }
    return remotes
  }

  private resolveTargetRemote(remotes: readonly string[]): string {
    if (remotes.includes('origin')) return 'origin'
    if (remotes.length === 1) return remotes[0]
    throw new Error('현재 브랜치에 연결된 원격 추적(upstream) 브랜치가 없습니다.')
  }

  private async remoteBranchExists(
    repoRoot: string,
    remote: string,
    branch: string
  ): Promise<boolean> {
    try {
      await this.execGit(
        repoRoot,
        ['ls-remote', '--exit-code', '--heads', remote, `refs/heads/${branch}`],
        this.networkTimeoutMs
      )
      return true
    } catch (error) {
      const execErr = error as ExecGitError
      if (execErr?.code === 2) {
        return false
      }
      throw error
    }
  }

  private async statusForRepo(repoRoot: string): Promise<GitStatus> {
    try {
      const raw = await this.execGit(repoRoot, [
        'status',
        '--porcelain=v2',
        '--branch',
        '-z',
        '--untracked-files=all'
      ])
      return parsePorcelainV2Z(raw, repoRoot)
    } catch (error) {
      throw formatGitError(error)
    }
  }

  private async resolveExistingDirectory(workspacePath: string): Promise<string> {
    const trimmed = workspacePath.trim()
    if (!trimmed || trimmed.includes('\0')) {
      throw new Error('유효한 워크스페이스 경로가 아닙니다.')
    }
    const resolved = resolve(trimmed)
    let realDir: string
    try {
      realDir = await realpath(resolved)
    } catch (error) {
      if (isErrnoCode(error, 'ENOENT')) {
        throw new Error(`워크스페이스 폴더를 찾을 수 없습니다: ${resolved}`)
      }
      throw error
    }
    const dirStats = await stat(realDir)
    if (!dirStats.isDirectory()) {
      throw new Error('선택한 경로는 폴더가 아닙니다.')
    }
    return realDir
  }

  private async requireRepoContext(
    workspacePath: string
  ): Promise<{ workspaceDir: string; repoRoot: string }> {
    const workspaceDir = await this.resolveExistingDirectory(workspacePath)
    try {
      const topLevel = (await this.execGit(workspaceDir, ['rev-parse', '--show-toplevel'])).trim()
      const repoRoot = await realpath(topLevel)
      return { workspaceDir, repoRoot }
    } catch (error) {
      throw formatGitError(error)
    }
  }

  private async hasHeadCommit(repoRoot: string): Promise<boolean> {
    try {
      await this.execGit(repoRoot, ['rev-parse', '--verify', '--quiet', 'HEAD'])
      return true
    } catch {
      return false
    }
  }

  private async validateRepoRelativePaths(
    workspaceDir: string,
    repoRoot: string,
    paths: readonly string[]
  ): Promise<string[]> {
    if (!Array.isArray(paths) || paths.length === 0) {
      throw new Error('대상 파일 경로가 지정되지 않았습니다.')
    }

    const validated: string[] = []
    for (const rawPath of paths) {
      if (typeof rawPath !== 'string' || rawPath.trim().length === 0 || rawPath.includes('\0')) {
        throw new Error('유효하지 않은 파일 경로입니다.')
      }

      const candidate = isAbsolute(rawPath) ? resolve(rawPath) : resolve(workspaceDir, rawPath)
      if (!isPathInsideBase(workspaceDir, candidate) || candidate === workspaceDir) {
        throw new Error('워크스페이스 저장소 밖의 경로에는 접근할 수 없습니다.')
      }
      if (hasGitMetadataSegment(relative(workspaceDir, candidate))) {
        throw new Error('시스템 .git 경로에는 접근할 수 없습니다.')
      }

      const resolvedReal = await this.resolveRealWithinBase(workspaceDir, repoRoot, candidate)
      if (hasGitMetadataSegment(relative(repoRoot, resolvedReal))) {
        throw new Error('시스템 .git 경로에는 접근할 수 없습니다.')
      }
      validated.push(relative(repoRoot, resolvedReal).replace(/\\/g, '/'))
    }
    return validated
  }

  private async resolveRealWithinBase(
    workspaceDir: string,
    repoRoot: string,
    candidate: string
  ): Promise<string> {
    const tailSegments: string[] = []
    let cursor = candidate

    while (true) {
      try {
        const realAncestor = await realpath(cursor)
        const resolvedReal =
          tailSegments.length > 0 ? join(realAncestor, ...tailSegments.slice().reverse()) : realAncestor
        if (
          !isPathInsideBase(workspaceDir, resolvedReal) ||
          !isPathInsideBase(repoRoot, resolvedReal)
        ) {
          throw new Error('워크스페이스 저장소 밖의 경로에는 접근할 수 없습니다.')
        }
        return resolvedReal
      } catch (error) {
        if (!isErrnoCode(error, 'ENOENT')) {
          throw error
        }
        const linkStats = await lstat(cursor).catch((statErr) => {
          if (isErrnoCode(statErr, 'ENOENT')) return null
          throw statErr
        })
        if (linkStats?.isSymbolicLink()) {
          throw new Error('유효하지 않은 심볼릭 링크 경로입니다.')
        }
        const parent = dirname(cursor)
        if (parent === cursor) {
          throw new Error('워크스페이스 저장소 밖의 경로에는 접근할 수 없습니다.')
        }
        tailSegments.push(basename(cursor))
        cursor = parent
      }
    }
  }

  private async execGit(
    cwd: string,
    args: readonly string[],
    timeoutMs = this.localTimeoutMs
  ): Promise<string> {
    const { stdout } = await execFileAsync('git', [...args], {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: DEFAULT_MAX_BUFFER_BYTES,
      timeout: timeoutMs,
      env: {
        ...process.env,
        ...this.env,
        GIT_TERMINAL_PROMPT: '0',
        GCM_INTERACTIVE: 'never',
        GIT_MERGE_AUTOEDIT: 'no'
      }
    })
    return stdout
  }
}
