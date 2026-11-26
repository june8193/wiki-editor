import type { SyntaxNode, Tree } from '@lezer/common'
import type { GitFileStatusCode } from '@shared/git'
import type {
  DocumentSymbolItem,
  SymbolIdentifierToken,
  SymbolKind,
  SymbolRange
} from '@shared/symbol'
import { getFileExtension } from '../utils/diffSyntaxHighlight'
import { parseUnifiedDiff } from '../utils/unifiedDiff'
import type { CodeParser } from './codeBlockHighlight'

const SYMBOL_SUPPORTED_EXTENSIONS = new Set([
  'ts',
  'tsx',
  'mts',
  'cts',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'py',
  'pyw',
  'go',
  'rs',
  'c',
  'cc',
  'cpp',
  'cxx',
  'h',
  'hh',
  'hpp',
  'hxx',
  'java',
  'php',
  'css',
  'scss',
  'sass',
  'less',
  'sql'
])

const IGNORED_SUBTREE_NAMES = new Set([
  'Comment',
  'LineComment',
  'BlockComment',
  'DocComment',
  'String',
  'TemplateString',
  'RawString',
  'CharLiteral',
  'StringLiteral',
  'InterpretedStringLiteral',
  'RawStringLiteral',
  'RegExp'
])

const IDENTIFIER_NODE_NAMES = new Set([
  'VariableName',
  'VariableDefinition',
  'PropertyName',
  'PropertyDefinition',
  'TypeName',
  'TypeDefinition',
  'Identifier',
  'BoundIdentifier',
  'TypeIdentifier',
  'FieldIdentifier',
  'DefName',
  'FieldName',
  'TypeDef',
  'Definition'
])

const DECLARATION_IDENTIFIER_NAMES = new Set([
  'VariableDefinition',
  'PropertyDefinition',
  'TypeDefinition',
  'BoundIdentifier',
  'DefName',
  'TypeDef',
  'Definition'
])

const DECLARATION_PARENT_NAMES = new Set([
  'FunctionDeclaration',
  'FunctionDecl',
  'FunctionDefinition',
  'FunctionItem',
  'FunctionDeclarator',
  'ClassDeclaration',
  'ClassDefinition',
  'ClassSpecifier',
  'StructSpecifier',
  'StructItem',
  'InterfaceDeclaration',
  'TraitItem',
  'TypeAliasDeclaration',
  'TypeSpec',
  'TypeItem',
  'EnumDeclaration',
  'EnumItem',
  'EnumSpecifier',
  'MethodDeclaration',
  'MethodDecl',
  'ConstructorDeclaration',
  'PropertyDeclaration',
  'ConstSpec',
  'VarSpec',
  'ConstItem',
  'StaticItem'
])

/**
 * Returns true if the given file path has a programming language extension
 * supported by Lezer symbol extraction (excludes Markdown, plain text, JSON, and images).
 */
export function isSymbolSupportedFile(filePath: string | null | undefined): boolean {
  if (!filePath) {
    return false
  }
  const ext = getFileExtension(filePath)
  return ext ? SYMBOL_SUPPORTED_EXTENSIONS.has(ext) : false
}

function buildLineStarts(content: string): number[] {
  const starts = [0]
  for (let i = 0; i < content.length; i += 1) {
    if (content.charCodeAt(i) === 10) {
      starts.push(i + 1)
    }
  }
  return starts
}

function offsetToLineColumn(
  lineStarts: readonly number[],
  offset: number
): { lineNumber: number; column: number } {
  let low = 0
  let high = lineStarts.length - 1
  while (low < high) {
    const mid = (low + high + 1) >> 1
    if (lineStarts[mid] <= offset) {
      low = mid
    } else {
      high = mid - 1
    }
  }
  return {
    lineNumber: low + 1,
    column: Math.max(0, offset - lineStarts[low])
  }
}

function lineColumnToOffset(
  lineStarts: readonly number[],
  contentLength: number,
  lineNumber: number,
  column: number
): number {
  const lineIndex = Math.max(0, Math.min(lineStarts.length - 1, lineNumber - 1))
  const lineStart = lineStarts[lineIndex]
  const nextLineStart = lineIndex + 1 < lineStarts.length ? lineStarts[lineIndex + 1] : contentLength
  return Math.max(lineStart, Math.min(nextLineStart, lineStart + Math.max(0, column)))
}

function findDirectChildByNames(node: SyntaxNode, names: readonly string[]): SyntaxNode | null {
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (names.includes(child.name)) {
      return child
    }
  }
  return null
}

function findDescendantByNames(
  node: SyntaxNode,
  names: readonly string[],
  maxDepth = 4
): SyntaxNode | null {
  if (maxDepth <= 0) {
    return null
  }
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (names.includes(child.name)) {
      return child
    }
    const nested = findDescendantByNames(child, names, maxDepth - 1)
    if (nested) {
      return nested
    }
  }
  return null
}

