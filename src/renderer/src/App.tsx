import type { WikiApi } from '@shared/ipc'
import { AuxiliaryAppShell } from './components/AuxiliaryAppShell'
import { MainAppShell } from './components/MainAppShell'
import { useWikiApi, WikiApiProvider } from './hooks/useWikiApi'

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
  return wikiApi.window?.role === 'auxiliary' ? <AuxiliaryAppShell /> : <MainAppShell />
}
