import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { formatGitError, parsePorcelainV2Z } from './GitService'
import { withGitTestSandbox } from './gitTestSandbox'

describe('GitService integration (status, init, stage, unstage, commit, branches)', () => {
  it('reports isRepo=false for non-git folders, blocks repo commands, and initializes via init()', () =>
    withGitTestSandbox(async (sandbox) => {
      const { service, nonGitDir, runGit } = sandbox

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
  }), 30_000)

  it('parses untracked, staged, unstaged, deleted, renamed, and non-ASCII/dash filenames and validates stage/unstage/commit', () =>
    withGitTestSandbox(async (sandbox) => {
      const { service, repoDir, tempRoot, runGit } = sandbox
    await service.init(repoDir)

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
  }), 60_000)

  it('lists local branches, checks out branches safely, and rejects conflicting or invalid checkouts', () =>
    withGitTestSandbox(async (sandbox) => {
      const { service, repoDir, runGit } = sandbox
    await service.init(repoDir)

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
  }), 60_000)
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
