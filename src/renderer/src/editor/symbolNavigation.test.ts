import { describe, expect, it, vi } from 'vitest'
import { javascript } from '@codemirror/lang-javascript'
import type { GitDiffRequest } from '@shared/git'
import type { SymbolCandidateMatch } from '@shared/symbol'
import {
  rankDeclarationCandidates,
  resolveDiffLineScope,
  resolveSymbolDefinitions,
  resolveSymbolReferences
} from './symbolNavigation'

describe('symbolNavigation', () => {
  describe('resolveDiffLineScope', () => {
    it('maps unstaged old/new sides to HEAD and working-tree', () => {
      const req: GitDiffRequest = { kind: 'unstaged', path: 'src/a.ts', status: 'M' }
      expect(resolveDiffLineScope(req, 'old')).toEqual({
        kind: 'git-ref',
        ref: 'HEAD',
        displayRef: 'HEAD'
      })
      expect(resolveDiffLineScope(req, 'new')).toEqual({ kind: 'working-tree' })
    })

    it('maps staged old/new sides to HEAD and git-index', () => {
      const req: GitDiffRequest = { kind: 'staged', path: 'src/a.ts', status: 'M' }
      expect(resolveDiffLineScope(req, 'old')).toEqual({
        kind: 'git-ref',
        ref: 'HEAD',
        displayRef: 'HEAD'
      })
      expect(resolveDiffLineScope(req, 'new')).toEqual({
        kind: 'git-index',
        displayRef: 'Staged'
      })
    })

    it('maps commit old/new sides to commitHash^1 and commitHash', () => {
      const req: GitDiffRequest = {
        kind: 'commit',
        commitHash: '1234567890abcdef',
        shortHash: '1234567',
        path: 'src/a.ts',
        status: 'M'
      }
      expect(resolveDiffLineScope(req, 'old')).toEqual({
        kind: 'git-ref',
        ref: '1234567890abcdef^1',
        displayRef: '1234567^1'
      })
      expect(resolveDiffLineScope(req, 'new')).toEqual({
        kind: 'git-ref',
        ref: '1234567890abcdef',
        displayRef: '1234567'
      })
    })

    it('maps stash old/new sides to stashHash^1 and stashHash with ^3 untrackedParentRef', () => {
      const req: GitDiffRequest = {
        kind: 'stash',
        stashHash: 'deadbeef1234',
        stashRef: 'stash@{0}',
        path: 'src/a.ts',
        status: '?'
      }
      expect(resolveDiffLineScope(req, 'old')).toEqual({
        kind: 'git-ref',
        ref: 'deadbeef1234^1',
        displayRef: 'stash@{0}^1'
      })
      expect(resolveDiffLineScope(req, 'new')).toEqual({
        kind: 'git-ref',
        ref: 'deadbeef1234',
        displayRef: 'stash@{0}',
        untrackedParentRef: 'deadbeef1234^3'
      })
    })

    it('maps branch-compare old/new sides to mergeBaseHash ?? baseRef and compareRef', () => {
      const req: GitDiffRequest = {
        kind: 'branch-compare',
        baseRef: 'main',
        compareRef: 'feat/nav',
        mergeBaseHash: 'abcdef123456',
        mode: 'three-dot',
        path: 'src/a.ts',
        status: 'M'
      }
      expect(resolveDiffLineScope(req, 'old')).toEqual({
        kind: 'git-ref',
        ref: 'abcdef123456',
        displayRef: 'abcdef1'
      })
      expect(resolveDiffLineScope(req, 'new')).toEqual({
        kind: 'git-ref',
        ref: 'feat/nav',
        displayRef: 'feat/nav'
      })
    })
  })

  describe('rankDeclarationCandidates', () => {
    it('ranks current file -> diff changed files (hunk first) -> adjacent dir -> alphabetical', () => {
      const candidates: SymbolCandidateMatch[] = [
        { path: 'z/other.ts', lineNumber: 10, lineText: 'function foo() {}', columnStart: 9, columnEnd: 12 },
        { path: 'src/sub/adj.ts', lineNumber: 5, lineText: 'function foo() {}', columnStart: 9, columnEnd: 12 },
        { path: 'lib/changed.ts', lineNumber: 20, lineText: 'function foo() {}', columnStart: 9, columnEnd: 12 },
        { path: 'src/sub/caller.ts', lineNumber: 2, lineText: 'function foo() {}', columnStart: 9, columnEnd: 12 }
      ]
      const ranked = rankDeclarationCandidates(candidates, {
        currentFilePath: 'src/sub/caller.ts',
        changedFilePaths: new Set(['lib/changed.ts'])
      })
      expect(ranked.map((c) => c.path)).toEqual([
        'src/sub/caller.ts',
        'lib/changed.ts',
        'src/sub/adj.ts',
        'z/other.ts'
      ])
    })
  })

  describe('resolveSymbolDefinitions', () => {
    it('filters out comments and usages via Lezer AST and returns verified declaration', async () => {
      const tsParser = javascript({ typescript: true }).language.parser
      const result = await resolveSymbolDefinitions({
        symbolName: 'greet',
        scope: { kind: 'working-tree' },
        currentFilePath: 'src/caller.ts',
        currentFileContent: 'import { greet } from "./helper"\ngreet()',
        workspaceRootPath: '/repo',
        searchSymbols: vi.fn().mockResolvedValue([
          {
            path: 'src/comment.ts',
            lineNumber: 1,
            lineText: '// function greet() {}',
            columnStart: 12,
            columnEnd: 17
          },
          {
            path: 'src/helper.ts',
            lineNumber: 2,
            lineText: 'export function greet() {}',
            columnStart: 16,
            columnEnd: 21
          }
        ]),
        readFileContent: vi.fn().mockImplementation(async (filePath: string) => {
          if (filePath === 'src/comment.ts') return '// function greet() {}'
          if (filePath === 'src/helper.ts') return 'const x = 1\nexport function greet() {}\n'
          return null
        }),
        getParserForPath: () => tsParser
      })

      expect(result.status).toBe('single')
      if (result.status === 'single') {
        expect(result.target.path).toBe('src/helper.ts')
        expect(result.target.lineNumber).toBe(2)
      }
    })

    it('excludes import specifiers from declaration candidates', async () => {
      const tsParser = javascript({ typescript: true }).language.parser
      const files: Record<string, string> = {
        'src/caller.ts': 'import { sharedFn } from "./a"\nsharedFn()',
        'src/a.ts': 'export function sharedFn() { return 1 }',
        'src/b.ts': 'export function sharedFn() { return 2 }'
      }
      const result = await resolveSymbolDefinitions({
        symbolName: 'sharedFn',
        scope: { kind: 'working-tree' },
        currentFilePath: 'src/caller.ts',
        currentFileContent: files['src/caller.ts'],
        workspaceRootPath: 'C:/repo',
        searchSymbols: async () => [
          { path: 'src/caller.ts', lineNumber: 1, lineText: 'import { sharedFn } from "./a"', columnStart: 9, columnEnd: 17 },
          { path: 'src/a.ts', lineNumber: 1, lineText: 'export function sharedFn() { return 1 }', columnStart: 16, columnEnd: 24 },
          { path: 'src/b.ts', lineNumber: 1, lineText: 'export function sharedFn() { return 2 }', columnStart: 16, columnEnd: 24 }
        ],
        readFileContent: async (p) => files[p] ?? null,
        getParserForPath: () => tsParser
      })
      expect(result.status).toBe('multiple')
      if (result.status === 'multiple') {
        expect(result.candidates.map((c) => `${c.path}:${c.lineNumber}`)).toEqual([
          'src/a.ts:1',
          'src/b.ts:1'
        ])
      }
    })
  })

  describe('resolveSymbolReferences', () => {
    it('filters out comments and strings via Lezer AST and ranks changed files before other files', async () => {
      const tsParser = javascript({ typescript: true }).language.parser
      const files: Record<string, string> = {
        'src/caller.ts': 'import { greet } from "./helper"\ngreet()',
        'src/comment.ts': '// greet() in comment\nconst s = "greet() in string"',
        'other/unchanged.ts': 'greet()',
        'diff/changed.ts': 'const x = greet()'
      }

      const refs = await resolveSymbolReferences({
        symbolName: 'greet',
        scope: { kind: 'working-tree' },
        currentFilePath: 'src/caller.ts',
        currentFileContent: files['src/caller.ts'],
        workspaceRootPath: 'C:/repo',
        changedFilePaths: new Set(['diff/changed.ts']),
        searchSymbols: async () => [
          { path: 'other/unchanged.ts', lineNumber: 1, lineText: 'greet()', columnStart: 0, columnEnd: 5 },
          { path: 'src/comment.ts', lineNumber: 1, lineText: '// greet() in comment', columnStart: 3, columnEnd: 8 },
          { path: 'src/comment.ts', lineNumber: 2, lineText: 'const s = "greet() in string"', columnStart: 11, columnEnd: 16 },
          { path: 'diff/changed.ts', lineNumber: 1, lineText: 'const x = greet()', columnStart: 10, columnEnd: 15 },
          { path: 'src/caller.ts', lineNumber: 2, lineText: 'greet()', columnStart: 0, columnEnd: 5 }
        ],
        readFileContent: async (p) => files[p] ?? null,
        getParserForPath: () => tsParser
      })

      expect(refs.map((r) => `${r.path}:${r.lineNumber}`)).toEqual([
        'src/caller.ts:2',
        'diff/changed.ts:1',
        'other/unchanged.ts:1'
      ])
    })
  })
})
