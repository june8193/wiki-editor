import { useEffect, useRef, useState } from 'react'
import type { ThemeMode } from '@shared/config'
import {
  defaultMermaidRenderer,
  mapThemeToMermaidTheme,
  type MermaidRenderer,
  type MermaidTheme
} from '../editor/mermaidRenderer'
import { useMermaidDiagramActions } from '../hooks/useMermaidDiagramActions'
import { logRendererWarn } from '../logging/rendererLogger'
import { MermaidActionBar, MermaidActionErrorAlert } from './MermaidActionBar'

interface MermaidDiagramProps {
  code: string
  theme: ThemeMode
  renderer?: MermaidRenderer
  debounceMs?: number
  className?: string
  sourceLine?: string
  sourceEndLine?: string
  showActionBar?: boolean
}

interface ValidDiagramSnapshot {
  code: string
  mermaidTheme: MermaidTheme
  svg: string
}

interface AsyncRenderState {
  lastValid: ValidDiagramSnapshot | null
  error: string | null
}

const DEFAULT_DEBOUNCE_MS = 250

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

/**
 * Re-renders the retained valid diagram in the active theme when the current source has syntax errors.
 */
async function syncLastValidTheme(
  previousValid: ValidDiagramSnapshot | null,
  theme: ThemeMode,
  mermaidTheme: MermaidTheme,
  renderer: MermaidRenderer
): Promise<ValidDiagramSnapshot | null> {
  if (!previousValid || previousValid.mermaidTheme === mermaidTheme) {
    return previousValid
  }

  const cachedValidSvg = renderer.getCachedSvg(previousValid.code, theme)
  if (cachedValidSvg !== null) {
    return { code: previousValid.code, mermaidTheme, svg: cachedValidSvg }
  }

  const syncResult = await renderer.render(previousValid.code, theme)
  if (syncResult.ok) {
    return { code: previousValid.code, mermaidTheme, svg: syncResult.svg }
  }
  return previousValid
}

/**
 * Renders a Mermaid diagram block with debounced live updates, theme synchronization,
 * and last-valid SVG retention paired with a compact inline alert on syntax errors.
 */
export function MermaidDiagram({
  code,
  theme,
  renderer = defaultMermaidRenderer,
  debounceMs = DEFAULT_DEBOUNCE_MS,
  className,
  sourceLine,
  sourceEndLine,
  showActionBar = true
}: MermaidDiagramProps) {
  const mermaidTheme = mapThemeToMermaidTheme(theme)
  const cachedSvg = renderer.getCachedSvg(code, theme)

  const [asyncState, setAsyncState] = useState<AsyncRenderState>(() => ({
    lastValid: cachedSvg !== null ? { code, mermaidTheme, svg: cachedSvg } : null,
    error: null
  }))
  const [isHovered, setIsHovered] = useState(false)
  const { canCopyCode, activeAction, completedAction, errorMessage, handleCopyCode } =
    useMermaidDiagramActions({ code })
  const lastValidRef = useRef<ValidDiagramSnapshot | null>(asyncState.lastValid)
  const mountedThemeRef = useRef<ThemeMode | null>(null)

  useEffect(() => {
    lastValidRef.current = asyncState.lastValid
  }, [asyncState.lastValid])

  useEffect(() => {
    const previousTheme = mountedThemeRef.current
    const isInitialOrThemeSwitch = previousTheme === null || previousTheme !== theme
    mountedThemeRef.current = theme

    if (cachedSvg !== null) {
      setAsyncState((prev) =>
        prev.lastValid?.code === code &&
        prev.lastValid.mermaidTheme === mermaidTheme &&
        prev.lastValid.svg === cachedSvg &&
        prev.error === null
          ? prev
          : { lastValid: { code, mermaidTheme, svg: cachedSvg }, error: null }
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
          lastValid: { code, mermaidTheme, svg: result.svg },
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
  }, [cachedSvg, code, debounceMs, mermaidTheme, renderer, theme])

  const displaySvg = cachedSvg ?? asyncState.lastValid?.svg ?? null
  const displayError = cachedSvg !== null ? null : asyncState.error
  const showFallbackErrorBox = displayError !== null && displaySvg === null

  return (
    <div
      className={`mermaid-diagram-block${className ? ` ${className}` : ''}`}
      data-testid="mermaid-diagram"
      data-mermaid-theme={mermaidTheme}
      data-source-line={sourceLine}
      data-source-end-line={sourceEndLine}
      onMouseEnter={showActionBar ? () => setIsHovered(true) : undefined}
      onMouseLeave={showActionBar ? () => setIsHovered(false) : undefined}
    >
      {showFallbackErrorBox ? (
        <div className="mermaid-error-box" role="alert">
          <div className="mermaid-error-title">Mermaid 다이어그램 문법 오류</div>
          <p className="mermaid-error-message">{displayError}</p>
          <pre className="mermaid-error-source">
            <code>{code}</code>
          </pre>
        </div>
      ) : (
        <>
          {displayError !== null && (
            <div className="mermaid-inline-error-banner" role="alert">
              <span className="mermaid-inline-error-title">Mermaid 문법 오류</span>
              <span className="mermaid-inline-error-message">{displayError}</span>
            </div>
          )}
          {displaySvg !== null ? (
            <div
              key="mermaid-svg"
              className="mermaid-svg-container"
              data-testid="mermaid-svg"
              dangerouslySetInnerHTML={{ __html: displaySvg }}
            />
          ) : (
            <div key="mermaid-loading" className="mermaid-loading">
              Mermaid 다이어그램 렌더링 중...
            </div>
          )}
        </>
      )}
      {showActionBar && (
        <>
          <MermaidActionBar
            variant="floating"
            isVisible={isHovered}
            canCopyCode={canCopyCode}
            activeAction={activeAction}
            completedAction={completedAction}
            onCopyCode={handleCopyCode}
          />
          <MermaidActionErrorAlert message={errorMessage} />
        </>
      )}
    </div>
  )
}
