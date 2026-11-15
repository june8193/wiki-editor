import { type ReactNode, useContext, useState } from 'react'
import type { ThemeMode } from '@shared/config'
import type { DiagramPngRasterAdapter } from '../editor/mermaidExport'
import { defaultMermaidRenderer, type MermaidRenderer, type MermaidTheme } from '../editor/mermaidRenderer'
import { useMermaidDiagramActions } from '../hooks/useMermaidDiagramActions'
import { DEFAULT_MERMAID_DEBOUNCE_MS, useMermaidRenderState } from '../hooks/useMermaidRenderState'
import { MermaidActionBar, MermaidActionErrorAlert } from './MermaidActionBar'
import { MermaidExportContext } from './MermaidExportContext'

export interface MermaidDiagramViewProps {
  code: string
  mermaidTheme: MermaidTheme
  displaySvg: string | null
  displayError: string | null
  className?: string
  sourceLine?: string
  sourceEndLine?: string
  onMouseEnter?: () => void
  onMouseLeave?: () => void
  children?: ReactNode
}

/**
 * Pure presentational view for a Mermaid diagram block shared between Preview/Split
 * and WYSIWYG NodeView wrappers.
 */
export function MermaidDiagramView({
  code,
  mermaidTheme,
  displaySvg,
  displayError,
  className,
  sourceLine,
  sourceEndLine,
  onMouseEnter,
  onMouseLeave,
  children
}: MermaidDiagramViewProps) {
  const showFallbackErrorBox = displayError !== null && displaySvg === null

  return (
    <div
      className={`mermaid-diagram-block${className ? ` ${className}` : ''}`}
      data-testid="mermaid-diagram"
      data-mermaid-theme={mermaidTheme}
      data-source-line={sourceLine}
      data-source-end-line={sourceEndLine}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
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
      {children}
    </div>
  )
}

interface MermaidDiagramProps {
  code: string
  theme: ThemeMode
  renderer?: MermaidRenderer
  rasterAdapter?: DiagramPngRasterAdapter
  debounceMs?: number
  className?: string
  sourceLine?: string
  sourceEndLine?: string
}

/**
 * Renders a Mermaid diagram block with debounced live updates, theme synchronization,
 * last-valid SVG retention, and floating action controls.
 */
export function MermaidDiagram({
  code,
  theme,
  renderer = defaultMermaidRenderer,
  rasterAdapter,
  debounceMs = DEFAULT_MERMAID_DEBOUNCE_MS,
  className,
  sourceLine,
  sourceEndLine
}: MermaidDiagramProps) {
  const contextRasterAdapter = useContext(MermaidExportContext)
  const effectiveRasterAdapter = rasterAdapter ?? contextRasterAdapter
  const [isHovered, setIsHovered] = useState(false)

  const { mermaidTheme, displaySvg, confirmedSvg, displayError } = useMermaidRenderState({
    code,
    theme,
    renderer,
    debounceMs
  })

  const actions = useMermaidDiagramActions({
    code,
    theme,
    confirmedSvg,
    rasterAdapter: effectiveRasterAdapter
  })

  return (
    <MermaidDiagramView
      code={code}
      mermaidTheme={mermaidTheme}
      displaySvg={displaySvg}
      displayError={displayError}
      className={className}
      sourceLine={sourceLine}
      sourceEndLine={sourceEndLine}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <MermaidActionBar variant="floating" isVisible={isHovered} actions={actions} />
      <MermaidActionErrorAlert message={actions.errorMessage} />
    </MermaidDiagramView>
  )
}