function isTopLevelNode(node: SyntaxNode): boolean {
  const parent = node.parent
  if (!parent) return true
  if (
    parent.name === 'Script' ||
    parent.name === 'Program' ||
    parent.name === 'SourceFile' ||
    parent.name === 'TranslationUnit'
  ) {
    return true
  }
  if (parent.name === 'ExportDeclaration' || parent.name === 'ExportGroup') {
    return isTopLevelNode(parent)
  }
  return false
}

function isIgnoredSubtreeNode(nodeName: string): boolean {
  return (
    IGNORED_SUBTREE_NAMES.has(nodeName) ||
    nodeName.includes('Comment') ||
    nodeName.includes('String')
  )
}

function isInsideIgnoredSubtree(node: SyntaxNode | null): boolean {
  for (let cur = node; cur; cur = cur.parent) {
    if (isIgnoredSubtreeNode(cur.name)) {
      return true
    }
  }
  return false
}

function nodeSpanToSymbolRange(
  lineStarts: readonly number[],
  node: SyntaxNode,
  nameLength: number
): SymbolRange {
  const start = offsetToLineColumn(lineStarts, node.from)
  const end = offsetToLineColumn(lineStarts, node.to)
  return {
    lineNumber: start.lineNumber,
    columnStart: start.column,
    columnEnd: end.lineNumber === start.lineNumber ? end.column : start.column + nameLength
  }
}

function pushSymbol(
  symbols: DocumentSymbolItem[],
  content: string,
  lineStarts: readonly number[],
  nameNode: SyntaxNode | null,
  kind: SymbolKind,
  containerName?: string
): string | null {
  if (!nameNode) {
    return null
  }
  const name = content.slice(nameNode.from, nameNode.to).trim()
  if (!name) {
    return null
  }
  symbols.push({
    name,
    kind,
    ...nodeSpanToSymbolRange(lineStarts, nameNode, name.length),
    ...(containerName ? { containerName } : {})
  })
  return name
}

const TOP_LEVEL_VARIABLE_NAME_NODES: Readonly<
  Record<string, { childNames: readonly string[]; checkGrandparent?: boolean }>
> = {
  VariableDeclaration: { childNames: ['VariableDefinition'] },
  AssignStatement: { childNames: ['VariableName'] },
  ConstSpec: { childNames: ['DefName'], checkGrandparent: true },
  VarSpec: { childNames: ['DefName'], checkGrandparent: true },
  ConstItem: { childNames: ['Identifier'] },
  StaticItem: { childNames: ['Identifier'] }
}

interface SimpleSymbolNodeSpec {
  childNames: readonly string[]
  kind: SymbolKind
  setsContainer?: boolean
  useContainerForKind?: boolean
}

const SIMPLE_SYMBOL_NODE_SPECS: Readonly<Record<string, SimpleSymbolNodeSpec>> = {
  FunctionDeclaration: { childNames: ['VariableDefinition', 'DefName', 'Identifier'], kind: 'function' },
  FunctionDecl: { childNames: ['VariableDefinition', 'DefName', 'Identifier'], kind: 'function' },
  FunctionItem: {
    childNames: ['BoundIdentifier', 'Identifier'],
    kind: 'function',
    useContainerForKind: true
  },
  ClassDeclaration: {
    childNames: ['VariableDefinition', 'VariableName', 'Definition', 'TypeIdentifier'],
    kind: 'class',
    setsContainer: true
  },
  ClassDefinition: {
    childNames: ['VariableDefinition', 'VariableName', 'Definition', 'TypeIdentifier'],
    kind: 'class',
    setsContainer: true
  },
  ClassSpecifier: {
    childNames: ['VariableDefinition', 'VariableName', 'Definition', 'TypeIdentifier'],
    kind: 'class',
    setsContainer: true
  },
  StructSpecifier: { childNames: ['TypeIdentifier'], kind: 'class', setsContainer: true },
  InterfaceDeclaration: {
    childNames: ['TypeDefinition', 'Definition', 'TypeIdentifier'],
    kind: 'interface',
    setsContainer: true
  },
  TraitItem: {
    childNames: ['TypeDefinition', 'Definition', 'TypeIdentifier'],
    kind: 'interface',
    setsContainer: true
  },
  TypeAliasDeclaration: { childNames: ['TypeDefinition', 'TypeIdentifier'], kind: 'type' },
  TypeItem: { childNames: ['TypeDefinition', 'TypeIdentifier'], kind: 'type' },
  StructItem: { childNames: ['TypeIdentifier'], kind: 'type' },
  EnumDeclaration: { childNames: ['TypeDefinition', 'Definition', 'TypeIdentifier'], kind: 'enum' },
  EnumItem: { childNames: ['TypeDefinition', 'Definition', 'TypeIdentifier'], kind: 'enum' },
  EnumSpecifier: { childNames: ['TypeDefinition', 'Definition', 'TypeIdentifier'], kind: 'enum' },
  PropertyDeclaration: { childNames: ['PropertyDefinition'], kind: 'property' }
}

