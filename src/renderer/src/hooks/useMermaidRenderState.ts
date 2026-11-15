import { useEffect, useRef, useState } from 'react'
import type { ThemeMode } from '@shared/config'
import {
  defaultMermaidRenderer,
  mapThemeToMermaidTheme,
  type MermaidRenderer,
  type MermaidTheme
} from '../editor/mermaidRenderer'
import { logRendererWarn } from '../logging/rendererLogger'

export const DEFAULT_MERMAID_DEBOUNCE_MS = 250

export interface UseMermaidRenderStateOptions {
  code: string
  theme: ThemeMode
  renderer?: MermaidRenderer
  debounceMs?: number
  enabled?: boolean
}

export interface MermaidRenderState {
  mermaidTheme: MermaidTheme
  displaySvg: string | null
  confirmedSvg: string | null
  displayError: string | null
}

interface ValidDiagramSnapshot {
  code: string
  mermaidTheme: MermaidTheme
  renderer: MermaidRenderer
  svg: string
}

interface AsyncRenderState {
  lastValid: ValidDiagramSnapshot | null
  error: string | null
}

function logMermaidRenderFailure(theme: ThemeMode, codeLength: number, errorMessage: string): void {
  logRendererWarn('ui', 'Mermaid diagram rendering failed', {
    data: {
      theme,
      codeLength,
      errorMessage
    },
    error: {
      name: 'MermaidRenderError',
      message: errorMessage
    }
  })
}

async function syncLastValidTheme(
  previousValid: ValidDiagramSnapshot | null,
  theme: ThemeMode,
  mermaidTheme: MermaidTheme,
  renderer: MermaidRenderer
): Promise<ValidDiagramSnapshot | null> {
  if (!previousValid || (previousValid.mermaidTheme === mermaidTheme && previousValid.renderer === renderer)) {
    return previousValid
  }

  const cachedValidSvg = renderer.getCachedSvg(previousValid.code, theme)
  if (cachedValidSvg !== null) {
    return { code: previousValid.code, mermaidTheme, renderer, svg: cachedValidSvg }
  }

  const syncResult = await renderer.render(previousValid.code, theme)
  if (syncResult.ok) {
    return { code: previousValid.code, mermaidTheme, renderer, svg: syncResult.svg }
  }
  return previousValid
}

/**
 * Manages debounced Mermaid rendering, theme synchronization, last-valid SVG retention,
 * and confirmed-SVG readiness for export/clipboard actions.
 */
export function useMermaidRenderState({
  code,
  theme,
  renderer = defaultMermaidRenderer,
  debounceMs = DEFAULT_MERMAID_DEBOUNCE_MS,
  enabled = true
}: UseMermaidRenderStateOptions): MermaidRenderState {
  const mermaidTheme = mapThemeToMermaidTheme(theme)
  const cachedSvg = enabled ? renderer.getCachedSvg(code, theme) : null

  const [asyncState, setAsyncState] = useState<AsyncRenderState>(() => ({
    lastValid: cachedSvg !== null ? { code, mermaidTheme, renderer, svg: cachedSvg } : null,
    error: null
  }))
  const lastValidRef = useRef<ValidDiagramSnapshot | null>(asyncState.lastValid)
  const mountedThemeRef = useRef<ThemeMode | null>(null)

  useEffect(() => {
    lastValidRef.current = asyncState.lastValid
  }, [asyncState.lastValid])

  useEffect(() => {
    if (!enabled) {
      return
    }

    const previousTheme = mountedThemeRef.current
    const isInitialOrThemeSwitch = previousTheme === null || previousTheme !== theme
    mountedThemeRef.current = theme

    if (cachedSvg !== null) {
      setAsyncState((prev) =>
        prev.lastValid?.code === code &&
        prev.lastValid.mermaidTheme === mermaidTheme &&
        prev.lastValid.renderer === renderer &&
        prev.lastValid.svg === cachedSvg &&
        prev.error === null
          ? prev
          : { lastValid: { code, mermaidTheme, renderer, svg: cachedSvg }, error: null }
      )
      return
    }

    let cancelled = false
    let settled = false
    const executeRender = async (): Promise<void> => {
      const result = await renderer.render(code, theme)
      if (cancelled) return
      if (result.ok) {
        settled = true
        setAsyncState({
          lastValid: { code, mermaidTheme, renderer, svg: result.svg },
          error: null
        })
        return
      }

      logMermaidRenderFailure(theme, code.length, result.errorMessage)
      const nextLastValid = await syncLastValidTheme(
        lastValidRef.current,
        theme,
        mermaidTheme,
        renderer
      )
      if (cancelled) return
      settled = true
      setAsyncState({
        lastValid: nextLastValid,
        error: result.errorMessage
      })
    }

    const timerId =
      isInitialOrThemeSwitch || debounceMs <= 0
        ? undefined
        : window.setTimeout(() => {
            void executeRender()
          }, debounceMs)

    if (timerId === undefined) {
      void executeRender()
    }

    return () => {
      cancelled = true
      // Restore previous theme if interrupted (e.g. StrictMode remount) so the next effect still runs immediately
      if (!settled) {
        mountedThemeRef.current = previousTheme
      }
      if (timerId !== undefined) {
        window.clearTimeout(timerId)
      }
    }
  }, [cachedSvg, code, debounceMs, enabled, mermaidTheme, renderer, theme])

  if (!enabled) {
    return {
      mermaidTheme,
      displaySvg: null,
      confirmedSvg: null,
      displayError: null
    }
  }

  const displaySvg = cachedSvg ?? asyncState.lastValid?.svg ?? null
  const displayError = cachedSvg !== null ? null : asyncState.error
  const hasNonBlankCode = code.trim().length > 0
  const confirmedSvg = !hasNonBlankCode
    ? null
    : cachedSvg !== null
      ? cachedSvg
      : asyncState.error === null &&
          asyncState.lastValid !== null &&
          asyncState.lastValid.code === code &&
          asyncState.lastValid.mermaidTheme === mermaidTheme &&
          asyncState.lastValid.renderer === renderer
        ? asyncState.lastValid.svg
        : null

  return {
    mermaidTheme,
    displaySvg,
    confirmedSvg,
    displayError
  }
}
