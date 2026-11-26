import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GIT_IPC_CHANNELS } from '@shared/ipc'
import type { IpcMainLike } from '../ipc/ipcHelpers'
import { registerGitIpc } from '../ipc/registerGitIpc'
import { WorkspaceFsService } from '../workspace/WorkspaceFsService'
import { createGitTestSandbox, type GitTestSandbox } from './gitTestSandbox'

interface RecordedGitCall {
  kind: 'execFile' | 'spawn'
  args: string[]
  cwd: string | undefined
}

const recordedCalls = vi.hoisted((): RecordedGitCall[] => [])

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const { promisify } = await import('node:util')
  const actualExecFileAsync = promisify(actual.execFile)

  const recordGitCall = (
    kind: RecordedGitCall['kind'],
    executable: string,
    args: unknown,
    options: unknown
  ): void => {
    if (executable === 'git' && Array.isArray(args)) {
      const opts =
        options && typeof options === 'object' ? (options as { cwd?: string }) : undefined
      recordedCalls.push({ kind, args: args.map(String), cwd: opts?.cwd })
    }
  }

  const execFileWrapper = ((file: string, args: unknown, options: unknown, callback: unknown) => {
    recordGitCall('execFile', file, args, options)
    return (actual.execFile as (...params: unknown[]) => unknown)(file, args, options, callback)
  }) as typeof actual.execFile

  Object.defineProperty(execFileWrapper, promisify.custom, {
    value: (file: string, args: unknown, options: unknown) => {
      recordGitCall('execFile', file, args, options)
      return (actualExecFileAsync as (...params: unknown[]) => unknown)(file, args, options)
    }
  })

  return {
    ...actual,
    execFile: execFileWrapper,
    spawn: ((command: string, args: unknown, options: unknown) => {
      recordGitCall('spawn', command, args, options)
      return (actual.spawn as (...params: unknown[]) => unknown)(command, args, options)
    }) as typeof actual.spawn
  }
})

function countGitSubcommand(calls: readonly RecordedGitCall[], subcommand: string): number {
  return calls.filter((call) => call.args.includes(subcommand)).length
}

