import { cpp } from '@codemirror/lang-cpp'
import { css } from '@codemirror/lang-css'
import { go } from '@codemirror/lang-go'
import { html } from '@codemirror/lang-html'
import { java } from '@codemirror/lang-java'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { less } from '@codemirror/lang-less'
import { markdown } from '@codemirror/lang-markdown'
import { php } from '@codemirror/lang-php'
import { python } from '@codemirror/lang-python'
import { rust } from '@codemirror/lang-rust'
import { sass } from '@codemirror/lang-sass'
import { sql } from '@codemirror/lang-sql'
import { xml } from '@codemirror/lang-xml'
import { yaml } from '@codemirror/lang-yaml'
import { LanguageDescription, StreamLanguage } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { json as legacyJson } from '@codemirror/legacy-modes/mode/javascript'
import { shell } from '@codemirror/legacy-modes/mode/shell'
import type { Extension } from '@codemirror/state'
import { tags } from '@lezer/highlight'
import type { DocumentBuffer } from '@shared/documentBuffer'

export type BundledRawEditorLanguage = keyof typeof BUNDLED_LANGUAGE_FACTORIES | 'plaintext'

export type RawEditorLanguage = BundledRawEditorLanguage | (string & {})

export interface RawLanguageExtensionResolution {
  extension: Extension
  needsAsyncLoad: boolean
}

const jsoncExtension = (): Extension =>
  StreamLanguage.define({
    ...legacyJson,
    tokenTable: { property: tags.propertyName }
  })

const shellExtension = (): Extension => StreamLanguage.define(shell)

const BUNDLED_LANGUAGE_FACTORIES = {
  markdown: () => markdown({ codeLanguages: languages }),
  json: () => json(),
  jsonc: jsoncExtension,
  javascript: () => javascript(),
  jsx: () => javascript({ jsx: true }),
  typescript: () => javascript({ typescript: true }),
  tsx: () => javascript({ jsx: true, typescript: true }),
  python: () => python(),
  c: () => cpp(),
  cpp: () => cpp(),
  html: () => html(),
  css: () => css(),
  scss: () => sass(),
  sass: () => sass({ indented: true }),
  less: () => less(),
  yaml: () => yaml(),
  sql: () => sql(),
  shell: shellExtension,
  java: () => java(),
  go: () => go(),
  rust: () => rust(),
  xml: () => xml(),
  php: () => php()
} satisfies Readonly<Record<string, () => Extension>>

const BUNDLED_EXTENSION_TO_LANGUAGE: Readonly<Record<string, RawEditorLanguage>> = {
  md: 'markdown',
  markdown: 'markdown',
  json: 'json',
  jsonc: 'jsonc',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  py: 'python',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hxx: 'cpp',
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'scss',
  sass: 'sass',
  less: 'less',
  yaml: 'yaml',
  yml: 'yaml',
  sql: 'sql',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  java: 'java',
  go: 'go',
  rs: 'rust',
  xml: 'xml',
  svg: 'xml',
  php: 'php'
}

const DESCRIPTION_BY_LANGUAGE_ID = new Map<string, LanguageDescription>()
for (const desc of languages) {
  const id = desc.name.toLowerCase()
  if (!DESCRIPTION_BY_LANGUAGE_ID.has(id)) {
    DESCRIPTION_BY_LANGUAGE_ID.set(id, desc)
  }
  for (const alias of desc.alias) {
    const normalizedAlias = alias.toLowerCase()
    if (!DESCRIPTION_BY_LANGUAGE_ID.has(normalizedAlias)) {
      DESCRIPTION_BY_LANGUAGE_ID.set(normalizedAlias, desc)
    }
  }
}

const loadedExtensionCache = new Map<string, Extension>()
const pendingExtensionLoads = new Map<string, Promise<Extension>>()

function getBaseName(fileName: string): string {
  return fileName.split(/[/\\]/).pop() ?? fileName
}

function getExtension(baseName: string): string {
  const lastDot = baseName.lastIndexOf('.')
  if (lastDot <= 0 || lastDot === baseName.length - 1) {
    return ''
  }
  return baseName.slice(lastDot + 1).toLowerCase()
}

function matchExtensionlessCodeLanguage(baseName: string): string | null {
  if (!baseName || getExtension(baseName) !== '') {
    return null
  }
  const desc = LanguageDescription.matchFilename(languages, baseName)
  if (!desc) {
    return null
  }
  const name = desc.name.toLowerCase()
  return name === 'markdown' ? null : name
}

/**
 * Returns true when an extensionless filename matches a known non-Markdown language
 * in `@codemirror/language-data` (for example `Dockerfile` or `Gemfile`).
 */
export function hasKnownCodeFilename(fileName: string): boolean {
  return matchExtensionlessCodeLanguage(getBaseName(fileName)) !== null
}

/**
 * Resolves the CodeMirror language identifier for Raw mode from a document buffer's kind and name.
 */
export function resolveRawEditorLanguageId(
  doc: Pick<DocumentBuffer, 'kind' | 'name'>
): RawEditorLanguage {
  if (doc.kind === 'config') {
    return 'json'
  }

  const baseName = getBaseName(doc.name)
  const ext = getExtension(baseName)
  if (ext) {
    const bundled = BUNDLED_EXTENSION_TO_LANGUAGE[ext]
    if (bundled) {
      return bundled
    }
    const matched = LanguageDescription.matchFilename(languages, baseName)
    return matched ? matched.name.toLowerCase() : 'plaintext'
  }

  return matchExtensionlessCodeLanguage(baseName) ?? 'markdown'
}

/**
 * Synchronously resolves a bundled or already-cached CodeMirror `Extension` for the given language ID.
 */
export function resolveRawLanguageExtensionSync(
  language: RawEditorLanguage
): RawLanguageExtensionResolution {
  const normalized = language.trim().toLowerCase()
  if (!normalized || normalized === 'plaintext') {
    return { extension: [], needsAsyncLoad: false }
  }

  const bundledFactory = (
    BUNDLED_LANGUAGE_FACTORIES as Readonly<Record<string, (() => Extension) | undefined>>
  )[normalized]
  if (bundledFactory) {
    return { extension: bundledFactory(), needsAsyncLoad: false }
  }

  if (loadedExtensionCache.has(normalized)) {
    return { extension: loadedExtensionCache.get(normalized) ?? [], needsAsyncLoad: false }
  }

  if (DESCRIPTION_BY_LANGUAGE_ID.has(normalized)) {
    return { extension: [], needsAsyncLoad: true }
  }

  return { extension: [], needsAsyncLoad: false }
}

/**
 * Asynchronously loads and caches a CodeMirror `Extension` via `@codemirror/language-data`.
 */
export async function loadRawLanguageExtension(
  language: RawEditorLanguage
): Promise<Extension> {
  const normalized = language.trim().toLowerCase()
  const sync = resolveRawLanguageExtensionSync(normalized)
  if (!sync.needsAsyncLoad) {
    return sync.extension
  }

  const existing = pendingExtensionLoads.get(normalized)
  if (existing) {
    return existing
  }

  const desc = DESCRIPTION_BY_LANGUAGE_ID.get(normalized)
  if (!desc) {
    return []
  }

  const promise = desc
    .load()
    .then((support) => {
      loadedExtensionCache.set(normalized, support)
      return support
    })
    .catch(() => {
      const empty: Extension = []
      loadedExtensionCache.set(normalized, empty)
      return empty
    })
    .finally(() => {
      pendingExtensionLoads.delete(normalized)
    })

  pendingExtensionLoads.set(normalized, promise)
  return promise
}
