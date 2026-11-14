import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LogService } from '../logging/LogService'
import { formatGitError, GitService, parsePorcelainV2Z } from './GitService'

const execFileAsync = promisify(execFile)

describe('GitService integration (isolated temp repos)', () => {
  let tempRoot: string
  let repoDir: string
  let nonGitDir: string
  let gitConfigFile: string
  let service: GitService

  async function runGit(cwd: string, args: string[]): Promise<string> {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      windowsHide: true,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GCM_INTERACTIVE: 'never',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: gitConfigFile
      }
    })
    return stdout
  }

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'wiki-editor-git-'))
    repoDir = join(tempRoot, 'repo')
    nonGitDir = join(tempRoot, 'plain-folder')
    gitConfigFile = join(tempRoot, '.gitconfig')
    await mkdir(repoDir, { recursive: true })
    await mkdir(nonGitDir, { recursive: true })
    await writeFile(gitConfigFile, '[init]\n\tdefaultBranch = main\n', 'utf8')

    service = new GitService({
      env: {
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: gitConfigFile
      }
    })
  })

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  it('reports isRepo=false for non-git folders, blocks repo commands, and initializes via init()', async () => {
    const before = await service.status(nonGitDir)
    expect(before).toEqual({
      isRepo: false,
      repoRoot: null,
      branch: null,
      isDetached: false,
      isUnborn: false,
      ahead: 0,
      behind: 0,
      hasUpstream: false,
      hasConflicts: false,
      staged: [],
      unstaged: [],
      untracked: []
    })

    await expect(service.commit(nonGitDir, 'Initial')).rejects.toThrow(/Git 저장소가 아닙니다/)

    const initialized = await service.init(nonGitDir)
    expect(initialized.isRepo).toBe(true)
    expect(initialized.isUnborn).toBe(true)
    expect(initialized.branch).toBe('main')
    expect((await stat(join(nonGitDir, '.git'))).isDirectory()).toBe(true)
    // Verify test isolation: runGit inside nonGitDir works independently
    expect((await runGit(nonGitDir, ['rev-parse', '--is-inside-work-tree'])).trim()).toBe('true')
  })

  it('parses untracked, staged, unstaged, deleted, renamed, and non-ASCII/dash filenames and validates stage/unstage/commit', async () => {
    await service.init(repoDir)
    await runGit(repoDir, ['config', 'user.name', 'Wiki Tester'])
    await runGit(repoDir, ['config', 'user.email', 'tester@example.com'])

    await writeFile(join(repoDir, 'note 1.md'), '# Note 1\n', 'utf8')
    await writeFile(join(repoDir, '한글 문서.md'), '# 한글\n', 'utf8')
    await writeFile(join(repoDir, '-dash.md'), '# Dash\n', 'utf8')

    let st = await service.status(repoDir)
    expect(st.isUnborn).toBe(true)
    expect(st.untracked.map((f) => `${f.status}:${f.path}`).sort()).toEqual([
      '?:한글 문서.md',
      '?:-dash.md',
      '?:note 1.md'
    ].sort())

    // Stage specific files including spaces, Korean, and leading dash
    st = await service.stage(repoDir, ['note 1.md', '한글 문서.md', '-dash.md'])
    expect(st.staged.map((f) => `${f.status}:${f.path}`).sort()).toEqual([
      'A:-dash.md',
      'A:note 1.md',
      'A:한글 문서.md'
    ].sort())
    expect(st.untracked).toEqual([])

    // Unstage in unborn repo (no HEAD yet!) without deleting files on disk
    st = await service.unstage(repoDir, ['한글 문서.md'])
    expect(st.staged.map((f) => f.path).sort()).toEqual(['-dash.md', 'note 1.md'])
    expect(st.untracked.map((f) => f.path)).toEqual(['한글 문서.md'])

    st = await service.unstageAll(repoDir)
    expect(st.staged).toEqual([])
    expect(st.untracked).toHaveLength(3)

    // Stage all & reject empty commit & commit with dash-prefixed message
    await service.stageAll(repoDir)
    await expect(service.commit(repoDir, '   ')).rejects.toThrow(/커밋 메시지/)
    st = await service.commit(repoDir, '-initial commit')
    expect(st.isUnborn).toBe(false)
    expect(st.staged).toEqual([])
    expect(st.unstaged).toEqual([])
    expect(st.untracked).toEqual([])

    // Modify, stage, modify again (MM), delete file, rename file
    await writeFile(join(repoDir, 'note 1.md'), '# Note 1 v2\n', 'utf8')
    await rm(join(repoDir, '-dash.md'))
    st = await service.status(repoDir)
    expect(st.unstaged.map((f) => `${f.status}:${f.path}`).sort()).toEqual([
      'D:-dash.md',
      'M:note 1.md'
    ])

    st = await service.stage(repoDir, ['note 1.md', '-dash.md'])
    await writeFile(join(repoDir, 'note 1.md'), '# Note 1 v3\n', 'utf8')
    st = await service.status(repoDir)
    expect(st.staged.map((f) => `${f.status}:${f.path}`).sort()).toEqual([
      'D:-dash.md',
      'M:note 1.md'
    ])
    expect(st.unstaged).toEqual([{ path: 'note 1.md', status: 'M' }])

    // Unstage modified and deleted entries cleanly
    st = await service.unstage(repoDir, ['-dash.md', 'note 1.md'])
    expect(st.staged).toEqual([])
    expect(st.unstaged.map((f) => `${f.status}:${f.path}`).sort()).toEqual([
      'D:-dash.md',
      'M:note 1.md'
    ])

    // Stage and unstage a renamed pair (both path and origPath) and operate cleanly from a subdirectory workspace
    await service.stageAll(repoDir)
    await service.commit(repoDir, 'before subdocs check')

    const subDir = join(repoDir, 'subdocs')
    await mkdir(subDir, { recursive: true })
    await writeFile(join(subDir, 'sub.md'), '# Sub\n', 'utf8')
    await runGit(repoDir, ['mv', 'note 1.md', 'note-renamed.md'])
    await service.stage(subDir, ['subdocs/sub.md'])
    st = await service.status(subDir)
    expect(st.staged).toContainEqual({ path: 'note-renamed.md', origPath: 'note 1.md', status: 'R' })
    st = await service.unstage(subDir, ['note-renamed.md', 'note 1.md'])
    expect(st.staged.map((f) => f.path)).toEqual(['subdocs/sub.md'])
    st = await service.unstageAll(subDir)
    expect(st.staged).toEqual([])
    st = await service.stageAll(subDir)
    expect(st.staged.map((f) => f.path)).toContain('subdocs/sub.md')
    expect(st.staged.map((f) => f.path)).toContain('note-renamed.md')
    await service.unstageAll(subDir)

    // Path traversal & .git access & empty path arrays are blocked
    await expect(service.stage(repoDir, [])).rejects.toThrow()
    await expect(service.stage(repoDir, ['../outside.txt'])).rejects.toThrow(/경로|저장소/)
    await expect(service.stage(repoDir, [join(tempRoot, 'outside.txt')])).rejects.toThrow(/경로|저장소/)
    await expect(service.stage(repoDir, ['.git/config'])).rejects.toThrow(/경로|\.git|시스템/)
    await expect(service.unstage(repoDir, ['../outside.txt'])).rejects.toThrow(/경로|저장소/)
  }, 30_000)

  it('lists local branches, checks out branches safely, and rejects conflicting or invalid checkouts', async () => {
    await service.init(repoDir)
    await runGit(repoDir, ['config', 'user.name', 'Wiki Tester'])
    await runGit(repoDir, ['config', 'user.email', 'tester@example.com'])

    await writeFile(join(repoDir, 'shared.md'), '# Main\n', 'utf8')
    await service.stageAll(repoDir)
    await service.commit(repoDir, 'init main')

    await runGit(repoDir, ['checkout', '-b', 'feature/wiki'])
    await writeFile(join(repoDir, 'shared.md'), '# Feature\n', 'utf8')
    await writeFile(join(repoDir, 'feature.md'), '# Only Feature\n', 'utf8')
    await service.stageAll(repoDir)
    await service.commit(repoDir, 'feature commit')

    await runGit(repoDir, ['checkout', 'main'])
    const branchList = await service.branches(repoDir)
    expect(branchList.current).toBe('main')
    expect(branchList.isDetached).toBe(false)
    expect(branchList.branches.map((b) => b.name).sort()).toEqual(['feature/wiki', 'main'])

    // Checkout feature/wiki
    const switched = await service.checkout(repoDir, 'feature/wiki')
    expect(switched.branch).toBe('feature/wiki')
    expect((await service.branches(repoDir)).current).toBe('feature/wiki')

    // Reject option-like or nonexistent branch names
    await expect(service.checkout(repoDir, '-main')).rejects.toThrow(/브랜치/)
    await expect(service.checkout(repoDir, 'does-not-exist')).rejects.toThrow(/브랜치|오류/)

    // Uncommitted local change to shared.md conflicts with switching back to main
    await writeFile(join(repoDir, 'shared.md'), '# Uncommitted Dirty\n', 'utf8')
    await expect(service.checkout(repoDir, 'main')).rejects.toThrow(/로컬 변경 사항/)
  }, 20_000)

  it('supports bare remote push, pull, ahead/behind, one-click sync, rename detection, conflicts, and non-hanging remote errors', async () => {
    const bareRemote = join(tempRoot, 'remote.git')
    const cloneA = join(tempRoot, 'clone-a')
    const cloneB = join(tempRoot, 'clone-b')
    await mkdir(bareRemote, { recursive: true })
    await runGit(bareRemote, ['init', '--bare'])

    // Seed remote from cloneA
    await runGit(tempRoot, ['clone', bareRemote, cloneA])
    await runGit(cloneA, ['checkout', '-b', 'main'])
    await runGit(cloneA, ['config', 'user.name', 'Alice'])
    await runGit(cloneA, ['config', 'user.email', 'alice@example.com'])
    await writeFile(join(cloneA, 'shared.md'), 'line 1\n', 'utf8')
    await writeFile(join(cloneA, 'old-name.md'), '# Renamed target\n', 'utf8')
    await service.stageAll(cloneA)
    await service.commit(cloneA, 'seed')
    await service.push(cloneA) // auto sets -u origin main

    // Ensure bare HEAD points to main for cloneB
    await runGit(bareRemote, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
    await runGit(tempRoot, ['clone', bareRemote, cloneB])
    await runGit(cloneB, ['config', 'user.name', 'Bob'])
    await runGit(cloneB, ['config', 'user.email', 'bob@example.com'])

    // Test rename status parsing in cloneA
    await runGit(cloneA, ['mv', 'old-name.md', 'new-name.md'])
    const renameStatus = await service.status(cloneA)
    expect(renameStatus.staged).toEqual([
      { path: 'new-name.md', origPath: 'old-name.md', status: 'R' }
    ])
    await service.commit(cloneA, 'rename file')
    let statusA = await service.status(cloneA)
    expect(statusA.hasUpstream).toBe(true)
    expect(statusA.ahead).toBe(1)
    expect(statusA.behind).toBe(0)

    statusA = await service.push(cloneA)
    expect(statusA.ahead).toBe(0)

    // cloneB fetches -> behind 1, then pulls
    await runGit(cloneB, ['fetch'])
    let statusB = await service.status(cloneB)
    expect(statusB.behind).toBe(1)
    statusB = await service.pull(cloneB)
    expect(statusB.behind).toBe(0)

    // Non-conflicting concurrent commits -> cloneA pushes a.md, cloneB syncs (pull -> push) with b.md
    await writeFile(join(cloneA, 'a.md'), '# A\n', 'utf8')
    await service.stageAll(cloneA)
    await service.commit(cloneA, 'add a')
    await service.push(cloneA)

    await writeFile(join(cloneB, 'b.md'), '# B\n', 'utf8')
    await service.stageAll(cloneB)
    await service.commit(cloneB, 'add b')
    const syncResult = await service.sync(cloneB)
    expect(syncResult.pulled).toBe(true)
    expect(syncResult.pushed).toBe(true)
    expect(syncResult.status.ahead).toBe(0)
    expect(syncResult.status.behind).toBe(0)

    // Conflicting edits on shared.md -> cloneA tries push (rejected non-fast-forward before pull), pulls, pushes; cloneB pulls -> conflict
    await writeFile(join(cloneA, 'shared.md'), 'from alice\n', 'utf8')
    await service.stageAll(cloneA)
    await service.commit(cloneA, 'alice conflict')
    await expect(service.push(cloneA)).rejects.toThrow(/Push가 거부/)
    await service.pull(cloneA)
    await service.push(cloneA)

    await writeFile(join(cloneB, 'shared.md'), 'from bob\n', 'utf8')
    await service.stageAll(cloneB)
    await service.commit(cloneB, 'bob conflict')
    await expect(service.pull(cloneB)).rejects.toThrow(/충돌|conflict/i)

    const conflictStatus = await service.status(cloneB)
    expect(conflictStatus.hasConflicts).toBe(true)
    expect(conflictStatus.unstaged).toContainEqual({ path: 'shared.md', status: 'U' })

    // Repo without remote fails cleanly
    await service.init(repoDir)
    await runGit(repoDir, ['config', 'user.name', 'Local User'])
    await runGit(repoDir, ['config', 'user.email', 'local@example.com'])
    await writeFile(join(repoDir, 'local.md'), '# Local\n', 'utf8')
    await service.stageAll(repoDir)
    await service.commit(repoDir, 'local only')
    await expect(service.pull(repoDir)).rejects.toThrow(/원격 저장소/)
    await expect(service.push(repoDir)).rejects.toThrow(/원격 저장소/)
    await expect(service.sync(repoDir)).rejects.toThrow(/원격 저장소/)

    // Unreachable/missing remote fails cleanly without hanging
    await runGit(repoDir, ['remote', 'add', 'origin', join(tempRoot, 'missing-remote.git')])
    await expect(service.push(repoDir)).rejects.toThrow(/원격|오류/)
    await expect(service.pull(repoDir)).rejects.toThrow(/원격|upstream|오류/)
  }, 60_000)

  it('logs raw Git CLI stderr, stdout, and exit code at error level before formatting user messages, without logging benign non-repo probes', async () => {
    const logService = new LogService(join(tempRoot, 'logs'))
    const loggedService = new GitService({
      logService,
      env: {
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: gitConfigFile
      }
    })

    // Benign status check on a non-git folder should not log errors
    const nonRepoStatus = await loggedService.status(nonGitDir)
    expect(nonRepoStatus.isRepo).toBe(false)
    expect(await logService.readEntries()).toHaveLength(0)

    // Initialize repo and commit an initial file
    await loggedService.init(repoDir)
    await runGit(repoDir, ['config', 'user.name', 'Wiki Tester'])
    await runGit(repoDir, ['config', 'user.email', 'tester@example.com'])
    await writeFile(join(repoDir, 'doc.md'), '# Doc\n', 'utf8')
    await loggedService.stageAll(repoDir)
    await loggedService.commit(repoDir, 'init')

    // 1. Failing checkout produces raw stderr + exit code
    await expect(loggedService.checkout(repoDir, 'nonexistent-branch')).rejects.toThrow(/브랜치|오류/)

    // 2. Failing commit with nothing staged produces raw stdout + exit code
    await expect(loggedService.commit(repoDir, 'empty commit')).rejects.toThrow(/커밋할/)

    const entries = await logService.readEntries()
    expect(entries).toHaveLength(2)

    expect(entries[0]).toMatchObject({
      level: 'error',
      process: 'main',
      category: 'git',
      data: {
        operation: 'checkout',
        code: 128
      }
    })
    expect(entries[0].error?.code).toBe(128)
    expect(entries[0].error?.stderr).toMatch(/invalid reference|pathspec|did not match/i)

    expect(entries[1]).toMatchObject({
      level: 'error',
      process: 'main',
      category: 'git',
      data: {
        operation: 'commit',
        code: 1
      }
    })
    expect(entries[1].error?.code).toBe(1)
    expect(entries[1].error?.stdout).toMatch(/nothing to commit/i)
  }, 30_000)
})

