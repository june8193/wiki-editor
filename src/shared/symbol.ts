export type SymbolKind =
  | 'function'
  | 'class'
  | 'method'
  | 'interface'
  | 'type'
  | 'enum'
  | 'variable'
  | 'property'

export interface SymbolRange {
  /** 1-based line number */
  lineNumber: number
  /** 0-based column start */
  columnStart: number
  /** 0-based column end */
  columnEnd: number
}

export interface DocumentSymbolItem extends SymbolRange {
  name: string
  kind: SymbolKind
  containerName?: string
  diffChange?: 'added' | 'modified'
}

export interface SymbolIdentifierToken extends SymbolRange {
  name: string
  isDeclaration: boolean
}
