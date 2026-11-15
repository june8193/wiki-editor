import { createContext, useContext, useState } from 'react'
import type { ThemeMode } from '@shared/config'
import { NodeViewContent, type NodeViewProps, NodeViewWrapper } from '@tiptap/react'
import type { MermaidRenderer } from '../editor/mermaidRenderer'
import { useMermaidDiagramActions } from '../hooks/useMermaidDiagramActions'
import { useMermaidRenderState } from '../hooks/useMermaidRenderState'
import { MermaidActionBar, MermaidActionErrorAlert } from './MermaidActionBar'
import { MermaidDiagramView } from './MermaidDiagram'

export interface WysiwygMermaidContextValue {
  theme: ThemeMode
  mermaidRenderer?: MermaidRenderer
  documentTitle?: string
}

export const WysiwygMermaidContext = createContext<WysiwygMermaidContextValue>({
  theme: 'light'
})

function WysiwygMermaidBlock({ code }: { code: string }) {
  const { theme, mermaidRenderer, documentTitle } = useContext(WysiwygMermaidContext)
  const [showSource, setShowSource] = useState(false)

  const { mermaidTheme, displaySvg, confirmedSvg, displayError } = useMermaidRenderState({
    code,
    theme,
    renderer: mermaidRenderer
  })

  const actions = useMermaidDiagramActions({
    code,
    theme,
    confirmedSvg,
    documentTitle
  })

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
        <MermaidDiagramView
          code={code}
          mermaidTheme={mermaidTheme}
          displaySvg={displaySvg}
          displayError={displayError}
        />
      </div>

      <MermaidActionErrorAlert message={actions.errorMessage} />
    </NodeViewWrapper>
  )
}

export function MermaidCodeBlockNodeView({ node }: NodeViewProps) {
  const language = typeof node.attrs.language === 'string' ? node.attrs.language : ''
  if (language !== 'mermaid') {
    return (
      <NodeViewWrapper as="pre" className="wysiwyg-code-block">
        <NodeViewContent<'code'> as="code" className={language ? `language-${language}` : undefined} />
      </NodeViewWrapper>
    )
  }

  return <WysiwygMermaidBlock code={node.textContent} />
}
