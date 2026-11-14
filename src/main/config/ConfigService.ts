import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import {
  AppConfig,
  cloneAppConfig,
  DEFAULT_APP_CONFIG,
  isPlainRecord,
  normalizeAppConfig
} from '@shared/config'

export type ConfigChangeListener = (config: AppConfig) => void

let tempSequence = 0

async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  const dir = dirname(filePath)
  await mkdir(dir, { recursive: true })
  tempSequence += 1
  const tempPath = join(dir, `.${basename(filePath)}.${process.pid}.${tempSequence}.tmp`)
  try {
    await writeFile(tempPath, content, 'utf8')
    await rename(tempPath, filePath)
  } catch (error) {
    await unlink(tempPath).catch(() => undefined)
    throw error
  }
}

function serializeConfig(config: AppConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`
}

/**
 * Manages persistence of the global application config.json file.
 */
export class ConfigService {
  private readonly configPath: string
  private readonly listeners = new Set<ConfigChangeListener>()
  private queue: Promise<void> = Promise.resolve()

  constructor(configPath: string) {
    this.configPath = configPath
  }

  getConfigPath(): string {
    return this.configPath
  }

  get(): Promise<AppConfig> {
    return this.enqueue(() => this.loadOrInitialize())
  }

  update(patch: Partial<AppConfig>): Promise<AppConfig> {
    return this.enqueue(async () => {
      const current = await this.loadOrInitialize()
      const safePatch = isPlainRecord(patch) ? patch : {}
      const merged: Record<string, unknown> = {
        ...current,
        ...safePatch,
        version: 1
      }
      const next = normalizeAppConfig(merged, current)
      await writeFileAtomic(this.configPath, serializeConfig(next))
      this.notifyListeners(next)
      return cloneAppConfig(next)
    })
  }

  readRaw(): Promise<string> {
    return this.enqueue(async () => {
      await this.loadOrInitialize()
      return readFile(this.configPath, 'utf8')
    })
  }

  onChanged(listener: ConfigChangeListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task)
    this.queue = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  private async loadOrInitialize(): Promise<AppConfig> {
    let raw: string
    try {
      raw = await readFile(this.configPath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        return this.writeDefaults()
      }
      throw error
    }

    try {
      const parsed: unknown = JSON.parse(raw)
      if (!isPlainRecord(parsed)) {
        return this.recoverCorrupted(raw)
      }
      return normalizeAppConfig(parsed)
    } catch {
      return this.recoverCorrupted(raw)
    }
  }

  private async writeDefaults(): Promise<AppConfig> {
    const initial = cloneAppConfig(DEFAULT_APP_CONFIG)
    await writeFileAtomic(this.configPath, serializeConfig(initial))
    return cloneAppConfig(initial)
  }

  private async recoverCorrupted(corruptRaw: string): Promise<AppConfig> {
    tempSequence += 1
    const backupPath = `${this.configPath}.corrupt.${Date.now()}-${tempSequence}.bak`
    await writeFileAtomic(backupPath, corruptRaw)
    return this.writeDefaults()
  }

  private notifyListeners(config: AppConfig): void {
    for (const listener of this.listeners) {
      listener(cloneAppConfig(config))
    }
  }
}
