import { type ReactNode, useState } from 'react'
import type { ThemeMode } from '@shared/config'
import { useMermaidSessionHeight } from '../editor/mermaidHeightSession'
import { defaultMermaidRenderer, type MermaidRenderer, type MermaidTheme } from '../editor/mermaidRenderer'
import { useMermaidDiagramActions } from '../hooks/useMermaidDiagramActions'
import { DEFAULT_MERMAID_DEBOUNCE_MS, useMermaidRenderState } from '../hooks/useMermaidRenderState'
import { type MermaidViewportState, useMermaidViewport } from '../hooks/useMermaidViewport'
import { MermaidActionBar, MermaidActionErrorAlert } from './MermaidActionBar'

export interface MermaidDiagramViewProps {
  code: string
  mermaidTheme: MermaidTheme
  displaySvg: string | null
  displayError: string | null
  viewport: MermaidViewportState
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
  viewport,
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
              ref={viewport.viewportRef}
              className={`mermaid-svg-container is-interactive${viewport.isPanning ? ' is-panning' : ''}${viewport.isCustomHeight ? ' is-custom-height' : ''}`}
              data-testid="mermaid-svg"
              style={
                viewport.effectiveHeightPx !== null
                  ? { height: `${viewport.effectiveHeightPx}px` }
                  : undefined
              }
              onPointerDown={viewport.handlePanStart}
              onMouseDown={viewport.handlePanStart}
            >
              <div
                ref={viewport.stageRef}
                className="mermaid-svg-stage"
                data-testid="mermaid-svg-stage"
                style={{
                  transform: `translate(${viewport.pan.x}px, ${viewport.pan.y}px) scale(${viewport.zoom})`
                }}
                dangerouslySetInnerHTML={{ __html: displaySvg }}
              />
              {viewport.isResizingHeight && viewport.activeResizeHeightPx !== null && (
                <div
                  className="mermaid-height-badge"
                  data-testid="mermaid-height-badge"
                  aria-hidden="true"
                >
                  {viewport.activeResizeHeightPx}px
                </div>
              )}
            </div>
          ) : (
            <div key="mermaid-loading" className="mermaid-loading">
              Mermaid 다이어그램 렌더링 중...
            </div>
          )}
        </>
      )}
      {children}
      {displaySvg !== null && (
        <div
          role="separator"
          tabIndex={0}
          aria-label="Mermaid 다이어그램 높이 조절"
          aria-orientation="horizontal"
          aria-valuemin={viewport.heightBounds.min}
          aria-valuemax={viewport.heightBounds.max}
          aria-valuenow={viewport.effectiveHeightPx ?? viewport.autoViewportHeightPx ?? undefined}
          data-testid="mermaid-resize-handle"
          className={`mermaid-resize-handle${viewport.isResizingHeight ? ' is-dragging' : ''}`}
          onPointerDown={(event) => {
            event.stopPropagation()
            viewport.handleResizeStart(event)
          }}
          onMouseDown={(event) => {
            event.stopPropagation()
            viewport.handleResizeStart(event)
          }}
          onKeyDown={viewport.handleResizeKeyDown}
          onDoubleClick={viewport.handleResizeDoubleClick}
        />
      )}
    </div>
  )
}

interface MermaidDiagramProps {
  code: string
  theme: ThemeMode
  documentTitle?: string
  renderer?: MermaidRenderer
  debounceMs?: number
  blockIndex?: number
  className?: string
  sourceLine?: string
  sourceEndLine?: string
}

/**
 * Renders a Mermaid diagram block with debounced live updates, theme synchronization,
 * last-valid SVG retention, interactive zoom/pan/resize viewport controls, and floating action controls.
 */
export function MermaidDiagram({
  code,
  theme,
  documentTitle,
  renderer = defaultMermaidRenderer,
  debounceMs = DEFAULT_MERMAID_DEBOUNCE_MS,
  blockIndex,
  className,
  sourceLine,
  sourceEndLine
}: MermaidDiagramProps) {
  const [isHovered, setIsHovered] = useState(false)
  const { persistedHeightPx, onCustomHeightChange } = useMermaidSessionHeight(blockIndex)

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
    documentTitle
  })

  const viewport = useMermaidViewport({
    hasSvg: displaySvg !== null,
    svgMarkup: displaySvg,
    persistedHeightPx,
    heightSyncKey: blockIndex,
    onCustomHeightChange
  })

  return (
    <MermaidDiagramView
      code={code}
      mermaidTheme={mermaidTheme}
      displaySvg={displaySvg}
      displayError={displayError}
      viewport={viewport}
      className={className}
      sourceLine={sourceLine}
      sourceEndLine={sourceEndLine}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <MermaidActionBar variant="floating" isVisible={isHovered} actions={actions} viewport={viewport} />
      <MermaidActionErrorAlert message={actions.errorMessage} />
    </MermaidDiagramView>
  )
}
