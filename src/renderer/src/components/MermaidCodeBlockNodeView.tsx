import { createContext, useContext, useState } from 'react'
import type { ThemeMode } from '@shared/config'
import { NodeViewContent, NodeViewWrapper } from '@tiptap/react'
import type { MermaidRenderer } from '../editor/mermaidRenderer'
import { useMermaidDiagramActions } from '../hooks/useMermaidDiagramActions'
import { useMermaidRenderState } from '../hooks/useMermaidRenderState'
import { CodeBlockLanguageCombobox } from './CodeBlockHeaderControls'
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

export interface WysiwygMermaidBlockProps {
  language: string
  code: string
  autoFocusTriggerOnMount: boolean
  onSelectLanguage: (nextLanguage: string) => void
}

/**
 * Interactive WYSIWYG Mermaid block view with inline export/copy toolbar,
 * collapsible source editor, and language switcher.
 */
export function WysiwygMermaidBlock({
  language,
  code,
  autoFocusTriggerOnMount,
  onSelectLanguage
}: WysiwygMermaidBlockProps) {
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
      <div className="mermaid-node-header" contentEditable={false}>
        <CodeBlockLanguageCombobox
          language={language}
          autoFocusTriggerOnMount={autoFocusTriggerOnMount}
          onSelectLanguage={onSelectLanguage}
        />
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

      <div className="mermaid-node-preview" contentEditable={false}>
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
