import { rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import iconv from 'iconv-lite'
import { describe, expect, it } from 'vitest'
import { GIT_BLOB_SNAPSHOT_MAX_BYTES } from '@shared/symbol'
import { withGitTestSandbox } from './gitTestSandbox'

describe('GitService integration (readBlobSnapshot)', () => {
  it('reads commit, parent, branch, staged index, and stash (^3 untracked) blobs with EUC-KR, binary, 2MB cap, existsInWorkspace, and security checks', () =>
    withGitTestSandbox(async (sandbox) => {
      const { service, tempRoot, repoDir, nonGitDir, runGit } = sandbox

      await expect(
        service.readBlobSnapshot(nonGitDir, {
          path: 'app.ts',
          scope: { kind: 'git-ref', ref: 'HEAD', displayRef: 'HEAD' }
        })
      ).rejects.toThrow(/Git 저장소가 아닙니다/)

      await service.init(repoDir)

      // Commit 1 on main
      await writeFile(join(repoDir, 'app.ts'), 'export function greet() {\n  return "v1"\n}\n', 'utf8')
      await writeFile(join(repoDir, 'legacy.ts'), 'export const legacy = true\n', 'utf8')
      await writeFile(
        join(repoDir, 'euc.txt'),
        iconv.encode('한글 스냅샷 테스트\n둘째 줄\n', 'cp949')
      )
      await writeFile(join(repoDir, 'logo.bin'), Buffer.from([0x89, 0x50, 0x00, 0x0a]))
      await runGit(repoDir, ['add', '-A'])
      await runGit(repoDir, ['commit', '-m', 'initial commit'])
      const commit1 = (await runGit(repoDir, ['rev-parse', 'HEAD'])).trim()

      // Security checks: path traversal, outside absolute, .git, symlink escape, ref/hash injection
      const outsideFile = join(tempRoot, 'outside.ts')
      await writeFile(outsideFile, 'secret', 'utf8')
      await expect(
        service.readBlobSnapshot(repoDir, {
          path: '../outside.ts',
          scope: { kind: 'git-ref', ref: 'HEAD', displayRef: 'HEAD' }
        })
      ).rejects.toThrow(/저장소 밖/)
      await expect(
        service.readBlobSnapshot(repoDir, {
          path: outsideFile,
          scope: { kind: 'git-ref', ref: 'HEAD', displayRef: 'HEAD' }
        })
      ).rejects.toThrow(/저장소 밖/)
      await expect(
        service.readBlobSnapshot(repoDir, {
          path: '.git/config',
          scope: { kind: 'git-ref', ref: 'HEAD', displayRef: 'HEAD' }
        })
      ).rejects.toThrow(/\.git/)
      await expect(
        service.readBlobSnapshot(repoDir, {
          path: 'app.ts',
          scope: { kind: 'git-ref', ref: '--option', displayRef: 'bad' }
        })
      ).rejects.toThrow(/유효한/)
      await expect(
        service.readBlobSnapshot(repoDir, {
          path: 'app.ts',
          scope: { kind: 'git-ref', ref: 'HEAD:euc.txt', displayRef: 'bad' }
        })
      ).rejects.toThrow(/유효한/)
      await expect(
        service.readBlobSnapshot(repoDir, {
          path: 'app.ts',
          scope: { kind: 'git-ref', ref: 'HEAD', displayRef: 'HEAD' },
          stashHash: 'not-a-hash'
        })
      ).rejects.toThrow(/유효한/)

      try {
        const linkPath = join(repoDir, 'escape-link.ts')
        await symlink(outsideFile, linkPath)
        await expect(
          service.readBlobSnapshot(repoDir, {
            path: 'escape-link.ts',
            scope: { kind: 'git-ref', ref: 'HEAD', displayRef: 'HEAD' }
          })
        ).rejects.toThrow(/저장소 밖/)
        await rm(linkPath, { force: true })
      } catch {
        // Symlink creation may require Developer Mode on Windows
      }

      // Feature branch modifies app.ts and deletes legacy.ts
      await runGit(repoDir, ['checkout', '-b', 'feature'])
      await writeFile(join(repoDir, 'app.ts'), 'export function greet() {\n  return "v2"\n}\n', 'utf8')
      await rm(join(repoDir, 'legacy.ts'))
      await runGit(repoDir, ['add', '-A'])
      await runGit(repoDir, ['commit', '-m', 'feature changes'])
      const commit2 = (await runGit(repoDir, ['rev-parse', 'HEAD'])).trim()

      // Read commit2 and commit2^1
      const snapV2 = await service.readBlobSnapshot(repoDir, {
        path: 'app.ts',
        scope: { kind: 'git-ref', ref: commit2, displayRef: commit2.slice(0, 7) }
      })
      expect(snapV2).toEqual({
        path: 'app.ts',
        scope: { kind: 'git-ref', ref: commit2, displayRef: commit2.slice(0, 7) },
        isBinary: false,
        isTruncated: false,
        existsInWorkspace: true,
        encoding: 'utf-8',
        content: 'export function greet() {\n  return "v2"\n}\n'
      })

      const snapLegacyAtParent = await service.readBlobSnapshot(repoDir, {
        path: 'legacy.ts',
        scope: { kind: 'git-ref', ref: `${commit2}^1`, displayRef: `${commit2.slice(0, 7)}^1` }
      })
      expect(snapLegacyAtParent).toMatchObject({
        path: 'legacy.ts',
        isBinary: false,
        isTruncated: false,
        existsInWorkspace: false,
        encoding: 'utf-8',
        content: 'export const legacy = true\n'
      })

      // Read branch ref (main) while on feature
      const snapMain = await service.readBlobSnapshot(repoDir, {
        path: 'app.ts',
        scope: { kind: 'git-ref', ref: 'main', displayRef: 'main' }
      })
      expect(snapMain.content).toContain('"v1"')
      expect(snapMain.scope.kind).toBe('git-ref')

      // EUC-KR & Binary
      const eucSnap = await service.readBlobSnapshot(repoDir, {
        path: 'euc.txt',
        scope: { kind: 'git-ref', ref: commit1, displayRef: commit1.slice(0, 7) }
      })
      expect(eucSnap).toMatchObject({
        encoding: 'euc-kr',
        isBinary: false,
        isTruncated: false,
        content: '한글 스냅샷 테스트\n둘째 줄\n'
      })

      const binSnap = await service.readBlobSnapshot(repoDir, {
        path: 'logo.bin',
        scope: { kind: 'git-ref', ref: commit1, displayRef: commit1.slice(0, 7) }
      })
      expect(binSnap).toMatchObject({
        isBinary: true,
        isTruncated: false,
        content: ''
      })

      // Staged index vs working tree
      await writeFile(join(repoDir, 'app.ts'), 'export const staged = 1\n', 'utf8')
      await runGit(repoDir, ['add', 'app.ts'])
      await writeFile(join(repoDir, 'app.ts'), 'export const unstaged = 2\n', 'utf8')

      const stagedSnap = await service.readBlobSnapshot(repoDir, {
        path: 'app.ts',
        scope: { kind: 'git-index', displayRef: 'Staged' }
      })
      expect(stagedSnap).toMatchObject({
        path: 'app.ts',
        scope: { kind: 'git-index', displayRef: 'Staged' },
        isBinary: false,
        isTruncated: false,
        existsInWorkspace: true,
        encoding: 'utf-8',
        content: 'export const staged = 1\n'
      })

      // Stash including untracked file (^3)
      await writeFile(join(repoDir, 'stashed-untracked.ts'), 'export const fromStash = 42\n', 'utf8')
      await runGit(repoDir, ['stash', 'push', '--include-untracked', '-m', 'wip'])
      const stashHash = (await runGit(repoDir, ['rev-parse', 'stash@{0}'])).trim()

      const stashUntrackedSnap = await service.readBlobSnapshot(repoDir, {
        path: 'stashed-untracked.ts',
        scope: {
          kind: 'git-ref',
          ref: stashHash,
          displayRef: 'stash@{0}',
          untrackedParentRef: `${stashHash}^3`
        },
        stashHash
      })
      expect(stashUntrackedSnap).toMatchObject({
        path: 'stashed-untracked.ts',
        isBinary: false,
        isTruncated: false,
        existsInWorkspace: false,
        encoding: 'utf-8',
        content: 'export const fromStash = 42\n'
      })

      // >2MB truncation at safe multibyte boundary
      const largeContent = '가'.repeat(1_000_000) // ~3MB in UTF-8
      await writeFile(join(repoDir, 'huge.txt'), largeContent, 'utf8')
      await runGit(repoDir, ['add', 'huge.txt'])
      const hugeSnap = await service.readBlobSnapshot(repoDir, {
        path: 'huge.txt',
        scope: { kind: 'git-index', displayRef: 'Staged' }
      })
      expect(hugeSnap.isBinary).toBe(false)
      expect(hugeSnap.isTruncated).toBe(true)
      expect(Buffer.byteLength(hugeSnap.content, 'utf8')).toBeLessThanOrEqual(
        GIT_BLOB_SNAPSHOT_MAX_BYTES
      )
      expect(hugeSnap.content.includes('\uFFFD')).toBe(false)
    }))
})