describe('GitService compare/diff process minimization & repoRoot caching', () => {
  let sandbox: GitTestSandbox

  beforeEach(async () => {
    recordedCalls.length = 0
    sandbox = await createGitTestSandbox()
  })

  afterEach(async () => {
    await sandbox.cleanup()
  })

  it('caches repoRoot across calls, invalidates on missing .git, nested .git, or init, and bypasses cache when GIT_DIR is set', async () => {
    await sandbox.runGit(sandbox.repoDir, ['init'])
    const subDir = join(sandbox.repoDir, 'nested', 'docs')
    await mkdir(subDir, { recursive: true })
    await writeFile(join(subDir, 'note.md'), '# Note\n', 'utf8')
    await sandbox.runGit(sandbox.repoDir, ['add', '.'])
    await sandbox.runGit(sandbox.repoDir, ['commit', '-m', 'init'])

    recordedCalls.length = 0
    await sandbox.service.status(subDir)
    expect(countGitSubcommand(recordedCalls, '--show-toplevel')).toBe(1)

    // Second call on same subdirectory reuses cached repoRoot without rev-parse --show-toplevel
    recordedCalls.length = 0
    await sandbox.service.status(subDir)
    expect(countGitSubcommand(recordedCalls, '--show-toplevel')).toBe(0)

    // Creating a nested .git externally inside subDir invalidates cache on next call
    await sandbox.runGit(subDir, ['init'])
    recordedCalls.length = 0
    const nestedStatus = await sandbox.service.status(subDir)
    expect(nestedStatus.repoRoot).toContain('docs')
    expect(countGitSubcommand(recordedCalls, '--show-toplevel')).toBe(1)

    // Removing .git invalidates cache on next call
    await rm(join(subDir, '.git'), { recursive: true, force: true })
    recordedCalls.length = 0
    const parentStatus = await sandbox.service.status(subDir)
    expect(parentStatus.repoRoot).not.toContain('docs')
    expect(countGitSubcommand(recordedCalls, '--show-toplevel')).toBe(1)

    // service.init() also invalidates cache
    recordedCalls.length = 0
    const initStatus = await sandbox.service.init(subDir)
    expect(initStatus.repoRoot).toContain('docs')
    expect(countGitSubcommand(recordedCalls, '--show-toplevel')).toBe(1)

    // Custom GIT_DIR env bypasses repoRoot cache
    const customGitDirService = sandbox.createService({
      env: { GIT_DIR: join(sandbox.repoDir, '.git') }
    })
    recordedCalls.length = 0
    await customGitDirService.status(sandbox.repoDir)
    await customGitDirService.status(sandbox.repoDir)
    expect(countGitSubcommand(recordedCalls, '--show-toplevel')).toBe(2)
  }, 60_000)

  it('executes a single git diff process when mergeBaseHash is provided, validates mergeBaseHash, and preserves unborn error & backward compatibility', async () => {
    await sandbox.runGit(sandbox.repoDir, ['init'])
    await writeFile(join(sandbox.repoDir, 'notes.md'), 'base line\n', 'utf8')
    await sandbox.runGit(sandbox.repoDir, ['add', '.'])
    await sandbox.runGit(sandbox.repoDir, ['commit', '-m', 'base commit'])
    const mergeBaseHash = (await sandbox.runGit(sandbox.repoDir, ['rev-parse', 'HEAD'])).trim()

    await sandbox.runGit(sandbox.repoDir, ['checkout', '-b', 'feature/diff'])
    await writeFile(join(sandbox.repoDir, 'notes.md'), 'base line\nfeature line\n', 'utf8')
    await sandbox.runGit(sandbox.repoDir, ['add', '.'])
    await sandbox.runGit(sandbox.repoDir, ['commit', '-m', 'feature commit'])

    await sandbox.runGit(sandbox.repoDir, ['checkout', 'main'])
    await writeFile(join(sandbox.repoDir, 'main-only.md'), 'main only\n', 'utf8')
    await sandbox.runGit(sandbox.repoDir, ['add', '.'])
    await sandbox.runGit(sandbox.repoDir, ['commit', '-m', 'main commit'])

    // Warm repoRoot cache
    await sandbox.service.status(sandbox.repoDir)

    // 1. With mergeBaseHash string: only 1 git process (diff <mergeBaseHash>..feature/diff)
    recordedCalls.length = 0
    const fastDiff = await sandbox.service.diff(sandbox.repoDir, {
      kind: 'branch-compare',
      baseRef: 'main',
      compareRef: 'feature/diff',
      mode: 'three-dot',
      mergeBaseHash,
      path: 'notes.md',
      status: 'M'
    })
    expect(fastDiff.rawPatch).toContain('+feature line')
    expect(recordedCalls).toHaveLength(1)
    expect(recordedCalls[0].args).toContain('diff')
    expect(recordedCalls[0].args).toContain(`${mergeBaseHash}..feature/diff`)

    // 2. With mergeBaseHash: null (no common ancestor): only 1 git process (diff main..feature/diff)
    recordedCalls.length = 0
    const nullBaseDiff = await sandbox.service.diff(sandbox.repoDir, {
      kind: 'branch-compare',
      baseRef: 'main',
      compareRef: 'feature/diff',
      mode: 'three-dot',
      mergeBaseHash: null,
      path: 'notes.md',
      status: 'M'
    })
    expect(nullBaseDiff.rawPatch).toContain('+feature line')
    expect(recordedCalls).toHaveLength(1)
    expect(recordedCalls[0].args).toContain('main..feature/diff')

    // 3. Without mergeBaseHash (backward compat): still works, and two-dot runs only 1 git diff process
    recordedCalls.length = 0
    const twoDotDiff = await sandbox.service.diff(sandbox.repoDir, {
      kind: 'branch-compare',
      baseRef: 'main',
      compareRef: 'feature/diff',
      mode: 'two-dot',
      path: 'notes.md',
      status: 'M'
    })
    expect(twoDotDiff.rawPatch).toContain('+feature line')
    expect(recordedCalls).toHaveLength(1)
    expect(recordedCalls[0].args).toContain('main..feature/diff')

    const legacyDiff = await sandbox.service.diff(sandbox.repoDir, {
      kind: 'branch-compare',
      baseRef: 'main',
      compareRef: 'feature/diff',
      mode: 'three-dot',
      path: 'notes.md',
      status: 'M'
    })
    expect(legacyDiff.rawPatch).toBe(fastDiff.rawPatch)

    // 4. Invalid mergeBaseHash formats are rejected
    for (const badHash of ['--output=/tmp/pwn', 'main..HEAD', 'not-hex', '12345']) {
      await expect(
        sandbox.service.diff(sandbox.repoDir, {
          kind: 'branch-compare',
          baseRef: 'main',
          compareRef: 'feature/diff',
          mode: 'three-dot',
          mergeBaseHash: badHash,
          path: 'notes.md',
          status: 'M'
        })
      ).rejects.toThrow(/유효한/)
    }

    // 5. Unborn repo preserves friendly error message even when mergeBaseHash is supplied
    const unbornDir = join(sandbox.tempRoot, 'unborn-diff')
    await mkdir(unbornDir, { recursive: true })
    await sandbox.runGit(unbornDir, ['init'])
    await expect(
      sandbox.service.diff(unbornDir, {
        kind: 'branch-compare',
        baseRef: 'main',
        compareRef: 'feature/diff',
        mode: 'three-dot',
        mergeBaseHash,
        path: 'notes.md',
        status: 'M'
      })
    ).rejects.toThrow('아직 커밋된 내역이 없어 브랜치를 비교할 수 없습니다.')
  }, 60_000)

  it('runs a single combined --raw --numstat -z -M git diff in compareSummary and works end-to-end through registerGitIpc', async () => {
    await sandbox.runGit(sandbox.repoDir, ['init'])
    await writeFile(join(sandbox.repoDir, 'shared.md'), 'line 1\nline 2\n', 'utf8')
    await writeFile(join(sandbox.repoDir, 'rename-me.md'), 'rename body\n', 'utf8')
    await writeFile(join(sandbox.repoDir, 'remove-me.md'), 'delete me\n', 'utf8')
    await sandbox.runGit(sandbox.repoDir, ['add', '.'])
    await sandbox.runGit(sandbox.repoDir, ['commit', '-m', 'base init'])
    const mergeBaseHash = (await sandbox.runGit(sandbox.repoDir, ['rev-parse', 'HEAD'])).trim()

    await sandbox.runGit(sandbox.repoDir, ['checkout', '-b', 'feature/topic'])
    await writeFile(join(sandbox.repoDir, 'shared.md'), 'line 1\nline 2 updated\nline 3\n', 'utf8')
    await writeFile(join(sandbox.repoDir, 'added.md'), 'new 1\nnew 2\n', 'utf8')
    await sandbox.runGit(sandbox.repoDir, ['mv', 'rename-me.md', 'renamed.md'])
    await sandbox.runGit(sandbox.repoDir, ['rm', 'remove-me.md'])
    await writeFile(
      join(sandbox.repoDir, 'icon.png'),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01])
    )
    await sandbox.runGit(sandbox.repoDir, ['add', '.'])
    await sandbox.runGit(sandbox.repoDir, ['commit', '-m', 'feature work'])

    await sandbox.runGit(sandbox.repoDir, ['checkout', 'main'])
    await writeFile(join(sandbox.repoDir, 'main-only.md'), 'main extra\n', 'utf8')
    await sandbox.runGit(sandbox.repoDir, ['add', 'main-only.md'])
    await sandbox.runGit(sandbox.repoDir, ['commit', '-m', 'main work'])

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

      // Warm repoRoot cache
      await invoke(GIT_IPC_CHANNELS.compareRefs, opened.rootPath)

      recordedCalls.length = 0
      const summary = (await invoke(GIT_IPC_CHANNELS.compareSummary, opened.rootPath, {
        baseRef: 'main',
        compareRef: 'feature/topic',
        mode: 'three-dot'
      })) as Awaited<ReturnType<typeof sandbox.service.compareSummary>>

      const diffCalls = recordedCalls.filter((c) => c.args.includes('diff'))
      expect(diffCalls).toHaveLength(1)
      expect(diffCalls[0].args).toEqual(
        expect.arrayContaining(['--raw', '--numstat', '-z', '-M', `${mergeBaseHash}..feature/topic`])
      )

      expect(summary.mergeBaseHash).toBe(mergeBaseHash)
      expect(summary.totalAdditions).toBe(4)
      expect(summary.totalDeletions).toBe(2)
      expect(summary.files).toEqual(
        expect.arrayContaining([
          { path: 'added.md', status: 'A', additions: 2, deletions: 0, isBinary: false },
          { path: 'shared.md', status: 'M', additions: 2, deletions: 1, isBinary: false },
          {
            path: 'renamed.md',
            origPath: 'rename-me.md',
            status: 'R',
            additions: 0,
            deletions: 0,
            isBinary: false
          },
          { path: 'remove-me.md', status: 'D', additions: 0, deletions: 1, isBinary: false },
          { path: 'icon.png', status: 'A', additions: null, deletions: null, isBinary: true }
        ])
      )

      // Subsequent diff via IPC with mergeBaseHash runs only 1 git diff process
      recordedCalls.length = 0
      const diffResult = await invoke(GIT_IPC_CHANNELS.diff, opened.rootPath, {
        kind: 'branch-compare',
        baseRef: 'main',
        compareRef: 'feature/topic',
        mode: 'three-dot',
        mergeBaseHash: summary.mergeBaseHash,
        path: 'shared.md',
        status: 'M'
      })
      expect(diffResult).toMatchObject({ path: 'shared.md', isBinary: false })
      expect(recordedCalls).toHaveLength(1)
      expect(recordedCalls[0].args).toContain(`${mergeBaseHash}..feature/topic`)
    } finally {
      dispose()
      workspaceService.dispose()
    }
  }, 60_000)
})
