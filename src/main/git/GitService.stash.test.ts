import { lstat, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { withGitTestSandbox } from './gitTestSandbox'

describe('GitService integration (stash)', () => {
  it('lists stash entries (empty on unborn, parses branch/custom messages/ISO timestamps) and validates stashRef format', () =>
    withGitTestSandbox(async ({ service, repoDir, nonGitDir, runGit }) => {
      await expect(service.stashList(nonGitDir)).rejects.toThrow(/Git 저장소가 아닙니다/)

      await service.init(repoDir)
      await runGit(repoDir, ['config', 'user.name', 'Wiki Tester'])
      await runGit(repoDir, ['config', 'user.email', 'tester@example.com'])

      // Unborn repo returns []
      expect(await service.stashList(repoDir)).toEqual([])

      // Seed initial commit
      await writeFile(join(repoDir, 'notes.md'), '# Init\n', 'utf8')
      await service.stageAll(repoDir)
      await service.commit(repoDir, 'initial commit')
      expect(await service.stashList(repoDir)).toEqual([])

      // Create two stashes via git CLI (default WIP message + custom message with colon/dash + detached HEAD)
      await writeFile(join(repoDir, 'notes.md'), '# WIP edit\n', 'utf8')
      await runGit(repoDir, ['stash', 'push'])

      await writeFile(join(repoDir, 'notes.md'), '# Custom edit\n', 'utf8')
      await runGit(repoDir, ['stash', 'push', '--message=-wip: save draft'])

      await runGit(repoDir, ['checkout', '--detach', 'HEAD'])
      await writeFile(join(repoDir, 'notes.md'), '# Detached edit\n', 'utf8')
      await runGit(repoDir, ['stash', 'push', '-m', 'detached note'])

      const entries = await service.stashList(repoDir)
      expect(entries).toHaveLength(3)
      expect(entries[0]).toMatchObject({
        ref: 'stash@{0}',
        branch: null,
        message: 'detached note'
      })
      expect(entries[0].hash).toMatch(/^[0-9a-f]{40}$/i)
      expect(Number.isNaN(Date.parse(entries[0].createdAt))).toBe(false)

      expect(entries[1]).toMatchObject({
        ref: 'stash@{1}',
        branch: 'main',
        message: '-wip: save draft'
      })

      expect(entries[2].ref).toBe('stash@{2}')
      expect(entries[2].branch).toBe('main')
      expect(entries[2].message).toContain('initial commit')

      // Reject malformed stashRef values in stashApply / stashPop
      for (const badRef of ['', 'HEAD', 'stash@{0}^', 'stash@{-1}', '--all', 'stash@{0} ', 'main']) {
        await expect(service.stashApply(repoDir, badRef)).rejects.toThrow(/Stash 참조/)
        await expect(service.stashPop(repoDir, badRef)).rejects.toThrow(/Stash 참조/)
      }
    }), 60_000)

  it('stashes only Changes (unstaged M/D and optional untracked ?) while preserving isolated Staged Changes and falling back to --keep-index on MM overlap', () =>
    withGitTestSandbox(async ({ service, repoDir, runGit }) => {
      await service.init(repoDir)
      await runGit(repoDir, ['config', 'user.name', 'Wiki Tester'])
      await runGit(repoDir, ['config', 'user.email', 'tester@example.com'])

      await mkdir(join(repoDir, 'subws'), { recursive: true })
      await writeFile(join(repoDir, 'staged-doc.md'), '# Staged v1\n', 'utf8')
      await writeFile(join(repoDir, 'unstaged-doc.md'), '# Unstaged v1\n', 'utf8')
      await writeFile(join(repoDir, 'deleted-doc.md'), '# Deleted v1\n', 'utf8')
      await writeFile(join(repoDir, 'mm-doc.md'), '# MM v1\n', 'utf8')
      await writeFile(join(repoDir, 'subws', '-dash 한글.md'), '# Sub v1\n', 'utf8')
      await service.stageAll(repoDir)
      await service.commit(repoDir, 'seed files')

      // 1. Disjoint staged + unstaged + untracked -> pathspec isolation preserves staged-doc completely
      await writeFile(join(repoDir, 'staged-doc.md'), '# Staged v2\n', 'utf8')
      await service.stage(repoDir, ['staged-doc.md'])
      await writeFile(join(repoDir, 'unstaged-doc.md'), '# Unstaged v2\n', 'utf8')
      await rm(join(repoDir, 'deleted-doc.md'))
      await writeFile(join(repoDir, 'subws', '-dash 한글.md'), '# Sub dirty\n', 'utf8')
      await writeFile(join(repoDir, 'draft.md'), '# Untracked Draft\n', 'utf8')

      // includeUntracked: false leaves draft.md untracked while stashing tracked unstaged edits
      let status = await service.stashCreate(join(repoDir, 'subws'), {
        scope: 'unstaged',
        message: 'only tracked changes',
        includeUntracked: false
      })
      expect(status.staged).toEqual([{ path: 'staged-doc.md', status: 'M' }])
      expect(status.unstaged).toEqual([])
      expect(status.untracked).toEqual([{ path: 'draft.md', status: '?' }])
      expect(await readFile(join(repoDir, 'staged-doc.md'), 'utf8')).toBe('# Staged v2\n')
      expect(await readFile(join(repoDir, 'unstaged-doc.md'), 'utf8')).toBe('# Unstaged v1\n')
      expect(await readFile(join(repoDir, 'deleted-doc.md'), 'utf8')).toBe('# Deleted v1\n')
      expect(await readFile(join(repoDir, 'draft.md'), 'utf8')).toBe('# Untracked Draft\n')

      // Verify staged-doc was NOT changed beyond the index (^2..stash) in the pathspec-isolated stash
      const isolatedStashShow = await runGit(repoDir, [
        '-c',
        'core.quotePath=false',
        'diff',
        '--name-only',
        'stash@{0}^2',
        'stash@{0}'
      ])
      expect(isolatedStashShow.trim().split(/\r?\n/)).toEqual([
        'deleted-doc.md',
        'subws/-dash 한글.md',
        'unstaged-doc.md'
      ])

      // Now stash untracked draft.md with default includeUntracked: true
      status = await service.stashCreate(repoDir, {
        scope: 'unstaged'
      })
      expect(status.staged).toEqual([{ path: 'staged-doc.md', status: 'M' }])
      expect(status.unstaged).toEqual([])
      expect(status.untracked).toEqual([])
      await expect(lstat(join(repoDir, 'draft.md'))).rejects.toMatchObject({ code: 'ENOENT' })

      // 2. Overlapping MM file (staged + unstaged on mm-doc.md) + untracked -> falls back to --keep-index
      await writeFile(join(repoDir, 'mm-doc.md'), '# MM staged v2\n', 'utf8')
      await service.stage(repoDir, ['mm-doc.md'])
      await writeFile(join(repoDir, 'mm-doc.md'), '# MM unstaged v3\n', 'utf8')
      await writeFile(join(repoDir, 'mm-untracked.md'), '# MM untracked\n', 'utf8')

      status = await service.stashCreate(repoDir, {
        scope: 'unstaged',
        message: 'mm fallback'
      })
      expect(status.staged.map((f) => `${f.status}:${f.path}`).sort()).toEqual([
        'M:mm-doc.md',
        'M:staged-doc.md'
      ])
      expect(status.unstaged).toEqual([])
      expect(status.untracked).toEqual([])
      expect(await readFile(join(repoDir, 'mm-doc.md'), 'utf8')).toBe('# MM staged v2\n')
      await expect(lstat(join(repoDir, 'mm-untracked.md'))).rejects.toMatchObject({ code: 'ENOENT' })

      const entries = await service.stashList(repoDir)
      expect(entries.map((e) => e.message)).toHaveLength(3)
      expect(entries[0].message).toBe('mm fallback')
    }), 60_000)

  it('supports scope=all and scope=paths stash creation, blocks unborn/empty targets, and enforces path security', () =>
    withGitTestSandbox(async ({ service, tempRoot, repoDir, runGit }) => {
      await service.init(repoDir)
      await runGit(repoDir, ['config', 'user.name', 'Wiki Tester'])
      await runGit(repoDir, ['config', 'user.email', 'tester@example.com'])

      // 1. Unborn repo error
      await writeFile(join(repoDir, 'seed.md'), '# Seed\n', 'utf8')
      await expect(service.stashCreate(repoDir, { scope: 'unstaged' })).rejects.toThrow(
        /아직 커밋된 내역이 없어/
      )
      await expect(service.stashCreate(repoDir, { scope: 'all' })).rejects.toThrow(
        /아직 커밋된 내역이 없어/
      )

      await service.stageAll(repoDir)
      await service.commit(repoDir, 'seed')

      // 2. Empty target errors across scopes & includeUntracked: false with only untracked files
      await expect(service.stashCreate(repoDir, { scope: 'unstaged' })).rejects.toThrow(
        /보관할 변경 사항이 없습니다/
      )
      await expect(service.stashCreate(repoDir, { scope: 'all' })).rejects.toThrow(
        /보관할 변경 사항이 없습니다/
      )
      await expect(service.stashCreate(repoDir, { scope: 'paths', paths: [] })).rejects.toThrow(
        /대상 파일 경로/
      )

      await writeFile(join(repoDir, 'only-untracked.md'), '# Untracked\n', 'utf8')
      await expect(
        service.stashCreate(repoDir, { scope: 'unstaged', includeUntracked: false })
      ).rejects.toThrow(/보관할 변경 사항이 없습니다/)
      await expect(
        service.stashCreate(repoDir, { scope: 'all', includeUntracked: false })
      ).rejects.toThrow(/보관할 변경 사항이 없습니다/)
      await expect(
        service.stashCreate(repoDir, {
          scope: 'paths',
          paths: ['only-untracked.md'],
          includeUntracked: false
        })
      ).rejects.toThrow(/보관할 변경 사항이 없습니다/)

      // 3. Path security for scope='paths'
      const outsideDir = join(tempRoot, 'outside-stash')
      await mkdir(outsideDir, { recursive: true })
      const outsideFile = join(outsideDir, 'secret.md')
      await writeFile(outsideFile, 'secret', 'utf8')

      await expect(
        service.stashCreate(repoDir, { scope: 'paths', paths: ['../outside-stash/secret.md'] })
      ).rejects.toThrow(/저장소 밖/)
      await expect(
        service.stashCreate(repoDir, { scope: 'paths', paths: [outsideFile] })
      ).rejects.toThrow(/저장소 밖/)
      await expect(
        service.stashCreate(repoDir, { scope: 'paths', paths: ['.git/config'] })
      ).rejects.toThrow(/\.git|시스템/)

      try {
        const escapeLink = join(repoDir, 'escape-stash')
        const gitLink = join(repoDir, 'git-stash-link')
        await symlink(outsideDir, escapeLink, 'junction')
        await symlink(join(repoDir, '.git'), gitLink, 'junction')
        await expect(
          service.stashCreate(repoDir, { scope: 'paths', paths: ['escape-stash/secret.md'] })
        ).rejects.toThrow(/저장소 밖/)
        await expect(
          service.stashCreate(repoDir, { scope: 'paths', paths: ['git-stash-link/config'] })
        ).rejects.toThrow(/\.git|시스템/)
        await rm(escapeLink, { force: true })
        await rm(gitLink, { force: true })
      } catch {
        // Symlink/junction creation may require elevated permissions on some Windows environments
      }

      // 4. scope='paths' stashes only selected file and leaves other changes intact
      await writeFile(join(repoDir, 'seed.md'), '# Seed modified\n', 'utf8')
      let status = await service.stashCreate(repoDir, {
        scope: 'paths',
        paths: ['only-untracked.md'],
        message: 'single untracked'
      })
      expect(status.untracked).toEqual([])
      expect(status.unstaged).toEqual([{ path: 'seed.md', status: 'M' }])

      // 5. scope='all' stashes staged + unstaged + untracked together
      await writeFile(join(repoDir, 'staged-all.md'), '# Staged all\n', 'utf8')
      await service.stage(repoDir, ['staged-all.md'])
      await writeFile(join(repoDir, 'untracked-all.md'), '# Untracked all\n', 'utf8')
      status = await service.stashCreate(repoDir, {
        scope: 'all',
        message: 'stash everything'
      })
      expect(status.staged).toEqual([])
      expect(status.unstaged).toEqual([])
      expect(status.untracked).toEqual([])

      const entries = await service.stashList(repoDir)
      expect(entries.slice(0, 2).map((e) => e.message)).toEqual([
        'stash everything',
        'single untracked'
      ])
    }), 60_000)

  it('restores Changes via stashApply (keeps entry) and stashPop (removes entry on success, preserves entry on conflict) and suggests Stash on local overwrite errors', () =>
    withGitTestSandbox(async ({ service, repoDir, runGit }) => {
      await service.init(repoDir)
      await runGit(repoDir, ['config', 'user.name', 'Wiki Tester'])
      await runGit(repoDir, ['config', 'user.email', 'tester@example.com'])

      await writeFile(join(repoDir, 'doc.md'), '# Base\n', 'utf8')
      await service.stageAll(repoDir)
      await service.commit(repoDir, 'base commit')

      // Create stash with staged + unstaged + untracked via scope='all'
      await writeFile(join(repoDir, 'doc.md'), '# Stashed Change\n', 'utf8')
      await service.stage(repoDir, ['doc.md'])
      await writeFile(join(repoDir, 'new-draft.md'), '# Stashed Untracked\n', 'utf8')
      await service.stashCreate(repoDir, { scope: 'all', message: 'restore me' })

      // 1. stashApply restores into working tree (Changes, no --index) and keeps stash entry
      let status = await service.stashApply(repoDir, 'stash@{0}')
      expect(status.staged).toEqual([])
      expect(status.unstaged).toEqual([{ path: 'doc.md', status: 'M' }])
      expect(status.untracked).toEqual([{ path: 'new-draft.md', status: '?' }])
      expect(await readFile(join(repoDir, 'doc.md'), 'utf8')).toBe('# Stashed Change\n')
      expect(await readFile(join(repoDir, 'new-draft.md'), 'utf8')).toBe('# Stashed Untracked\n')
      expect(await service.stashList(repoDir)).toHaveLength(1)

      // 2. Trying to stashPop/stashApply when uncommitted local change collides -> fails with Stash hint & preserves stash
      await expect(service.stashPop(repoDir, 'stash@{0}')).rejects.toThrow(
        /커밋하거나 Stash로 임시 보관/
      )
      expect(await service.stashList(repoDir)).toHaveLength(1)

      // Clean working tree -> stashPop restores cleanly and removes stash entry
      await service.discardAll(repoDir)
      status = await service.stashPop(repoDir, 'stash@{0}')
      expect(status.unstaged).toEqual([{ path: 'doc.md', status: 'M' }])
      expect(status.untracked).toEqual([{ path: 'new-draft.md', status: '?' }])
      expect(await service.stashList(repoDir)).toEqual([])

      // 3. Conflict during stashPop preserves the stash entry and returns conflict error
      await service.stashCreate(repoDir, { scope: 'unstaged', message: 'conflict stash' })
      await writeFile(join(repoDir, 'doc.md'), '# Conflicting Commit\n', 'utf8')
      await service.stage(repoDir, ['doc.md'])
      await service.commit(repoDir, 'divergent commit')

      await expect(service.stashPop(repoDir, 'stash@{0}')).rejects.toThrow(/충돌/)
      const entriesAfterConflict = await service.stashList(repoDir)
      expect(entriesAfterConflict).toHaveLength(1)
      expect(entriesAfterConflict[0].message).toBe('conflict stash')
      const conflictStatus = await service.status(repoDir)
      expect(conflictStatus.hasConflicts).toBe(true)
    }), 60_000)

  it('drops individual stashes with ref renumbering, clears all stashes idempotently, and blocks non-repo/invalid/missing stashRefs', () =>
    withGitTestSandbox(async ({ service, repoDir, nonGitDir, runGit }) => {
      await expect(service.stashDrop(nonGitDir, 'stash@{0}')).rejects.toThrow(/Git 저장소가 아닙니다/)
      await expect(service.stashClear(nonGitDir)).rejects.toThrow(/Git 저장소가 아닙니다/)

      await service.init(repoDir)
      await runGit(repoDir, ['config', 'user.name', 'Wiki Tester'])
      await runGit(repoDir, ['config', 'user.email', 'tester@example.com'])

      // Unborn repo: stashClear returns [] cleanly, malformed stashRefs are rejected
      expect(await service.stashClear(repoDir)).toEqual([])
      for (const badRef of ['', 'HEAD', 'stash@{0}^', 'stash@{-1}', '--all', 'stash@{0} ', 'main']) {
        await expect(service.stashDrop(repoDir, badRef)).rejects.toThrow(/Stash 참조/)
      }

      await mkdir(join(repoDir, 'subws'), { recursive: true })
      await writeFile(join(repoDir, 'subws', 'note.md'), '# Base\n', 'utf8')
      await service.stageAll(repoDir)
      await service.commit(repoDir, 'seed')

      // Missing stash ref fails cleanly
      await expect(service.stashDrop(repoDir, 'stash@{0}')).rejects.toThrow(/Stash 항목/)

      // Create 3 stashes (oldest=first, middle=second, newest=third)
      for (const label of ['first stash', 'second stash', 'third stash']) {
        await writeFile(join(repoDir, 'subws', 'note.md'), `# ${label}\n`, 'utf8')
        await service.stashCreate(repoDir, { scope: 'unstaged', message: label })
      }

      await expect(service.stashDrop(repoDir, 'stash@{99}')).rejects.toThrow(/Stash 항목/)

      // Drop middle entry stash@{1} from subdirectory workspace -> remaining stashes renumber to stash@{0} and stash@{1}
      const afterDrop = await service.stashDrop(join(repoDir, 'subws'), 'stash@{1}')
      expect(afterDrop.map((entry) => `${entry.ref}:${entry.message}`)).toEqual([
        'stash@{0}:third stash',
        'stash@{1}:first stash'
      ])
      expect(await service.stashList(repoDir)).toEqual(afterDrop)

      // Clear all remaining stashes -> returns [] and subsequent clear is idempotent
      expect(await service.stashClear(join(repoDir, 'subws'))).toEqual([])
      expect(await service.stashList(repoDir)).toEqual([])
      expect(await service.stashClear(repoDir)).toEqual([])
    }), 60_000)
})
