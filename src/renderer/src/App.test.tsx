import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { AppConfig, cloneAppConfig, DEFAULT_APP_CONFIG } from '@shared/config'
import { WikiApi } from '@shared/ipc'
import { App } from './App'

function createInMemoryWikiApi(initialOverrides: Partial<AppConfig> = {}): {
  api: WikiApi
  emitExternalChange: (patch: Partial<AppConfig>) => void
  getListenerCount: () => number
} {
  let state: AppConfig = {
    ...cloneAppConfig(DEFAULT_APP_CONFIG),
    ...initialOverrides
  }
  const listeners = new Set<(config: AppConfig) => void>()
  const configPath = 'C:\\Users\\test\\AppData\\Roaming\\wiki-editor\\config.json'

  const applyAndBroadcast = (patch: Partial<AppConfig>): AppConfig => {
    state = { ...state, ...patch, version: 1 }
    const snapshot = cloneAppConfig(state)
    for (const listener of listeners) {
      listener(snapshot)
    }
    return cloneAppConfig(snapshot)
  }

  const api: WikiApi = {
    config: {
      async get() {
        return cloneAppConfig(state)
      },
      async update(patch) {
        return applyAndBroadcast(patch)
      },
      async getConfigPath() {
        return configPath
      },
      async readRaw() {
        return JSON.stringify(state, null, 2)
      },
      onChanged(listener) {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      }
    }
  }

  return {
    api,
    emitExternalChange(patch) {
      applyAndBroadcast(patch)
    },
    getListenerCount: () => listeners.size
  }
}

describe('App shell, theme persistence, and settings panel', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-theme')
  })

  it('initializes document theme from persisted config on mount', async () => {
    const { api } = createInMemoryWikiApi({ theme: 'dark' })
    window.wikiApi = api

    render(<App />)

    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute('data-theme', 'dark')
    })
  })

  it('toggles theme from header, updates data-theme immediately, and persists across restart', async () => {
    const user = userEvent.setup()
    const { api } = createInMemoryWikiApi({ theme: 'light' })
    window.wikiApi = api

    const firstMount = render(<App />)

    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute('data-theme', 'light')
    })

    const headerToggle = await screen.findByRole('button', { name: /테마 전환/i })
    await user.click(headerToggle)

    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute('data-theme', 'dark')
    })

    firstMount.unmount()
    document.documentElement.removeAttribute('data-theme')

    render(<App />)
    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute('data-theme', 'dark')
    })
  })

  it('displays config.json path and loads raw config preview when clicking 설정 파일 직접 열기', async () => {
    const user = userEvent.setup()
    const { api } = createInMemoryWikiApi({ theme: 'light', autoSave: true })
    window.wikiApi = api

    render(<App />)

    const settingsButton = await screen.findByRole('button', { name: /설정/i })
    await user.click(settingsButton)

    expect(
      await screen.findByText('C:\\Users\\test\\AppData\\Roaming\\wiki-editor\\config.json')
    ).toBeInTheDocument()

    const settingsThemeToggle = screen.getByRole('button', { name: /다크 모드로 전환/i })
    await user.click(settingsThemeToggle)

    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute('data-theme', 'dark')
    })

    const openConfigButton = screen.getByRole('button', { name: /설정 파일 직접 열기/i })
    await user.click(openConfigButton)

    const preview = await screen.findByTestId('config-raw-preview')
    expect(preview.textContent).toContain('"theme": "dark"')
    expect(preview.textContent).toContain('"autoSave": true')
  })

  it('reacts to external config change broadcasts and cleans up listener on unmount', async () => {
    const { api, emitExternalChange, getListenerCount } = createInMemoryWikiApi({
      theme: 'light'
    })
    window.wikiApi = api

    const view = render(<App />)

    await waitFor(() => {
      expect(getListenerCount()).toBe(1)
    })

    emitExternalChange({ theme: 'dark' })

    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute('data-theme', 'dark')
    })

    view.unmount()
    expect(getListenerCount()).toBe(0)
  })

  it('refreshes open raw config preview when an external change arrives', async () => {
    const user = userEvent.setup()
    const { api, emitExternalChange } = createInMemoryWikiApi({ theme: 'light' })
    window.wikiApi = api

    render(<App />)

    await user.click(await screen.findByRole('button', { name: /설정/i }))
    await user.click(screen.getByRole('button', { name: /설정 파일 직접 열기/i }))

    const preview = await screen.findByTestId('config-raw-preview')
    expect(preview.textContent).toContain('"theme": "light"')

    emitExternalChange({ theme: 'dark' })

    await waitFor(() => {
      expect(screen.getByTestId('config-raw-preview').textContent).toContain('"theme": "dark"')
    })
  })

  it('rolls back theme and shows an error banner when saving theme fails', async () => {
    const user = userEvent.setup()
    const { api } = createInMemoryWikiApi({ theme: 'light' })
    api.config.update = async () => {
      throw new Error('디스크 쓰기 오류')
    }
    window.wikiApi = api

    render(<App />)

    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute('data-theme', 'light')
    })

    await user.click(await screen.findByRole('button', { name: /테마 전환/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent('디스크 쓰기 오류')
    expect(document.documentElement).toHaveAttribute('data-theme', 'light')
  })

  it('keeps the latest theme when rapid toggles resolve out of order', async () => {
    const user = userEvent.setup()
    const { api } = createInMemoryWikiApi({ theme: 'light' })

    let resolveFirst!: (value: AppConfig) => void
    let callCount = 0
    api.config.update = (patch) => {
      callCount += 1
      if (callCount === 1) {
        return new Promise<AppConfig>((resolve) => {
          resolveFirst = resolve
        })
      }
      return Promise.resolve({ ...cloneAppConfig(DEFAULT_APP_CONFIG), ...patch })
    }
    window.wikiApi = api

    render(<App />)
    const toggle = await screen.findByRole('button', { name: /테마 전환/i })

    await user.click(toggle) // light -> dark (pending)
    await user.click(toggle) // dark -> light (resolves immediately)

    resolveFirst({ ...cloneAppConfig(DEFAULT_APP_CONFIG), theme: 'dark' })

    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute('data-theme', 'light')
    })
  })

  it('shows an error banner when reading raw config fails', async () => {
    const user = userEvent.setup()
    const { api } = createInMemoryWikiApi({ theme: 'light' })
    api.config.readRaw = async () => {
      throw new Error('읽기 권한 없음')
    }
    window.wikiApi = api

    render(<App />)

    await user.click(await screen.findByRole('button', { name: /설정/i }))
    await user.click(screen.getByRole('button', { name: /설정 파일 직접 열기/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent('읽기 권한 없음')
  })
})
