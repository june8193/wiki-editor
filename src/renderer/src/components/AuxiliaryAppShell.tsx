import { useEffect, useRef } from 'react'
import { formatWindowTitle } from '@shared/window'
import { useWikiApi } from '../hooks/useWikiApi'
import { useWindowEditorShell } from '../hooks/useWindowEditorShell'
import { EditorWindowFrame } from './EditorWindowFrame'

/**
 * Auxiliary editor shell dedicated to detached document tabs: omits workspace/settings chrome,
 * keeps right outline collapsed initially, tracks the active document title, and closes once empty.
 */
export function AuxiliaryAppShell() {
  const wikiApi = useWikiApi()
  const shell = useWindowEditorShell({ initialRightCollapsed: true })

  useEffect(() => {
    document.title = formatWindowTitle(shell.activeBuffer?.name)
  }, [shell.activeBuffer?.name])

  const hadTabsRef = useRef<boolean>(false)
  useEffect(() => {
    if (shell.totalTabCount > 0) {
      hadTabsRef.current = true
      return
    }
    if (hadTabsRef.current) {
      void wikiApi.window?.closeCurrent().catch(() => undefined)
    }
  }, [shell.totalTabCount, wikiApi])

  return <EditorWindowFrame shell={shell} canDetachToNewWindow={shell.totalTabCount > 1} />
}
