import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GIT_DIFF_MAX_BYTES } from '@shared/git'
import { GIT_IPC_CHANNELS } from '@shared/ipc'
import type { IpcMainLike } from '../ipc/ipcHelpers'
import { registerGitIpc } from '../ipc/registerGitIpc'
import { WorkspaceFsService } from '../workspace/WorkspaceFsService'
import {
  createGitTestSandbox,
  setupBareRemoteClones,
  type GitTestSandbox
} from './gitTestSandbox'

describe('GitService integration (branch and worktree compare)', () => {
  let sandbox: GitTestSandbox

  beforeEach(async () => {
    sandbox = await createGitTestSandbox()
  })

  afterEach(async () => {
    await sandbox.cleanup()
  })

  it('lists worktrees (including detached HEAD), local branches, remote branches (excluding */HEAD), defaultBaseRef, and currentRef', async () => {
    await sandbox.runGit(sandbox.repoDir, ['init'])
    await writeFile(join(sandbox.repoDir, 'README.md'), '# Root\n', 'utf8')
    await sandbox.runGit(sandbox.repoDir, ['add', 'README.md'])
    await sandbox.runGit(sandbox.repoDir, ['commit', '-m', 'init main'])

    await sandbox.runGit(sandbox.repoDir, ['checkout', '-b', 'feature/alpha'])
    await writeFile(join(sandbox.repoDir, 'alpha.md'), 'alpha\n', 'utf8')
    await sandbox.runGit(sandbox.repoDir, ['add', 'alpha.md'])
    await sandbox.runGit(sandbox.repoDir, ['commit', '-m', 'add alpha'])

    const detachedCommitHash = (
      await sandbox.runGit(sandbox.repoDir, ['rev-parse', '--short=7', 'HEAD'])
    ).trim()

    await sandbox.runGit(sandbox.repoDir, ['checkout', 'main'])

    const branchWorktreeDir = join(sandbox.tempRoot, 'wt-feature')
    const detachedWorktreeDir = join(sandbox.tempRoot, 'wt-detached')
    await sandbox.runGit(sandbox.repoDir, ['worktree', 'add', branchWorktreeDir, 'feature/alpha'])
    await sandbox.runGit(sandbox.repoDir, [
      'worktree',
      'add',
      '--detach',
      detachedWorktreeDir,
      'feature/alpha'
    ])

    const refs = await sandbox.service.compareRefs(sandbox.repoDir)
    expect(refs.defaultBaseRef).toBe('main')
    expect(refs.currentRef).toBe('main')

    expect(refs.localBranches.map((b) => ({ ref: b.ref, isCurrent: b.isCurrent }))).toEqual([
      { ref: 'feature/alpha', isCurrent: false },
      { ref: 'main', isCurrent: true }
    ])
    expect(refs.remoteBranches).toEqual([])

    expect(refs.worktrees).toHaveLength(3)
    const mainWt = refs.worktrees.find((w) => w.worktreeName === 'repo')
    const featureWt = refs.worktrees.find((w) => w.worktreeName === 'wt-feature')
    const detachedWt = refs.worktrees.find((w) => w.worktreeName === 'wt-detached')

    expect(mainWt).toMatchObject({
      kind: 'worktree',
      ref: 'main',
      worktreeName: 'repo',
      branchName: 'main',
      isDetached: false,
      isCurrent: true
    })
    expect(featureWt).toMatchObject({
      kind: 'worktree',
      ref: 'feature/alpha',
      worktreeName: 'wt-feature',
      branchName: 'feature/alpha',
      isDetached: false,
      isCurrent: false
    })
    expect(detachedWt).toMatchObject({
      kind: 'worktree',
      ref: detachedCommitHash,
      worktreeName: 'wt-detached',
      branchName: null,
      shortHash: detachedCommitHash,
      isDetached: true,
      isCurrent: false
    })

    // In detached worktree, currentRef should be its shortHash
    const detachedRefs = await sandbox.service.compareRefs(detachedWorktreeDir)
    expect(detachedRefs.currentRef).toBe(detachedCommitHash)
    expect(detachedRefs.worktrees.find((w) => w.worktreeName === 'wt-detached')?.isCurrent).toBe(
      true
    )
  })

  it('resolves defaultBaseRef from origin/HEAD when present, excluding */HEAD from remoteBranches, and handles unborn and non-git directories', async () => {
    // Non-git folder throws
    await expect(sandbox.service.compareRefs(sandbox.nonGitDir)).rejects.toThrow(/Git 저장소/)

    // Unborn repository returns empty refs without throwing
    const unbornDir = join(sandbox.tempRoot, 'unborn')
    await mkdir(unbornDir, { recursive: true })
    await sandbox.runGit(unbornDir, ['init'])
    expect(await sandbox.service.compareRefs(unbornDir)).toEqual({
      defaultBaseRef: null,
      currentRef: null,
      worktrees: [],
      localBranches: [],
      remoteBranches: []
    })

    // Remote with origin/HEAD
    const { cloneA } = await setupBareRemoteClones(sandbox, {
      prefix: 'compare-remote',
      files: { 'README.md': '# Remote\n' },
      commitMessage: 'initial commit'
    })
    await sandbox.runGit(cloneA, ['remote', 'set-head', 'origin', 'main'])
    await sandbox.runGit(cloneA, ['checkout', '-b', 'topic/notes'])

    const remoteRefs = await sandbox.service.compareRefs(cloneA)
    expect(remoteRefs.defaultBaseRef).toBe('origin/main')
    expect(remoteRefs.currentRef).toBe('topic/notes')
    expect(remoteRefs.remoteBranches.map((r) => r.ref)).toEqual(['origin/main'])
    expect(remoteRefs.remoteBranches.some((r) => r.ref.endsWith('/HEAD'))).toBe(false)
  })

  it('computes three-dot vs two-dot compareSummary with numstat, renames, binary files, commits, and same-ref empty result', async () => {
    await sandbox.runGit(sandbox.repoDir, ['init'])
    await writeFile(join(sandbox.repoDir, 'shared.md'), 'line 1\nline 2\n', 'utf8')
    await writeFile(join(sandbox.repoDir, 'rename-me.md'), 'rename body\n', 'utf8')
    await writeFile(join(sandbox.repoDir, 'remove-me.md'), 'to be deleted\n', 'utf8')
    await sandbox.runGit(sandbox.repoDir, ['add', '.'])
    await sandbox.runGit(sandbox.repoDir, ['commit', '-m', 'base init'])
    const mergeBaseHash = (await sandbox.runGit(sandbox.repoDir, ['rev-parse', 'HEAD'])).trim()

    // Branch off feature/topic
    await sandbox.runGit(sandbox.repoDir, ['checkout', '-b', 'feature/topic'])
    await writeFile(join(sandbox.repoDir, 'shared.md'), 'line 1\nline 2 updated\nline 3\n', 'utf8')
    await writeFile(join(sandbox.repoDir, 'added.md'), 'new line 1\nnew line 2\n', 'utf8')
    await sandbox.runGit(sandbox.repoDir, ['mv', 'rename-me.md', 'renamed.md'])
    await sandbox.runGit(sandbox.repoDir, ['rm', 'remove-me.md'])
    await writeFile(
      join(sandbox.repoDir, 'icon.png'),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01])
    )
    await sandbox.runGit(sandbox.repoDir, ['add', '.'])
    await sandbox.runGit(sandbox.repoDir, ['commit', '-m', 'feature changes'])

    // Advance main independently after branch-off
    await sandbox.runGit(sandbox.repoDir, ['checkout', 'main'])
    await writeFile(join(sandbox.repoDir, 'main-only.md'), 'main extra line\n', 'utf8')
    await sandbox.runGit(sandbox.repoDir, ['add', 'main-only.md'])
    await sandbox.runGit(sandbox.repoDir, ['commit', '-m', 'main advance'])

    // three-dot: only feature/topic changes since merge-base (excludes main-only.md)
    const threeDot = await sandbox.service.compareSummary(sandbox.repoDir, {
      baseRef: 'main',
      compareRef: 'feature/topic',
      mode: 'three-dot'
    })
    expect(threeDot.mergeBaseHash).toBe(mergeBaseHash)
    expect(threeDot.mode).toBe('three-dot')
    expect(threeDot.commits.map((c) => c.subject)).toEqual(['feature changes'])
    expect(threeDot.files.map((f) => f.path)).not.toContain('main-only.md')

    const sharedFile = threeDot.files.find((f) => f.path === 'shared.md')
    expect(sharedFile).toEqual({
      path: 'shared.md',
      status: 'M',
      additions: 2,
      deletions: 1,
      isBinary: false
    })
    const addedFile = threeDot.files.find((f) => f.path === 'added.md')
    expect(addedFile).toEqual({
      path: 'added.md',
      status: 'A',
      additions: 2,
      deletions: 0,
      isBinary: false
    })
    const renamedFile = threeDot.files.find((f) => f.path === 'renamed.md')
    expect(renamedFile).toEqual({
      path: 'renamed.md',
      origPath: 'rename-me.md',
      status: 'R',
      additions: 0,
      deletions: 0,
      isBinary: false
    })
    const deletedFile = threeDot.files.find((f) => f.path === 'remove-me.md')
    expect(deletedFile).toEqual({
      path: 'remove-me.md',
      status: 'D',
      additions: 0,
      deletions: 1,
      isBinary: false
    })
    const binaryFile = threeDot.files.find((f) => f.path === 'icon.png')
    expect(binaryFile).toEqual({
      path: 'icon.png',
      status: 'A',
      additions: null,
      deletions: null,
      isBinary: true
    })
    expect(threeDot.totalAdditions).toBe(4)
    expect(threeDot.totalDeletions).toBe(2)

    // two-dot: includes inverse of main-only.md (deleted in feature/topic relative to main)
    const twoDot = await sandbox.service.compareSummary(sandbox.repoDir, {
      baseRef: 'main',
      compareRef: 'feature/topic',
      mode: 'two-dot'
    })
    expect(twoDot.mode).toBe('two-dot')
    const mainOnlyInTwoDot = twoDot.files.find((f) => f.path === 'main-only.md')
    expect(mainOnlyInTwoDot).toEqual({
      path: 'main-only.md',
      status: 'D',
      additions: 0,
      deletions: 1,
      isBinary: false
    })
    expect(twoDot.totalAdditions).toBe(4)
    expect(twoDot.totalDeletions).toBe(3)

    // Same-ref compare returns empty files, commits, and 0/0 totals
    const sameRef = await sandbox.service.compareSummary(sandbox.repoDir, {
      baseRef: 'main',
      compareRef: 'main',
      mode: 'three-dot'
    })
    expect(sameRef.files).toEqual([])
    expect(sameRef.commits).toEqual([])
    expect(sameRef.totalAdditions).toBe(0)
    expect(sameRef.totalDeletions).toBe(0)
  })

  it('blocks revision injection, unborn repositories, and non-git directories in compareSummary', async () => {
    await expect(
      sandbox.service.compareSummary(sandbox.nonGitDir, {
        baseRef: 'main',
        compareRef: 'HEAD',
        mode: 'three-dot'
      })
    ).rejects.toThrow(/Git 저장소/)

    const unbornDir = join(sandbox.tempRoot, 'unborn-summary')
    await mkdir(unbornDir, { recursive: true })
    await sandbox.runGit(unbornDir, ['init'])
    await expect(
      sandbox.service.compareSummary(unbornDir, {
        baseRef: 'main',
        compareRef: 'HEAD',
        mode: 'three-dot'
      })
    ).rejects.toThrow(/커밋된 내역이 없어/)

    await sandbox.runGit(sandbox.repoDir, ['init'])
    await writeFile(join(sandbox.repoDir, 'README.md'), '# Root\n', 'utf8')
    await sandbox.runGit(sandbox.repoDir, ['add', 'README.md'])
    await sandbox.runGit(sandbox.repoDir, ['commit', '-m', 'init'])

    for (const badRef of ['-u', '--exec=evil', 'main..HEAD', 'main HEAD', 'main\nHEAD', 'main\0']) {
      await expect(
        sandbox.service.compareSummary(sandbox.repoDir, {
          baseRef: badRef,
          compareRef: 'main',
          mode: 'three-dot'
        })
      ).rejects.toThrow(/유효한/)
      await expect(
        sandbox.service.compareSummary(sandbox.repoDir, {
          baseRef: 'main',
          compareRef: badRef,
          mode: 'three-dot'
        })
      ).rejects.toThrow(/유효한/)
    }
  })

  it('computes kind=branch-compare diffs (3-dot/2-dot, rename, binary, >1MB truncation, existsInWorkspace) and enforces path/ref/IPC workspace security', async () => {
    await sandbox.runGit(sandbox.repoDir, ['init'])
    await writeFile(join(sandbox.repoDir, 'notes.md'), 'base line\n', 'utf8')
    await writeFile(join(sandbox.repoDir, 'old-name.md'), 'rename line 1\n', 'utf8')
    await sandbox.runGit(sandbox.repoDir, ['add', '.'])
    await sandbox.runGit(sandbox.repoDir, ['commit', '-m', 'base commit'])

    await sandbox.runGit(sandbox.repoDir, ['checkout', '-b', 'feature/diff'])
    await writeFile(join(sandbox.repoDir, 'notes.md'), 'base line\nfeature line\n', 'utf8')
    await writeFile(join(sandbox.repoDir, 'only-feature.md'), 'feature only\n', 'utf8')
    await sandbox.runGit(sandbox.repoDir, ['mv', 'old-name.md', 'new-name.md'])
    await writeFile(join(sandbox.repoDir, 'new-name.md'), 'rename line 1\nrename line 2\n', 'utf8')
    await writeFile(
      join(sandbox.repoDir, 'image.png'),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x02])
    )
    const hugeLines = Array.from({ length: 30_000 }, (_, i) => `huge line ${i} ${'x'.repeat(40)}\n`).join('')
    await writeFile(join(sandbox.repoDir, 'huge.md'), hugeLines, 'utf8')
    await sandbox.runGit(sandbox.repoDir, ['add', '.'])
    await sandbox.runGit(sandbox.repoDir, ['commit', '-m', 'feature diff commit'])

    await sandbox.runGit(sandbox.repoDir, ['checkout', 'main'])
    await writeFile(join(sandbox.repoDir, 'main-extra.md'), 'main extra\n', 'utf8')
    await sandbox.runGit(sandbox.repoDir, ['add', 'main-extra.md'])
    await sandbox.runGit(sandbox.repoDir, ['commit', '-m', 'main extra commit'])

    // Modified file in 3-dot (existsInWorkspace: true because notes.md is on main too)
    const notesDiff = await sandbox.service.diff(sandbox.repoDir, {
      kind: 'branch-compare',
      baseRef: 'main',
      compareRef: 'feature/diff',
      mode: 'three-dot',
      path: 'notes.md',
      status: 'M'
    })
    expect(notesDiff.isBinary).toBe(false)
    expect(notesDiff.isTruncated).toBe(false)
    expect(notesDiff.existsInWorkspace).toBe(true)
    expect(notesDiff.rawPatch).toContain('+feature line')

    // Feature-only file does not exist in current main workspace
    const featureOnlyDiff = await sandbox.service.diff(sandbox.repoDir, {
      kind: 'branch-compare',
      baseRef: 'main',
      compareRef: 'feature/diff',
      mode: 'three-dot',
      path: 'only-feature.md',
      status: 'A'
    })
    expect(featureOnlyDiff.existsInWorkspace).toBe(false)
    expect(featureOnlyDiff.rawPatch).toContain('+feature only')

    // 3-dot excludes main-extra.md, 2-dot includes it as deleted
    const mainExtraThreeDot = await sandbox.service.diff(sandbox.repoDir, {
      kind: 'branch-compare',
      baseRef: 'main',
      compareRef: 'feature/diff',
      mode: 'three-dot',
      path: 'main-extra.md',
      status: 'D'
    })
    expect(mainExtraThreeDot.rawPatch).toBe('')

    const mainExtraTwoDot = await sandbox.service.diff(sandbox.repoDir, {
      kind: 'branch-compare',
      baseRef: 'main',
      compareRef: 'feature/diff',
      mode: 'two-dot',
      path: 'main-extra.md',
      status: 'D'
    })
    expect(mainExtraTwoDot.rawPatch).toContain('-main extra')

    // Rename with origPath
    const renameDiff = await sandbox.service.diff(sandbox.repoDir, {
      kind: 'branch-compare',
      baseRef: 'main',
      compareRef: 'feature/diff',
      mode: 'three-dot',
      path: 'new-name.md',
      origPath: 'old-name.md',
      status: 'R'
    })
    expect(renameDiff.origPath).toBe('old-name.md')
    expect(renameDiff.rawPatch).toContain('+rename line 2')

    // Binary file
    const binaryDiff = await sandbox.service.diff(sandbox.repoDir, {
      kind: 'branch-compare',
      baseRef: 'main',
      compareRef: 'feature/diff',
      mode: 'three-dot',
      path: 'image.png',
      status: 'A'
    })
    expect(binaryDiff.isBinary).toBe(true)
    expect(binaryDiff.rawPatch).toBe('')

    // >1MB truncation
    const hugeDiff = await sandbox.service.diff(sandbox.repoDir, {
      kind: 'branch-compare',
      baseRef: 'main',
      compareRef: 'feature/diff',
      mode: 'three-dot',
      path: 'huge.md',
      status: 'A'
    })
    expect(hugeDiff.isTruncated).toBe(true)
    expect(Buffer.byteLength(hugeDiff.rawPatch, 'utf8')).toBeLessThanOrEqual(GIT_DIFF_MAX_BYTES)

    // Path traversal & .git access & ref injection blocked
    await expect(
      sandbox.service.diff(sandbox.repoDir, {
        kind: 'branch-compare',
        baseRef: 'main',
        compareRef: 'feature/diff',
        mode: 'three-dot',
        path: '../outside.md',
        status: 'M'
      })
    ).rejects.toThrow()
    await expect(
      sandbox.service.diff(sandbox.repoDir, {
        kind: 'branch-compare',
        baseRef: 'main',
        compareRef: 'feature/diff',
        mode: 'three-dot',
        path: '.git/config',
        status: 'M'
      })
    ).rejects.toThrow()
    await expect(
      sandbox.service.diff(sandbox.repoDir, {
        kind: 'branch-compare',
        baseRef: '--output=/tmp/pwn',
        compareRef: 'feature/diff',
        mode: 'three-dot',
        path: 'notes.md',
        status: 'M'
      })
    ).rejects.toThrow(/유효한/)

    // End-to-end registerGitIpc + real GitService integration
    const handlers = new Map<string, (_event: unknown, ...args: unknown[]) => unknown>()
    const ipcMain: IpcMainLike = {
      handle(channel, listener) {
        handlers.set(channel, listener)
      },
      removeHandler(channel) {
        handlers.delete(channel)
      }
    }
    const workspaceService = new WorkspaceFsService()
    const dispose = registerGitIpc({
      ipcMain,
      gitService: sandbox.service,
      workspaceService
    })
    try {
      const opened = await workspaceService.openWorkspace(sandbox.repoDir)
      const invoke = (channel: string, ...args: unknown[]) => {
        const handler = handlers.get(channel)
        if (!handler) throw new Error(`Missing handler: ${channel}`)
        return handler({}, ...args)
      }

      const refsResult = await invoke(GIT_IPC_CHANNELS.compareRefs, opened.rootPath)
      expect(refsResult).toMatchObject({ currentRef: 'main', defaultBaseRef: 'main' })

      const summaryResult = await invoke(GIT_IPC_CHANNELS.compareSummary, opened.rootPath, {
        baseRef: 'main',
        compareRef: 'feature/diff',
        mode: 'three-dot'
      })
      expect(summaryResult).toMatchObject({ baseRef: 'main', compareRef: 'feature/diff' })

      const diffResult = await invoke(GIT_IPC_CHANNELS.diff, opened.rootPath, {
        kind: 'branch-compare',
        baseRef: 'main',
        compareRef: 'feature/diff',
        mode: 'three-dot',
        path: 'notes.md',
        status: 'M'
      })
      expect(diffResult).toMatchObject({ path: 'notes.md', isBinary: false })

      await expect(async () =>
        invoke(GIT_IPC_CHANNELS.compareRefs, sandbox.nonGitDir)
      ).rejects.toThrow(/일치하지 않습니다/)
    } finally {
      dispose()
      workspaceService.dispose()
    }
  })
})