describe('GitService helpers (unit)', () => {
  it('parses detached HEAD, branch ahead/behind, unmerged entries, and ignored entries', () => {
    const raw = [
      '# branch.oid abcdef1234',
      '# branch.head (detached)',
      '# branch.upstream origin/main',
      '# branch.ab +2 -1',
      'u UU N... 100644 100644 100644 100644 h1 h2 h3 conflict.md',
      '! ignored.tmp',
      ''
    ].join('\0')

    const parsed = parsePorcelainV2Z(raw, 'C:\\temp\\wiki')
    expect(parsed.isDetached).toBe(true)
    expect(parsed.branch).toBeNull()
    expect(parsed.hasUpstream).toBe(true)
    expect(parsed.ahead).toBe(2)
    expect(parsed.behind).toBe(1)
    expect(parsed.hasConflicts).toBe(true)
    expect(parsed.staged).toEqual([])
    expect(parsed.unstaged).toContainEqual({ path: 'conflict.md', status: 'U' })
    expect(parsed.untracked).toEqual([])
  })

  it('maps ENOENT, timeouts, authentication failures, conflicts, and network failures cleanly', () => {
    expect(formatGitError(Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' })).message).toMatch(
      /Git CLI/
    )
    expect(formatGitError(Object.assign(new Error('killed'), { killed: true })).message).toMatch(/시간이 초과/)
    expect(
      formatGitError(Object.assign(new Error('fail'), { stderr: 'fatal: Authentication failed for https://...' })).message
    ).toMatch(/인증/)
    expect(
      formatGitError(Object.assign(new Error('fail'), { stderr: 'Could not read Username for https://...' })).message
    ).toMatch(/인증/)
    expect(
      formatGitError(Object.assign(new Error('fail'), { stderr: 'CONFLICT (content): Merge conflict in doc.md' })).message
    ).toMatch(/충돌/)
  })
})
