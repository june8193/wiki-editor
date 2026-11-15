import { createContext, useContext, useState } from 'react'
import type { ThemeMode } from '@shared/config'
import { NodeViewContent, type NodeViewProps, NodeViewWrapper } from '@tiptap/react'
import type { MermaidRenderer } from '../editor/mermaidRenderer'
import { useMermaidDiagramActions } from '../hooks/useMermaidDiagramActions'
import { useMermaidRenderState } from '../hooks/useMermaidRenderState'
import { MermaidActionBar, MermaidActionErrorAlert } from './MermaidActionBar'
import { MermaidDiagram } from './MermaidDiagram'
import { MermaidExportContext } from './MermaidExportContext'

export interface WysiwygMermaidContextValue {
  theme: ThemeMode
  mermaidRenderer?: MermaidRenderer
}

export const WysiwygMermaidContext = createContext<WysiwygMermaidContextValue>({
  theme: 'light'
})

export function MermaidCodeBlockNodeView({ node }: NodeViewProps) {
  const { theme, mermaidRenderer } = useContext(WysiwygMermaidContext)
  const rasterAdapter = useContext(MermaidExportContext)
  const [showSource, setShowSource] = useState(false)
  const language = typeof node.attrs.language === 'string' ? node.attrs.language : ''
  const isMermaid = language === 'mermaid'
  const code = isMermaid ? node.textContent : ''

  const renderState = useMermaidRenderState({
    code,
    theme,
    renderer: mermaidRenderer,
    enabled: isMermaid
  })

  const actions = useMermaidDiagramActions({
    code,
    theme,
    confirmedSvg: renderState.confirmedSvg,
    rasterAdapter
  })

  if (!isMermaid) {
    return (
      <NodeViewWrapper as="pre" className="wysiwyg-code-block">
        <NodeViewContent<'code'> as="code" className={language ? `language-${language}` : undefined} />
      </NodeViewWrapper>
    )
  }

  return (
    <NodeViewWrapper
      as="div"
      className="wysiwyg-mermaid-node"
      data-testid="wysiwyg-mermaid-block"
    >
      <div
        className="mermaid-node-header"
        contentEditable={false}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <span className="mermaid-node-badge">Mermaid</span>
        <div className="mermaid-node-header-actions">
          <MermaidActionBar variant="inline" actions={actions} />
          <button
            type="button"
            className="toolbar-btn"
            onClick={() => setShowSource((prev) => !prev)}
          >
            {showSource ? '코드 숨기기' : '코드 편집'}
          </button>
        </div>
      </div>

      <div
        className="mermaid-node-source-wrapper"
        style={showSource ? undefined : { display: 'none' }}
      >
        <pre className="mermaid-node-source">
          <NodeViewContent<'code'> as="code" />
        </pre>
      </div>

      <div
        className="mermaid-node-preview"
        contentEditable={false}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <MermaidDiagram
          code={code}
          theme={theme}
          renderer={mermaidRenderer}
          renderState={renderState}
          showActionBar={false}
        />
      </div>

      <MermaidActionErrorAlert message={actions.errorMessage} />
    </NodeViewWrapper>
  )
}
