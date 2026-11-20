import { execFile } from 'node:child_process'
import { lstat, realpath, rm, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import {
  createEmptyGitStatus,
  DEFAULT_GIT_LOG_LIMIT,
  type GitBranchInfo,
  type GitBranchList,
  type GitCommitDetail,
  type GitDiffRequest,
  type GitFileDiff,
  type GitLogOptions,
  type GitLogResult,
  type GitStashCreateOptions,
  type GitStashDetail,
  type GitStashEntry,
  type GitStatus,
  type GitSyncResult
} from '@shared/git'
import {
  hasBlockedPathSegment,
  isErrnoCode,
  isMissingPathError,
  isPathInsideRoot,
  resolveRealPathWithAncestor
} from '../fs/pathSecurity'
import type { LogService } from '../logging/LogService'
import {
  type ExecGitError,
  extractGitErrorDetail,
  formatGitError,
  GitFormattedError
} from './gitErrors'
import {
  assertValidCommitHash,
  GIT_COMMIT_DETAIL_FORMAT,
  parseCommitDetailOutput,
  parseGitNameStatusZ
} from './gitCommitDetail'
import { assertValidDiffTarget, computeGitDiff } from './gitDiff'
import { parseForEachRefOutput, parseGitLogOutput } from './gitLog'
import { parsePorcelainV2Z } from './gitPorcelain'
import {
  assertValidStashRef,
  buildStashPushArgs,
  GIT_STASH_LIST_FORMAT,
  hasAllScopeStashTargets,
  hasMatchingPathStashTargets,
  parseStashListOutput,
  parseStashUntrackedTreeOutput,
  resolveUnstagedStashTargets
} from './gitStash'

export { formatGitError, parsePorcelainV2Z }

const execFileAsync = promisify(execFile)

const DEFAULT_LOCAL_TIMEOUT_MS = 30_000
const DEFAULT_MAX_BUFFER_BYTES = 10 * 1024 * 1024
const GIT_METADATA_NAMES: ReadonlySet<string> = new Set(['.git'])
const OUTSIDE_REPO_PATH_MESSAGE = '워크스페이스 저장소 밖의 경로에는 접근할 수 없습니다.'

export interface GitServiceOptions {
  env?: NodeJS.ProcessEnv
  localTimeoutMs?: number
  networkTimeoutMs?: number
  logService?: LogService
  trashItem?: (targetPath: string) => Promise<void>
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
  private readonly logService?: LogService
  private readonly trashItem?: (targetPath: string) => Promise<void>
  private readonly failedExecMeta = new WeakMap<object, { cwd: string; args: readonly string[] }>()

  constructor(options: GitServiceOptions = {}) {
    this.env = options.env
    this.localTimeoutMs = options.localTimeoutMs ?? DEFAULT_LOCAL_TIMEOUT_MS
    this.networkTimeoutMs = options.networkTimeoutMs ?? DEFAULT_LOCAL_TIMEOUT_MS * 2
    this.logService = options.logService
    this.trashItem = options.trashItem
  }

  async status(workspacePath: string): Promise<GitStatus> {
    const repoRoot = await this.findRepoRoot(workspacePath)
    if (!repoRoot) {
      return createEmptyGitStatus(false, null)
    }
    return this.statusForRepo(repoRoot)
  }

  async init(workspacePath: string): Promise<GitStatus> {
    const resolvedDir = await this.resolveExistingDirectory(workspacePath)
    try {
      await this.execGit(resolvedDir, ['init'])
    } catch (error) {
      throw await this.formatAndLogGitError('init', error)
    }
    return this.status(resolvedDir)
  }

  async stage(workspacePath: string, paths: readonly string[]): Promise<GitStatus> {
    const repoRoot = await this.requireRepoRoot(workspacePath)
    const validatedPaths = await this.validateRepoRelativePaths(repoRoot, paths)
    try {
      await this.execGit(repoRoot, ['add', '-A', '--', ...validatedPaths])
    } catch (error) {
      throw await this.formatAndLogGitError('stage', error)
    }
    return this.statusForRepo(repoRoot)
  }

  async stageAll(workspacePath: string): Promise<GitStatus> {
    const repoRoot = await this.requireRepoRoot(workspacePath)
    try {
      await this.execGit(repoRoot, ['add', '-A', '--', '.'])
    } catch (error) {
      throw await this.formatAndLogGitError('stageAll', error)
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

  async discard(workspacePath: string, paths: readonly string[]): Promise<GitStatus> {
    const repoRoot = await this.requireRepoRoot(workspacePath)
    const validatedPaths = await this.validateRepoRelativePaths(repoRoot, paths, {
      followLeafSymlink: false
    })
    const currentStatus = await this.statusForRepo(repoRoot)
    const targets = this.classifyDiscardTargets(currentStatus, validatedPaths)

    await this.executeDiscardTargets(repoRoot, 'discard', targets)
    return this.statusForRepo(repoRoot)
  }

  async discardAll(workspacePath: string): Promise<GitStatus> {
    const repoRoot = await this.requireRepoRoot(workspacePath)
    const currentStatus = await this.statusForRepo(repoRoot)
    const targets = this.classifyDiscardTargets(currentStatus)

    if (
      targets.trackedRestorePaths.length === 0 &&
      targets.conflictPaths.length === 0 &&
      targets.untrackedPaths.length === 0
    ) {
      return currentStatus
    }

    await this.executeDiscardTargets(repoRoot, 'discardAll', targets)
    return this.statusForRepo(repoRoot)
  }

  private classifyDiscardTargets(
    currentStatus: GitStatus,
    targetPaths?: readonly string[]
  ): {
    trackedRestorePaths: string[]
    conflictPaths: string[]
    untrackedPaths: string[]
  } {
    const targetSet = targetPaths ? new Set(targetPaths) : null
    const trackedRestorePaths: string[] = []
    const conflictPaths: string[] = []
    for (const item of currentStatus.unstaged) {
      if (targetSet && !targetSet.has(item.path)) continue
      if (item.status === 'M' || item.status === 'D') {
        trackedRestorePaths.push(item.path)
      } else if (item.status === 'U') {
        conflictPaths.push(item.path)
      }
    }
    const untrackedPaths = currentStatus.untracked
      .filter((item) => !targetSet || targetSet.has(item.path))
      .map((item) => item.path)
    return { trackedRestorePaths, conflictPaths, untrackedPaths }
  }

  private async executeDiscardTargets(
    repoRoot: string,
    operation: 'discard' | 'discardAll',
    targets: {
      trackedRestorePaths: readonly string[]
      conflictPaths: readonly string[]
      untrackedPaths: readonly string[]
    }
  ): Promise<void> {
    try {
      if (targets.trackedRestorePaths.length > 0) {
        await this.execGit(repoRoot, ['checkout', '-f', '--', ...targets.trackedRestorePaths])
      }
      if (targets.conflictPaths.length > 0) {
        await this.discardConflictPaths(repoRoot, targets.conflictPaths)
      }
    } catch (error) {
      throw await this.formatAndLogGitError(operation, error)
    }

    for (const relPath of targets.untrackedPaths) {
      await this.discardUntrackedPath(repoRoot, relPath)
    }
  }

  private async discardUntrackedPath(repoRoot: string, relPath: string): Promise<void> {
    const segments = relPath.split('/').filter(Boolean)
    const targetPath = resolve(repoRoot, ...segments)
    this.assertRepoCandidatePath(repoRoot, targetPath)
    try {
      await lstat(targetPath)
    } catch (error) {
      if (isMissingPathError(error)) {
        return
      }
      throw error
    }

    if (this.trashItem) {
      try {
        await this.trashItem(targetPath)
      } catch (error) {
        if (isMissingPathError(error)) {
          return
        }
        await this.logService?.error('git', 'Git discard trashItem failed', {
          data: { targetPath },
          error
        })
        throw error
      }
      return
    }

    await rm(targetPath, { recursive: true, force: true })
  }

  private async discardConflictPaths(
    repoRoot: string,
    conflictPaths: readonly string[]
  ): Promise<void> {
    const hasHead = await this.hasHeadCommit(repoRoot)
    const headPathSet = new Set<string>()
    if (hasHead) {
      const lsRaw = await this.execGit(repoRoot, [
        '-c',
        'core.quotePath=false',
        'ls-tree',
        '-r',
        '-z',
        '--name-only',
        'HEAD',
        '--',
        ...conflictPaths
      ])
      for (const entry of lsRaw.split('\0')) {
        if (entry) {
          headPathSet.add(entry)
        }
      }
    }

    const restoreFromHead: string[] = []
    const removeFromIndexAndTree: string[] = []
    for (const relPath of conflictPaths) {
      if (headPathSet.has(relPath)) {
        restoreFromHead.push(relPath)
      } else {
        removeFromIndexAndTree.push(relPath)
      }
    }

    if (restoreFromHead.length > 0) {
      await this.execGit(repoRoot, ['checkout', '-f', 'HEAD', '--', ...restoreFromHead])
    }
    if (removeFromIndexAndTree.length > 0) {
      await this.execGit(repoRoot, ['rm', '-f', '--ignore-unmatch', '--', ...removeFromIndexAndTree])
    }
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
      throw await this.formatAndLogGitError('commit', error)
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
      throw await this.formatAndLogGitError('branches', error)
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
      throw await this.formatAndLogGitError('checkout', error)
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
      throw await this.formatAndLogGitError('pull', error)
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
      throw await this.formatAndLogGitError('push', error)
    }
    return this.statusForRepo(repoRoot)
  }

  /** Updates remote-tracking refs via `git fetch` without modifying the working tree or index. */
  async fetch(workspacePath: string): Promise<GitStatus> {
    const repoRoot = await this.requireRepoRoot(workspacePath)
    await this.requireRemotes(repoRoot)
    try {
      await this.execGit(repoRoot, ['fetch'], this.networkTimeoutMs)
    } catch (error) {
      throw await this.formatAndLogGitError('fetch', error)
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
      throw await this.formatAndLogGitError('sync', error)
    }

    const status = await this.statusForRepo(repoRoot)
    return {
      status,
      pulled,
      pushed: true,
      summary: pulled ? 'Pull 및 Push 동기화 완료' : '원격 브랜치 게시(Push) 완료'
    }
  }

  async log(workspacePath: string, options: GitLogOptions = {}): Promise<GitLogResult> {
    const scope = options.scope ?? 'all'
    if (scope !== 'all' && scope !== 'current') {
      throw new Error('유효한 Git 로그 조회 범위가 아닙니다.')
    }
    const limit = options.limit ?? DEFAULT_GIT_LOG_LIMIT
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1) {
      throw new Error('유효한 커밋 조회 개수(limit)가 아닙니다.')
    }
    const skip = options.skip ?? 0
    if (typeof skip !== 'number' || !Number.isInteger(skip) || skip < 0) {
      throw new Error('유효한 커밋 건너뛰기(skip) 값이 아닙니다.')
    }

    const repoRoot = await this.requireRepoRoot(workspacePath)
    const headHash = await this.resolveRevisionHash(repoRoot, 'HEAD')
    if (scope === 'current' && !headHash) {
      return { commits: [], hasMore: false }
    }

    try {
      const [headRefName, forEachRefRaw] = await Promise.all([
        headHash ? this.resolveSymbolicHeadRef(repoRoot) : Promise.resolve(null),
        this.execGit(repoRoot, [
          'for-each-ref',
          '--format=%(objectname)%09%(*objectname)%09%(refname)%09%(refname:short)%09%(symref)',
          'refs/heads',
          'refs/remotes',
          'refs/tags'
        ])
      ])

      const refsByHash = parseForEachRefOutput(forEachRefRaw, headRefName)
      if (scope === 'all' && !headHash && refsByHash.size === 0) {
        return { commits: [], hasMore: false }
      }

      const revArgs =
        scope === 'current'
          ? (await this.resolveRevisionHash(repoRoot, '@{upstream}')) !== null
            ? ['HEAD', '@{upstream}']
            : ['HEAD']
          : [
              ...(headHash ? ['HEAD'] : []),
              '--branches',
              '--exclude=refs/remotes/*/HEAD',
              '--remotes',
              '--tags'
            ]

      const raw = await this.execGit(repoRoot, [
        'log',
        '--topo-order',
        '-z',
        `--max-count=${limit + 1}`,
        `--skip=${skip}`,
        '--format=%H%x1f%h%x1f%P%x1f%s%x1f%an%x1f%cI',
        ...revArgs
      ])

      const parsed = parseGitLogOutput(raw, refsByHash, headHash)
      const hasMore = parsed.length > limit
      return {
        commits: hasMore ? parsed.slice(0, limit) : parsed,
        hasMore
      }
    } catch (error) {
      throw await this.formatAndLogGitError('log', error)
    }
  }

  async commitDetail(workspacePath: string, commitHash: string): Promise<GitCommitDetail> {
    const validatedHash = assertValidCommitHash(commitHash)
    const repoRoot = await this.requireRepoRoot(workspacePath)
    try {
      const raw = await this.execGit(repoRoot, [
        '-c',
        'core.quotePath=false',
        'show',
        '--first-parent',
        '-m',
        '--root',
        '-M',
        '--name-status',
        '-z',
        GIT_COMMIT_DETAIL_FORMAT,
        `${validatedHash}^{commit}`
      ])
      return parseCommitDetailOutput(raw)
    } catch (error) {
      throw await this.formatAndLogGitError('commitDetail', error)
    }
  }

  async diff(workspacePath: string, request: GitDiffRequest): Promise<GitFileDiff> {
    if (
      !request ||
      (request.kind !== 'staged' &&
        request.kind !== 'unstaged' &&
        request.kind !== 'commit' &&
        request.kind !== 'stash')
    ) {
      throw new Error('유효하지 않은 Diff 요청 형식입니다.')
    }

    const repoRoot = await this.requireRepoRoot(workspacePath)
    assertValidDiffTarget(request)
    const workspaceRealRoot = await realpath(resolve(workspacePath))
    const rawPaths = request.origPath ? [request.path, request.origPath] : [request.path]
    const [safePath, safeOrigPath] = await this.validateRepoRelativePaths(repoRoot, rawPaths)

    try {
      const hasHeadCommit = request.kind === 'staged' ? await this.hasHeadCommit(repoRoot) : true
      return await computeGitDiff({
        repoRoot,
        workspaceRealRoot,
        request,
        safePath,
        safeOrigPath,
        hasHeadCommit,
        execOptions: {
          env: this.createGitChildEnv(),
          timeoutMs: this.localTimeoutMs,
          onFailureMeta: this.recordFailedExecMeta
        }
      })
    } catch (error) {
      throw await this.formatAndLogGitError('diff', error)
    }
  }

  async stashList(workspacePath: string): Promise<GitStashEntry[]> {
    const repoRoot = await this.requireRepoRoot(workspacePath)
    return this.listStashesForRepo(repoRoot)
  }

  async stashDetail(workspacePath: string, stashRef: string): Promise<GitStashDetail> {
    const validatedRef = assertValidStashRef(stashRef)
    const repoRoot = await this.requireRepoRoot(workspacePath)
    const entries = await this.listStashesForRepo(repoRoot)
    const entry = entries.find((item) => item.ref === validatedRef)
    if (!entry) {
      throw new GitFormattedError('지정한 Stash 항목을 찾을 수 없습니다.')
    }

    try {
      const [trackedRaw, untrackedParentHash] = await Promise.all([
        this.execGit(repoRoot, [
          '-c',
          'core.quotePath=false',
          'diff',
          '--name-status',
          '-z',
          '-M',
          `${entry.hash}^1`,
          entry.hash
        ]),
        this.resolveRevisionHash(repoRoot, `${entry.hash}^3`)
      ])
      const trackedFiles = parseGitNameStatusZ(trackedRaw)
      const untrackedRaw = untrackedParentHash
        ? await this.execGit(repoRoot, [
            '-c',
            'core.quotePath=false',
            'ls-tree',
            '-r',
            '-z',
            '--name-only',
            `${entry.hash}^3`
          ])
        : ''
      return {
        ...entry,
        files: [...trackedFiles, ...parseStashUntrackedTreeOutput(untrackedRaw)]
      }
    } catch (error) {
      throw await this.formatAndLogGitError('stashDetail', error)
    }
  }

  private async listStashesForRepo(repoRoot: string): Promise<GitStashEntry[]> {
    if (!(await this.hasHeadCommit(repoRoot))) {
      return []
    }
    try {
      const raw = await this.execGit(repoRoot, ['stash', 'list', GIT_STASH_LIST_FORMAT])
      return parseStashListOutput(raw)
    } catch (error) {
      throw await this.formatAndLogGitError('stashList', error)
    }
  }

  async stashCreate(workspacePath: string, options: GitStashCreateOptions): Promise<GitStatus> {
    if (
      !options ||
      (options.scope !== 'unstaged' && options.scope !== 'all' && options.scope !== 'paths')
    ) {
      throw new Error('유효한 Stash 범위가 아닙니다.')
    }
    const includeUntracked = options.includeUntracked ?? true
    const message = typeof options.message === 'string' ? options.message.trim() : ''
    const repoRoot = await this.requireRepoRoot(workspacePath)
    const currentStatus = await this.statusForRepo(repoRoot)
    if (currentStatus.isUnborn) {
      throw new Error('아직 커밋된 내역이 없어 Stash를 생성할 수 없습니다.')
    }

    const args = await this.buildValidatedStashCreateArgs(
      repoRoot,
      currentStatus,
      options.scope,
      includeUntracked,
      message,
      options.paths
    )
    try {
      await this.execGit(repoRoot, args)
    } catch (error) {
      throw await this.formatAndLogGitError('stashCreate', error)
    }
    return this.statusForRepo(repoRoot)
  }

  private async buildValidatedStashCreateArgs(
    repoRoot: string,
    currentStatus: GitStatus,
    scope: GitStashCreateOptions['scope'],
    includeUntracked: boolean,
    message: string,
    paths?: readonly string[]
  ): Promise<string[]> {
    const emptyErrorMessage = 'Stash로 보관할 변경 사항이 없습니다.'

    if (scope === 'unstaged') {
      const { targetPaths, overlapsStaged } = resolveUnstagedStashTargets(
        currentStatus,
        includeUntracked
      )
      if (targetPaths.length === 0) {
        throw new Error(emptyErrorMessage)
      }
      return overlapsStaged
        ? buildStashPushArgs({ includeUntracked, keepIndex: true, message })
        : buildStashPushArgs({ includeUntracked, message, pathspecs: targetPaths })
    }

    if (scope === 'all') {
      if (!hasAllScopeStashTargets(currentStatus, includeUntracked)) {
        throw new Error(emptyErrorMessage)
      }
      return buildStashPushArgs({ includeUntracked, message })
    }

    const validatedPaths = await this.validateRepoRelativePaths(repoRoot, paths ?? [])
    if (!hasMatchingPathStashTargets(currentStatus, validatedPaths, includeUntracked)) {
      throw new Error(emptyErrorMessage)
    }
    return buildStashPushArgs({ includeUntracked, message, pathspecs: validatedPaths })
  }

  async stashApply(workspacePath: string, stashRef: string): Promise<GitStatus> {
    return this.execStashRestore(workspacePath, stashRef, 'apply')
  }

  async stashPop(workspacePath: string, stashRef: string): Promise<GitStatus> {
    return this.execStashRestore(workspacePath, stashRef, 'pop')
  }

  async stashDrop(workspacePath: string, stashRef: string): Promise<GitStashEntry[]> {
    return this.execStashListMutation(workspacePath, 'stashDrop', [
      'stash',
      'drop',
      assertValidStashRef(stashRef)
    ])
  }

  async stashClear(workspacePath: string): Promise<GitStashEntry[]> {
    return this.execStashListMutation(workspacePath, 'stashClear', ['stash', 'clear'])
  }

  private async execStashListMutation(
    workspacePath: string,
    operation: 'stashDrop' | 'stashClear',
    args: readonly string[]
  ): Promise<GitStashEntry[]> {
    const repoRoot = await this.requireRepoRoot(workspacePath)
    try {
      await this.execGit(repoRoot, args)
    } catch (error) {
      throw await this.formatAndLogGitError(operation, error)
    }
    return this.listStashesForRepo(repoRoot)
  }

  private async execStashRestore(
    workspacePath: string,
    stashRef: string,
    mode: 'apply' | 'pop'
  ): Promise<GitStatus> {
    const validatedRef = assertValidStashRef(stashRef)
    const repoRoot = await this.requireRepoRoot(workspacePath)
    try {
      await this.execGit(repoRoot, ['stash', mode, validatedRef])
    } catch (error) {
      throw await this.formatAndLogGitError(mode === 'apply' ? 'stashApply' : 'stashPop', error)
    }
    return this.statusForRepo(repoRoot)
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
      throw await this.formatAndLogGitError('unstage', error)
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
        '-c',
        'core.quotePath=false',
        'status',
        '--porcelain=v2',
        '--branch',
        '-z',
        '--untracked-files=all'
      ])
      return parsePorcelainV2Z(raw, repoRoot)
    } catch (error) {
      throw await this.formatAndLogGitError('status', error)
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

  private async findRepoRoot(workspacePath: string): Promise<string | null> {
    const workspaceDir = await this.resolveExistingDirectory(workspacePath)
    try {
      const topLevel = (await this.execGit(workspaceDir, ['rev-parse', '--show-toplevel'])).trim()
      return await realpath(topLevel)
    } catch (error) {
      const detail = extractGitErrorDetail(error).toLowerCase()
      if (detail.includes('not a git repository')) {
        return null
      }
      throw await this.formatAndLogGitError('findRepoRoot', error)
    }
  }

  private async requireRepoRoot(workspacePath: string): Promise<string> {
    const repoRoot = await this.findRepoRoot(workspacePath)
    if (!repoRoot) {
      throw new GitFormattedError('현재 워크스페이스는 Git 저장소가 아닙니다.')
    }
    return repoRoot
  }

  private async hasHeadCommit(repoRoot: string): Promise<boolean> {
    return (await this.resolveRevisionHash(repoRoot, 'HEAD')) !== null
  }

  private async resolveRevisionHash(repoRoot: string, rev: string): Promise<string | null> {
    try {
      const hash = (await this.execGit(repoRoot, ['rev-parse', '--verify', '--quiet', rev])).trim()
      return hash || null
    } catch {
      return null
    }
  }

  private async resolveSymbolicHeadRef(repoRoot: string): Promise<string | null> {
    try {
      const refName = (
        await this.execGit(repoRoot, ['symbolic-ref', '--quiet', 'HEAD'])
      ).trim()
      return refName || null
    } catch {
      return null
    }
  }

  private assertRepoCandidatePath(repoRoot: string, candidatePath: string): void {
    if (!isPathInsideRoot(repoRoot, candidatePath) || candidatePath === repoRoot) {
      throw new Error(OUTSIDE_REPO_PATH_MESSAGE)
    }
    if (hasBlockedPathSegment(relative(repoRoot, candidatePath), GIT_METADATA_NAMES)) {
      throw new Error('시스템 .git 경로에는 접근할 수 없습니다.')
    }
  }

  private async validateRepoRelativePaths(
    repoRoot: string,
    paths: readonly string[],
    options: { followLeafSymlink?: boolean } = {}
  ): Promise<string[]> {
    if (!Array.isArray(paths) || paths.length === 0) {
      throw new Error('대상 파일 경로가 지정되지 않았습니다.')
    }

    const followLeafSymlink = options.followLeafSymlink ?? true
    const validated: string[] = []
    for (const rawPath of paths) {
      if (typeof rawPath !== 'string' || rawPath.trim().length === 0 || rawPath.includes('\0')) {
        throw new Error('유효하지 않은 파일 경로입니다.')
      }

      const candidate = isAbsolute(rawPath) ? resolve(rawPath) : resolve(repoRoot, rawPath)
      this.assertRepoCandidatePath(repoRoot, candidate)

      const assertResolvedInsideRepo = (resolved: string): void => {
        if (!isPathInsideRoot(repoRoot, resolved)) {
          throw new Error(OUTSIDE_REPO_PATH_MESSAGE)
        }
      }
      const targetToResolve = followLeafSymlink ? candidate : dirname(candidate)
      const { resolvedReal: resolvedTarget } = await resolveRealPathWithAncestor(targetToResolve, {
        outsideMessage: OUTSIDE_REPO_PATH_MESSAGE,
        assertResolved: assertResolvedInsideRepo
      })
      const resolvedReal = followLeafSymlink
        ? resolvedTarget
        : join(resolvedTarget, basename(candidate))
      if (!followLeafSymlink) {
        assertResolvedInsideRepo(resolvedReal)
      }
      if (hasBlockedPathSegment(relative(repoRoot, resolvedReal), GIT_METADATA_NAMES)) {
        throw new Error('시스템 .git 경로에는 접근할 수 없습니다.')
      }
      validated.push(relative(repoRoot, resolvedReal).replace(/\\/g, '/'))
    }
    return validated
  }

  private async formatAndLogGitError(operation: string, error: unknown): Promise<GitFormattedError> {
    if (!(error instanceof GitFormattedError)) {
      const execErr = error as ExecGitError | undefined
      const meta =
        typeof error === 'object' && error !== null ? this.failedExecMeta.get(error) : undefined
      await this.logService?.error('git', `Git ${operation} failed`, {
        data: {
          operation,
          ...(meta ? { cwd: meta.cwd, args: meta.args } : {}),
          ...(execErr?.code !== undefined ? { code: execErr.code } : {}),
          ...(execErr?.signal ? { signal: execErr.signal } : {}),
          ...(execErr?.killed !== undefined ? { killed: execErr.killed } : {})
        },
        error
      })
    }
    return formatGitError(error)
  }

  private createGitChildEnv(): NodeJS.ProcessEnv {
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ...this.env,
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'never',
      GIT_MERGE_AUTOEDIT: 'no',
      LC_MESSAGES: 'C',
      LANGUAGE: 'C'
    }
    delete childEnv.LC_ALL
    return childEnv
  }

  private recordFailedExecMeta = (error: unknown, cwd: string, args: string[]): void => {
    if (typeof error === 'object' && error !== null) {
      this.failedExecMeta.set(error, { cwd, args })
    }
  }

  private async execGit(
    cwd: string,
    args: readonly string[],
    timeoutMs = this.localTimeoutMs
  ): Promise<string> {
    const childEnv = this.createGitChildEnv()

    try {
      const { stdout } = await execFileAsync('git', [...args], {
        cwd,
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: DEFAULT_MAX_BUFFER_BYTES,
        timeout: timeoutMs,
        env: childEnv
      })
      return stdout
    } catch (error) {
      this.recordFailedExecMeta(error, cwd, [...args])
      throw error
    }
  }
}
