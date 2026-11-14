import { AppConfig } from './config'

export const CONFIG_IPC_CHANNELS = {
  get: 'config:get',
  update: 'config:update',
  getPath: 'config:get-path',
  readRaw: 'config:read-raw',
  changed: 'config:changed'
} as const

export interface WikiConfigApi {
  get(): Promise<AppConfig>
  update(patch: Partial<AppConfig>): Promise<AppConfig>
  getConfigPath(): Promise<string>
  readRaw(): Promise<string>
  onChanged(listener: (config: AppConfig) => void): () => void
}

export interface WikiApi {
  config: WikiConfigApi
}
