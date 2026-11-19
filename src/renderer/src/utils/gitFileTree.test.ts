import { describe, expect, it } from 'vitest'
import type { GitChangedFile } from '@shared/git'
import { buildCompressedGitFileTree } from './gitFileTree'

describe('gitFileTree', () => {
  it('returns an empty tree for empty file lists', () => {
    expect(buildCompressedGitFileTree([])).toEqual([])
  })

  it('compresses single-child folder chains, stops at forks or folders with direct files, and sorts folders before files alphabetically', () => {
    const files: GitChangedFile[] = [
      { path: 'README.md', status: 'M' },
      { path: 'alpha.md', status: '?' },
      { path: 'z-root/deep/only/leaf.md', status: 'A' },
      { path: 'docs/guide/intro/page-b.md', status: 'M' },
      { path: 'docs/guide/intro/page-a.md', status: 'A' },
      { path: 'docs/guide/api/spec.md', status: 'M' },
      { path: 'assets/root-note.md', status: '?' },
      { path: 'assets/icons/svg/logo.svg', status: 'A' }
    ]

    const tree = buildCompressedGitFileTree(files)

    expect(tree).toEqual([
      {
        kind: 'dir',
        path: 'assets',
        label: 'assets',
        children: [
          {
            kind: 'dir',
            path: 'assets/icons/svg',
            label: 'icons/svg',
            children: [{ kind: 'file', file: { path: 'assets/icons/svg/logo.svg', status: 'A' } }]
          },
          { kind: 'file', file: { path: 'assets/root-note.md', status: '?' } }
        ]
      },
      {
        kind: 'dir',
        path: 'docs/guide',
        label: 'docs/guide',
        children: [
          {
            kind: 'dir',
            path: 'docs/guide/api',
            label: 'api',
            children: [{ kind: 'file', file: { path: 'docs/guide/api/spec.md', status: 'M' } }]
          },
          {
            kind: 'dir',
            path: 'docs/guide/intro',
            label: 'intro',
            children: [
              { kind: 'file', file: { path: 'docs/guide/intro/page-a.md', status: 'A' } },
              { kind: 'file', file: { path: 'docs/guide/intro/page-b.md', status: 'M' } }
            ]
          }
        ]
      },
      {
        kind: 'dir',
        path: 'z-root/deep/only',
        label: 'z-root/deep/only',
        children: [{ kind: 'file', file: { path: 'z-root/deep/only/leaf.md', status: 'A' } }]
      },
      { kind: 'file', file: { path: 'alpha.md', status: '?' } },
      { kind: 'file', file: { path: 'README.md', status: 'M' } }
    ])
  })

  it('places renamed files at their destination path while preserving origPath metadata and normalizes Windows separators', () => {
    const renamed: GitChangedFile = {
      path: 'docs\\sub\\new-name.md',
      origPath: 'legacy/old-name.md',
      status: 'R'
    }

    const tree = buildCompressedGitFileTree([renamed])

    expect(tree).toEqual([
      {
        kind: 'dir',
        path: 'docs/sub',
        label: 'docs/sub',
        children: [{ kind: 'file', file: renamed }]
      }
    ])
    expect(renamed.path).toBe('docs\\sub\\new-name.md')
    expect(renamed.origPath).toBe('legacy/old-name.md')
  })
})
