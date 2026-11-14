import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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
      recentWorkspaces: [],
      customCommands: []
    })

    const rawOnDisk = await readFile(configPath, 'utf8')
    expect(JSON.parse(rawOnDisk)).toEqual(config)
  })

  it('normalizes partial or invalid field values while preserving valid persisted fields', async () => {
    await mkdir(dirname(configPath), { recursive: true })
    await writeFile(
      configPath,
      JSON.stringify({
        theme: 'dark',
        autoSave: true,
        autoSaveDelayMs: -10,
        recentWorkspaces: ['C:\\docs', 123]
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
      recentWorkspaces: ['C:\\docs'],
      customCommands: []
    })
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
})
