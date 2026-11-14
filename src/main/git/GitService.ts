import { execFile } from 'node:child_process'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import {
  createEmptyGitStatus,
  type GitBranchInfo,
  type GitBranchList,
  type GitStatus,
  type GitSyncResult
} from '@shared/git'
import {
  hasBlockedPathSegment,
  isErrnoCode,
  isPathInsideRoot,
  resolveRealPathWithAncestor
} from '../fs/pathSecurity'
import {
  type ExecGitError,
  extractGitErrorDetail,
  formatGitError,
  parsePorcelainV2Z
} from './gitPorcelain'

export { formatGitError, parsePorcelainV2Z }

const execFileAsync = promisify(execFile)

const DEFAULT_LOCAL_TIMEOUT_MS = 30_000
const DEFAULT_MAX_BUFFER_BYTES = 10 * 1024 * 1024
const GIT_METADATA_NAMES: ReadonlySet<string> = new Set(['.git'])

export interface GitServiceOptions {
  env?: NodeJS.ProcessEnv
  localTimeoutMs?: number
  networkTimeoutMs?: number
}

interface PublishableBranchContext {
  repoRoot: string
  currentStatus: GitStatus
  branch: string
  remotes: string[]
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
    const repoRoot = await this.requireRepoRoot(workspacePath)
    const validatedPaths = await this.validateRepoRelativePaths(repoRoot, paths)
    try {
      await this.execGit(repoRoot, ['add', '-A', '--', ...validatedPaths])
    } catch (error) {
      throw formatGitError(error)
    }
    return this.statusForRepo(repoRoot)
  }

  async stageAll(workspacePath: string): Promise<GitStatus> {
    const repoRoot = await this.requireRepoRoot(workspacePath)
    try {
      await this.execGit(repoRoot, ['add', '-A', '--', '.'])
    } catch (error) {
      throw formatGitError(error)
    }
    return this.statusForRepo(repoRoot)
  }

  async unstage(workspacePath: string, paths: readonly string[]): Promise<GitStatus> {
    const repoRoot = await this.requireRepoRoot(workspacePath)
    const validatedPaths = await this.validateRepoRelativePaths(repoRoot, paths)
    await this.execUnstageTargets(repoRoot, validatedPaths)
    return this.statusForRepo(repoRoot)
  }

  async unstageAll(workspacePath: string): Promise<GitStatus> {
    const repoRoot = await this.requireRepoRoot(workspacePath)
    await this.execUnstageTargets(repoRoot, ['.'])
    return this.statusForRepo(repoRoot)
  }

  async commit(workspacePath: string, message: string): Promise<GitStatus> {
    const trimmed = message.trim()
    if (!trimmed) {
      throw new Error('커밋 메시지를 입력하세요.')
    }
    const repoRoot = await this.requireRepoRoot(workspacePath)
    try {
      await this.execGit(repoRoot, ['commit', '-m', trimmed])
    } catch (error) {
      throw formatGitError(error)
    }
    return this.statusForRepo(repoRoot)
  }

  async branches(workspacePath: string): Promise<GitBranchList> {
    const repoRoot = await this.requireRepoRoot(workspacePath)
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
    const repoRoot = await this.requireRepoRoot(workspacePath)
    try {
      await this.execGit(repoRoot, ['switch', '--no-guess', trimmed])
    } catch (error) {
      throw formatGitError(error)
    }
    return this.statusForRepo(repoRoot)
  }

  async pull(workspacePath: string): Promise<GitStatus> {
    const repoRoot = await this.requireRepoRoot(workspacePath)
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
    const { repoRoot, currentStatus, branch, remotes } = await this.requirePublishableBranchContext(
      workspacePath,
      'Push'
    )

    try {
      if (currentStatus.hasUpstream) {
        await this.execGit(repoRoot, ['push'], this.networkTimeoutMs)
      } else {
        const targetRemote = this.resolveTargetRemote(remotes)
        await this.execGit(repoRoot, ['push', '-u', targetRemote, branch], this.networkTimeoutMs)
      }
    } catch (error) {
      throw formatGitError(error)
    }
    return this.statusForRepo(repoRoot)
  }

  async sync(workspacePath: string): Promise<GitSyncResult> {
    const { repoRoot, currentStatus, branch, remotes } = await this.requirePublishableBranchContext(
      workspacePath,
      'Sync'
    )

    let pulled = false
    try {
      if (currentStatus.hasUpstream) {
        await this.execPull(repoRoot, [])
        pulled = true
        await this.execGit(repoRoot, ['push'], this.networkTimeoutMs)
      } else {
        const targetRemote = this.resolveTargetRemote(remotes)
        const hasRemoteHead = await this.remoteBranchExists(repoRoot, targetRemote, branch)
        if (hasRemoteHead) {
          await this.execPull(repoRoot, [targetRemote, branch])
          pulled = true
        }
        await this.execGit(repoRoot, ['push', '-u', targetRemote, branch], this.networkTimeoutMs)
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

  private async execUnstageTargets(repoRoot: string, targets: readonly string[]): Promise<void> {
    const hasHead = await this.hasHeadCommit(repoRoot)
    try {
      if (hasHead) {
        await this.execGit(repoRoot, ['reset', '-q', 'HEAD', '--', ...targets])
      } else {
        await this.execGit(repoRoot, ['rm', '--cached', '-r', '--ignore-unmatch', '--', ...targets])
      }
    } catch (error) {
      throw formatGitError(error)
    }
  }

  private async requirePublishableBranchContext(
    workspacePath: string,
    actionName: 'Push' | 'Sync'
  ): Promise<PublishableBranchContext> {
    const repoRoot = await this.requireRepoRoot(workspacePath)
    const currentStatus = await this.statusForRepo(repoRoot)
    const remotes = await this.requireRemotes(repoRoot)
    if (currentStatus.isUnborn) {
      throw new Error(`커밋된 내역이 없어 ${actionName}할 수 없습니다.`)
    }
    if (currentStatus.isDetached || !currentStatus.branch) {
      throw new Error(`Detached HEAD 상태에서는 ${actionName}할 수 없습니다.`)
    }
    return { repoRoot, currentStatus, branch: currentStatus.branch, remotes }
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

  private async requireRepoRoot(workspacePath: string): Promise<string> {
    const workspaceDir = await this.resolveExistingDirectory(workspacePath)
    try {
      const topLevel = (await this.execGit(workspaceDir, ['rev-parse', '--show-toplevel'])).trim()
      return await realpath(topLevel)
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
    repoRoot: string,
    paths: readonly string[]
  ): Promise<string[]> {
    if (!Array.isArray(paths) || paths.length === 0) {
      throw new Error('대상 파일 경로가 지정되지 않았습니다.')
    }

    const outsideMessage = '워크스페이스 저장소 밖의 경로에는 접근할 수 없습니다.'
    const validated: string[] = []
    for (const rawPath of paths) {
      if (typeof rawPath !== 'string' || rawPath.trim().length === 0 || rawPath.includes('\0')) {
        throw new Error('유효하지 않은 파일 경로입니다.')
      }

      const candidate = isAbsolute(rawPath) ? resolve(rawPath) : resolve(repoRoot, rawPath)
      if (!isPathInsideRoot(repoRoot, candidate) || candidate === repoRoot) {
        throw new Error(outsideMessage)
      }
      if (hasBlockedPathSegment(relative(repoRoot, candidate), GIT_METADATA_NAMES)) {
        throw new Error('시스템 .git 경로에는 접근할 수 없습니다.')
      }

      const { resolvedReal } = await resolveRealPathWithAncestor(candidate, {
        outsideMessage,
        assertResolved: (resolved) => {
          if (!isPathInsideRoot(repoRoot, resolved)) {
            throw new Error(outsideMessage)
          }
        }
      })
      if (hasBlockedPathSegment(relative(repoRoot, resolvedReal), GIT_METADATA_NAMES)) {
        throw new Error('시스템 .git 경로에는 접근할 수 없습니다.')
      }
      validated.push(relative(repoRoot, resolvedReal).replace(/\\/g, '/'))
    }
    return validated
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
