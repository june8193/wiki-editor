import { readFile } from 'node:fs/promises'
import {
  AppConfig,
  cloneAppConfig,
  DEFAULT_APP_CONFIG,
  isPlainRecord,
  normalizeAppConfig,
  validateConfigPatch,
  validateConfigRaw
} from '@shared/config'
import {
  recordRecentWorkspace,
  removeFavoriteWorkspace,
  toggleFavoriteWorkspace
} from '@shared/workspace'
import { createAsyncQueue } from '@shared/asyncQueue'
import { loadOrInitializeJsonFile, writeFileAtomic } from '../fs/atomicFile'
import type { LogService } from '../logging/LogService'

export type ConfigChangeListener = (config: AppConfig) => void

export interface ConfigServiceOptions {
  logService?: LogService
}

function serializeConfig(config: AppConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`
}

/**
 * Manages persistence of the global application config.json file.
 */
export class ConfigService {
  private readonly configPath: string
  private readonly logService?: LogService
  private readonly listeners = new Set<ConfigChangeListener>()
  private readonly queue = createAsyncQueue()

  constructor(configPath: string, options: ConfigServiceOptions = {}) {
    this.configPath = configPath
    this.logService = options.logService
  }

  getConfigPath(): string {
    return this.configPath
  }

  get(): Promise<AppConfig> {
    return this.queue.enqueue(() => this.loadOrInitialize())
  }

  async update(patch: Partial<AppConfig>): Promise<AppConfig> {
    const validatedPatch = validateConfigPatch(patch)
    return this.mutate((current) =>
      normalizeAppConfig({ ...current, ...validatedPatch, version: 1 }, current)
    )
  }

  readRaw(): Promise<string> {
    return this.queue.enqueue(async () => {
      await this.loadOrInitialize()
      return readFile(this.configPath, 'utf8')
    })
  }

  async saveRaw(rawJson: string): Promise<AppConfig> {
    const validated = validateConfigRaw(rawJson)
    return this.queue.enqueue(() => this.commitConfig(validated))
  }

  removeFavoriteWorkspace(workspacePath: string): Promise<AppConfig> {
    return this.mutate((current) => ({
      ...current,
      favoriteWorkspaces: removeFavoriteWorkspace(current.favoriteWorkspaces, workspacePath)
    }))
  }

  toggleFavoriteWorkspace(workspacePath: string, name?: string): Promise<AppConfig> {
    return this.mutate((current) => ({
      ...current,
      favoriteWorkspaces: toggleFavoriteWorkspace(current.favoriteWorkspaces, workspacePath, name)
    }))
  }

  recordRecentWorkspace(workspacePath: string): Promise<AppConfig> {
    return this.mutate((current) => ({
      ...current,
      recentWorkspaces: recordRecentWorkspace(current.recentWorkspaces, workspacePath)
    }))
  }

  onChanged(listener: ConfigChangeListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private mutate(transform: (current: AppConfig) => AppConfig): Promise<AppConfig> {
    return this.queue.enqueue(async () => {
      const current = await this.loadOrInitialize()
      const next = transform(current)
      return this.commitConfig(next)
    })
  }

  private async commitConfig(next: AppConfig): Promise<AppConfig> {
    await writeFileAtomic(this.configPath, serializeConfig(next))
    this.notifyListeners(next)
    return cloneAppConfig(next)
  }

  private loadOrInitialize(): Promise<AppConfig> {
    return loadOrInitializeJsonFile({
      filePath: this.configPath,
      createDefault: () => cloneAppConfig(DEFAULT_APP_CONFIG),
      serialize: serializeConfig,
      parseValid: (parsed) =>
        isPlainRecord(parsed)
          ? { ok: true, value: normalizeAppConfig(parsed) }
          : { ok: false, reason: 'non-object' },
      onRecovered: ({ filePath, backupPath, reason, contentLength }) =>
        this.logService?.warn('config', 'Recovered corrupted config.json to defaults', {
          data: {
            configPath: filePath,
            backupPath,
            reason,
            contentLength
          }
        })
    })
  }

  private notifyListeners(config: AppConfig): void {
    for (const listener of this.listeners) {
      listener(cloneAppConfig(config))
    }
  }
}
