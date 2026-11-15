import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_APP_CONFIG } from '@shared/config'
import { LogService } from '../logging/LogService'
import { ConfigService } from './ConfigService'

describe('ConfigService', () => {
  let tempDir: string
  let configPath: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'wiki-editor-config-'))
    configPath = join(tempDir, 'nested', 'config.json')
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('creates config.json with default AppConfig when missing and returns the injected path', async () => {
    const service = new ConfigService(configPath)

    expect(service.getConfigPath()).toBe(configPath)

    const config = await service.get()
    expect(config).toEqual({
      version: 1,
      theme: 'light',
      autoSave: false,
      autoSaveDelayMs: 1000,
      showHeadingNumbers: true,
      favoriteWorkspaces: [],
      recentWorkspaces: []
    })

    const rawOnDisk = await readFile(configPath, 'utf8')
    expect(JSON.parse(rawOnDisk)).toEqual(config)
  })

  it('normalizes partial or invalid field values while preserving valid persisted fields and ignoring legacy customCommands', async () => {
    await mkdir(dirname(configPath), { recursive: true })
    await writeFile(
      configPath,
      JSON.stringify({
        theme: 'dark',
        autoSave: true,
        autoSaveDelayMs: -10,
        recentWorkspaces: ['C:\\docs', 123],
        customCommands: [{ trigger: 'legacy', label: 'Legacy', template: 'x' }]
      }),
      'utf8'
    )

    const service = new ConfigService(configPath)
    const config = await service.get()

    expect(config).toEqual({
      version: 1,
      theme: 'dark',
      autoSave: true,
      autoSaveDelayMs: 1000,
      showHeadingNumbers: true,
      favoriteWorkspaces: [],
      recentWorkspaces: ['C:\\docs']
    })

    const files = await readdir(dirname(configPath))
    expect(files.some((name) => name.startsWith('config.json.corrupt.'))).toBe(false)
  })

  it('recovers from corrupted JSON by backing up the broken file and writing valid defaults', async () => {
    await mkdir(dirname(configPath), { recursive: true })
    await writeFile(configPath, '{ broken json', 'utf8')

    const service = new ConfigService(configPath)
    const config = await service.get()

    expect(config.theme).toBe('light')
    expect(config.version).toBe(1)

    const repairedRaw = await readFile(configPath, 'utf8')
    expect(JSON.parse(repairedRaw)).toEqual(config)

    const files = await readdir(dirname(configPath))
    const backupFile = files.find((name) => name.startsWith('config.json.corrupt.') && name.endsWith('.bak'))
    expect(backupFile).toBeDefined()
    expect(await readFile(join(dirname(configPath), backupFile!), 'utf8')).toBe('{ broken json')
  })

  it('recovers when config.json contains non-object JSON such as an array or null', async () => {
    await mkdir(dirname(configPath), { recursive: true })
    await writeFile(configPath, '[1, 2, 3]', 'utf8')

    const service = new ConfigService(configPath)
    const config = await service.get()

    expect(config.version).toBe(1)
    expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual(config)

    const files = await readdir(dirname(configPath))
    expect(files.some((name) => name.startsWith('config.json.corrupt.') && name.endsWith('.bak'))).toBe(true)
  })

  it('partially updates config atomically without leaving temp files and persists across instances', async () => {
    const service = new ConfigService(configPath)
    await service.update({ theme: 'dark', autoSave: true })

    const files = await readdir(dirname(configPath))
    expect(files.some((name) => name.endsWith('.tmp'))).toBe(false)

    const reloaded = await new ConfigService(configPath).get()
    expect(reloaded.theme).toBe('dark')
    expect(reloaded.autoSave).toBe(true)
    expect(reloaded.autoSaveDelayMs).toBe(1000)
    expect(reloaded.showHeadingNumbers).toBe(true)
  })

  it('serializes concurrent updates so neither change is lost', async () => {
    const service = new ConfigService(configPath)

    await Promise.all([
      service.update({ theme: 'dark' }),
      service.update({ autoSave: true, autoSaveDelayMs: 2500 })
    ])

    const finalConfig = await new ConfigService(configPath).get()
    expect(finalConfig.theme).toBe('dark')
    expect(finalConfig.autoSave).toBe(true)
    expect(finalConfig.autoSaveDelayMs).toBe(2500)
  })

  it('notifies onChanged listeners on update and supports unsubscribing cleanly', async () => {
    const service = new ConfigService(configPath)
    const received: string[] = []

    const unsubscribe = service.onChanged((cfg) => {
      received.push(cfg.theme)
    })

    await service.update({ theme: 'dark' })
    unsubscribe()
    await service.update({ theme: 'light' })

    expect(received).toEqual(['dark'])
  })

  it('readRaw returns the raw UTF-8 contents of config.json (initializing if missing)', async () => {
    const service = new ConfigService(configPath)
    const raw = await service.readRaw()

    expect(JSON.parse(raw)).toEqual(await service.get())

    await service.update({ theme: 'dark' })
    const updatedRaw = await service.readRaw()
    expect(JSON.parse(updatedRaw).theme).toBe('dark')
  })

  it('rejects invalid schema updates without overwriting disk or notifying listeners', async () => {
    const service = new ConfigService(configPath)
    await service.get()

    let changeCount = 0
    service.onChanged(() => {
      changeCount += 1
    })

    await expect(
      service.update({ theme: 'invalid-theme' as 'light' })
    ).rejects.toThrow(/theme/i)
    await expect(
      service.update({ autoSaveDelayMs: -100 })
    ).rejects.toThrow(/autoSaveDelayMs/i)

    expect(changeCount).toBe(0)
    expect((await service.get()).theme).toBe('light')
    expect((await service.get()).autoSaveDelayMs).toBe(1000)
  })

  it('saveRaw validates raw JSON against AppConfig schema, writes atomically, and leaves disk intact on error', async () => {
    const service = new ConfigService(configPath)
    await service.get()

    const notifications: string[] = []
    service.onChanged((cfg) => notifications.push(cfg.theme))

    await expect(service.saveRaw('{ invalid json')).rejects.toThrow(/JSON/i)
    await expect(service.saveRaw('{"theme": "neon"}')).rejects.toThrow(/theme/i)
    await expect(service.saveRaw('{"unknown": 1}')).rejects.toThrow(/unknown config key/i)
    await expect(
      service.saveRaw(
        JSON.stringify({
          ...DEFAULT_APP_CONFIG,
          customCommands: []
        })
      )
    ).rejects.toThrow(/Unknown config key: "customCommands"/)

    expect(notifications).toEqual([])
    expect((await service.get()).theme).toBe('light')

    const validRaw = JSON.stringify({
      version: 1,
      theme: 'dark',
      autoSave: true,
      autoSaveDelayMs: 500,
      showHeadingNumbers: false,
      favoriteWorkspaces: [
        { path: join(tempDir, 'docs'), name: 'docs', pinnedAt: '2026-11-14T00:00:00.000Z' }
      ],
      recentWorkspaces: [join(tempDir, 'docs')]
    })

    const saved = await service.saveRaw(validRaw)
    expect(saved.theme).toBe('dark')
    expect(saved.autoSave).toBe(true)
    expect(saved.autoSaveDelayMs).toBe(500)
    expect(notifications).toEqual(['dark'])
    expect((await new ConfigService(configPath).get()).theme).toBe('dark')
  })

  it('manages favoriteWorkspaces and recentWorkspaces atomically with deduplication', async () => {
    const service = new ConfigService(configPath)
    const wsA = join(tempDir, 'wiki-a')
    const wsB = join(tempDir, 'wiki-b')

    const afterAdd = await service.toggleFavoriteWorkspace(`${wsA}/`, 'Wiki A')
    expect(afterAdd.favoriteWorkspaces).toHaveLength(1)
    expect(afterAdd.favoriteWorkspaces[0]).toMatchObject({ path: wsA, name: 'Wiki A' })

    // Toggle adds wsB, then removes wsA cleanly
    const afterToggleB = await service.toggleFavoriteWorkspace(wsB)
    expect(afterToggleB.favoriteWorkspaces).toHaveLength(2)
    const afterRemoveA = await service.removeFavoriteWorkspace(`${wsA}/`)
    expect(afterRemoveA.favoriteWorkspaces.map((item) => item.path)).toEqual([wsB])

    await service.recordRecentWorkspace(wsA)
    await service.recordRecentWorkspace(wsB)
    const afterMru = await service.recordRecentWorkspace(`${wsA}/`)
    expect(afterMru.recentWorkspaces).toEqual([wsA, wsB])
  })

  it('logs a warn entry with backupPath without leaking corrupt raw content when recovering corrupted config.json', async () => {
    const logService = new LogService(join(tempDir, 'logs'))
    const corruptRaw = '{ broken_secret_payload'
    await mkdir(dirname(configPath), { recursive: true })
    await writeFile(configPath, corruptRaw, 'utf8')

    const service = new ConfigService(configPath, { logService })
    await service.get()

    const entries = await logService.readEntries()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      level: 'warn',
      process: 'main',
      category: 'config',
      data: {
        configPath
      }
    })
    expect(String(entries[0].data?.backupPath)).toContain('.corrupt.')
    expect(JSON.stringify(entries[0])).not.toContain(corruptRaw)
  })
})