function visitSyntaxNode(
  node: SyntaxNode,
  content: string,
  lineStarts: readonly number[],
  symbols: DocumentSymbolItem[],
  containerName?: string
): void {
  if (isIgnoredSubtreeNode(node.name)) {
    return
  }

  let nextContainer = containerName
  const simpleSpec = SIMPLE_SYMBOL_NODE_SPECS[node.name]
  if (simpleSpec) {
    const nameNode = findDirectChildByNames(node, simpleSpec.childNames)
    const resolvedKind =
      simpleSpec.useContainerForKind && containerName ? 'method' : simpleSpec.kind
    const pushedName = pushSymbol(symbols, content, lineStarts, nameNode, resolvedKind, containerName)
    if (simpleSpec.setsContainer && pushedName) {
      nextContainer = pushedName
    }
  } else {
    switch (node.name) {
      case 'FunctionDefinition': {
        // Python or C/C++
        const pyName = findDirectChildByNames(node, ['VariableName'])
        const declarator = pyName ? null : findDescendantByNames(node, ['FunctionDeclarator'], 3)
        const nameNode =
          pyName ??
          (declarator ? findDirectChildByNames(declarator, ['Identifier', 'FieldIdentifier']) : null)
        pushSymbol(
          symbols,
          content,
          lineStarts,
          nameNode,
          containerName ? 'method' : 'function',
          containerName
        )
        break
      }
      case 'ImplItem': {
        const typeNode = findDirectChildByNames(node, ['TypeIdentifier'])
        if (typeNode) {
          nextContainer = content.slice(typeNode.from, typeNode.to).trim() || containerName
        }
        break
      }
      case 'TypeSpec': {
        // Go
        const nameNode = findDirectChildByNames(node, ['DefName', 'TypeDef'])
        const isInterface = findDirectChildByNames(node, ['InterfaceType']) !== null
        pushSymbol(
          symbols,
          content,
          lineStarts,
          nameNode,
          isInterface ? 'interface' : 'type',
          containerName
        )
        break
      }
      case 'MethodDeclaration':
      case 'MethodDecl':
      case 'ConstructorDeclaration': {
        // TS/JS, Go, Java
        const nameNode =
          findDirectChildByNames(node, ['PropertyDefinition', 'Definition', 'FieldName']) ??
          findDescendantByNames(node, ['FieldName', 'DefName'], 2)
        pushSymbol(symbols, content, lineStarts, nameNode, 'method', containerName)
        break
      }
      case 'FieldDeclaration': {
        // Java class field
        if (containerName) {
          const declarator = findDirectChildByNames(node, ['VariableDeclarator'])
          const nameNode = declarator ? findDirectChildByNames(declarator, ['Definition']) : null
          pushSymbol(symbols, content, lineStarts, nameNode, 'property', containerName)
        }
        break
      }
      default: {
        const varSpec = TOP_LEVEL_VARIABLE_NAME_NODES[node.name]
        if (varSpec) {
          const scopeNode = varSpec.checkGrandparent ? node.parent : node
          if (scopeNode && isTopLevelNode(scopeNode)) {
            const nameNode = findDirectChildByNames(node, varSpec.childNames)
            pushSymbol(symbols, content, lineStarts, nameNode, 'variable', containerName)
          }
        }
        break
      }
    }
  }

  for (let child = node.firstChild; child; child = child.nextSibling) {
    visitSyntaxNode(child, content, lineStarts, symbols, nextContainer)
  }
}

/**
 * Extracts declaration symbols (functions, classes, methods, interfaces, types, enums, variables, properties)
 * from source code using a Lezer parser, ignoring comments and string literals.
 */
export function extractDocumentSymbols(
  content: string,
  parser: CodeParser | null
): DocumentSymbolItem[] {
  if (!content || !parser) {
    return []
  }
  const tree = parser.parse(content) as unknown as Tree
  const lineStarts = buildLineStarts(content)
  const symbols: DocumentSymbolItem[] = []
  visitSyntaxNode(tree.topNode, content, lineStarts, symbols)
  return symbols
}

/**
 * Resolves the identifier token at a 1-based line/0-based column or character offset using a Lezer syntax tree.
 * Returns null if the position is inside a comment, string literal, keyword, or non-identifier token.
 */
