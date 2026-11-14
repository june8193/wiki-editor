import { useEffect, useRef, useState } from 'react'
import type { ThemeMode } from '@shared/config'
import {
  defaultMermaidRenderer,
  mapThemeToMermaidTheme,
  type MermaidRenderer
} from '../editor/mermaidRenderer'
import { logRendererWarn } from '../logging/rendererLogger'

interface MermaidDiagramProps {
  code: string
  theme: ThemeMode
  renderer?: MermaidRenderer
  debounceMs?: number
  className?: string
}

interface AsyncRenderState {
  key: string
  svg: string | null
  error: string | null
}

const DEFAULT_DEBOUNCE_MS = 250

export function MermaidDiagram({
  code,
  theme,
  renderer = defaultMermaidRenderer,
  debounceMs = DEFAULT_DEBOUNCE_MS,
  className
}: MermaidDiagramProps) {
  const mermaidTheme = mapThemeToMermaidTheme(theme)
  const renderKey = `${mermaidTheme}\0${code}`
  const cachedSvg = renderer.getCachedSvg(code, theme)

  const [asyncState, setAsyncState] = useState<AsyncRenderState>({
    key: '',
    svg: null,
    error: null
  })
  const mountedThemeRef = useRef<ThemeMode | null>(null)

  useEffect(() => {
    const isInitialOrThemeSwitch =
      mountedThemeRef.current === null || mountedThemeRef.current !== theme
    mountedThemeRef.current = theme

    if (cachedSvg !== null) {
      return
    }

    let cancelled = false
    const executeRender = (): void => {
      void renderer.render(code, theme).then((result) => {
        if (cancelled) return
        if (result.ok) {
          setAsyncState({ key: renderKey, svg: result.svg, error: null })
        } else {
          setAsyncState({ key: renderKey, svg: null, error: result.errorMessage })
          logRendererWarn('ui', 'Mermaid diagram rendering failed', {
            data: {
              theme,
              codeLength: code.length,
              errorMessage: result.errorMessage
            },
            error: {
              name: 'MermaidRenderError',
              message: result.errorMessage
            }
          })
        }
      })
    }

    if (isInitialOrThemeSwitch || debounceMs <= 0) {
      executeRender()
      return () => {
        cancelled = true
      }
    }

    const timerId = window.setTimeout(executeRender, debounceMs)
    return () => {
      cancelled = true
      window.clearTimeout(timerId)
    }
  }, [cachedSvg, code, debounceMs, renderKey, renderer, theme])

  const displaySvg =
    cachedSvg !== null
      ? cachedSvg
      : asyncState.key === renderKey
        ? asyncState.svg
        : asyncState.error === null
          ? asyncState.svg
          : null
  const displayError =
    cachedSvg !== null ? null : asyncState.key === renderKey ? asyncState.error : null

  return (
    <div
      className={`mermaid-diagram-block${className ? ` ${className}` : ''}`}
      data-testid="mermaid-diagram"
      data-mermaid-theme={mermaidTheme}
    >
      {displayError !== null ? (
        <div className="mermaid-error-box" role="alert">
          <div className="mermaid-error-title">Mermaid 다이어그램 문법 오류</div>
          <p className="mermaid-error-message">{displayError}</p>
          <pre className="mermaid-error-source">
            <code>{code}</code>
          </pre>
        </div>
      ) : displaySvg !== null ? (
        <div
          className="mermaid-svg-container"
          data-testid="mermaid-svg"
          dangerouslySetInnerHTML={{ __html: displaySvg }}
        />
      ) : (
        <div className="mermaid-loading">Mermaid 다이어그램 렌더링 중...</div>
      )}
    </div>
  )
}
