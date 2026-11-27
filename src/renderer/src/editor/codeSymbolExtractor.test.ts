import { describe, expect, it } from 'vitest'
import {
  extractDiffSymbols,
  extractDocumentSymbols,
  extractIdentifierAtPosition,
  isSymbolSupportedFile
} from './codeSymbolExtractor'
import { resolveCodeBlockParser } from './codeBlockHighlight'

describe('codeSymbolExtractor', () => {
  it('identifies supported code file extensions and excludes markdown, text, json, and images', () => {
    expect(isSymbolSupportedFile('src/app.ts')).toBe(true)
    expect(isSymbolSupportedFile('src/Component.tsx')).toBe(true)
    expect(isSymbolSupportedFile('index.js')).toBe(true)
    expect(isSymbolSupportedFile('App.jsx')).toBe(true)
    expect(isSymbolSupportedFile('main.py')).toBe(true)
    expect(isSymbolSupportedFile('server.go')).toBe(true)
    expect(isSymbolSupportedFile('lib.rs')).toBe(true)
    expect(isSymbolSupportedFile('engine.cpp')).toBe(true)
    expect(isSymbolSupportedFile('engine.h')).toBe(true)
    expect(isSymbolSupportedFile('Service.java')).toBe(true)

    expect(isSymbolSupportedFile('README.md')).toBe(false)
    expect(isSymbolSupportedFile('notes.markdown')).toBe(false)
    expect(isSymbolSupportedFile('notes.txt')).toBe(false)
    expect(isSymbolSupportedFile('config.json')).toBe(false)
    expect(isSymbolSupportedFile('diagram.png')).toBe(false)
    expect(isSymbolSupportedFile('README')).toBe(false)
  })

  it('extracts TypeScript functions, classes, methods, interfaces, types, enums, and top-level variables while ignoring comments and strings', () => {
    const code = [
      '// function fakeInComment() {}',
      '/* class FakeBlockComment {} */',
      'const fakeText = "function fakeInString() {}"',
      'export interface UserProfile {',
      '  id: string',
      '}',
      'export type UserId = string',
      'export enum UserRole {',
      '  Admin = "admin"',
      '}',
      'export class UserService {',
      '  private readonly count: number = 0',
      '  async findUser(id: UserId): Promise<UserProfile | null> {',
      '    const localTemp = id',
      '    return null',
      '  }',
      '}',
      'export function createService(): UserService {',
      '  return new UserService()',
      '}'
    ].join('\n')

    const parser = resolveCodeBlockParser('ts')
    const symbols = extractDocumentSymbols(code, parser)

    expect(symbols.map((s) => ({ name: s.name, kind: s.kind, line: s.lineNumber, container: s.containerName }))).toEqual([
      { name: 'fakeText', kind: 'variable', line: 3, container: undefined },
      { name: 'UserProfile', kind: 'interface', line: 4, container: undefined },
      { name: 'UserId', kind: 'type', line: 7, container: undefined },
      { name: 'UserRole', kind: 'enum', line: 8, container: undefined },
      { name: 'UserService', kind: 'class', line: 11, container: undefined },
      { name: 'count', kind: 'property', line: 12, container: 'UserService' },
      { name: 'findUser', kind: 'method', line: 13, container: 'UserService' },
      { name: 'createService', kind: 'function', line: 18, container: undefined }
    ])
  })

  it('extracts Python classes, methods, functions, and module-level variables', () => {
    const code = [
      '# def commented_fn(): pass',
      'MAX_RETRIES = 3',
      'class Worker:',
      '    def run(self, task_id):',
      '        local_var = task_id',
      '        return local_var',
      '',
      'def helper():',
      '    return "def fake_in_string():"'
    ].join('\n')

    const parser = resolveCodeBlockParser('py')
    const symbols = extractDocumentSymbols(code, parser)

    expect(symbols.map((s) => ({ name: s.name, kind: s.kind, line: s.lineNumber, container: s.containerName }))).toEqual([
      { name: 'MAX_RETRIES', kind: 'variable', line: 2, container: undefined },
      { name: 'Worker', kind: 'class', line: 3, container: undefined },
      { name: 'run', kind: 'method', line: 4, container: 'Worker' },
      { name: 'helper', kind: 'function', line: 8, container: undefined }
    ])
  })

  it('extracts Go structs/interfaces, methods, functions, and package variables', () => {
    const code = [
      'package main',
      'const DefaultPort = 8080',
      'type Server struct {',
      '    port int',
      '}',
      'func (s *Server) Start() error {',
      '    return nil',
      '}',
      'func main() {}'
    ].join('\n')

    const parser = resolveCodeBlockParser('go')
    const symbols = extractDocumentSymbols(code, parser)

    expect(symbols.map((s) => ({ name: s.name, kind: s.kind, line: s.lineNumber }))).toEqual([
      { name: 'DefaultPort', kind: 'variable', line: 2 },
      { name: 'Server', kind: 'type', line: 3 },
      { name: 'Start', kind: 'method', line: 6 },
      { name: 'main', kind: 'function', line: 9 }
    ])
  })

  it('extracts Rust structs, enums, traits, impl methods, and functions', () => {
    const code = [
      'struct Config {',
      '    debug: bool,',
      '}',
      'enum Mode {',
      '    Fast,',
      '}',
      'trait Runner {',
      '    fn execute(&self);',
      '}',
      'impl Config {',
      '    fn is_debug(&self) -> bool { self.debug }',
      '}',
      'fn main() {}'
    ].join('\n')

    const parser = resolveCodeBlockParser('rs')
    const symbols = extractDocumentSymbols(code, parser)

    expect(symbols.map((s) => ({ name: s.name, kind: s.kind, line: s.lineNumber, container: s.containerName }))).toEqual([
      { name: 'Config', kind: 'type', line: 1, container: undefined },
      { name: 'Mode', kind: 'enum', line: 4, container: undefined },
      { name: 'Runner', kind: 'interface', line: 7, container: undefined },
      { name: 'execute', kind: 'method', line: 8, container: 'Runner' },
      { name: 'is_debug', kind: 'method', line: 11, container: 'Config' },
      { name: 'main', kind: 'function', line: 13, container: undefined }
    ])
  })

  it('extracts Java classes, interfaces, enums, and methods', () => {
    const code = [
      'public interface Greeter {',
      '    void greet();',
      '}',
      'public class AppGreeter implements Greeter {',
      '    public void greet() {}',
      '}'
    ].join('\n')

    const parser = resolveCodeBlockParser('java')
    const symbols = extractDocumentSymbols(code, parser)

    expect(symbols.map((s) => ({ name: s.name, kind: s.kind, line: s.lineNumber, container: s.containerName }))).toEqual([
      { name: 'Greeter', kind: 'interface', line: 1, container: undefined },
      { name: 'greet', kind: 'method', line: 2, container: 'Greeter' },
      { name: 'AppGreeter', kind: 'class', line: 4, container: undefined },
      { name: 'greet', kind: 'method', line: 5, container: 'AppGreeter' }
    ])
  })

  it('extracts C++ classes, structs, and functions', () => {
    const code = [
      'class Engine {',
      'public:',
      '    void start() {}',
      '};',
      'int compute(int x) {',
      '    return x + 1;',
      '}'
    ].join('\n')

    const parser = resolveCodeBlockParser('cpp')
    const symbols = extractDocumentSymbols(code, parser)

    expect(symbols.map((s) => ({ name: s.name, kind: s.kind, line: s.lineNumber }))).toEqual([
      { name: 'Engine', kind: 'class', line: 1 },
      { name: 'start', kind: 'method', line: 3 },
      { name: 'compute', kind: 'function', line: 5 }
    ])
  })

  it('extracts identifier token at position and returns null inside comments or strings', () => {
    const code = [
      '// computeValue in comment',
      'const label = "computeValue in string"',
      'function computeValue(input: number): number {',
      '  return input + 1',
      '}',
      'const out = computeValue(42)'
    ].join('\n')

    const parser = resolveCodeBlockParser('ts')

    // Line 1: comment -> null
    expect(extractIdentifierAtPosition(code, { lineNumber: 1, column: 5 }, parser)).toBeNull()
    // Line 2: string -> null
    expect(extractIdentifierAtPosition(code, { lineNumber: 2, column: 18 }, parser)).toBeNull()
    // Line 3: declaration `computeValue`
    expect(extractIdentifierAtPosition(code, { lineNumber: 3, column: 12 }, parser)).toEqual({
      name: 'computeValue',
      lineNumber: 3,
      columnStart: 9,
      columnEnd: 21,
      isDeclaration: true
    })
    // Line 6: call reference `computeValue`
    expect(extractIdentifierAtPosition(code, { lineNumber: 6, column: 14 }, parser)).toEqual({
      name: 'computeValue',
      lineNumber: 6,
      columnStart: 12,
      columnEnd: 24,
      isDeclaration: false
    })
  })

  it('extracts symbols from unified diff hunks with accurate newLineNumbers and added/modified diffChange badges', () => {
    const patch = [
      'diff --git a/src/service.ts b/src/service.ts',
      '--- a/src/service.ts',
      '+++ b/src/service.ts',
      '@@ -10,4 +10,5 @@',
      ' export function existingFn() {',
      '-  return 1',
      '+  return 2',
      ' }',
      '+export function brandNewFn() { return 3 }'
    ].join('\n')

    const parser = resolveCodeBlockParser('ts')
    const symbols = extractDiffSymbols(patch, 'M', parser)

    expect(symbols).toEqual([
      expect.objectContaining({
        name: 'existingFn',
        kind: 'function',
        lineNumber: 10,
        diffChange: 'modified'
      }),
      expect.objectContaining({
        name: 'brandNewFn',
        kind: 'function',
        lineNumber: 13,
        diffChange: 'added'
      })
    ])
  })
})
