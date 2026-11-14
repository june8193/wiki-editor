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

  const api: WikiApi = {
    config: {
      async get() {
        return cloneAppConfig(state)
      },
      async update(patch) {
        state = { ...state, ...patch, version: 1 }
        const snapshot = cloneAppConfig(state)
        for (const listener of listeners) {
          listener(snapshot)
        }
        return cloneAppConfig(snapshot)
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
      state = { ...state, ...patch, version: 1 }
      const snapshot = cloneAppConfig(state)
      for (const listener of listeners) {
        listener(snapshot)
      }
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
})
