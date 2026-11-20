import { spawn } from 'node:child_process'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LogService } from '../logging/LogService'
import { setupBareRemoteClones, withGitTestSandbox } from './gitTestSandbox'

describe('GitService integration (log, commitDetail, error logging)', () => {
  it('logs raw Git CLI stderr, stdout, and exit code at error level before formatting user messages, without logging benign non-repo probes', () =>
    withGitTestSandbox(async (sandbox) => {
      const { tempRoot, repoDir, nonGitDir, createService } = sandbox
    const logService = new LogService(join(tempRoot, 'logs'))
    const loggedService = createService({ logService })

    // Benign status check on a non-git folder should not log errors
    const nonRepoStatus = await loggedService.status(nonGitDir)
    expect(nonRepoStatus.isRepo).toBe(false)
    expect(await logService.readEntries()).toHaveLength(0)

    // Initialize repo and commit an initial file
    await loggedService.init(repoDir)
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
  }), 60_000)

  it('returns empty commits for unborn repo, rejects non-git folders, and paginates linear history with refs and ISO timestamps', () =>
    withGitTestSandbox(async (sandbox) => {
      const { service, repoDir, nonGitDir } = sandbox

    await expect(service.log(nonGitDir)).rejects.toThrow(/Git 저장소가 아닙니다/)

    await service.init(repoDir)

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
  }), 60_000)

  it('filters log by scope (all vs current+upstream), resolves branches/remotes/annotated tags, excludes refs/stash and */HEAD, and defaults pagination to 100 commits', () =>
    withGitTestSandbox(async (sandbox) => {
      const { service, repoDir, env, runGit } = sandbox
    const { cloneA, cloneB } = await setupBareRemoteClones(sandbox, {
      prefix: 'graph',
      files: { 'base.md': '# Base\n' },
      commitMessage: 'base commit'
    })

    const baseHash = (await runGit(cloneA, ['rev-parse', 'HEAD'])).trim()
    await runGit(cloneA, ['tag', 'v1.0'])
    await runGit(cloneA, ['tag', '-a', 'v1.0-ann', '-m', 'Release v1.0'])
    await runGit(cloneA, ['push', 'origin', '--tags'])

    // Clone B tracks origin/main and creates origin/HEAD symbolic ref on fetch/clone
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
          ...env
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
  }), 90_000)

  it('validates commit hashes and parses commitDetail for root, normal (A/M/D/R + body), merge (--first-parent), and empty commits', () =>
    withGitTestSandbox(async (sandbox) => {
      const { service, repoDir, nonGitDir, runGit } = sandbox

    await expect(service.commitDetail(nonGitDir, 'abcdef1')).rejects.toThrow(/Git 저장소가 아닙니다/)

    await service.init(repoDir)

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
  }), 60_000)
})
