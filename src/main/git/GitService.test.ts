import { execFile, spawn } from 'node:child_process'
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

  it('returns empty commits for unborn repo, rejects non-git folders, and paginates linear history with refs and ISO timestamps', async () => {
    await expect(service.log(nonGitDir)).rejects.toThrow(/Git 저장소가 아닙니다/)

    await service.init(repoDir)
    await runGit(repoDir, ['config', 'user.name', 'Wiki Tester'])
    await runGit(repoDir, ['config', 'user.email', 'tester@example.com'])

    expect(await service.log(repoDir)).toEqual({ commits: [], hasMore: false })
    expect(await service.log(repoDir, { scope: 'current' })).toEqual({ commits: [], hasMore: false })

    await writeFile(join(repoDir, 'a.md'), '# A\n', 'utf8')
    await service.stageAll(repoDir)
    await service.commit(repoDir, 'initial commit')

    await writeFile(join(repoDir, 'b.md'), '# B\n', 'utf8')
    await service.stageAll(repoDir)
    await service.commit(repoDir, '한글 제목: second commit')

    await writeFile(join(repoDir, 'c.md'), '# C\n', 'utf8')
    await service.stageAll(repoDir)
    await service.commit(repoDir, 'third commit')

    const page1 = await service.log(repoDir, { limit: 2, skip: 0 })
    expect(page1.hasMore).toBe(true)
    expect(page1.commits).toHaveLength(2)

    const [c3, c2] = page1.commits
    expect(c3.subject).toBe('third commit')
    expect(c3.authorName).toBe('Wiki Tester')
    expect(c3.hash).toMatch(/^[0-9a-f]{40}$/)
    expect(c3.shortHash).toBe(c3.hash.slice(0, c3.shortHash.length))
    expect(c3.parents).toEqual([c2.hash])
    expect(Number.isNaN(Date.parse(c3.committedAt))).toBe(false)
    expect(c3.refs).toEqual([
      { name: 'HEAD', kind: 'head', isCurrentHead: true },
      { name: 'main', kind: 'local-branch', isCurrentHead: true }
    ])

    expect(c2.subject).toBe('한글 제목: second commit')
    expect(c2.refs).toEqual([])

    const page2 = await service.log(repoDir, { limit: 2, skip: 2 })
    expect(page2.hasMore).toBe(false)
    expect(page2.commits).toHaveLength(1)
    expect(page2.commits[0].subject).toBe('initial commit')
    expect(page2.commits[0].parents).toEqual([])
    expect(c2.parents).toEqual([page2.commits[0].hash])

    await expect(service.log(repoDir, { limit: 0 })).rejects.toThrow(/limit/)
    await expect(service.log(repoDir, { skip: -1 })).rejects.toThrow(/skip/)
  }, 30_000)

  it('filters log by scope (all vs current+upstream), resolves branches/remotes/annotated tags, excludes refs/stash and */HEAD, and defaults pagination to 100 commits', async () => {
    const bareRemote = join(tempRoot, 'graph-remote.git')
    const cloneA = join(tempRoot, 'graph-clone-a')
    const cloneB = join(tempRoot, 'graph-clone-b')
    await mkdir(bareRemote, { recursive: true })
    await runGit(bareRemote, ['init', '--bare'])

    await runGit(tempRoot, ['clone', bareRemote, cloneA])
    await runGit(cloneA, ['checkout', '-b', 'main'])
    await runGit(cloneA, ['config', 'user.name', 'Alice'])
    await runGit(cloneA, ['config', 'user.email', 'alice@example.com'])
    await writeFile(join(cloneA, 'base.md'), '# Base\n', 'utf8')
    await service.stageAll(cloneA)
    await service.commit(cloneA, 'base commit')
    const baseHash = (await runGit(cloneA, ['rev-parse', 'HEAD'])).trim()
    await runGit(cloneA, ['tag', 'v1.0'])
    await runGit(cloneA, ['tag', '-a', 'v1.0-ann', '-m', 'Release v1.0'])
    await service.push(cloneA)
    await runGit(cloneA, ['push', 'origin', '--tags'])
    await runGit(bareRemote, ['symbolic-ref', 'HEAD', 'refs/heads/main'])

    // Clone B tracks origin/main and creates origin/HEAD symbolic ref on fetch/clone
    await runGit(tempRoot, ['clone', bareRemote, cloneB])
    await runGit(cloneB, ['config', 'user.name', 'Bob'])
    await runGit(cloneB, ['config', 'user.email', 'bob@example.com'])
    await runGit(cloneB, ['remote', 'set-head', 'origin', 'main'])

    // Feature branch merged with --no-ff on cloneB
    await runGit(cloneB, ['checkout', '-b', 'feature/graph'])
    await writeFile(join(cloneB, 'feat.md'), '# Feat\n', 'utf8')
    await service.stageAll(cloneB)
    await service.commit(cloneB, 'feature work')
    const featureHash = (await runGit(cloneB, ['rev-parse', 'HEAD'])).trim()

    await runGit(cloneB, ['checkout', 'main'])
    await runGit(cloneB, ['merge', '--no-ff', 'feature/graph', '-m', 'merge feature/graph'])
    const mergeHash = (await runGit(cloneB, ['rev-parse', 'HEAD'])).trim()

    // Separate side branch not merged into main
    await runGit(cloneB, ['checkout', '-b', 'side/only', baseHash])
    await writeFile(join(cloneB, 'side.md'), '# Side\n', 'utf8')
    await service.stageAll(cloneB)
    await service.commit(cloneB, 'side branch commit')
    const sideHash = (await runGit(cloneB, ['rev-parse', 'HEAD'])).trim()

    // Return to main and create a stash (refs/stash MUST be excluded from scope:'all')
    await runGit(cloneB, ['checkout', 'main'])
    await writeFile(join(cloneB, 'stash-temp.md'), '# Stashed\n', 'utf8')
    await runGit(cloneB, ['stash', 'push', '-u', '-m', 'secret stash wip'])

    // Advance origin/main from cloneA and fetch in cloneB so @{upstream} has an unpulled commit
    await writeFile(join(cloneA, 'remote-next.md'), '# Remote\n', 'utf8')
    await service.stageAll(cloneA)
    await service.commit(cloneA, 'upstream commit')
    const upstreamHash = (await runGit(cloneA, ['rev-parse', 'HEAD'])).trim()
    await service.push(cloneA)
    await runGit(cloneB, ['fetch', '--tags'])

    const allResult = await service.log(cloneB, { scope: 'all' })
    const allHashes = allResult.commits.map((c) => c.hash)
    expect(allHashes).toContain(upstreamHash)
    expect(allHashes).toContain(mergeHash)
    expect(allHashes).toContain(featureHash)
    expect(allHashes).toContain(sideHash)
    expect(allHashes).toContain(baseHash)
    expect(allResult.commits.some((c) => c.subject.includes('secret stash wip'))).toBe(false)
    expect(allResult.commits.flatMap((c) => c.refs).some((r) => r.name.includes('HEAD') && r.kind === 'remote-branch')).toBe(false)
    expect(allResult.commits.flatMap((c) => c.refs).some((r) => r.name === 'origin')).toBe(false)

    const mergeCommit = allResult.commits.find((c) => c.hash === mergeHash)!
    expect(mergeCommit.parents).toHaveLength(2)
    expect(mergeCommit.refs).toEqual([
      { name: 'HEAD', kind: 'head', isCurrentHead: true },
      { name: 'main', kind: 'local-branch', isCurrentHead: true }
    ])

    const upstreamCommit = allResult.commits.find((c) => c.hash === upstreamHash)!
    expect(upstreamCommit.refs).toEqual([{ name: 'origin/main', kind: 'remote-branch' }])

    const baseCommit = allResult.commits.find((c) => c.hash === baseHash)!
    expect(baseCommit.refs).toEqual([
      { name: 'v1.0', kind: 'tag' },
      { name: 'v1.0-ann', kind: 'tag' }
    ])

    // scope: 'current' includes HEAD + @{upstream} and excludes side/only
    const currentResult = await service.log(cloneB, { scope: 'current' })
    const currentHashes = currentResult.commits.map((c) => c.hash)
    expect(currentHashes).toContain(upstreamHash)
    expect(currentHashes).toContain(mergeHash)
    expect(currentHashes).toContain(featureHash)
    expect(currentHashes).toContain(baseHash)
    expect(currentHashes).not.toContain(sideHash)

    // Detached HEAD commit not reachable from any branch is included in both 'all' and 'current'
    await runGit(cloneB, ['checkout', '--detach', baseHash])
    await writeFile(join(cloneB, 'detached.md'), '# Detached\n', 'utf8')
    await service.stageAll(cloneB)
    await service.commit(cloneB, 'detached tip')
    const detachedHash = (await runGit(cloneB, ['rev-parse', 'HEAD'])).trim()

    const detachedAll = await service.log(cloneB, { scope: 'all' })
    const detachedTip = detachedAll.commits.find((c) => c.hash === detachedHash)!
    expect(detachedTip.refs).toEqual([{ name: 'HEAD', kind: 'head', isCurrentHead: true }])

    const detachedCurrent = await service.log(cloneB, { scope: 'current' })
    expect(detachedCurrent.commits.map((c) => c.hash)).toEqual([detachedHash, baseHash])

    // Default pagination limit = 100 verified via fast-import of 105 linear commits
    await service.init(repoDir)
    const fastImportLines: string[] = []
    for (let i = 1; i <= 105; i += 1) {
      fastImportLines.push(
        `commit refs/heads/main`,
        `mark :${i}`,
        `committer Wiki Tester <tester@example.com> ${1700000000 + i} +0000`,
        `data ${Buffer.byteLength(`commit ${i}`)}`,
        `commit ${i}`,
        ...(i > 1 ? [`from :${i - 1}`] : [])
      )
    }
    await new Promise<void>((resolve, reject) => {
      const child = spawn('git', ['fast-import', '--quiet'], {
        cwd: repoDir,
        windowsHide: true,
        env: {
          ...process.env,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: gitConfigFile
        }
      })
      child.on('error', reject)
      child.on('close', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`git fast-import exited with code ${code}`))
      })
      child.stdin.end(fastImportLines.join('\n') + '\n')
    })

    const defaultPage1 = await service.log(repoDir)
    expect(defaultPage1.commits).toHaveLength(100)
    expect(defaultPage1.hasMore).toBe(true)
    expect(defaultPage1.commits[0].subject).toBe('commit 105')

    const defaultPage2 = await service.log(repoDir, { skip: 100 })
    expect(defaultPage2.commits).toHaveLength(5)
    expect(defaultPage2.hasMore).toBe(false)
    expect(defaultPage2.commits[4].subject).toBe('commit 1')
  }, 60_000)

  it('validates commit hashes and parses commitDetail for root, normal (A/M/D/R + body), merge (--first-parent), and empty commits', async () => {
    await expect(service.commitDetail(nonGitDir, 'abcdef1')).rejects.toThrow(/Git 저장소가 아닙니다/)

    await service.init(repoDir)
    await runGit(repoDir, ['config', 'user.name', 'Wiki Tester'])
    await runGit(repoDir, ['config', 'user.email', 'tester@example.com'])

    // Reject option-injection and invalid hash formats before invoking git
    for (const invalidHash of [
      '',
      'abc123',
      '-abc1234',
      '--all',
      '-n1',
      'zzzzzzz',
      'HEAD',
      'a'.repeat(65),
      'abcdef1 --stat'
    ]) {
      await expect(service.commitDetail(repoDir, invalidHash)).rejects.toThrow(/커밋 해시/)
    }

    // 1. Root commit (--root): all files reported as 'A'
    await writeFile(join(repoDir, 'keep.md'), '# Keep\n', 'utf8')
    await writeFile(join(repoDir, 'delete-me.md'), '# Delete me\n', 'utf8')
    await writeFile(join(repoDir, '한글 이름.md'), '# Rename target\nLine 2\nLine 3\n', 'utf8')
    await service.stageAll(repoDir)
    await service.commit(repoDir, 'root commit')
    const rootHash = (await runGit(repoDir, ['rev-parse', 'HEAD'])).trim()

    await expect(service.commitDetail(repoDir, '0123456789abcdef')).rejects.toThrow()

    const rootDetail = await service.commitDetail(repoDir, rootHash.slice(0, 7))
    expect(rootDetail.hash).toBe(rootHash)
    expect(rootDetail.shortHash).toBe(rootHash.slice(0, rootDetail.shortHash.length))
    expect(rootDetail.parents).toEqual([])
    expect(rootDetail.subject).toBe('root commit')
    expect(rootDetail.body).toBe('')
    expect(rootDetail.authorName).toBe('Wiki Tester')
    expect(rootDetail.authorEmail).toBe('tester@example.com')
    expect(Number.isNaN(Date.parse(rootDetail.committedAt))).toBe(false)
    expect(rootDetail.files).toEqual([
      { path: 'delete-me.md', status: 'A' },
      { path: 'keep.md', status: 'A' },
      { path: '한글 이름.md', status: 'A' }
    ])

    // 2. Normal commit with multi-line body and A / M / D / R changes
    await writeFile(join(repoDir, 'keep.md'), '# Keep Updated\n', 'utf8')
    await writeFile(join(repoDir, 'added note.md'), '# Added\n', 'utf8')
    await rm(join(repoDir, 'delete-me.md'))
    await runGit(repoDir, ['mv', '한글 이름.md', 'moved 한글.md'])
    await service.stageAll(repoDir)
    await runGit(repoDir, [
      'commit',
      '-m',
      'update and reorganize docs',
      '-m',
      'Detailed body line 1.\n\nDetailed body paragraph 2.'
    ])
    const normalHash = (await runGit(repoDir, ['rev-parse', 'HEAD'])).trim()

    const normalDetail = await service.commitDetail(repoDir, normalHash)
    expect(normalDetail.hash).toBe(normalHash)
    expect(normalDetail.parents).toEqual([rootHash])
    expect(normalDetail.subject).toBe('update and reorganize docs')
    expect(normalDetail.body).toBe('Detailed body line 1.\n\nDetailed body paragraph 2.')
    expect(normalDetail.files).toEqual(
      expect.arrayContaining([
        { path: 'added note.md', status: 'A' },
        { path: 'keep.md', status: 'M' },
        { path: 'delete-me.md', status: 'D' },
        { path: 'moved 한글.md', origPath: '한글 이름.md', status: 'R' }
      ])
    )
    expect(normalDetail.files).toHaveLength(4)

    // 3. Merge commit (--first-parent): clean merge without conflicts still yields merged branch changes
    await runGit(repoDir, ['checkout', '-b', 'feature/detail'])
    await writeFile(join(repoDir, 'feature-only.md'), '# Feature\n', 'utf8')
    await writeFile(join(repoDir, 'keep.md'), '# Keep From Feature\n', 'utf8')
    await service.stageAll(repoDir)
    await service.commit(repoDir, 'feature changes')
    const featureHash = (await runGit(repoDir, ['rev-parse', 'HEAD'])).trim()

    await runGit(repoDir, ['checkout', 'main'])
    await writeFile(join(repoDir, 'main-only.md'), '# Main only\n', 'utf8')
    await service.stageAll(repoDir)
    await service.commit(repoDir, 'main changes')
    const mainBeforeMergeHash = (await runGit(repoDir, ['rev-parse', 'HEAD'])).trim()

    await runGit(repoDir, ['merge', '--no-ff', 'feature/detail', '-m', 'merge feature/detail'])
    const mergeHash = (await runGit(repoDir, ['rev-parse', 'HEAD'])).trim()

    const mergeDetail = await service.commitDetail(repoDir, mergeHash)
    expect(mergeDetail.parents).toEqual([mainBeforeMergeHash, featureHash])
    expect(mergeDetail.subject).toBe('merge feature/detail')
    expect(mergeDetail.files).toEqual(
      expect.arrayContaining([
        { path: 'feature-only.md', status: 'A' },
        { path: 'keep.md', status: 'M' }
      ])
    )
    expect(mergeDetail.files).toHaveLength(2)

    // 4. Empty commit (--allow-empty): returns empty files list
    await runGit(repoDir, ['commit', '--allow-empty', '-m', 'empty checkpoint'])
    const emptyHash = (await runGit(repoDir, ['rev-parse', 'HEAD'])).trim()

    const emptyDetail = await service.commitDetail(repoDir, emptyHash)
    expect(emptyDetail.subject).toBe('empty checkpoint')
    expect(emptyDetail.body).toBe('')
    expect(emptyDetail.files).toEqual([])
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
