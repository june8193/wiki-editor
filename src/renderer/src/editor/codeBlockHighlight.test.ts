import { describe, expect, it } from 'vitest'
import {
  CODE_BLOCK_LANGUAGE_OPTIONS,
  filterCodeBlockLanguageOptions,
  formatCodeBlockLanguageLabel,
  getCodeBlockHighlightSpans,
  isMermaidLanguage,
  resolveCanonicalLanguageInput
} from './codeBlockHighlight'

describe('codeBlockHighlight', () => {
  it('exposes the agreed preset language options in order', () => {
    expect(CODE_BLOCK_LANGUAGE_OPTIONS.map((opt) => [opt.value, opt.label])).toEqual([
      ['', 'Plain Text'],
      ['c', 'C'],
      ['cpp', 'C++'],
      ['python', 'Python'],
      ['javascript', 'JavaScript'],
      ['typescript', 'TypeScript'],
      ['json', 'JSON'],
      ['html', 'HTML'],
      ['css', 'CSS'],
      ['yaml', 'YAML'],
      ['markdown', 'Markdown'],
      ['mermaid', 'Mermaid']
    ])
  })

  it('formats preset, alias, extra, plain text, and custom language labels consistently', () => {
    expect(formatCodeBlockLanguageLabel(undefined)).toBe('Plain Text')
    expect(formatCodeBlockLanguageLabel(null)).toBe('Plain Text')
    expect(formatCodeBlockLanguageLabel('')).toBe('Plain Text')
    expect(formatCodeBlockLanguageLabel('   ')).toBe('Plain Text')
    expect(formatCodeBlockLanguageLabel('plaintext')).toBe('Plain Text')
    expect(formatCodeBlockLanguageLabel('text')).toBe('Plain Text')

    expect(formatCodeBlockLanguageLabel('c')).toBe('C')
    expect(formatCodeBlockLanguageLabel('C')).toBe('C')
    expect(formatCodeBlockLanguageLabel('cpp')).toBe('C++')
    expect(formatCodeBlockLanguageLabel('c++')).toBe('C++')
    expect(formatCodeBlockLanguageLabel('py')).toBe('Python')
    expect(formatCodeBlockLanguageLabel('Python')).toBe('Python')
    expect(formatCodeBlockLanguageLabel('js')).toBe('JavaScript')
    expect(formatCodeBlockLanguageLabel('ts')).toBe('TypeScript')
    expect(formatCodeBlockLanguageLabel('json')).toBe('JSON')
    expect(formatCodeBlockLanguageLabel('html')).toBe('HTML')
    expect(formatCodeBlockLanguageLabel('css')).toBe('CSS')
    expect(formatCodeBlockLanguageLabel('yml')).toBe('YAML')
    expect(formatCodeBlockLanguageLabel('md')).toBe('Markdown')
    expect(formatCodeBlockLanguageLabel('mermaid')).toBe('Mermaid')

    expect(formatCodeBlockLanguageLabel('bash')).toBe('Bash')
    expect(formatCodeBlockLanguageLabel('sh')).toBe('Bash')
    expect(formatCodeBlockLanguageLabel('sql')).toBe('SQL')
    expect(formatCodeBlockLanguageLabel('java')).toBe('Java')
    expect(formatCodeBlockLanguageLabel('go')).toBe('Go')
    expect(formatCodeBlockLanguageLabel('rust')).toBe('Rust')
    expect(formatCodeBlockLanguageLabel('xml')).toBe('XML')
    expect(formatCodeBlockLanguageLabel('php')).toBe('PHP')

    expect(formatCodeBlockLanguageLabel('  kotlin  ')).toBe('kotlin')
  })

  it('resolves canonical language identifiers from combobox user input', () => {
    expect(resolveCanonicalLanguageInput('')).toBe('')
    expect(resolveCanonicalLanguageInput('   ')).toBe('')
    expect(resolveCanonicalLanguageInput('Plain Text')).toBe('')
    expect(resolveCanonicalLanguageInput('plaintext')).toBe('')
    expect(resolveCanonicalLanguageInput('text')).toBe('')

    expect(resolveCanonicalLanguageInput('C')).toBe('c')
    expect(resolveCanonicalLanguageInput('C++')).toBe('cpp')
    expect(resolveCanonicalLanguageInput('Python')).toBe('python')
    expect(resolveCanonicalLanguageInput('py')).toBe('python')
    expect(resolveCanonicalLanguageInput('JavaScript')).toBe('javascript')
    expect(resolveCanonicalLanguageInput('TypeScript')).toBe('typescript')
    expect(resolveCanonicalLanguageInput('Mermaid')).toBe('mermaid')

    expect(resolveCanonicalLanguageInput('Bash')).toBe('bash')
    expect(resolveCanonicalLanguageInput('jsx')).toBe('jsx')
    expect(resolveCanonicalLanguageInput('TSX')).toBe('tsx')
    expect(resolveCanonicalLanguageInput('scss')).toBe('scss')
    expect(resolveCanonicalLanguageInput('less')).toBe('less')
    expect(resolveCanonicalLanguageInput('jsonc')).toBe('jsonc')
    expect(resolveCanonicalLanguageInput('  Shell Script  ')).toBe('shell-script')
    expect(resolveCanonicalLanguageInput('```python```')).toBe('python')
    expect(resolveCanonicalLanguageInput('my`lang')).toBe('mylang')
    expect(resolveCanonicalLanguageInput('~~~ts~~~')).toBe('typescript')
    expect(resolveCanonicalLanguageInput('```')).toBe('')
    expect(resolveCanonicalLanguageInput('~~~')).toBe('')
  })

  it('detects mermaid language identifiers and filters preset language options cleanly', () => {
    expect(isMermaidLanguage('mermaid')).toBe(true)
    expect(isMermaidLanguage('  Mermaid  ')).toBe(true)
    expect(isMermaidLanguage('c')).toBe(false)
    expect(isMermaidLanguage('')).toBe(false)
    expect(isMermaidLanguage(null)).toBe(false)
    expect(isMermaidLanguage(undefined)).toBe(false)

    expect(filterCodeBlockLanguageOptions('')).toHaveLength(12)
    expect(filterCodeBlockLanguageOptions('py').map((o) => o.value)).toEqual(['python'])
    expect(filterCodeBlockLanguageOptions('ts').map((o) => o.value)).toEqual(['typescript'])
    expect(filterCodeBlockLanguageOptions('scss')).toEqual([])
  })

  it('produces syntax highlight spans for C, Python, TypeScript, JSON, HTML, CSS, YAML, Markdown, and Shell', () => {
    const cCode = 'int main() {\n  return 42; // answer\n}'
    const cSpans = getCodeBlockHighlightSpans(cCode, 'c')
    expect(cSpans.length).toBeGreaterThan(0)
    expect(
      cSpans.map((span) => [cCode.slice(span.from, span.to), span.className])
    ).toEqual(
      expect.arrayContaining([
        ['int', 'tok-type'],
        ['main', 'tok-function'],
        ['return', 'tok-keyword'],
        ['42', 'tok-number'],
        ['// answer', 'tok-comment']
      ])
    )

    const pyCode = 'def greet(name):\n    # hello\n    return "hi"'
    const pySpans = getCodeBlockHighlightSpans(pyCode, 'python')
    expect(
      pySpans.map((span) => [pyCode.slice(span.from, span.to), span.className])
    ).toEqual(
      expect.arrayContaining([
        ['def', 'tok-keyword'],
        ['greet', 'tok-function'],
        ['# hello', 'tok-comment'],
        ['return', 'tok-keyword'],
        ['"hi"', 'tok-string']
      ])
    )

    const tsCode = 'const count: number = 10'
    const tsSpans = getCodeBlockHighlightSpans(tsCode, 'ts')
    expect(
      tsSpans.map((span) => [tsCode.slice(span.from, span.to), span.className])
    ).toEqual(
      expect.arrayContaining([
        ['const', 'tok-keyword'],
        ['number', 'tok-type'],
        ['10', 'tok-number']
      ])
    )

    const jsonCode = '{"enabled": true}'
    const jsonSpans = getCodeBlockHighlightSpans(jsonCode, 'json')
    expect(
      jsonSpans.map((span) => [jsonCode.slice(span.from, span.to), span.className])
    ).toEqual(
      expect.arrayContaining([
        ['"enabled"', 'tok-property'],
        ['true', 'tok-number']
      ])
    )

    expect(getCodeBlockHighlightSpans('<div class="box">hi</div>', 'html').length).toBeGreaterThan(0)
    expect(getCodeBlockHighlightSpans('body { color: red; }', 'css').length).toBeGreaterThan(0)
    expect(getCodeBlockHighlightSpans('name: wiki-editor', 'yaml').length).toBeGreaterThan(0)
    expect(getCodeBlockHighlightSpans('# Heading\n\n**bold**', 'markdown').length).toBeGreaterThan(0)
    expect(getCodeBlockHighlightSpans('echo "hello"', 'bash').length).toBeGreaterThan(0)
    expect(getCodeBlockHighlightSpans('SELECT 1;', 'sql').length).toBeGreaterThan(0)
    expect(getCodeBlockHighlightSpans('const card = <Card title="hi" />', 'jsx').length).toBeGreaterThan(0)
    expect(getCodeBlockHighlightSpans('const card: JSX.Element = <Card title="hi" />', 'tsx').length).toBeGreaterThan(0)
    expect(
      getCodeBlockHighlightSpans('$bg: #fff;\n// comment\nbody { color: $bg; }', 'scss').map((span) => [
        '$bg: #fff;\n// comment\nbody { color: $bg; }'.slice(span.from, span.to),
        span.className
      ])
    ).toEqual(
      expect.arrayContaining([
        ['$bg', 'tok-variable'],
        ['// comment', 'tok-comment'],
        ['color', 'tok-property']
      ])
    )
    expect(
      getCodeBlockHighlightSpans('@bg: #fff;\n// comment\nbody { color: @bg; }', 'less').map((span) => [
        '@bg: #fff;\n// comment\nbody { color: @bg; }'.slice(span.from, span.to),
        span.className
      ])
    ).toEqual(
      expect.arrayContaining([
        ['@bg', 'tok-variable'],
        ['// comment', 'tok-comment'],
        ['color', 'tok-property']
      ])
    )
    expect(
      getCodeBlockHighlightSpans('{\n  // comment\n  "enabled": true\n}', 'jsonc').map((span) => [
        '{\n  // comment\n  "enabled": true\n}'.slice(span.from, span.to),
        span.className
      ])
    ).toEqual(
      expect.arrayContaining([
        ['// comment', 'tok-comment'],
        ['true', 'tok-number']
      ])
    )
    expect(getCodeBlockHighlightSpans('fn main() { let x = 1; }', 'rust').length).toBeGreaterThan(0)
    expect(
      getCodeBlockHighlightSpans('class Box { public: int count = 1; }; // c++', 'cpp').length
    ).toBeGreaterThan(0)
    expect(
      getCodeBlockHighlightSpans('const fn = () => "ok"', 'javascript').length
    ).toBeGreaterThan(0)
    expect(
      getCodeBlockHighlightSpans('body\n  color: #fff\n  // comment', 'sass').length
    ).toBeGreaterThan(0)
    expect(getCodeBlockHighlightSpans('export PATH="/bin"', 'zsh').length).toBeGreaterThan(0)
    expect(getCodeBlockHighlightSpans('public class App { int n = 1; }', 'java').length).toBeGreaterThan(0)
    expect(getCodeBlockHighlightSpans('func main() { return }', 'go').length).toBeGreaterThan(0)
    expect(getCodeBlockHighlightSpans('<note to="you">hi</note>', 'xml').length).toBeGreaterThan(0)
    expect(getCodeBlockHighlightSpans('<?php echo "hi"; ?>', 'php').length).toBeGreaterThan(0)

    expect(getCodeBlockHighlightSpans('plain text', '')).toEqual([])
    expect(getCodeBlockHighlightSpans('plain text', 'unknown-lang')).toEqual([])
  })

  it('produces non-overlapping, in-bounds highlight spans preserving source indices across newlines', () => {
    const code = 'def add(a, b):\n    # sum\n    return a + b < 10'
    const spans = getCodeBlockHighlightSpans(code, 'python')
    expect(spans.length).toBeGreaterThan(0)

    let prevEnd = 0
    for (const span of spans) {
      expect(span.from).toBeGreaterThanOrEqual(prevEnd)
      expect(span.to).toBeGreaterThan(span.from)
      expect(span.to).toBeLessThanOrEqual(code.length)
      prevEnd = span.to
    }
    expect(spans.map((span) => [code.slice(span.from, span.to), span.className])).toEqual(
      expect.arrayContaining([
        ['def', 'tok-keyword'],
        ['# sum', 'tok-comment'],
        ['return', 'tok-keyword']
      ])
    )
  })
})
