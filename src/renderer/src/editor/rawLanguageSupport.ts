import { LanguageDescription, type LanguageSupport } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import type { Extension } from '@codemirror/state'

const loadedLanguageSupportCache = new Map<string, LanguageSupport | null>()
const pendingLanguageSupportLoads = new Map<string, Promise<LanguageSupport | null>>()

export interface RawCodeLanguageResolution {
  extension: Extension | null
  needsAsyncLoad: boolean
}

/**
 * Synchronously resolves a cached CodeMirror LanguageSupport extension for a non-markdown file path.
 */
export function resolveRawCodeLanguageSync(
  filePath: string | null | undefined
): RawCodeLanguageResolution {
  if (!filePath) {
    return { extension: null, needsAsyncLoad: false }
  }
  const desc = LanguageDescription.matchFilename(languages, filePath)
  if (!desc) {
    return { extension: null, needsAsyncLoad: false }
  }
  if (loadedLanguageSupportCache.has(desc.name)) {
    return {
      extension: loadedLanguageSupportCache.get(desc.name) ?? null,
      needsAsyncLoad: false
    }
  }
  return { extension: null, needsAsyncLoad: true }
}

/**
 * Lazily loads and caches a CodeMirror LanguageSupport extension via `@codemirror/language-data`.
 */
export async function loadRawCodeLanguage(filePath: string): Promise<Extension | null> {
  const desc = LanguageDescription.matchFilename(languages, filePath)
  if (!desc) {
    return null
  }
  if (loadedLanguageSupportCache.has(desc.name)) {
    return loadedLanguageSupportCache.get(desc.name) ?? null
  }
  const existing = pendingLanguageSupportLoads.get(desc.name)
  if (existing) {
    return existing
  }

  const promise = desc
    .load()
    .then((support) => {
      loadedLanguageSupportCache.set(desc.name, support)
      return support
    })
    .catch(() => {
      loadedLanguageSupportCache.set(desc.name, null)
      return null
    })
    .finally(() => {
      pendingLanguageSupportLoads.delete(desc.name)
    })

  pendingLanguageSupportLoads.set(desc.name, promise)
  return promise
}
