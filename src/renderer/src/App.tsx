import { useEffect } from 'react'
import type { WikiApi } from '@shared/ipc'
import { AuxiliaryAppShell } from './components/AuxiliaryAppShell'
import { MainAppShell } from './components/MainAppShell'
import { useWikiApi, WikiApiProvider } from './hooks/useWikiApi'
import { registerRendererGlobalErrorLogging } from './logging/rendererLogger'

export interface AppProps {
  wikiApi?: WikiApi
}

export function App({ wikiApi }: AppProps = {}) {
  return (
    <WikiApiProvider api={wikiApi}>
      <RoleAwareAppShell />
    </WikiApiProvider>
  )
}

function RoleAwareAppShell() {
  const wikiApi = useWikiApi()
  useEffect(() => {
    return registerRendererGlobalErrorLogging()
  }, [])
  return wikiApi.window?.role === 'auxiliary' ? <AuxiliaryAppShell /> : <MainAppShell />
}