export function extractIdentifierAtPosition(
  content: string,
  position: { lineNumber: number; column: number } | number,
  parser: CodeParser | null
): SymbolIdentifierToken | null {
  if (!content || !parser) {
    return null
  }
  const lineStarts = buildLineStarts(content)
  const offset =
    typeof position === 'number'
      ? Math.max(0, Math.min(content.length, position))
      : lineColumnToOffset(lineStarts, content.length, position.lineNumber, position.column)

  const tree = parser.parse(content) as unknown as Tree
  let node: SyntaxNode | null = tree.resolveInner(offset, -1)
  if (!IDENTIFIER_NODE_NAMES.has(node.name)) {
    const rightNode = tree.resolveInner(offset, 1)
    if (IDENTIFIER_NODE_NAMES.has(rightNode.name)) {
      node = rightNode
    }
  }

  if (!IDENTIFIER_NODE_NAMES.has(node.name) || isInsideIgnoredSubtree(node)) {
    return null
  }

  const name = content.slice(node.from, node.to).trim()
  if (!name) {
    return null
  }

  const parentName = node.parent?.name ?? ''
  const isDeclaration =
    DECLARATION_IDENTIFIER_NAMES.has(node.name) || DECLARATION_PARENT_NAMES.has(parentName)

  return {
    name,
    ...nodeSpanToSymbolRange(lineStarts, node, name.length),
    isDeclaration
  }
}

/**
 * Extracts symbols from unified diff hunks (new-side lines) and annotates each symbol
 * with `'added'` or `'modified'` diff change badges when applicable.
 */
export function extractDiffSymbols(
  rawPatch: string,
  fileStatus: GitFileStatusCode | undefined,
  parser: CodeParser | null
): DocumentSymbolItem[] {
  if (!rawPatch || !parser) {
    return []
  }

  const parsed = parseUnifiedDiff(rawPatch)
  if (parsed.hunks.length === 0) {
    return []
  }

  const result: DocumentSymbolItem[] = []
  const seen = new Set<string>()
  const isNewFile = fileStatus === 'A' || fileStatus === '?'

  for (const hunk of parsed.hunks) {
    const newLines: Array<{
      lineNumber: number
      content: string
      isAdded: boolean
      deletedBlockIndex: number
      hadPureDeleteBefore: boolean
    }> = []
    const deletedBlocks: string[][] = []
    let activeDeletedBlockIndex = -1

    for (const line of hunk.lines) {
      if (line.type === 'delete') {
        if (activeDeletedBlockIndex === -1) {
          activeDeletedBlockIndex = deletedBlocks.length
          deletedBlocks.push([])
        }
        deletedBlocks[activeDeletedBlockIndex].push(line.content)
        continue
      }
      if (line.type === 'note' || line.newLineNumber === null) {
        continue
      }
      const isAdded = line.type === 'add'
      const hadPureDeleteBefore = !isAdded && activeDeletedBlockIndex !== -1
      if (!isAdded) {
        activeDeletedBlockIndex = -1
      }
      newLines.push({
        lineNumber: line.newLineNumber,
        content: line.content,
        isAdded,
        deletedBlockIndex: isAdded ? activeDeletedBlockIndex : -1,
        hadPureDeleteBefore
      })
    }

    if (newLines.length === 0) {
      continue
    }

    const deletedNamesByBlock = deletedBlocks.map((lines) => {
      const syms = extractDocumentSymbols(lines.join('\n'), parser)
      return new Set(syms.map((s) => s.name))
    })

    const hunkCode = newLines.map((entry) => entry.content).join('\n')
    const extracted = extractDocumentSymbols(hunkCode, parser)

    for (let i = 0; i < extracted.length; i += 1) {
      const sym = extracted[i]
      const entry = newLines[sym.lineNumber - 1]
      if (!entry) {
        continue
      }

      const nextSymEntry =
        i + 1 < extracted.length ? newLines[extracted[i + 1].lineNumber - 1] : undefined
      const symEndLine = nextSymEntry ? nextSymEntry.lineNumber - 1 : Number.POSITIVE_INFINITY

      let diffChange: 'added' | 'modified' | undefined
      if (isNewFile) {
        diffChange = 'added'
      } else if (entry.isAdded) {
        const deletedNames =
          entry.deletedBlockIndex >= 0 ? deletedNamesByBlock[entry.deletedBlockIndex] : undefined
        diffChange = deletedNames?.has(sym.name) ? 'modified' : 'added'
      } else if (
        newLines.some(
          (candidate) =>
            candidate.lineNumber > entry.lineNumber &&
            candidate.lineNumber <= symEndLine &&
            (candidate.isAdded || candidate.hadPureDeleteBefore)
        )
      ) {
        diffChange = 'modified'
      }

      const dedupKey = `${sym.name}\0${sym.kind}\0${entry.lineNumber}`
      if (seen.has(dedupKey)) {
        continue
      }
      seen.add(dedupKey)

      result.push({
        ...sym,
        lineNumber: entry.lineNumber,
        ...(diffChange ? { diffChange } : {})
      })
    }
  }

  return result
}
