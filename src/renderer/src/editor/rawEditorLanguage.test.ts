import { describe, expect, it } from 'vitest'
import {
  hasKnownCodeFilename,
  loadRawLanguageExtension,
  resolveRawEditorLanguageId,
  resolveRawLanguageExtensionSync
} from './rawEditorLanguage'

describe('rawEditorLanguage', () => {
  it('resolves bundled language IDs for source code extensions, config, markdown, and plaintext', () => {
    expect(resolveRawEditorLanguageId({ kind: 'config', name: 'config.json' })).toBe('json')
    expect(resolveRawEditorLanguageId({ kind: 'workspace', name: 'package.json' })).toBe('json')
    expect(resolveRawEditorLanguageId({ kind: 'workspace', name: 'tsconfig.jsonc' })).toBe('jsonc')
    expect(resolveRawEditorLanguageId({ kind: 'workspace', name: 'README.md' })).toBe('markdown')
    expect(resolveRawEditorLanguageId({ kind: 'workspace', name: 'Guide.MARKDOWN' })).toBe('markdown')
    expect(resolveRawEditorLanguageId({ kind: 'workspace', name: 'scratch-note' })).toBe('markdown')

    expect(resolveRawEditorLanguageId({ kind: 'workspace', name: 'index.ts' })).toBe('typescript')
    expect(resolveRawEditorLanguageId({ kind: 'workspace', name: 'module.mts' })).toBe('typescript')
    expect(resolveRawEditorLanguageId({ kind: 'workspace', name: 'module.cts' })).toBe('typescript')
    expect(resolveRawEditorLanguageId({ kind: 'workspace', name: 'App.tsx' })).toBe('tsx')
    expect(resolveRawEditorLanguageId({ kind: 'workspace', name: 'main.js' })).toBe('javascript')
    expect(resolveRawEditorLanguageId({ kind: 'workspace', name: 'main.mjs' })).toBe('javascript')
    expect(resolveRawEditorLanguageId({ kind: 'workspace', name: 'main.cjs' })).toBe('javascript')
    expect(resolveRawEditorLanguageId({ kind: 'workspace', name: 'Card.jsx' })).toBe('jsx')
    expect(resolveRawEditorLanguageId({ kind: 'workspace', name: 'script.py' })).toBe('python')
    expect(resolveRawEditorLanguageId({ kind: 'workspace', name: 'main.c' })).toBe('c')
    expect(resolveRawEditorLanguageId({ kind: 'workspace', name: 'header.h' })).toBe('c')
    expect(resolveRawEditorLanguageId({ kind: 'workspace', name: 'engine.cpp' })).toBe('cpp')
    expect(resolveRawEditorLanguageId({ kind: 'workspace', name: 'engine.hpp' })).toBe('cpp')
    expect(resolveRawEditorLanguageId({ kind: 'workspace', name: 'page.html' })).toBe('html')
    expect(resolveRawEditorLanguageId({ kind: 'workspace', name: 'page.htm' })).toBe('html')
    expect(resolveRawEditorLanguageId({ kind: 'workspace', name: 'theme.css' })).toBe('css')
    expect(resolveRawEditorLanguageId({ kind: 'workspace', name: 'theme.scss' })).toBe('scss')
    expect(resolveRawEditorLanguageId({ kind: 'workspace', name: 'theme.sass' })).toBe('sass')
    expect(resolveRawEditorLanguageId({ kind: 'workspace', name: 'theme.less' })).toBe('less')
    expect(resolveRawEditorLanguageId({ kind: 'workspace', name: 'workflow.yaml' })).toBe('yaml')
    expect(resolveRawEditorLanguageId({ kind: 'workspace', name: 'workflow.yml' })).toBe('yaml')
    expect(resolveRawEditorLanguageId({ kind: 'workspace', name: 'query.sql' })).toBe('sql')
    expect(resolveRawEditorLanguageId({ kind: 'workspace', name: 'deploy.sh' })).toBe('shell')
    expect(resolveRawEditorLanguageId({ kind: 'workspace', name: 'deploy.bash' })).toBe('shell')
    expect(resolveRawEditorLanguageId({ kind: 'workspace', name: 'deploy.zsh' })).toBe('shell')
    expect(resolveRawEditorLanguageId({ kind: 'workspace', name: 'Main.java' })).toBe('java')
    expect(resolveRawEditorLanguageId({ kind: 'workspace', name: 'server.go' })).toBe('go')
    expect(resolveRawEditorLanguageId({ kind: 'workspace', name: 'lib.rs' })).toBe('rust')
    expect(resolveRawEditorLanguageId({ kind: 'workspace', name: 'pom.xml' })).toBe('xml')
    expect(resolveRawEditorLanguageId({ kind: 'workspace', name: 'icon.svg' })).toBe('xml')
    expect(resolveRawEditorLanguageId({ kind: 'workspace', name: 'index.php' })).toBe('php')

    expect(resolveRawEditorLanguageId({ kind: 'workspace', name: 'notes.txt' })).toBe('plaintext')
    expect(resolveRawEditorLanguageId({ kind: 'workspace', name: 'app.log' })).toBe('plaintext')
    expect(resolveRawEditorLanguageId({ kind: 'workspace', name: 'file.unknownext' })).toBe('plaintext')
  })

  it('recognizes known extensionless code filenames without misclassifying general notes', () => {
    expect(hasKnownCodeFilename('Dockerfile')).toBe(true)
    expect(hasKnownCodeFilename('Gemfile')).toBe(true)
    expect(hasKnownCodeFilename('scratch-note')).toBe(false)

    expect(resolveRawEditorLanguageId({ kind: 'workspace', name: 'Dockerfile' })).toBe('dockerfile')
    expect(resolveRawEditorLanguageId({ kind: 'workspace', name: 'Gemfile' })).toBe('ruby')
    expect(resolveRawEditorLanguageId({ kind: 'workspace', name: 'script.rb' })).toBe('ruby')
  })

  it('returns bundled extensions synchronously and lazy-loads + caches @codemirror/language-data languages', async () => {
    const tsSync = resolveRawLanguageExtensionSync('typescript')
    expect(tsSync.needsAsyncLoad).toBe(false)
    expect(tsSync.extension).not.toEqual([])

    const plainSync = resolveRawLanguageExtensionSync('plaintext')
    expect(plainSync.needsAsyncLoad).toBe(false)
    expect(plainSync.extension).toEqual([])

    const rubyBefore = resolveRawLanguageExtensionSync('ruby')
    expect(rubyBefore.needsAsyncLoad).toBe(true)
    expect(rubyBefore.extension).toEqual([])

    const [loaded1, loaded2] = await Promise.all([
      loadRawLanguageExtension('ruby'),
      loadRawLanguageExtension('ruby')
    ])
    expect(loaded1).toBe(loaded2)
    expect(loaded1).not.toEqual([])

    const rubyAfter = resolveRawLanguageExtensionSync('ruby')
    expect(rubyAfter.needsAsyncLoad).toBe(false)
    expect(rubyAfter.extension).toBe(loaded1)

    expect(await loadRawLanguageExtension('plaintext')).toEqual([])
    expect(await loadRawLanguageExtension('nonexistent-lang-xyz')).toEqual([])
  })
})
