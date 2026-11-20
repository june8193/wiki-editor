import { lstat, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { withGitTestSandbox } from './gitTestSandbox'

describe('GitService integration (discard and discardAll)', () => {
  it('discards tracked M/D changes from Index (preserving staged MM/AM/RM and unborn repos), skips clean paths, and blocks unsafe paths', () =>
    withGitTestSandbox(async (sandbox) => {
      const { service, tempRoot, repoDir, nonGitDir, runGit } = sandbox

    await expect(service.discard(nonGitDir, ['a.md'])).rejects.toThrow(/Git 저장소가 아닙니다/)

    await service.init(repoDir)

    // Path validation: empty, NUL, outside repo, .git, symlinked ancestor escape
    const outsideDir = join(tempRoot, 'outside-discard')
    await mkdir(outsideDir, { recursive: true })
    const outsideFile = join(outsideDir, 'secret.md')
    await writeFile(outsideFile, 'secret', 'utf8')

    await expect(service.discard(repoDir, [])).rejects.toThrow(/대상 파일 경로/)
    await expect(service.discard(repoDir, ['   '])).rejects.toThrow(/유효하지 않은/)
    await expect(service.discard(repoDir, ['bad\0path.md'])).rejects.toThrow(/유효하지 않은/)
    await expect(service.discard(repoDir, ['../outside-discard/secret.md'])).rejects.toThrow(/저장소 밖/)
    await expect(service.discard(repoDir, [outsideFile])).rejects.toThrow(/저장소 밖/)
    await expect(service.discard(repoDir, ['.'])).rejects.toThrow(/저장소 밖/)
    await expect(service.discard(repoDir, ['.git/config'])).rejects.toThrow(/\.git|시스템/)

    try {
      const outsideLinkDir = join(repoDir, 'escape-dir')
      const gitLinkDir = join(repoDir, 'git-link-dir')
      await symlink(outsideDir, outsideLinkDir, 'junction')
      await symlink(join(repoDir, '.git'), gitLinkDir, 'junction')
      await expect(service.discard(repoDir, ['escape-dir/secret.md'])).rejects.toThrow(/저장소 밖/)
      await expect(service.discard(repoDir, ['git-link-dir/config'])).rejects.toThrow(/\.git|시스템/)
      await rm(outsideLinkDir, { force: true })
      await rm(gitLinkDir, { force: true })
    } catch {
      // Symlink/junction creation may require elevated permissions on some Windows environments
    }

    // 1. Unborn repo: AM and AD restore from Index without losing staged status
    await writeFile(join(repoDir, 'unborn-mod.md'), '# Staged v1\n', 'utf8')
    await writeFile(join(repoDir, 'unborn-del.md'), '# Staged delete\n', 'utf8')
    await service.stage(repoDir, ['unborn-mod.md', 'unborn-del.md'])
    await writeFile(join(repoDir, 'unborn-mod.md'), '# Unstaged working edit\n', 'utf8')
    await rm(join(repoDir, 'unborn-del.md'))

    let status = await service.discard(repoDir, ['unborn-mod.md', 'unborn-del.md'])
    expect(status.isUnborn).toBe(true)
    expect(status.unstaged).toEqual([])
    expect(status.staged.map((f) => `${f.status}:${f.path}`).sort()).toEqual([
      'A:unborn-del.md',
      'A:unborn-mod.md'
    ])
    expect(await readFile(join(repoDir, 'unborn-mod.md'), 'utf8')).toBe('# Staged v1\n')
    expect(await readFile(join(repoDir, 'unborn-del.md'), 'utf8')).toBe('# Staged delete\n')

    // 2. Committed repo: M, D (including deleted parent dir), MM, RM, non-ASCII/dash, clean skip, subdir workspace
    await mkdir(join(repoDir, 'nested'), { recursive: true })
    await mkdir(join(repoDir, 'subws'), { recursive: true })
    await writeFile(join(repoDir, '-dash.md'), '# Dash v1\n', 'utf8')
    await writeFile(join(repoDir, '한글 문서.md'), '# 한글 v1\n', 'utf8')
    await writeFile(join(repoDir, 'nested', 'deleted.md'), '# Nested v1\n', 'utf8')
    await writeFile(join(repoDir, 'mm-file.md'), '# MM v1\n', 'utf8')
    await writeFile(join(repoDir, 'rename-src.md'), '# Rename v1\nline 2\nline 3\n', 'utf8')
    await writeFile(join(repoDir, 'subws', 'inside.md'), '# Sub v1\n', 'utf8')
    await writeFile(join(repoDir, 'clean-staged.md'), '# Clean staged v1\n', 'utf8')
    await service.stageAll(repoDir)
    await service.commit(repoDir, 'seed committed files')

    // Modify -dash.md & 한글 문서.md, delete nested/ (parent + file!), stage mm-file v2 then edit v3, rename & edit RM, stage clean-staged
    await writeFile(join(repoDir, '-dash.md'), '# Dash dirty\n', 'utf8')
    await writeFile(join(repoDir, '한글 문서.md'), '# 한글 dirty\n', 'utf8')
    await rm(join(repoDir, 'nested'), { recursive: true, force: true })
    await writeFile(join(repoDir, 'mm-file.md'), '# MM staged v2\n', 'utf8')
    await writeFile(join(repoDir, 'clean-staged.md'), '# Clean staged v2\n', 'utf8')
    await service.stage(repoDir, ['mm-file.md', 'clean-staged.md'])
    await writeFile(join(repoDir, 'mm-file.md'), '# MM unstaged v3\n', 'utf8')
    await runGit(repoDir, ['mv', 'rename-src.md', 'rename-dest.md'])
    await writeFile(join(repoDir, 'rename-dest.md'), '# Rename unstaged edit\nline 2\nline 3\n', 'utf8')
    await writeFile(join(repoDir, 'subws', 'inside.md'), '# Sub dirty\n', 'utf8')

    status = await service.discard(repoDir, [
      '-dash.md',
      '한글 문서.md',
      'nested/deleted.md',
      'mm-file.md',
      'rename-dest.md',
      'clean-staged.md',
      'not-changed.md'
    ])
    expect(status.unstaged).toEqual([{ path: 'subws/inside.md', status: 'M' }])
    expect(status.staged.map((f) => `${f.status}:${f.path}`).sort()).toEqual([
      'M:clean-staged.md',
      'M:mm-file.md',
      'R:rename-dest.md'
    ])
    expect(await readFile(join(repoDir, '-dash.md'), 'utf8')).toBe('# Dash v1\n')
    expect(await readFile(join(repoDir, '한글 문서.md'), 'utf8')).toBe('# 한글 v1\n')
    expect(await readFile(join(repoDir, 'nested', 'deleted.md'), 'utf8')).toBe('# Nested v1\n')
    expect(await readFile(join(repoDir, 'mm-file.md'), 'utf8')).toBe('# MM staged v2\n')
    expect(await readFile(join(repoDir, 'rename-dest.md'), 'utf8')).toBe(
      '# Rename v1\nline 2\nline 3\n'
    )
    expect(await readFile(join(repoDir, 'clean-staged.md'), 'utf8')).toBe('# Clean staged v2\n')

    // Subdirectory workspace discard
    status = await service.discard(join(repoDir, 'subws'), ['subws/inside.md'])
    expect(status.unstaged).toEqual([])
    expect(await readFile(join(repoDir, 'subws', 'inside.md'), 'utf8')).toBe('# Sub v1\n')
  }), 60_000)

  it('discards all merge conflict U states (UU, AA, DD, DU, UD, AU, UA) to HEAD/--ours and clears conflict status', () =>
    withGitTestSandbox(async (sandbox) => {
      const { service, repoDir, runGit } = sandbox

    await service.init(repoDir)

    await writeFile(join(repoDir, 'uu.md'), 'base uu\n', 'utf8')
    await writeFile(join(repoDir, 'du.md'), 'base du\n', 'utf8')
    await writeFile(join(repoDir, 'ud.md'), 'base ud\n', 'utf8')
    await writeFile(join(repoDir, 'base-rename.md'), 'rename line 1\nrename line 2\nrename line 3\n', 'utf8')
    await service.stageAll(repoDir)
    await service.commit(repoDir, 'base')

    await runGit(repoDir, ['checkout', '-b', 'theirs'])
    await writeFile(join(repoDir, 'uu.md'), 'theirs uu\n', 'utf8')
    await writeFile(join(repoDir, 'aa.md'), 'theirs aa\n', 'utf8')
    await writeFile(join(repoDir, 'du.md'), 'theirs du edit\n', 'utf8')
    await rm(join(repoDir, 'ud.md'))
    await runGit(repoDir, ['mv', 'base-rename.md', 'ua-theirs.md'])
    await service.stageAll(repoDir)
    await service.commit(repoDir, 'theirs branch')

    await runGit(repoDir, ['checkout', 'main'])
    await writeFile(join(repoDir, 'uu.md'), 'ours uu\n', 'utf8')
    await writeFile(join(repoDir, 'aa.md'), 'ours aa\n', 'utf8')
    await rm(join(repoDir, 'du.md'))
    await writeFile(join(repoDir, 'ud.md'), 'ours ud edit\n', 'utf8')
    await runGit(repoDir, ['mv', 'base-rename.md', 'au-ours.md'])
    await service.stageAll(repoDir)
    await service.commit(repoDir, 'ours branch')

    await expect(runGit(repoDir, ['merge', 'theirs'])).rejects.toThrow()

    // Confirm all 7 porcelain v2 unmerged codes are present before discarding
    const rawPorcelain = await runGit(repoDir, ['status', '--porcelain=v2', '-z'])
    const unmergedCodes = rawPorcelain
      .split('\0')
      .filter((tok) => tok.startsWith('u '))
      .map((tok) => `${tok.slice(2, 4)}:${tok.split(' ').slice(10).join(' ')}`)
    expect(unmergedCodes).toEqual(
      expect.arrayContaining([
        'UU:uu.md',
        'AA:aa.md',
        'DD:base-rename.md',
        'DU:du.md',
        'UD:ud.md',
        'AU:au-ours.md',
        'UA:ua-theirs.md'
      ])
    )

    const beforeStatus = await service.status(repoDir)
    expect(beforeStatus.hasConflicts).toBe(true)

    const conflictTargets = [
      'uu.md',
      'aa.md',
      'base-rename.md',
      'du.md',
      'ud.md',
      'au-ours.md',
      'ua-theirs.md'
    ]
    const afterStatus = await service.discard(repoDir, conflictTargets)
    expect(afterStatus.hasConflicts).toBe(false)
    expect(afterStatus.unstaged).toEqual([])
    expect(await readFile(join(repoDir, 'uu.md'), 'utf8')).toBe('ours uu\n')
    expect(await readFile(join(repoDir, 'aa.md'), 'utf8')).toBe('ours aa\n')
    expect(await readFile(join(repoDir, 'ud.md'), 'utf8')).toBe('ours ud edit\n')
    expect(await readFile(join(repoDir, 'au-ours.md'), 'utf8')).toBe(
      'rename line 1\nrename line 2\nrename line 3\n'
    )
    await expect(lstat(join(repoDir, 'base-rename.md'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(lstat(join(repoDir, 'du.md'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(lstat(join(repoDir, 'ua-theirs.md'))).rejects.toMatchObject({ code: 'ENOENT' })
  }), 60_000)

  it('discards untracked ? files via injected trashItem (with fs fallback), handles symlink leaves without following targets, and treats ENOENT idempotently', () =>
    withGitTestSandbox(async (sandbox) => {
      const { service, repoDir, createService } = sandbox

    await service.init(repoDir)
    const realRepoDir = await realpath(repoDir)

    await mkdir(join(repoDir, 'subws'), { recursive: true })
    await writeFile(join(repoDir, 'keep-target.md'), '# Keep Target\n', 'utf8')
    await service.stageAll(repoDir)
    await service.commit(repoDir, 'seed')

    // 1. Injected trashItem handles untracked files (including subdirectory workspace) and ENOENT idempotently
    await writeFile(join(repoDir, 'subws', 'draft.md'), '# Draft\n', 'utf8')
    await writeFile(join(repoDir, 'race-missing.md'), '# Missing\n', 'utf8')
    const trashedPaths: string[] = []
    const trashItem = vi.fn(async (targetPath: string) => {
      if (targetPath.endsWith('race-missing.md')) {
        await rm(targetPath, { force: true })
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      }
      trashedPaths.push(targetPath)
      await rm(targetPath, { recursive: true, force: true })
    })
    const trashService = createService({ trashItem })

    let status = await trashService.discard(join(repoDir, 'subws'), [
      'subws/draft.md',
      'race-missing.md',
      'never-existed.md'
    ])
    expect(status.untracked).toEqual([])
    expect(trashedPaths).toEqual([join(realRepoDir, 'subws', 'draft.md')])
    await expect(lstat(join(repoDir, 'subws', 'draft.md'))).rejects.toMatchObject({ code: 'ENOENT' })

    // 2. Fallback filesystem deletion when trashItem is not injected + symlink leaf is removed without touching target
    await writeFile(join(repoDir, 'fallback-untracked.md'), '# Fallback\n', 'utf8')
    const linkTargetPath = join(repoDir, 'keep-target.md')
    const linkPath = join(repoDir, 'untracked-link.md')
    let symlinkCreated = false
    try {
      await symlink(linkTargetPath, linkPath)
      symlinkCreated = true
    } catch {
      symlinkCreated = false
    }

    const targets = symlinkCreated
      ? ['fallback-untracked.md', 'untracked-link.md']
      : ['fallback-untracked.md']
    status = await service.discard(repoDir, targets)
    expect(status.untracked).toEqual([])
    await expect(lstat(join(repoDir, 'fallback-untracked.md'))).rejects.toMatchObject({ code: 'ENOENT' })
    if (symlinkCreated) {
      await expect(lstat(linkPath)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await readFile(linkTargetPath, 'utf8')).toBe('# Keep Target\n')
    }
  }), 60_000)

  it('discardsAll across M/D, U (HEAD/--ours), and ? (via trashItem/fallback) while preserving staged changes and remaining idempotent when clean', () =>
    withGitTestSandbox(async (sandbox) => {
      const { service, repoDir, createService, runGit } = sandbox

    await expect(service.discardAll(sandbox.nonGitDir)).rejects.toThrow(/Git 저장소가 아닙니다/)

    await service.init(repoDir)
    const realRepoDir = await realpath(repoDir)

    // 1. Clean unborn repo is idempotent
    let status = await service.discardAll(repoDir)
    expect(status.isUnborn).toBe(true)
    expect(status.unstaged).toEqual([])
    expect(status.untracked).toEqual([])

    // Seed unborn staged file + unstaged modification -> discardAll restores from Index while preserving staged A
    await writeFile(join(repoDir, 'unborn-staged.md'), '# Unborn staged\n', 'utf8')
    await service.stage(repoDir, ['unborn-staged.md'])
    await writeFile(join(repoDir, 'unborn-staged.md'), '# Unborn unstaged edit\n', 'utf8')
    status = await service.discardAll(repoDir)
    expect(status.unstaged).toEqual([])
    expect(status.staged).toEqual([{ path: 'unborn-staged.md', status: 'A' }])
    expect(await readFile(join(repoDir, 'unborn-staged.md'), 'utf8')).toBe('# Unborn staged\n')

    // 2. Clean staged-only repo (with commit history) is idempotent
    await mkdir(join(repoDir, 'nested'), { recursive: true })
    await writeFile(join(repoDir, 'mod.md'), '# Mod v1\n', 'utf8')
    await writeFile(join(repoDir, 'nested', 'del.md'), '# Del v1\n', 'utf8')
    await writeFile(join(repoDir, 'mm.md'), '# MM v1\n', 'utf8')
    await writeFile(join(repoDir, 'conflict-both.md'), 'base\n', 'utf8')
    await writeFile(join(repoDir, 'base-ua.md'), 'ua line 1\nua line 2\nua line 3\n', 'utf8')
    await writeFile(join(repoDir, 'staged-clean.md'), '# Staged clean v1\n', 'utf8')
    await mkdir(join(repoDir, 'subws'), { recursive: true })
    await writeFile(join(repoDir, 'subws', 'sub-mod.md'), '# Sub v1\n', 'utf8')
    await service.stageAll(repoDir)
    await service.commit(repoDir, 'base commit')

    // Branch with UA conflict candidate and UU conflict candidate
    await runGit(repoDir, ['checkout', '-b', 'theirs'])
    await writeFile(join(repoDir, 'conflict-both.md'), 'theirs conflict\n', 'utf8')
    await runGit(repoDir, ['mv', 'base-ua.md', 'theirs-ua.md'])
    await service.stageAll(repoDir)
    await service.commit(repoDir, 'theirs commit')

    await runGit(repoDir, ['checkout', 'main'])
    await writeFile(join(repoDir, 'conflict-both.md'), 'ours conflict\n', 'utf8')
    await runGit(repoDir, ['mv', 'base-ua.md', 'ours-au.md'])
    await service.stageAll(repoDir)
    await service.commit(repoDir, 'ours commit')

    // Staged-only clean check before creating conflicts
    await writeFile(join(repoDir, 'staged-clean.md'), '# Staged clean v2\n', 'utf8')
    await service.stage(repoDir, ['staged-clean.md'])
    status = await service.discardAll(repoDir)
    expect(status.staged).toEqual([{ path: 'staged-clean.md', status: 'M' }])
    expect(status.unstaged).toEqual([])
    expect(status.untracked).toEqual([])
    expect(await readFile(join(repoDir, 'staged-clean.md'), 'utf8')).toBe('# Staged clean v2\n')

    // Commit staged-clean first so merge can start cleanly, then stage it again post-conflict
    await service.commit(repoDir, 'commit staged clean')
    await expect(runGit(repoDir, ['merge', 'theirs'])).rejects.toThrow()

    // Now mix U (UU + UA), M, D (deleted directory), MM (staged + unstaged), staged-only, and ? (in subws + nested)
    await writeFile(join(repoDir, 'staged-clean.md'), '# Staged clean v3\n', 'utf8')
    await writeFile(join(repoDir, 'mm.md'), '# MM staged v2\n', 'utf8')
    await service.stage(repoDir, ['staged-clean.md', 'mm.md'])
    await writeFile(join(repoDir, 'mm.md'), '# MM unstaged v3\n', 'utf8')
    await writeFile(join(repoDir, 'mod.md'), '# Mod dirty\n', 'utf8')
    await rm(join(repoDir, 'nested'), { recursive: true, force: true })
    await writeFile(join(repoDir, 'subws', 'sub-mod.md'), '# Sub dirty\n', 'utf8')
    await writeFile(join(repoDir, 'subws', 'untracked.md'), '# Sub untracked\n', 'utf8')
    await mkdir(join(repoDir, 'untracked-dir'), { recursive: true })
    await writeFile(join(repoDir, 'untracked-dir', 'draft.md'), '# Draft\n', 'utf8')

    const trashedPaths: string[] = []
    const trashService = createService({
      trashItem: async (targetPath: string) => {
        trashedPaths.push(targetPath)
        await rm(targetPath, { recursive: true, force: true })
      }
    })

    status = await trashService.discardAll(join(repoDir, 'subws'))
    expect(status.hasConflicts).toBe(false)
    expect(status.unstaged).toEqual([])
    expect(status.untracked).toEqual([])
    expect(status.staged.map((f) => `${f.status}:${f.path}`).sort()).toEqual([
      'M:mm.md',
      'M:staged-clean.md'
    ])

    expect(await readFile(join(repoDir, 'mod.md'), 'utf8')).toBe('# Mod v1\n')
    expect(await readFile(join(repoDir, 'nested', 'del.md'), 'utf8')).toBe('# Del v1\n')
    expect(await readFile(join(repoDir, 'mm.md'), 'utf8')).toBe('# MM staged v2\n')
    expect(await readFile(join(repoDir, 'staged-clean.md'), 'utf8')).toBe('# Staged clean v3\n')
    expect(await readFile(join(repoDir, 'subws', 'sub-mod.md'), 'utf8')).toBe('# Sub v1\n')
    expect(await readFile(join(repoDir, 'conflict-both.md'), 'utf8')).toBe('ours conflict\n')
    expect(await readFile(join(repoDir, 'ours-au.md'), 'utf8')).toBe(
      'ua line 1\nua line 2\nua line 3\n'
    )
    await expect(lstat(join(repoDir, 'theirs-ua.md'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(lstat(join(repoDir, 'base-ua.md'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(trashedPaths.sort()).toEqual(
      [join(realRepoDir, 'subws', 'untracked.md'), join(realRepoDir, 'untracked-dir', 'draft.md')].sort()
    )

    // 3. Fallback deletion without trashItem + idempotent second call
    await writeFile(join(repoDir, 'fallback.md'), '# Fallback\n', 'utf8')
    status = await service.discardAll(repoDir)
    expect(status.unstaged).toEqual([])
    expect(status.untracked).toEqual([])
    await expect(lstat(join(repoDir, 'fallback.md'))).rejects.toMatchObject({ code: 'ENOENT' })

    const idempotent = await service.discardAll(repoDir)
    expect(idempotent.unstaged).toEqual([])
    expect(idempotent.untracked).toEqual([])
  }), 60_000)
})
