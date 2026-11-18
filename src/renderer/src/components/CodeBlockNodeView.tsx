import { useLayoutEffect, useRef } from 'react'
import { NodeViewContent, type NodeViewProps, NodeViewWrapper } from '@tiptap/react'
import { isMermaidLanguage, resolveCanonicalLanguageInput } from '../editor/codeBlockHighlight'
import { CodeBlockCopyButton, CodeBlockLanguageCombobox } from './CodeBlockHeaderControls'
import { WysiwygMermaidBlock } from './MermaidCodeBlockNodeView'

/**
 * TipTap NodeView for WYSIWYG code blocks, rendering either a syntax-highlighted
 * code block header with language combobox/copy controls or the Mermaid diagram block.
 */
export function CodeBlockNodeView({ node, updateAttributes, getPos }: NodeViewProps) {
  const language = typeof node.attrs.language === 'string' ? node.attrs.language : ''
  const isMermaid = isMermaidLanguage(language)
  const pendingTriggerFocusRef = useRef(false)
  const autoFocusTriggerOnMount = pendingTriggerFocusRef.current

  useLayoutEffect(() => {
    pendingTriggerFocusRef.current = false
  }, [isMermaid])

  const handleSelectLanguage = (nextLanguage: string): void => {
    const normalizedNext = nextLanguage || ''
    if (
      normalizedNext === language ||
      resolveCanonicalLanguageInput(normalizedNext) === resolveCanonicalLanguageInput(language)
    ) {
      return
    }
    pendingTriggerFocusRef.current = isMermaidLanguage(normalizedNext) !== isMermaid
    updateAttributes({ language: normalizedNext || null })
  }

  if (!isMermaid) {
    const codeText = node.textContent
    return (
      <NodeViewWrapper
        as="div"
        className="wysiwyg-code-block-node"
        data-testid="wysiwyg-code-block"
        data-language={language || 'plaintext'}
      >
        <div className="code-block-header" contentEditable={false}>
          <CodeBlockLanguageCombobox
            language={language}
            autoFocusTriggerOnMount={autoFocusTriggerOnMount}
            onSelectLanguage={handleSelectLanguage}
          />
          <CodeBlockCopyButton code={codeText} />
        </div>
        <pre className="wysiwyg-code-block">
          <NodeViewContent<'code'>
            as="code"
            className={language ? `language-${language}` : undefined}
          />
        </pre>
      </NodeViewWrapper>
    )
  }

  return (
    <WysiwygMermaidBlock
      language={language || 'mermaid'}
      code={node.textContent}
      getBlockPos={typeof getPos === 'function' ? getPos : undefined}
      autoFocusTriggerOnMount={autoFocusTriggerOnMount}
      onSelectLanguage={handleSelectLanguage}
    />
  )
}
