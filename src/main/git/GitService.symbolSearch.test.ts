import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import iconv from 'iconv-lite'
import { describe, expect, it } from 'vitest'
import { ConfigService } from '../config/ConfigService'
import { createSharedDocumentBufferHub } from '../ipc/registerBufferIpc'
import { createDiskWorkspaceQueryAndSchemaHub } from '../workspace/diskWorkspaceQueryAndSchema'
import { WorkspaceFsService } from '../workspace/WorkspaceFsService'
import { withGitTestSandbox } from './gitTestSandbox'

describe('GitService + WorkspaceQueryAndSchemaHub integration (searchSymbols)', () => {
  it('searches working-tree (git grep + dirty buffer + untracked), non-Git fallback, git-ref, git-index, stash ^3, and enforces exclusions & security', () =>
    withGitTestSandbox(async (sandbox) => {
      const { service, tempRoot, repoDir, nonGitDir, runGit } = sandbox
      const configService = new ConfigService(join(tempRoot, 'config.json'))
      await configService.get()

      const workspaceService = new WorkspaceFsService({ watchDebounceMs: 25 })
      const bufferHub = createSharedDocumentBufferHub({ workspaceService, configService })
      const hub = createDiskWorkspaceQueryAndSchemaHub({
        workspaceService,
        bufferHub,
        gitService: service,
        watchDebounceMs: 25
      })

      try {
        // 1. Non-Git folder fallback + dirty buffer
        await writeFile(
          join(nonGitDir, 'helper.ts'),
          'export function calcTotal(a: number) {\n  return a + 1\n}\n',
          'utf8'
        )
        await mkdir(join(nonGitDir, 'node_modules', 'pkg'), { recursive: true })
        await writeFile(
          join(nonGitDir, 'node_modules', 'pkg', 'index.ts'),
          'export function calcTotal() { return 0 }\n',
          'utf8'
        )
        await workspaceService.openWorkspace(nonGitDir)

        const nonGitMatches = await hub.searchSymbols({
          symbolName: 'calcTotal',
          scope: { kind: 'working-tree' }
        })
        expect(nonGitMatches).toHaveLength(1)
        expect(nonGitMatches[0]).toMatchObject({
          path: 'helper.ts',
          lineNumber: 1,
          columnStart: 16,
          columnEnd: 25
        })

        // 2. Git repo setup
        await service.init(repoDir)
        await mkdir(join(repoDir, 'src'), { recursive: true })
        await mkdir(join(repoDir, '.wiki-editor'), { recursive: true })
        await mkdir(join(repoDir, 'node_modules', 'dep'), { recursive: true })

        await writeFile(
          join(repoDir, 'src', 'parser.ts'),
          [
            'export function parseToken(input: string) {',
            '  return input.trim()',
            '}',
            'export function parseTokenAsync(input: string) {',
            '  return Promise.resolve(parseToken(input))',
            '}'
          ].join('\n'),
          'utf8'
        )
        await writeFile(
          join(repoDir, 'src', 'korean.ts'),
          iconv.encode('// 한글 주석\nexport const koreanValue = "안녕"\n', 'cp949')
        )
        await writeFile(
          join(repoDir, '.wiki-editor', 'ignored.ts'),
          'export function parseToken() {}\n',
          'utf8'
        )
        await writeFile(
          join(repoDir, 'node_modules', 'dep', 'ignored.ts'),
          'export function parseToken() {}\n',
          'utf8'
        )
        await writeFile(join(repoDir, 'bin.dat'), Buffer.from([0x00, 0x70, 0x61, 0x72, 0x73, 0x65]))

        await runGit(repoDir, ['add', 'src/parser.ts', 'src/korean.ts', 'bin.dat'])
        await runGit(repoDir, ['commit', '-m', 'initial'])
        const commit1 = (await runGit(repoDir, ['rev-parse', 'HEAD'])).trim()

        const openedWorkspace = await workspaceService.openWorkspace(repoDir)

        // Whole-word symbolName match in working-tree (excludes parseTokenAsync, .wiki-editor, node_modules, binary)
        const wtMatches = await hub.searchSymbols({
          symbolName: 'parseToken',
          scope: { kind: 'working-tree' }
        })
        expect(wtMatches.map((m) => `${m.path}:${m.lineNumber}`)).toEqual([
          'src/parser.ts:1',
          'src/parser.ts:5'
        ])

        // Declaration query prefilter
        const declMatches = await hub.searchSymbols({
          declarationQuery: 'parseToken',
          scope: { kind: 'working-tree' }
        })
        expect(declMatches.map((m) => `${m.path}:${m.lineNumber}`)).toEqual([
          'src/parser.ts:1',
          'src/parser.ts:4'
        ])

        // EUC-KR file in git repo
        const eucMatches = await hub.searchSymbols({
          symbolName: 'koreanValue',
          scope: { kind: 'working-tree' }
        })
        expect(eucMatches).toHaveLength(1)
        expect(eucMatches[0].lineText).toContain('koreanValue')

        // Open unsaved dirty buffer overrides disk in working-tree
        const parserPath = join(openedWorkspace.rootPath, 'src', 'parser.ts')
        const opened = await bufferHub.openWorkspaceFile(parserPath, 'parser.ts')
        await bufferHub.updateContent(
          opened.key,
          'export function unsavedSymbol() {\n  return 1\n}\n'
        )

        const afterDirtyOld = await hub.searchSymbols({
          symbolName: 'parseToken',
          scope: { kind: 'working-tree' }
        })
        expect(afterDirtyOld).toEqual([])

        const afterDirtyNew = await hub.searchSymbols({
          symbolName: 'unsavedSymbol',
          scope: { kind: 'working-tree' }
        })
        expect(afterDirtyNew).toHaveLength(1)
        expect(afterDirtyNew[0]).toMatchObject({
          path: 'src/parser.ts',
          lineNumber: 1
        })

        // Staged index vs working-tree
        await writeFile(
          join(repoDir, 'src', 'stagedOnly.ts'),
          'export const stagedSym = 10\n',
          'utf8'
        )
        await runGit(repoDir, ['add', 'src/stagedOnly.ts'])
        await writeFile(
          join(repoDir, 'src', 'stagedOnly.ts'),
          'export const workingOnlySym = 20\n',
          'utf8'
        )

        const indexMatches = await hub.searchSymbols({
          symbolName: 'stagedSym',
          scope: { kind: 'git-index', displayRef: 'Staged' }
        })
        expect(indexMatches).toHaveLength(1)
        expect(indexMatches[0].path).toBe('src/stagedOnly.ts')

        // Historical commit & root commit parent safe empty fallback
        const commit1Matches = await hub.searchSymbols({
          symbolName: 'parseToken',
          scope: { kind: 'git-ref', ref: commit1, displayRef: commit1.slice(0, 7) }
        })
        expect(commit1Matches).toHaveLength(2)

        const rootParentMatches = await hub.searchSymbols({
          symbolName: 'parseToken',
          scope: { kind: 'git-ref', ref: `${commit1}^1`, displayRef: `${commit1.slice(0, 7)}^1` }
        })
        expect(rootParentMatches).toEqual([])

        // Stash including untracked ^3
        await writeFile(
          join(repoDir, 'src', 'stashUntracked.ts'),
          'export function stashUntrackedFn() {}\n',
          'utf8'
        )
        await runGit(repoDir, ['stash', 'push', '--include-untracked', '-m', 'wip'])
        const stashHash = (await runGit(repoDir, ['rev-parse', 'stash@{0}'])).trim()

        const stashMatches = await hub.searchSymbols({
          symbolName: 'stashUntrackedFn',
          scope: {
            kind: 'git-ref',
            ref: stashHash,
            displayRef: 'stash@{0}',
            untrackedParentRef: `${stashHash}^3`
          }
        })
        expect(stashMatches).toHaveLength(1)
        expect(stashMatches[0].path).toBe('src/stashUntracked.ts')

        // Ref injection blocked
        await expect(
          hub.searchSymbols({
            symbolName: 'parseToken',
            scope: { kind: 'git-ref', ref: '--evil', displayRef: 'bad' }
          })
        ).rejects.toThrow(/유효한/)

        // Single-flight cancellation: earlier call is superseded
        const firstPromise = hub.searchSymbols({
          symbolName: 'parseToken',
          scope: { kind: 'git-ref', ref: commit1, displayRef: commit1.slice(0, 7) }
        })
        const secondPromise = hub.searchSymbols({
          symbolName: 'koreanValue',
          scope: { kind: 'git-ref', ref: commit1, displayRef: commit1.slice(0, 7) }
        })
        const [firstRes, secondRes] = await Promise.all([firstPromise, secondPromise])
        expect(firstRes).toEqual([])
        expect(secondRes).toHaveLength(1)
      } finally {
        hub.dispose()
        bufferHub.dispose()
        workspaceService.dispose()
      }
    }),
    15_000
  )
})
