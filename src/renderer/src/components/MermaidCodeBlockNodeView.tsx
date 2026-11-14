import { createContext, useContext, useState } from 'react'
import type { ThemeMode } from '@shared/config'
import { NodeViewContent, type NodeViewProps, NodeViewWrapper } from '@tiptap/react'
import type { MermaidRenderer } from '../editor/mermaidRenderer'
import { MermaidDiagram } from './MermaidDiagram'

export interface WysiwygMermaidContextValue {
  theme: ThemeMode
  mermaidRenderer?: MermaidRenderer
}

export const WysiwygMermaidContext = createContext<WysiwygMermaidContextValue>({
  theme: 'light'
})

export function MermaidCodeBlockNodeView({ node }: NodeViewProps) {
  const { theme, mermaidRenderer } = useContext(WysiwygMermaidContext)
  const [showSource, setShowSource] = useState(false)
  const language = typeof node.attrs.language === 'string' ? node.attrs.language : ''

  if (language !== 'mermaid') {
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
        <button
          type="button"
          className="toolbar-btn"
          onClick={() => setShowSource((prev) => !prev)}
        >
          {showSource ? '코드 숨기기' : '코드 편집'}
        </button>
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
        <MermaidDiagram code={node.textContent} theme={theme} renderer={mermaidRenderer} />
      </div>
    </NodeViewWrapper>
  )
}
