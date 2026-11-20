import { mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { GIT_DIFF_MAX_BYTES } from '@shared/git'
import { withGitTestSandbox } from './gitTestSandbox'

describe('GitService integration (working-tree and commit diffs)', () => {
  it('computes staged, unstaged, untracked, renamed, deleted, binary, and >1MB truncated diffs while enforcing path security', () =>
    withGitTestSandbox(async (sandbox) => {
      const { service, tempRoot, repoDir, nonGitDir, runGit } = sandbox

    await expect(
      service.diff(nonGitDir, { kind: 'unstaged', path: 'note.md', status: 'M' })
    ).rejects.toThrow(/Git 저장소가 아닙니다/)

    await service.init(repoDir)

    // Path traversal, outside absolute path, and .git metadata path are blocked (including origPath)
    const outsideFile = join(tempRoot, 'outside.md')
    await writeFile(outsideFile, 'outside secret', 'utf8')
    await expect(
      service.diff(repoDir, { kind: 'unstaged', path: '../outside.md', status: 'M' })
    ).rejects.toThrow(/저장소 밖/)
    await expect(
      service.diff(repoDir, { kind: 'unstaged', path: outsideFile, status: 'M' })
    ).rejects.toThrow(/저장소 밖/)
    await expect(
      service.diff(repoDir, { kind: 'staged', path: '.git/config', status: 'M' })
    ).rejects.toThrow(/\.git/)
    await expect(
      service.diff(repoDir, {
        kind: 'staged',
        path: 'note.md',
        origPath: '../outside.md',
        status: 'R'
      })
    ).rejects.toThrow(/저장소 밖/)

    try {
      const linkPath = join(repoDir, 'escape-link.md')
      await symlink(outsideFile, linkPath)
      await expect(
        service.diff(repoDir, { kind: 'unstaged', path: 'escape-link.md', status: '?' })
      ).rejects.toThrow(/저장소 밖/)
      await rm(linkPath, { force: true })
    } catch {
      // Symlink creation without Developer Mode may fail on Windows
    }

    // 1. Unborn repo: untracked text, untracked empty, untracked binary, and staged file
    await writeFile(join(repoDir, '새노트.md'), '# 안녕\n둘째 줄\n', 'utf8')
    await writeFile(join(repoDir, 'empty.md'), '', 'utf8')
    await writeFile(join(repoDir, 'untracked-bin.dat'), Buffer.from([0x89, 0x50, 0x00, 0x0a]))

    const untrackedDiff = await service.diff(repoDir, {
      kind: 'unstaged',
      path: '새노트.md',
      status: '?'
    })
    expect(untrackedDiff).toMatchObject({
      path: '새노트.md',
      status: '?',
      isBinary: false,
      isTruncated: false,
      existsInWorkspace: true
    })
    expect(untrackedDiff.rawPatch).toContain('@@ -0,0 +1,2 @@')
    expect(untrackedDiff.rawPatch).toContain('+# 안녕')
    expect(untrackedDiff.rawPatch).toContain('+둘째 줄')

    const emptyUntrackedDiff = await service.diff(repoDir, {
      kind: 'unstaged',
      path: 'empty.md',
      status: '?'
    })
    expect(emptyUntrackedDiff.rawPatch).toBe('')
    expect(emptyUntrackedDiff.isBinary).toBe(false)

    const untrackedBinDiff = await service.diff(repoDir, {
      kind: 'unstaged',
      path: 'untracked-bin.dat',
      status: '?'
    })
    expect(untrackedBinDiff).toMatchObject({
      path: 'untracked-bin.dat',
      status: '?',
      isBinary: true,
      isTruncated: false,
      existsInWorkspace: true,
      rawPatch: ''
    })

    await service.stage(repoDir, ['새노트.md'])
    const unbornStagedDiff = await service.diff(repoDir, {
      kind: 'staged',
      path: '새노트.md',
      status: 'A'
    })
    expect(unbornStagedDiff.isBinary).toBe(false)
    expect(unbornStagedDiff.existsInWorkspace).toBe(true)
    expect(unbornStagedDiff.rawPatch).toContain('+# 안녕')

    await service.stage(repoDir, ['untracked-bin.dat'])
    const unbornStagedBinDiff = await service.diff(repoDir, {
      kind: 'staged',
      path: 'untracked-bin.dat',
      status: 'A'
    })
    expect(unbornStagedBinDiff.isBinary).toBe(true)
    expect(unbornStagedBinDiff.rawPatch).toBe('')

    await rm(join(repoDir, 'untracked-bin.dat'), { force: true })
    await service.unstageAll(repoDir)
    await service.stage(repoDir, ['새노트.md'])
    await writeFile(join(repoDir, 'base.md'), 'line 1\nline 2\n', 'utf8')
    await writeFile(join(repoDir, 'keep-old.md'), 'alpha\nbeta\ngamma\ndelta\n', 'utf8')
    await service.stageAll(repoDir)
    await service.commit(repoDir, 'initial commit')
    const rootHash = (await runGit(repoDir, ['rev-parse', 'HEAD'])).trim()

    // 2. Post-commit: tracked unstaged M, tracked staged R (-M rename), and deleted file (existsInWorkspace=false)
    await writeFile(join(repoDir, 'base.md'), 'line 1\nline 2 updated\n', 'utf8')
    const unstagedModDiff = await service.diff(repoDir, {
      kind: 'unstaged',
      path: 'base.md',
      status: 'M'
    })
    expect(unstagedModDiff.rawPatch).toContain('-line 2')
    expect(unstagedModDiff.rawPatch).toContain('+line 2 updated')
    expect(unstagedModDiff.existsInWorkspace).toBe(true)

    await mkdir(join(repoDir, 'sub'), { recursive: true })
    await writeFile(join(repoDir, 'sub/moved.md'), 'alpha\nbeta\ngamma\ndelta\n', 'utf8')
    await rm(join(repoDir, 'keep-old.md'))
    await service.stageAll(repoDir)

    const stagedRenameDiff = await service.diff(repoDir, {
      kind: 'staged',
      path: 'sub/moved.md',
      origPath: 'keep-old.md',
      status: 'R'
    })
    expect(stagedRenameDiff).toMatchObject({
      path: 'sub/moved.md',
      origPath: 'keep-old.md',
      status: 'R',
      isBinary: false,
      existsInWorkspace: true
    })
    expect(stagedRenameDiff.rawPatch).toContain('rename from keep-old.md')
    expect(stagedRenameDiff.rawPatch).toContain('rename to sub/moved.md')

    // Subdirectory workspace: files inside workspace root & non-ignored have existsInWorkspace=true,
    // while files outside the opened subdirectory or under IGNORED_ENTRY_NAMES have existsInWorkspace=false.
    const subRepoDiff = await service.diff(join(repoDir, 'sub'), {
      kind: 'staged',
      path: 'sub/moved.md',
      origPath: 'keep-old.md',
      status: 'R'
    })
    expect(subRepoDiff.existsInWorkspace).toBe(true)

    const parentOutsideDiff = await service.diff(join(repoDir, 'sub'), {
      kind: 'staged',
      path: 'base.md',
      status: 'M'
    })
    expect(parentOutsideDiff.existsInWorkspace).toBe(false)
    expect(parentOutsideDiff.rawPatch).toContain('+line 2 updated')

    await mkdir(join(repoDir, 'sub', 'node_modules'), { recursive: true })
    await writeFile(join(repoDir, 'sub', 'node_modules', 'ignored.md'), '# Ignored\n', 'utf8')
    const ignoredEntryDiff = await service.diff(join(repoDir, 'sub'), {
      kind: 'unstaged',
      path: 'sub/node_modules/ignored.md',
      status: '?'
    })
    expect(ignoredEntryDiff.existsInWorkspace).toBe(false)
    expect(ignoredEntryDiff.rawPatch).toContain('+# Ignored')
    await rm(join(repoDir, 'sub', 'node_modules'), { recursive: true, force: true })

    await service.commit(repoDir, 'modify and move')
    await rm(join(repoDir, 'base.md'))
    const unstagedDeletedDiff = await service.diff(repoDir, {
      kind: 'unstaged',
      path: 'base.md',
      status: 'D'
    })
    expect(unstagedDeletedDiff.existsInWorkspace).toBe(false)
    expect(unstagedDeletedDiff.rawPatch).toContain('-line 2 updated')

    await service.stage(repoDir, ['base.md'])
    const stagedDeletedDiff = await service.diff(repoDir, {
      kind: 'staged',
      path: 'base.md',
      status: 'D'
    })
    expect(stagedDeletedDiff.existsInWorkspace).toBe(false)
    expect(stagedDeletedDiff.rawPatch).toContain('-line 1')
    await service.commit(repoDir, 'delete base')

    // 3. Commit diff for a file no longer in workspace -> existsInWorkspace=false
    const historicalCommitDiff = await service.diff(repoDir, {
      kind: 'commit',
      commitHash: rootHash,
      shortHash: rootHash.slice(0, 7),
      path: 'base.md',
      status: 'A'
    })
    expect(historicalCommitDiff.existsInWorkspace).toBe(false)
    expect(historicalCommitDiff.rawPatch).toContain('+line 1')

    // 4. >1MB large tracked diff and >1MB untracked diff are truncated
    const bigLine = 'A'.repeat(1024) + '\n'
    const bigBody = bigLine.repeat(1200) // ~1.2MB
    await writeFile(join(repoDir, 'huge-untracked.md'), bigBody, 'utf8')
    const hugeUntrackedDiff = await service.diff(repoDir, {
      kind: 'unstaged',
      path: 'huge-untracked.md',
      status: '?'
    })
    expect(hugeUntrackedDiff.isTruncated).toBe(true)
    expect(Buffer.byteLength(hugeUntrackedDiff.rawPatch, 'utf8')).toBeLessThanOrEqual(
      GIT_DIFF_MAX_BYTES
    )

    await service.stage(repoDir, ['huge-untracked.md'])
    await service.commit(repoDir, 'add huge file')
    await writeFile(join(repoDir, 'huge-untracked.md'), 'B'.repeat(1024).concat('\n').repeat(1200), 'utf8')
    const hugeTrackedDiff = await service.diff(repoDir, {
      kind: 'unstaged',
      path: 'huge-untracked.md',
      status: 'M'
    })
    expect(hugeTrackedDiff.isTruncated).toBe(true)
    expect(Buffer.byteLength(hugeTrackedDiff.rawPatch, 'utf8')).toBeLessThanOrEqual(
      GIT_DIFF_MAX_BYTES
    )

    // Untracked >1MB file with multi-byte UTF-8 split across 1MB boundary must not produce replacement chars
    await writeFile(
      join(repoDir, 'huge-utf8-untracked.md'),
      'x'.repeat(GIT_DIFF_MAX_BYTES - 1) + '가'.repeat(20),
      'utf8'
    )
    const hugeUtf8Untracked = await service.diff(repoDir, {
      kind: 'unstaged',
      path: 'huge-utf8-untracked.md',
      status: '?'
    })
    expect(hugeUtf8Untracked.isTruncated).toBe(true)
    expect(hugeUtf8Untracked.rawPatch).not.toContain('\uFFFD')
    expect(Buffer.byteLength(hugeUtf8Untracked.rawPatch, 'utf8')).toBeLessThanOrEqual(
      GIT_DIFF_MAX_BYTES
    )
  }), 60_000)

  it('validates commit hashes and computes commit diffs for root, normal, merge (--first-parent), rename, binary, and deleted historical paths while enforcing path security', () =>
    withGitTestSandbox(async (sandbox) => {
      const { service, repoDir, nonGitDir, runGit } = sandbox

    await expect(
      service.diff(nonGitDir, {
        kind: 'commit',
        commitHash: '1234567',
        shortHash: '1234567',
        path: 'guide.md',
        status: 'M'
      })
    ).rejects.toThrow()

    await service.init(repoDir)

    for (const invalidHash of ['', 'abc123', '-flag', 'HEAD', 'zzzzzzzz', 'a'.repeat(65), 'abcdef12 --stat']) {
      await expect(
        service.diff(repoDir, {
          kind: 'commit',
          commitHash: invalidHash,
          shortHash: 'abc1234',
          path: 'guide.md',
          status: 'M'
        })
      ).rejects.toThrow(/커밋 해시/)
    }

    const blockedPathCases: Array<{ path: string; origPath?: string; status: 'M' | 'R' }> = [
      { path: '.git/config', status: 'M' },
      { path: '../outside.md', status: 'M' },
      { path: 'guide.md', origPath: '../outside.md', status: 'R' }
    ]
    for (const target of blockedPathCases) {
      await expect(
        service.diff(repoDir, {
          kind: 'commit',
          commitHash: '1234567',
          shortHash: '1234567',
          ...target
        })
      ).rejects.toThrow()
    }

    // 1. Root commit (--root), including nested folder and binary asset
    await mkdir(join(repoDir, 'archived', 'sub'), { recursive: true })
    await writeFile(join(repoDir, 'guide.md'), '# Guide v1\nline 2\n', 'utf8')
    await writeFile(join(repoDir, 'archived', 'sub', 'old-note.md'), '# Old Archived Note\n', 'utf8')
    await writeFile(join(repoDir, '한글 이름.md'), '# Rename source\nbody 1\nbody 2\n', 'utf8')
    await writeFile(join(repoDir, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]))
    await service.stageAll(repoDir)
    await service.commit(repoDir, 'root commit')
    const rootHash = (await runGit(repoDir, ['rev-parse', 'HEAD'])).trim()

    const rootGuideDiff = await service.diff(repoDir, {
      kind: 'commit',
      commitHash: rootHash,
      shortHash: rootHash.slice(0, 7),
      path: 'guide.md',
      status: 'A'
    })
    expect(rootGuideDiff).toMatchObject({
      path: 'guide.md',
      status: 'A',
      isBinary: false,
      isTruncated: false,
      existsInWorkspace: true
    })
    expect(rootGuideDiff.rawPatch).toContain('+# Guide v1')

    const rootBinaryDiff = await service.diff(repoDir, {
      kind: 'commit',
      commitHash: rootHash,
      shortHash: rootHash.slice(0, 7),
      path: 'logo.png',
      status: 'A'
    })
    expect(rootBinaryDiff).toMatchObject({
      path: 'logo.png',
      status: 'A',
      isBinary: true,
      rawPatch: '',
      existsInWorkspace: true
    })

    // 2. Normal commit: modify, delete nested folder, rename non-ASCII file
    await writeFile(join(repoDir, 'guide.md'), '# Guide v2\nline 2\n', 'utf8')
    await rm(join(repoDir, 'archived'), { recursive: true, force: true })
    await runGit(repoDir, ['mv', '한글 이름.md', 'moved 한글.md'])
    await service.stageAll(repoDir)
    await service.commit(repoDir, 'reorganize and update guide')
    const normalHash = (await runGit(repoDir, ['rev-parse', 'HEAD'])).trim()

    const renamedCommitDiff = await service.diff(repoDir, {
      kind: 'commit',
      commitHash: normalHash,
      shortHash: normalHash.slice(0, 7),
      path: 'moved 한글.md',
      origPath: '한글 이름.md',
      status: 'R'
    })
    expect(renamedCommitDiff).toMatchObject({
      path: 'moved 한글.md',
      origPath: '한글 이름.md',
      status: 'R',
      isBinary: false,
      existsInWorkspace: true
    })
    expect(renamedCommitDiff.rawPatch).toContain('rename from 한글 이름.md')
    expect(renamedCommitDiff.rawPatch).toContain('rename to moved 한글.md')

    // 3. Historically deleted file whose parent dir is deleted AND replaced by a regular file (ENOTDIR edge case)
    await writeFile(join(repoDir, 'archived'), 'now a regular file blocking dir traversal\n', 'utf8')
    await service.stageAll(repoDir)
    await service.commit(repoDir, 'replace archived dir with file')

    const deletedNestedDiff = await service.diff(repoDir, {
      kind: 'commit',
      commitHash: rootHash,
      shortHash: rootHash.slice(0, 7),
      path: 'archived/sub/old-note.md',
      status: 'A'
    })
    expect(deletedNestedDiff).toMatchObject({
      path: 'archived/sub/old-note.md',
      status: 'A',
      isBinary: false,
      existsInWorkspace: false
    })
    expect(deletedNestedDiff.rawPatch).toContain('+# Old Archived Note')

    const deletedInNormalDiff = await service.diff(repoDir, {
      kind: 'commit',
      commitHash: normalHash,
      shortHash: normalHash.slice(0, 7),
      path: 'archived/sub/old-note.md',
      status: 'D'
    })
    expect(deletedInNormalDiff).toMatchObject({
      path: 'archived/sub/old-note.md',
      status: 'D',
      existsInWorkspace: false
    })
    expect(deletedInNormalDiff.rawPatch).toContain('-# Old Archived Note')

    // 4. Merge commit (--first-parent): diff matches <merge>^1 <-> <merge>
    await runGit(repoDir, ['checkout', '-b', 'feature/diff-test'])
    await writeFile(join(repoDir, 'guide.md'), '# Guide Merge Feature\nline 2\n', 'utf8')
    await writeFile(join(repoDir, 'feature-doc.md'), '# Feature Doc\n', 'utf8')
    await service.stageAll(repoDir)
    await service.commit(repoDir, 'feature updates')

    await runGit(repoDir, ['checkout', 'main'])
    await writeFile(join(repoDir, 'main-doc.md'), '# Main Doc\n', 'utf8')
    await service.stageAll(repoDir)
    await service.commit(repoDir, 'main updates')

    await runGit(repoDir, ['merge', '--no-ff', 'feature/diff-test', '-m', 'merge feature/diff-test'])
    const mergeHash = (await runGit(repoDir, ['rev-parse', 'HEAD'])).trim()

    const mergeGuideDiff = await service.diff(repoDir, {
      kind: 'commit',
      commitHash: mergeHash,
      shortHash: mergeHash.slice(0, 7),
      path: 'guide.md',
      status: 'M'
    })
    expect(mergeGuideDiff.isBinary).toBe(false)
    expect(mergeGuideDiff.existsInWorkspace).toBe(true)
    expect(mergeGuideDiff.rawPatch).toContain('-# Guide v2')
    expect(mergeGuideDiff.rawPatch).toContain('+# Guide Merge Feature')

    const mergeAddedDiff = await service.diff(repoDir, {
      kind: 'commit',
      commitHash: mergeHash,
      shortHash: mergeHash.slice(0, 7),
      path: 'feature-doc.md',
      status: 'A'
    })
    expect(mergeAddedDiff.rawPatch).toContain('+# Feature Doc')

    // 5. Subdirectory workspace existsInWorkspace check for commit diffs
    await mkdir(join(repoDir, 'sub-ws'), { recursive: true })
    await writeFile(join(repoDir, 'sub-ws', 'inside.md'), '# Inside\n', 'utf8')
    await service.stageAll(repoDir)
    await service.commit(repoDir, 'add sub-ws file')
    const subHash = (await runGit(repoDir, ['rev-parse', 'HEAD'])).trim()

    const insideSubWsDiff = await service.diff(join(repoDir, 'sub-ws'), {
      kind: 'commit',
      commitHash: subHash,
      shortHash: subHash.slice(0, 7),
      path: 'sub-ws/inside.md',
      status: 'A'
    })
    expect(insideSubWsDiff.existsInWorkspace).toBe(true)

    const outsideSubWsDiff = await service.diff(join(repoDir, 'sub-ws'), {
      kind: 'commit',
      commitHash: subHash,
      shortHash: subHash.slice(0, 7),
      path: 'guide.md',
      status: 'M'
    })
    expect(outsideSubWsDiff.existsInWorkspace).toBe(false)
  }), 60_000)
})
