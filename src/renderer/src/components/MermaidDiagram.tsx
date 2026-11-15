import { useContext, useState } from 'react'
import type { ThemeMode } from '@shared/config'
import type { DiagramPngRasterAdapter } from '../editor/mermaidExport'
import { defaultMermaidRenderer, type MermaidRenderer } from '../editor/mermaidRenderer'
import { useMermaidDiagramActions } from '../hooks/useMermaidDiagramActions'
import {
  DEFAULT_MERMAID_DEBOUNCE_MS,
  type MermaidRenderState,
  useMermaidRenderState
} from '../hooks/useMermaidRenderState'
import { MermaidActionBar, MermaidActionErrorAlert } from './MermaidActionBar'
import { MermaidExportContext } from './MermaidExportContext'

interface MermaidDiagramProps {
  code: string
  theme: ThemeMode
  renderer?: MermaidRenderer
  rasterAdapter?: DiagramPngRasterAdapter
  renderState?: MermaidRenderState
  debounceMs?: number
  className?: string
  sourceLine?: string
  sourceEndLine?: string
  showActionBar?: boolean
}

/**
 * Renders a Mermaid diagram block with debounced live updates, theme synchronization,
 * last-valid SVG retention, and optional floating action controls.
 */
export function MermaidDiagram({
  code,
  theme,
  renderer = defaultMermaidRenderer,
  rasterAdapter,
  renderState,
  debounceMs = DEFAULT_MERMAID_DEBOUNCE_MS,
  className,
  sourceLine,
  sourceEndLine,
  showActionBar = true
}: MermaidDiagramProps) {
  const contextRasterAdapter = useContext(MermaidExportContext)
  const effectiveRasterAdapter = rasterAdapter ?? contextRasterAdapter
  const [isHovered, setIsHovered] = useState(false)

  const internalRenderState = useMermaidRenderState({
    code,
    theme,
    renderer,
    debounceMs,
    enabled: renderState === undefined
  })
  const activeRenderState = renderState ?? internalRenderState
  const { mermaidTheme, displaySvg, confirmedSvg, displayError } = activeRenderState

  const actions = useMermaidDiagramActions({
    code,
    theme,
    confirmedSvg: showActionBar ? confirmedSvg : null,
    rasterAdapter: effectiveRasterAdapter
  })

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
          <MermaidActionBar variant="floating" isVisible={isHovered} actions={actions} />
          <MermaidActionErrorAlert message={actions.errorMessage} />
        </>
      )}
    </div>
  )
}
