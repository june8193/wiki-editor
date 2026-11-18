import { describe, expect, it } from 'vitest'
import { resolveNormalizedWorkspacePath, resolveWorkspaceChildPath } from './workspace'
import {
  mapValidWorkspaceTabs,
  normalizeWorkspaceStateDocument,
  reconcileLoadedWorkspaceLayout,
  reconcilePersistedWorkspaceLayout,
  type PersistedWorkspacePaneLayout
} from './workspaceState'

describe('workspace path security and workspace state normalization', () => {
  it('validates child paths inside Windows, POSIX, and UNC workspace roots while blocking escapes', () => {
    expect(resolveNormalizedWorkspacePath('C:/wiki/project/')).toBe('C:\\wiki\\project')
    expect(resolveNormalizedWorkspacePath('/tmp/wiki/')).toBe('/tmp/wiki')
    expect(resolveNormalizedWorkspacePath('relative/path')).toBeNull()
    expect(resolveNormalizedWorkspacePath('/tmp/../../escape')).toBeNull()
    expect(resolveNormalizedWorkspacePath('C:\\wiki\0bad')).toBeNull()

    expect(resolveWorkspaceChildPath('C:\\wiki', 'C:/wiki/docs/sub')).toBe('C:\\wiki\\docs\\sub')
    expect(resolveWorkspaceChildPath('C:\\wiki', 'C:\\wiki')).toBeNull()
    expect(resolveWorkspaceChildPath('C:\\wiki', 'C:\\wiki-other\\docs')).toBeNull()
    expect(resolveWorkspaceChildPath('C:\\wiki', 'C:\\wiki\\..\\secret')).toBeNull()
    expect(resolveWorkspaceChildPath('C:\\wiki', 'D:\\wiki\\docs')).toBeNull()
    expect(resolveWorkspaceChildPath('/wiki', '/wiki/docs/../guides')).toBe('/wiki/guides')
    expect(resolveWorkspaceChildPath('/wiki', '/wiki/../secret')).toBeNull()
    expect(resolveWorkspaceChildPath('\\\\server\\share\\wiki', '\\\\server\\share\\wiki\\docs')).toBe(
      '\\\\server\\share\\wiki\\docs'
    )
    expect(resolveWorkspaceChildPath('\\\\server\\share\\wiki', '\\\\server\\share\\other')).toBeNull()
  })

  it('reconciles split layouts with single-mode collapse, secondary promotion, and fallback activeTabPath', () => {
    const emptySec: PersistedWorkspacePaneLayout = {
      splitMode: 'horizontal',
      splitRatio: 0.65,
      activePaneId: 'secondary',
      panes: {
        primary: {
          tabs: [
            {
              path: '/ws/a.md',
              mode: 'raw',
              cursor: { selectionStart: 0, selectionEnd: 0 },
              scrollTop: 0,
              splitPreviewRatio: 0.5
            }
          ],
          activeTabPath: '/ws/missing.md'
        },
        secondary: { tabs: [], activeTabPath: null }
      }
    }
    expect(reconcilePersistedWorkspaceLayout(emptySec)).toEqual({
      splitMode: 'single',
      splitRatio: 0.65,
      activePaneId: 'primary',
      panes: {
        primary: {
          tabs: [
            {
              path: '/ws/a.md',
              mode: 'raw',
              cursor: { selectionStart: 0, selectionEnd: 0 },
              scrollTop: 0,
              splitPreviewRatio: 0.5
            }
          ],
          activeTabPath: '/ws/a.md'
        },
        secondary: { tabs: [], activeTabPath: null }
      }
    })

    const emptyPri: PersistedWorkspacePaneLayout = {
      splitMode: 'vertical',
      splitRatio: 0.45,
      activePaneId: 'secondary',
      panes: {
        primary: { tabs: [], activeTabPath: null },
        secondary: {
          tabs: [
            {
              path: '/ws/b.md',
              mode: 'preview',
              cursor: { selectionStart: 0, selectionEnd: 0 },
              scrollTop: 12,
              splitPreviewRatio: 0.5
            }
          ],
          activeTabPath: '/ws/b.md'
        }
      }
    }
    expect(reconcilePersistedWorkspaceLayout(emptyPri)).toEqual({
      splitMode: 'single',
      splitRatio: 0.45,
      activePaneId: 'primary',
      panes: {
        primary: {
          tabs: [
            {
              path: '/ws/b.md',
              mode: 'preview',
              cursor: { selectionStart: 0, selectionEnd: 0 },
              scrollTop: 12,
              splitPreviewRatio: 0.5
            }
          ],
          activeTabPath: '/ws/b.md'
        },
        secondary: { tabs: [], activeTabPath: null }
      }
    })
  })

  it('merges secondary tabs into primary when splitMode is explicitly single and resolves colliding keys by latest updatedAt', () => {
    const normalized = normalizeWorkspaceStateDocument({
      version: 1,
      workspaces: {
        'c:/ws-older': {
          rootPath: 'C:\\WS',
          updatedAt: '2026-11-18T00:00:00.000Z',
          expandedDirs: ['C:\\WS\\old'],
          layout: {
            splitMode: 'single',
            splitRatio: 0.5,
            activePaneId: 'primary',
            panes: {
              primary: { tabs: [], activeTabPath: null },
              secondary: { tabs: [], activeTabPath: null }
            }
          }
        },
        'c:/ws': {
          rootPath: 'C:/WS/',
          updatedAt: '2026-11-18T01:00:00.000Z',
          expandedDirs: ['C:/WS/new'],
          layout: {
            splitMode: 'single',
            splitRatio: 0.5,
            activePaneId: 'primary',
            panes: {
              primary: {
                tabs: [
                  {
                    path: 'C:/WS/a.md',
                    mode: 'raw',
                    cursor: { selectionStart: 0, selectionEnd: 0 },
                    scrollTop: 0,
                    splitPreviewRatio: 0.5
                  }
                ],
                activeTabPath: 'C:/WS/a.md'
              },
              secondary: {
                tabs: [
                  {
                    path: 'C:/WS/b.md',
                    mode: 'split',
                    cursor: { selectionStart: 0, selectionEnd: 0 },
                    scrollTop: 10,
                    splitPreviewRatio: 0.6
                  }
                ],
                activeTabPath: 'C:/WS/b.md'
              }
            }
          }
        }
      }
    })

    expect(Object.keys(normalized.workspaces)).toEqual(['c:/ws'])
    expect(normalized.workspaces['c:/ws'].expandedDirs).toEqual(['C:\\WS\\new'])
    expect(normalized.workspaces['c:/ws'].layout).toEqual({
      splitMode: 'single',
      splitRatio: 0.5,
      activePaneId: 'primary',
      panes: {
        primary: {
          tabs: [
            {
              path: 'C:\\WS\\a.md',
              mode: 'raw',
              cursor: { selectionStart: 0, selectionEnd: 0 },
              scrollTop: 0,
              splitPreviewRatio: 0.5
            },
            {
              path: 'C:\\WS\\b.md',
              mode: 'split',
              cursor: { selectionStart: 0, selectionEnd: 0 },
              scrollTop: 10,
              splitPreviewRatio: 0.6
            }
          ],
          activeTabPath: 'C:\\WS\\a.md'
        },
        secondary: { tabs: [], activeTabPath: null }
      }
    })
  })

  it('filters candidate pane tabs inside root and reconciles loaded workspace layouts', () => {
    const filtered = mapValidWorkspaceTabs('/ws', [
      {
        path: '/ws/docs/../a.md',
        mode: 'raw',
        cursor: { selectionStart: 1, selectionEnd: 2 },
        scrollTop: 0,
        splitPreviewRatio: 0.5
      },
      {
        path: '/outside/secret.md',
        mode: 'raw',
        cursor: { selectionStart: 0, selectionEnd: 0 },
        scrollTop: 0,
        splitPreviewRatio: 0.5
      }
    ])
    expect(filtered.hadDroppedTabs).toBe(true)
    expect(filtered.tabs.map((t) => t.path)).toEqual(['/ws/a.md'])

    const result = reconcileLoadedWorkspaceLayout(
      '/ws',
      {
        splitMode: 'horizontal',
        splitRatio: 0.45,
        activePaneId: 'secondary',
        panes: {
          primary: { tabs: filtered.tabs, activeTabPath: '/ws/missing.md' },
          secondary: {
            tabs: [
              {
                path: '/ws/b.md',
                mode: 'preview',
                cursor: { selectionStart: 0, selectionEnd: 0 },
                scrollTop: 30,
                splitPreviewRatio: 0.5
              }
            ],
            activeTabPath: '/ws/b.md'
          }
        }
      },
      () => null
    )
    expect(result.hadDroppedTabs).toBe(true)
    expect(result.reconciledLayout.splitMode).toBe('single')
    expect(result.reconciledLayout.panes.primary.tabs).toEqual([])
  })
})
