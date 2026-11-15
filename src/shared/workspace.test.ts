import { describe, expect, it } from 'vitest'
import {
  addFavoriteWorkspace,
  formatAbsoluteEntryPath,
  formatRelativeEntryPath,
  getParentPath,
  getWorkspaceDisplayName,
  isFavoriteWorkspacePath,
  isNestedOrSamePath,
  isSameWorkspacePath,
  joinWorkspacePath,
  matchPathSeparators,
  normalizeWorkspacePath,
  recordRecentWorkspace,
  remapPathPrefix,
  removeFavoriteWorkspace,
  removeRecentWorkspace,
  resolveRepoFileInWorkspace,
  toggleFavoriteWorkspace,
  toWorkspaceRelativePath
} from './workspace'

describe('shared workspace path and favorites helpers', () => {
  it('normalizes paths and matches equivalent Windows or POSIX workspace paths', () => {
    expect(normalizeWorkspacePath('C:/Docs/Wiki/')).toBe('C:\\Docs\\Wiki')
    expect(normalizeWorkspacePath('C:\\')).toBe('C:\\')
    expect(normalizeWorkspacePath('/tmp/wiki/')).toBe('/tmp/wiki')

    expect(isSameWorkspacePath('C:\\Docs\\Wiki\\', 'c:/docs/wiki')).toBe(true)
    expect(isSameWorkspacePath('/tmp/wiki/', '/tmp/wiki')).toBe(true)
    expect(isSameWorkspacePath('/tmp/Wiki', '/tmp/wiki')).toBe(false)
    expect(getWorkspaceDisplayName('C:\\Docs\\my-wiki\\')).toBe('my-wiki')
    expect(getWorkspaceDisplayName('C:\\')).toBe('C:\\')
  })

  it('adds, deduplicates, removes, and toggles favorite workspaces by normalized path', () => {
    const pinnedAt = '2026-11-14T00:00:00.000Z'
    const first = addFavoriteWorkspace([], 'C:/Docs/Wiki/', undefined, pinnedAt)
    expect(first).toEqual([
      { path: 'C:\\Docs\\Wiki', name: 'Wiki', pinnedAt }
    ])

    // Duplicate with different casing/trailing slash should not add a second item
    const deduped = addFavoriteWorkspace(first, 'c:\\docs\\wiki', 'Custom Name', '2026-11-15T00:00:00.000Z')
    expect(deduped).toHaveLength(1)
    expect(isFavoriteWorkspacePath(deduped, 'c:/docs/wiki/')).toBe(true)

    const removed = removeFavoriteWorkspace(deduped, 'c:\\docs\\wiki\\')
    expect(removed).toEqual([])

    const toggledOn = toggleFavoriteWorkspace([], 'C:\\Docs\\Alpha', undefined, pinnedAt)
    expect(toggledOn).toHaveLength(1)
    const toggledOff = toggleFavoriteWorkspace(toggledOn, 'c:/docs/alpha/')
    expect(toggledOff).toEqual([])
  })

  it('records recent workspaces in MRU order, deduplicates, and enforces cap', () => {
    let recents: string[] = []
    recents = recordRecentWorkspace(recents, 'C:\\w1', 3)
    recents = recordRecentWorkspace(recents, 'C:\\w2', 3)
    recents = recordRecentWorkspace(recents, 'C:\\w3', 3)
    expect(recents).toEqual(['C:\\w3', 'C:\\w2', 'C:\\w1'])

    // Re-opening w1 moves it to the top without duplicating
    recents = recordRecentWorkspace(recents, 'c:/w1/', 3)
    expect(recents).toEqual(['c:\\w1', 'C:\\w3', 'C:\\w2'])

    // Adding w4 evicts oldest (w2)
    recents = recordRecentWorkspace(recents, 'C:\\w4', 3)
    expect(recents).toEqual(['C:\\w4', 'c:\\w1', 'C:\\w3'])
  })

  it('removes recent workspaces using normalized path comparison while preserving remaining order', () => {
    const recents = ['C:\\Docs\\Alpha', 'C:\\Docs\\Beta', '/tmp/gamma']

    expect(removeRecentWorkspace(recents, 'c:/docs/alpha/')).toEqual([
      'C:\\Docs\\Beta',
      '/tmp/gamma'
    ])
    expect(removeRecentWorkspace(recents, '/tmp/gamma/')).toEqual([
      'C:\\Docs\\Alpha',
      'C:\\Docs\\Beta'
    ])
    expect(removeRecentWorkspace(recents, 'C:\\Docs\\Missing')).toEqual(recents)
  })

  it('resolves parent paths, nested checks, and prefix remapping safely', () => {
    expect(getParentPath('C:\\wiki\\docs\\a.md', 'C:\\wiki')).toBe('C:\\wiki\\docs')
    expect(getParentPath('C:\\a.md', 'C:\\')).toBe('C:\\')
    expect(isNestedOrSamePath('C:\\wiki\\docs\\a.md', 'C:\\wiki\\docs')).toBe(true)
    expect(isNestedOrSamePath('C:\\wiki\\docs-other\\a.md', 'C:\\wiki\\docs')).toBe(false)
    expect(remapPathPrefix('C:\\wiki\\docs\\a.md', 'C:\\wiki\\docs', 'C:\\wiki\\guides')).toBe(
      'C:\\wiki\\guides\\a.md'
    )
    expect(matchPathSeparators('sub/a.md', 'C:\\wiki\\root')).toBe('sub\\a.md')
    expect(matchPathSeparators('sub\\a.md', '/repo/root')).toBe('sub/a.md')
    expect(joinWorkspacePath('C:\\wiki\\root\\', 'sub/doc.md')).toBe('C:\\wiki\\root\\sub\\doc.md')
    expect(joinWorkspacePath('/repo/root/', 'sub\\doc.md')).toBe('/repo/root/sub/doc.md')
    expect(resolveRepoFileInWorkspace('C:/repo', 'C:/repo/sub', 'sub/doc.md')).toEqual({
      path: 'C:/repo/sub/doc.md',
      relativePath: 'doc.md'
    })
    expect(resolveRepoFileInWorkspace('C:/repo', 'C:/repo/sub', 'other.md')).toBeNull()
  })

  it('computes workspace-relative POSIX paths and formatted entry paths without trailing separators', () => {
    expect(toWorkspaceRelativePath('C:\\wiki\\notes', 'C:\\wiki\\notes\\Guides\\Setup.md')).toBe(
      'Guides/Setup.md'
    )
    expect(toWorkspaceRelativePath('c:\\wiki\\notes', 'C:\\Wiki\\Notes\\guides\\a.md')).toBe(
      'guides/a.md'
    )
    expect(toWorkspaceRelativePath('C:\\', 'C:\\notes\\a.md')).toBe('notes/a.md')
    expect(toWorkspaceRelativePath('C:\\wiki\\notes', 'C:\\wiki\\notes\\guides\\')).toBe('guides')
    expect(toWorkspaceRelativePath('/Users/june/wiki', '/Users/june/wiki/guides/setup.md')).toBe(
      'guides/setup.md'
    )
    expect(toWorkspaceRelativePath('/', '/guides/setup.md')).toBe('guides/setup.md')
    expect(toWorkspaceRelativePath('C:\\wiki', 'C:\\wiki')).toBe('')
    expect(toWorkspaceRelativePath('C:\\wiki', 'D:\\other\\a.md')).toBe('')

    expect(
      formatRelativeEntryPath(
        {
          path: 'C:\\wiki\\notes\\handbook\\setup.md',
          relativePath: 'guides/setup.md'
        },
        'C:\\wiki\\notes'
      )
    ).toBe('handbook/setup.md')
    expect(
      formatRelativeEntryPath({
        path: 'C:\\wiki\\notes\\guides\\setup.md',
        relativePath: '\\guides\\setup.md\\'
      })
    ).toBe('guides/setup.md')

    expect(
      formatAbsoluteEntryPath({
        path: 'C:/wiki/notes/guides/setup.md'
      })
    ).toBe('C:\\wiki\\notes\\guides\\setup.md')
    expect(
      formatAbsoluteEntryPath({
        path: 'C:\\wiki\\notes\\guides\\'
      })
    ).toBe('C:\\wiki\\notes\\guides')
    expect(
      formatAbsoluteEntryPath({
        path: '/tmp/wiki/guides/'
      })
    ).toBe('/tmp/wiki/guides')
  })
})
