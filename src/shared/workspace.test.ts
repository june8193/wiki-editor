import { describe, expect, it } from 'vitest'
import {
  addFavoriteWorkspace,
  formatAbsoluteEntryPath,
  formatRelativeEntryPath,
  getParentDirectory,
  getParentPath,
  getWorkspaceDisplayName,
  isFavoriteWorkspacePath,
  isMarkdownFileName,
  isNestedOrSamePath,
  isSameWorkspacePath,
  isWorkspaceChangeAffectingPath,
  joinWorkspacePath,
  matchPathSeparators,
  normalizeWorkspacePath,
  recordRecentWorkspace,
  remapPathPrefix,
  removeFavoriteWorkspace,
  removeRecentWorkspace,
  resolveRelativeWorkspacePath,
  resolveRepoFileInWorkspace,
  stripMarkdownExtension,
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

  it('identifies and strips .md and .markdown extensions case-insensitively', () => {
    expect(isMarkdownFileName('guide.md')).toBe(true)
    expect(isMarkdownFileName('GUIDE.MD')).toBe(true)
    expect(isMarkdownFileName('spec.MarkDown')).toBe(true)
    expect(isMarkdownFileName('guide.md.txt')).toBe(false)
    expect(isMarkdownFileName('README')).toBe(false)

    expect(stripMarkdownExtension('guide.md')).toBe('guide')
    expect(stripMarkdownExtension('spec.MarkDown')).toBe('spec')
    expect(stripMarkdownExtension('v1.2.MD')).toBe('v1.2')
    expect(stripMarkdownExtension('.md')).toBe('.md')
    expect(stripMarkdownExtension('plain.txt')).toBe('plain.txt')
  })

  it('resolves relative workspace paths across POSIX, Windows, and UNC roots while rejecting escapes and invalid paths', () => {
    expect(
      resolveRelativeWorkspacePath('/wiki/notes', '/wiki/notes/docs/current.md', './sibling.md')
    ).toEqual({
      ok: true,
      targetPath: '/wiki/notes/docs/sibling.md'
    })
    expect(
      resolveRelativeWorkspacePath('/wiki/notes', '/wiki/notes/docs/current.md', '../sub/guide (1).md')
    ).toEqual({
      ok: true,
      targetPath: '/wiki/notes/sub/guide (1).md'
    })

    expect(
      resolveRelativeWorkspacePath(
        'C:\\wiki\\notes',
        'C:\\wiki\\notes\\docs\\current.md',
        '../sub/target.md'
      )
    ).toEqual({
      ok: true,
      targetPath: 'C:\\wiki\\notes\\sub\\target.md'
    })

    expect(
      resolveRelativeWorkspacePath(
        '\\\\server\\share\\wiki',
        '\\\\server\\share\\wiki\\docs\\a.md',
        '../b.md'
      )
    ).toEqual({
      ok: true,
      targetPath: '\\\\server\\share\\wiki\\b.md'
    })

    // Escapes & root boundary
    for (const escapeCase of [
      resolveRelativeWorkspacePath('/wiki/notes', '/wiki/notes/docs/current.md', '../../outside.md'),
      resolveRelativeWorkspacePath('/wiki/notes', '/wiki/notes/docs/current.md', '/etc/passwd.md'),
      resolveRelativeWorkspacePath('C:\\wiki\\notes', 'C:\\wiki\\notes\\docs\\current.md', 'D:\\x.md'),
      resolveRelativeWorkspacePath('C:\\wiki\\notes', 'D:\\other\\docs\\a.md', './b.md'),
      resolveRelativeWorkspacePath('/wiki/notes', '/wiki/notes/docs/current.md', '..')
    ]) {
      expect(escapeCase).toEqual({ ok: false, reason: 'outside-workspace' })
    }

    // Invalid relative paths inside workspace
    for (const invalidCase of [
      resolveRelativeWorkspacePath('/wiki/notes', '/wiki/notes/docs/current.md', ''),
      resolveRelativeWorkspacePath('/wiki/notes', '/wiki/notes/docs/current.md', 'bad\0.md'),
      resolveRelativeWorkspacePath('/wiki/notes', '/wiki/notes/docs/current.md', './sub/'),
      resolveRelativeWorkspacePath('/wiki/notes', '/wiki/notes/docs/current.md', './sub\\'),
      resolveRelativeWorkspacePath('/wiki/notes', '/wiki/notes/docs/current.md', './.'),
      resolveRelativeWorkspacePath('/wiki/notes', '/wiki/notes/docs/current.md', './sub/..')
    ]) {
      expect(invalidCase).toEqual({ ok: false, reason: 'invalid' })
    }
  })

  it('resolves parent directory and matches workspace change events against target paths', () => {
    expect(getParentDirectory('C:/wiki/assets/logo.png')).toBe('C:\\wiki\\assets')
    expect(getParentDirectory('C:/logo.png')).toBe('C:\\')
    expect(getParentDirectory('/wiki/assets/logo.png')).toBe('/wiki/assets')
    expect(getParentDirectory('/logo.png')).toBe('/')

    const target = 'C:/wiki/assets/logo.png'
    expect(isWorkspaceChangeAffectingPath(target)).toBe(true)
    expect(
      isWorkspaceChangeAffectingPath(target, { rootPath: 'C:/wiki', eventType: 'change', relativePath: null })
    ).toBe(true)
    expect(
      isWorkspaceChangeAffectingPath(target, { rootPath: 'C:/wiki', eventType: 'change', relativePath: '.' })
    ).toBe(true)
    expect(
      isWorkspaceChangeAffectingPath(target, {
        rootPath: 'C:\\Wiki\\',
        eventType: 'change',
        relativePath: 'Assets/logo.png'
      })
    ).toBe(true)
    expect(
      isWorkspaceChangeAffectingPath(target, {
        rootPath: 'C:/wiki',
        eventType: 'rename',
        relativePath: 'assets'
      })
    ).toBe(true)
    expect(
      isWorkspaceChangeAffectingPath(target, {
        rootPath: 'C:/wiki',
        eventType: 'change',
        relativePath: 'docs/other.md'
      })
    ).toBe(false)
    expect(
      isWorkspaceChangeAffectingPath(target, {
        rootPath: 'C:/wiki',
        eventType: 'change',
        relativePath: 'assets-other/logo.png'
      })
    ).toBe(false)
  })
})
