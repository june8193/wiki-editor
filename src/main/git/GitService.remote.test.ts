import { lstat, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { setupBareRemoteClones, withGitTestSandbox } from './gitTestSandbox'

describe('GitService integration (remote push, pull, sync, fetch)', () => {
  it('publishes to bare remote (-u origin main), detects renames, tracks ahead/behind via push/pull, and performs non-conflicting concurrent sync', () =>
    withGitTestSandbox(async (sandbox) => {
      const { service, runGit } = sandbox
    const { cloneA, cloneB } = await setupBareRemoteClones(sandbox, {
      prefix: 'remote',
      files: {
        'shared.md': 'line 1\n',
        'old-name.md': '# Renamed target\n'
      },
      commitMessage: 'seed'
    })

    // First push auto-set -u origin main
    expect((await service.status(cloneA)).hasUpstream).toBe(true)

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
  }), 90_000)

  it('rejects non-fast-forward push, surfaces pull merge conflicts (U), and fails cleanly on missing or unreachable remotes', () =>
    withGitTestSandbox(async (sandbox) => {
      const { service, repoDir, tempRoot, runGit } = sandbox
    const { cloneA, cloneB } = await setupBareRemoteClones(sandbox, {
      prefix: 'bare',
      files: { 'shared.md': 'line 1\n' },
      commitMessage: 'seed'
    })

    // Advance origin/main from cloneB so cloneA is behind and hits non-fast-forward rejection
    await writeFile(join(cloneB, 'b.md'), '# B\n', 'utf8')
    await service.stageAll(cloneB)
    await service.commit(cloneB, 'add b')
    await service.push(cloneB)

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
  }), 90_000)

  it('fetches remote refs and behind count from a bare remote without modifying working tree or staged index, and handles non-repo/no-remote/unreachable errors', () =>
    withGitTestSandbox(async (sandbox) => {
      const { service, repoDir, nonGitDir, tempRoot, runGit } = sandbox

    await expect(service.fetch(nonGitDir)).rejects.toThrow(/Git 저장소가 아닙니다/)

    await service.init(repoDir)
    await writeFile(join(repoDir, 'local.md'), '# Local\n', 'utf8')
    await service.stageAll(repoDir)
    await service.commit(repoDir, 'local only')
    await expect(service.fetch(repoDir)).rejects.toThrow(/원격 저장소/)

    await runGit(repoDir, ['remote', 'add', 'origin', join(tempRoot, 'missing-remote.git')])
    await expect(service.fetch(repoDir)).rejects.toThrow(/원격|오류/)

    const { cloneA, cloneB } = await setupBareRemoteClones(sandbox, {
      prefix: 'fetch',
      files: { 'shared.md': '# Shared v1\n' },
      commitMessage: 'seed remote'
    })

    // Push a new commit from cloneA without pulling in cloneB
    await writeFile(join(cloneA, 'shared.md'), '# Shared v2 from remote\n', 'utf8')
    await writeFile(join(cloneA, 'remote-only.md'), '# Remote Only\n', 'utf8')
    await service.stageAll(cloneA)
    await service.commit(cloneA, 'remote advance')
    const remoteHeadHash = (await runGit(cloneA, ['rev-parse', 'HEAD'])).trim()
    await service.push(cloneA)

    // Create staged, unstaged, and untracked local changes in cloneB
    await writeFile(join(cloneB, 'staged-local.md'), '# Staged Local\n', 'utf8')
    await service.stage(cloneB, ['staged-local.md'])
    await writeFile(join(cloneB, 'shared.md'), '# Local Unstaged Edit\n', 'utf8')
    await writeFile(join(cloneB, 'untracked-local.md'), '# Untracked Local\n', 'utf8')

    const beforeStatus = await service.status(cloneB)
    expect(beforeStatus.behind).toBe(0)

    const fetchedStatus = await service.fetch(cloneB)
    expect(fetchedStatus.hasUpstream).toBe(true)
    expect(fetchedStatus.ahead).toBe(0)
    expect(fetchedStatus.behind).toBe(1)
    expect(fetchedStatus.staged).toEqual([{ path: 'staged-local.md', status: 'A' }])
    expect(fetchedStatus.unstaged).toEqual([{ path: 'shared.md', status: 'M' }])
    expect(fetchedStatus.untracked).toEqual([{ path: 'untracked-local.md', status: '?' }])

    // Working tree files remain untouched and remote-only.md is NOT checked out into working tree
    expect(await readFile(join(cloneB, 'shared.md'), 'utf8')).toBe('# Local Unstaged Edit\n')
    expect(await readFile(join(cloneB, 'staged-local.md'), 'utf8')).toBe('# Staged Local\n')
    expect(await readFile(join(cloneB, 'untracked-local.md'), 'utf8')).toBe('# Untracked Local\n')
    await expect(lstat(join(cloneB, 'remote-only.md'))).rejects.toMatchObject({ code: 'ENOENT' })

    // Remote ref origin/main is updated
    expect((await runGit(cloneB, ['rev-parse', 'refs/remotes/origin/main'])).trim()).toBe(
      remoteHeadHash
    )
    const logResult = await service.log(cloneB, { scope: 'all' })
    expect(logResult.commits.some((commit) => commit.hash === remoteHeadHash)).toBe(true)
  }), 90_000)
})
