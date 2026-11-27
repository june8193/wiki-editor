import { useEffect, useState } from 'react'
import { formatWindowTitle, type WindowInitContext } from '@shared/window'

/**
 * Loads `appVersion` once from `loadInitContext`, formats the window title, and keeps `document.title` in sync.
 */
export function useWindowTitle(
  loadInitContext: () => Promise<WindowInitContext | null>,
  activeTitleName?: string | null,
  workspaceName?: string | null
): string {
  const [appVersion, setAppVersion] = useState<string | undefined>(undefined)

  useEffect(() => {
    let cancelled = false
    void loadInitContext().then((context) => {
      if (!cancelled && context?.appVersion) {
        setAppVersion(context.appVersion)
      }
    })
    return () => {
      cancelled = true
    }
  }, [loadInitContext])

  const windowTitle = formatWindowTitle(activeTitleName, appVersion, workspaceName)

  useEffect(() => {
    document.title = windowTitle
  }, [windowTitle])

  return windowTitle
}
