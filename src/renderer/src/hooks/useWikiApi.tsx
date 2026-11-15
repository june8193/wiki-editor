import { createContext, type ReactNode, useContext } from 'react'
import type { WikiApi } from '@shared/ipc'

const WikiApiContext = createContext<WikiApi | undefined>(undefined)

export interface WikiApiProviderProps {
  api?: WikiApi
  children: ReactNode
}

/**
 * Provides a window-scoped WikiApi instance to renderer hooks and components,
 * defaulting to global window.wikiApi in production Electron windows.
 */
export function WikiApiProvider({ api, children }: WikiApiProviderProps) {
  return <WikiApiContext.Provider value={api}>{children}</WikiApiContext.Provider>
}

export function useWikiApi(): WikiApi {
  return useContext(WikiApiContext) ?? window.wikiApi
}
