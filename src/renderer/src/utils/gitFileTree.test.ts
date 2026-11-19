import { describe, expect, it } from 'vitest'
import type { GitChangedFile } from '@shared/git'
import {
  buildCompressedGitFileTree,
  createDefaultGitChangesViewState,
  resetGitChangesTreeCollapsedDirs,
  toggleGitChangesGroupCollapsed,
  toggleGitChangesTreeDirCollapsed,
  toggleGitChangesViewMode
} from './gitFileTree'

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

  it('updates session-only Changes view state immutably and resets tree folder collapses on workspace change', () => {
    const initial = createDefaultGitChangesViewState()
    expect(initial.viewMode).toBe('list')
    expect(initial.isStagedCollapsed).toBe(false)
    expect(initial.isChangesCollapsed).toBe(false)
    expect(initial.collapsedTreeDirs.size).toBe(0)

    const inTreeMode = toggleGitChangesViewMode(initial)
    expect(inTreeMode.viewMode).toBe('tree')
    expect(toggleGitChangesViewMode(inTreeMode).viewMode).toBe('list')

    const stagedCollapsed = toggleGitChangesGroupCollapsed(inTreeMode, 'staged')
    expect(stagedCollapsed.isStagedCollapsed).toBe(true)
    expect(stagedCollapsed.isChangesCollapsed).toBe(false)

    const changesCollapsed = toggleGitChangesGroupCollapsed(stagedCollapsed, 'changes')
    expect(changesCollapsed.isStagedCollapsed).toBe(true)
    expect(changesCollapsed.isChangesCollapsed).toBe(true)

    const dirCollapsed = toggleGitChangesTreeDirCollapsed(changesCollapsed, 'changes:docs/guide')
    expect(dirCollapsed.collapsedTreeDirs.has('changes:docs/guide')).toBe(true)
    expect(initial.collapsedTreeDirs.size).toBe(0)

    const dirReopened = toggleGitChangesTreeDirCollapsed(dirCollapsed, 'changes:docs/guide')
    expect(dirReopened.collapsedTreeDirs.has('changes:docs/guide')).toBe(false)
    expect(resetGitChangesTreeCollapsedDirs(dirReopened)).toBe(dirReopened)

    const resetAfterSwitch = resetGitChangesTreeCollapsedDirs(dirCollapsed)
    expect(resetAfterSwitch.collapsedTreeDirs.size).toBe(0)
    expect(resetAfterSwitch.viewMode).toBe('tree')
    expect(resetAfterSwitch.isStagedCollapsed).toBe(true)
  })
})
