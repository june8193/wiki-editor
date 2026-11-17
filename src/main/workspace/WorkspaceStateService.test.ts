import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_MAX_PERSISTED_WORKSPACES } from '@shared/workspaceState'
import { LogService } from '../logging/LogService'
import { WorkspaceStateService } from './WorkspaceStateService'

describe('WorkspaceStateService', () => {
  let tempDir: string
  let statePath: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'wiki-editor-ws-state-'))
    statePath = join(tempDir, 'nested', 'workspace-state.json')
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('creates workspace-state.json with default document when missing, separate from config.json', async () => {
    const configPath = join(dirname(statePath), 'config.json')
    await mkdir(dirname(statePath), { recursive: true })
    await writeFile(configPath, JSON.stringify({ version: 1, theme: 'dark' }), 'utf8')

    const service = new WorkspaceStateService(statePath)
    expect(service.getStatePath()).toBe(statePath)

    const doc = await service.getDocument()
    expect(doc).toEqual({
      version: 1,
      workspaces: {}
    })

    const rawOnDisk = await readFile(statePath, 'utf8')
    expect(JSON.parse(rawOnDisk)).toEqual(doc)
    expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual({ version: 1, theme: 'dark' })
  })

  it('saves and reloads workspace expandedDirs atomically across instances and serializes concurrent writes', async () => {
    const wsA = join(tempDir, 'wiki-a')
    const wsB = join(tempDir, 'wiki-b')
    const service = new WorkspaceStateService(statePath)

    await Promise.all([
      service.saveWorkspaceState(wsA, { expandedDirs: [join(wsA, 'docs'), join(wsA, 'guides')] }),
      service.saveWorkspaceState(wsB, { expandedDirs: [join(wsB, 'notes')] })
    ])

    const files = await readdir(dirname(statePath))
    expect(files.some((name) => name.endsWith('.tmp'))).toBe(false)

    const reloaded = new WorkspaceStateService(statePath)
    const stateA = await reloaded.getWorkspaceState(`${wsA}/`)
    const stateB = await reloaded.getWorkspaceState(wsB)

    expect(stateA?.expandedDirs).toEqual([join(wsA, 'docs'), join(wsA, 'guides')])
    expect(stateB?.expandedDirs).toEqual([join(wsB, 'notes')])
    expect(await reloaded.getWorkspaceState(join(tempDir, 'unknown'))).toBeNull()
  })

  it('backs up corrupted JSON, recovers to default document, and logs a warn entry without leaking payload', async () => {
    const logService = new LogService(join(tempDir, 'logs'))
    const corruptRaw = '{ broken_secret_workspace_payload'
    await mkdir(dirname(statePath), { recursive: true })
    await writeFile(statePath, corruptRaw, 'utf8')

    const service = new WorkspaceStateService(statePath, { logService })
    const doc = await service.getDocument()

    expect(doc).toEqual({ version: 1, workspaces: {} })
    expect(JSON.parse(await readFile(statePath, 'utf8'))).toEqual(doc)

    const files = await readdir(dirname(statePath))
    const backupFile = files.find(
      (name) => name.startsWith('workspace-state.json.corrupt.') && name.endsWith('.bak')
    )
    expect(backupFile).toBeDefined()
    expect(await readFile(join(dirname(statePath), backupFile!), 'utf8')).toBe(corruptRaw)

    const entries = await logService.readEntries()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      level: 'warn',
      process: 'main',
      category: 'workspace',
      data: {
        statePath
      }
    })
    expect(String(entries[0].data?.backupPath)).toContain('.corrupt.')
    expect(JSON.stringify(entries[0])).not.toContain(corruptRaw)
  })

  it('recovers when workspace-state.json has corrupt top-level structure such as array, non-object workspaces, or unsupported version', async () => {
    await mkdir(dirname(statePath), { recursive: true })

    for (const payload of ['[1, 2, 3]', '{"version":1,"workspaces":[]}', '{"version":2,"workspaces":{}}']) {
      await writeFile(statePath, payload, 'utf8')
      const service = new WorkspaceStateService(statePath)
      const doc = await service.getDocument()
      expect(doc).toEqual({ version: 1, workspaces: {} })
      expect(JSON.parse(await readFile(statePath, 'utf8'))).toEqual(doc)
    }

    const files = await readdir(dirname(statePath))
    const backups = files.filter(
      (name) => name.startsWith('workspace-state.json.corrupt.') && name.endsWith('.bak')
    )
    expect(backups).toHaveLength(3)
  })

  it('normalizes partially corrupt workspace entries, clamps ratios, dedupes pane tabs, and strips outside-root paths without creating backup', async () => {
    const wsA = join(tempDir, 'wiki-a')
    await mkdir(dirname(statePath), { recursive: true })
    await writeFile(
      statePath,
      JSON.stringify({
        version: 1,
        workspaces: {
          'corrupt-string': 'not-an-object',
          'missing-root': { expandedDirs: [join(wsA, 'docs')] },
          'NON-CANONICAL-KEY': {
            rootPath: `${wsA}/`,
            updatedAt: '2026-11-18T00:00:00.000Z',
            expandedDirs: [
              join(wsA, 'docs'),
              `${join(wsA, 'docs')}/`,
              wsA,
              join(tempDir, 'outside'),
              join(wsA, '..', 'outside-secret'),
              'relative/dir',
              123
            ],
            layout: {
              splitMode: 'horizontal',
              splitRatio: 0.99,
              activePaneId: 'secondary',
              panes: {
                primary: {
                  tabs: [
                    {
                      path: join(wsA, 'a.md'),
                      mode: 'wysiwyg',
                      cursor: { selectionStart: 3, selectionEnd: 10 },
                      scrollTop: 120,
                      splitPreviewRatio: 0.05
                    },
                    {
                      path: `${join(wsA, 'a.md')}`,
                      mode: 'raw',
                      cursor: { selectionStart: 0, selectionEnd: 0 },
                      scrollTop: 0,
                      splitPreviewRatio: 0.5
                    },
                    {
                      path: join(wsA, '..', 'secret.md'),
                      mode: 'raw',
                      cursor: { selectionStart: 0, selectionEnd: 0 },
                      scrollTop: 0,
                      splitPreviewRatio: 0.5
                    },
                    {
                      path: 'relative.md',
                      mode: 'raw',
                      cursor: { selectionStart: 0, selectionEnd: 0 },
                      scrollTop: 0,
                      splitPreviewRatio: 0.5
                    },
                    {
                      path: join(wsA, 'b.md'),
                      mode: 'unknown-mode',
                      cursor: { selectionStart: -5, selectionEnd: 'bad' },
                      scrollTop: -20,
                      splitPreviewRatio: null
                    }
                  ],
                  activeTabPath: join(tempDir, 'outside.md')
                },
                secondary: {
                  tabs: [
                    {
                      path: join(wsA, 'c.md'),
                      mode: 'split',
                      cursor: { selectionStart: 1, selectionEnd: 4 },
                      scrollTop: 80,
                      splitPreviewRatio: 0.72
                    }
                  ],
                  activeTabPath: join(wsA, 'c.md')
                }
              }
            }
          }
        }
      }),
      'utf8'
    )

    const service = new WorkspaceStateService(statePath)
    const doc = await service.getDocument()
    expect(Object.keys(doc.workspaces)).toHaveLength(1)

    const stateA = await service.getWorkspaceState(wsA)
    expect(stateA).toEqual({
      rootPath: wsA,
      updatedAt: '2026-11-18T00:00:00.000Z',
      expandedDirs: [join(wsA, 'docs')],
      layout: {
        splitMode: 'horizontal',
        splitRatio: 0.85,
        activePaneId: 'secondary',
        panes: {
          primary: {
            tabs: [
              {
                path: join(wsA, 'a.md'),
                mode: 'wysiwyg',
                cursor: { selectionStart: 3, selectionEnd: 10 },
                scrollTop: 120,
                splitPreviewRatio: 0.15
              },
              {
                path: join(wsA, 'b.md'),
                mode: 'raw',
                cursor: { selectionStart: 0, selectionEnd: 0 },
                scrollTop: 0,
                splitPreviewRatio: 0.5
              }
            ],
            activeTabPath: join(wsA, 'a.md')
          },
          secondary: {
            tabs: [
              {
                path: join(wsA, 'c.md'),
                mode: 'split',
                cursor: { selectionStart: 1, selectionEnd: 4 },
                scrollTop: 80,
                splitPreviewRatio: 0.72
              }
            ],
            activeTabPath: join(wsA, 'c.md')
          }
        }
      }
    })

    const files = await readdir(dirname(statePath))
    expect(files.some((name) => name.includes('.corrupt.'))).toBe(false)
  })

  it('collapses empty secondary pane to single mode and promotes secondary tabs when primary is empty', async () => {
    const wsEmptySec = join(tempDir, 'ws-empty-sec')
    const wsEmptyPri = join(tempDir, 'ws-empty-pri')
    const service = new WorkspaceStateService(statePath)

    const savedEmptySec = await service.saveWorkspaceState(wsEmptySec, {
      layout: {
        splitMode: 'horizontal',
        splitRatio: 0.6,
        activePaneId: 'secondary',
        panes: {
          primary: {
            tabs: [
              {
                path: join(wsEmptySec, 'main.md'),
                mode: 'preview',
                cursor: { selectionStart: 0, selectionEnd: 0 },
                scrollTop: 40,
                splitPreviewRatio: 0.5
              }
            ],
            activeTabPath: join(wsEmptySec, 'main.md')
          },
          secondary: {
            tabs: [
              {
                path: join(tempDir, 'outside.md'),
                mode: 'raw',
                cursor: { selectionStart: 0, selectionEnd: 0 },
                scrollTop: 0,
                splitPreviewRatio: 0.5
              }
            ],
            activeTabPath: join(tempDir, 'outside.md')
          }
        }
      }
    })

    expect(savedEmptySec.layout).toEqual({
      splitMode: 'single',
      splitRatio: 0.6,
      activePaneId: 'primary',
      panes: {
        primary: {
          tabs: [
            {
              path: join(wsEmptySec, 'main.md'),
              mode: 'preview',
              cursor: { selectionStart: 0, selectionEnd: 0 },
              scrollTop: 40,
              splitPreviewRatio: 0.5
            }
          ],
          activeTabPath: join(wsEmptySec, 'main.md')
        },
        secondary: { tabs: [], activeTabPath: null }
      }
    })

    const savedEmptyPri = await service.saveWorkspaceState(wsEmptyPri, {
      layout: {
        splitMode: 'vertical',
        splitRatio: 0.4,
        activePaneId: 'secondary',
        panes: {
          primary: { tabs: [], activeTabPath: null },
          secondary: {
            tabs: [
              {
                path: join(wsEmptyPri, 'only-sec.md'),
                mode: 'wysiwyg',
                cursor: { selectionStart: 2, selectionEnd: 5 },
                scrollTop: 90,
                splitPreviewRatio: 0.5
              }
            ],
            activeTabPath: join(wsEmptyPri, 'only-sec.md')
          }
        }
      }
    })

    expect(savedEmptyPri.layout).toEqual({
      splitMode: 'single',
      splitRatio: 0.4,
      activePaneId: 'primary',
      panes: {
        primary: {
          tabs: [
            {
              path: join(wsEmptyPri, 'only-sec.md'),
              mode: 'wysiwyg',
              cursor: { selectionStart: 2, selectionEnd: 5 },
              scrollTop: 90,
              splitPreviewRatio: 0.5
            }
          ],
          activeTabPath: join(wsEmptyPri, 'only-sec.md')
        },
        secondary: { tabs: [], activeTabPath: null }
      }
    })
  })

  it('prunes least-recently-updated workspaces beyond LRU cap and preserves existing fields across partial updates', async () => {
    let tick = 1
    const service = new WorkspaceStateService(statePath, {
      maxWorkspaces: 2,
      now: () => new Date(Date.UTC(2026, 10, 18, 0, 0, tick++)).toISOString()
    })

    const ws1 = join(tempDir, 'ws-1')
    const ws2 = join(tempDir, 'ws-2')
    const ws3 = join(tempDir, 'ws-3')

    await service.saveWorkspaceState(ws1, { expandedDirs: [join(ws1, 'd1')] })
    await service.saveWorkspaceState(ws2, {
      expandedDirs: [join(ws2, 'd2')],
      layout: {
        splitMode: 'single',
        splitRatio: 0.5,
        activePaneId: 'primary',
        panes: {
          primary: {
            tabs: [
              {
                path: join(ws2, 'note.md'),
                mode: 'raw',
                cursor: { selectionStart: 1, selectionEnd: 2 },
                scrollTop: 55,
                splitPreviewRatio: 0.5
              }
            ],
            activeTabPath: join(ws2, 'note.md')
          },
          secondary: { tabs: [], activeTabPath: null }
        }
      }
    })
    await service.saveWorkspaceState(ws3, { expandedDirs: [join(ws3, 'd3')] })

    expect(await service.getWorkspaceState(ws1)).toBeNull()
    expect(await service.getWorkspaceState(ws2)).not.toBeNull()
    expect(await service.getWorkspaceState(ws3)).not.toBeNull()

    // Updating only expandedDirs on ws2 refreshes its LRU timestamp and preserves its layout
    const updatedWs2 = await service.saveWorkspaceState(ws2, {
      expandedDirs: [join(ws2, 'd2'), join(ws2, 'd2-sub')]
    })
    expect(updatedWs2.expandedDirs).toEqual([join(ws2, 'd2'), join(ws2, 'd2-sub')])
    expect(updatedWs2.layout.panes.primary.tabs).toHaveLength(1)
    expect(updatedWs2.layout.panes.primary.tabs[0].scrollTop).toBe(55)

    // Saving ws1 again evicts ws3 (older than refreshed ws2)
    await service.saveWorkspaceState(ws1, { expandedDirs: [] })
    expect(await service.getWorkspaceState(ws3)).toBeNull()
    expect(await service.getWorkspaceState(ws2)).not.toBeNull()
    expect(await service.getWorkspaceState(ws1)).not.toBeNull()

    // Default cap constant equals 30
    expect(DEFAULT_MAX_PERSISTED_WORKSPACES).toBe(30)
    const defaultCapService = new WorkspaceStateService(join(tempDir, 'cap30.json'), {
      now: () => new Date(Date.UTC(2026, 10, 18, 0, 1, tick++)).toISOString()
    })
    for (let i = 0; i < DEFAULT_MAX_PERSISTED_WORKSPACES + 2; i += 1) {
      const ws = join(tempDir, `cap-${i}`)
      await defaultCapService.saveWorkspaceState(ws, { expandedDirs: [join(ws, 'docs')] })
    }
    const capDoc = await defaultCapService.getDocument()
    expect(Object.keys(capDoc.workspaces)).toHaveLength(DEFAULT_MAX_PERSISTED_WORKSPACES)
    expect(await defaultCapService.getWorkspaceState(join(tempDir, 'cap-0'))).toBeNull()
    expect(await defaultCapService.getWorkspaceState(join(tempDir, 'cap-1'))).toBeNull()
    expect(
      await defaultCapService.getWorkspaceState(join(tempDir, `cap-${DEFAULT_MAX_PERSISTED_WORKSPACES + 1}`))
    ).not.toBeNull()
  })

  it('rejects invalid saveWorkspaceState payloads without altering existing file on disk', async () => {
    const ws = join(tempDir, 'ws-valid')
    const service = new WorkspaceStateService(statePath)
    await service.saveWorkspaceState(ws, { expandedDirs: [join(ws, 'docs')] })

    await expect(service.saveWorkspaceState('', { expandedDirs: [] })).rejects.toThrow()
    await expect(service.saveWorkspaceState('relative/ws', { expandedDirs: [] })).rejects.toThrow()
    await expect(
      service.saveWorkspaceState(ws, null as unknown as { expandedDirs: string[] })
    ).rejects.toThrow()
    await expect(
      service.saveWorkspaceState(ws, { expandedDirs: 'not-array' as unknown as string[] })
    ).rejects.toThrow()
    await expect(
      service.saveWorkspaceState(ws, { expandedDirs: [123 as unknown as string] })
    ).rejects.toThrow()

    expect((await service.getWorkspaceState(ws))?.expandedDirs).toEqual([join(ws, 'docs')])
  })
})
