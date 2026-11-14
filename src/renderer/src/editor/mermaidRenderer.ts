import type { ThemeMode } from '@shared/config'
import DOMPurify from 'dompurify'
import type { MermaidConfig } from 'mermaid'
import { toErrorMessage } from '../utils/toErrorMessage'

export type MermaidTheme = 'default' | 'dark'

export interface MermaidDriver {
  initialize: (config: MermaidConfig) => void | Promise<void>
  render: (id: string, text: string) => Promise<{ svg: string }>
}

export type MermaidRenderResult =
  | { ok: true; svg: string; fromCache: boolean }
  | { ok: false; errorMessage: string }

export interface MermaidRenderer {
  getCachedSvg: (code: string, theme: ThemeMode) => string | null
  render: (code: string, theme: ThemeMode) => Promise<MermaidRenderResult>
  clearCache: () => void
}

const DEFAULT_MAX_CACHE_ENTRIES = 200

const MERMAID_SVG_SANITIZE_CONFIG = {
  ADD_TAGS: ['foreignobject', 'style'],
  ADD_ATTR: ['dominant-baseline'],
  HTML_INTEGRATION_POINTS: { foreignobject: true },
  FORBID_TAGS: [
    'script',
    'iframe',
    'object',
    'embed',
    'applet',
    'form',
    'meta',
    'link',
    'base'
  ],
  ALLOW_ARIA_ATTR: true
}

function normalizeMermaidSource(code: string): string {
  return code.replace(/\r\n?/g, '\n').trim()
}

export function mapThemeToMermaidTheme(theme: ThemeMode): MermaidTheme {
  return theme === 'dark' ? 'dark' : 'default'
}

/**
 * Computes a deterministic 64-bit FNV-1a hex digest over normalized Mermaid source.
 */
export function hashMermaidSource(code: string): string {
  const normalized = normalizeMermaidSource(code)
  let h1 = 0x811c9dc5
  let h2 = 0x050c5d1f

  for (let i = 0; i < normalized.length; i += 1) {
    const ch = normalized.charCodeAt(i)
    h1 ^= ch
    h1 = Math.imul(h1, 0x01000193)
    h2 ^= ch + (i & 0xff)
    h2 = Math.imul(h2, 0x01000193)
  }

  return `${(h1 >>> 0).toString(16).padStart(8, '0')}${(h2 >>> 0).toString(16).padStart(8, '0')}`
}

/**
 * Sanitizes Mermaid-generated SVG markup against XSS vectors (`<script>`, `on*` handlers,
 * dangerous tags, and unsafe URI schemes) while preserving SVG and foreignObject diagram nodes.
 */
export function sanitizeMermaidSvg(svg: string): string {
  if (!svg) return ''
  return DOMPurify.sanitize(svg, MERMAID_SVG_SANITIZE_CONFIG)
}

async function loadMermaidModule() {
  const mod = await import('mermaid')
  return mod.default
}

const defaultMermaidDriver: MermaidDriver = {
  initialize: async (config) => {
    const mermaid = await loadMermaidModule()
    mermaid.initialize(config)
  },
  render: async (id, text) => {
    const mermaid = await loadMermaidModule()
    try {
      const result = await mermaid.render(id, text)
      return { svg: result.svg }
    } finally {
      if (typeof document !== 'undefined') {
        document.getElementById(`d${id}`)?.remove()
      }
    }
  }
}

function buildCacheKey(normalizedCode: string, theme: ThemeMode): string {
  const mermaidTheme = mapThemeToMermaidTheme(theme)
  const hash = hashMermaidSource(normalizedCode)
  return `${mermaidTheme}\0${hash}\0${normalizedCode}`
}

/**
 * Creates a Mermaid SVG renderer with theme-synchronized initialization,
 * LRU hash+source caching, concurrent in-flight deduplication, and error isolation.
 */
export function createMermaidRenderer(
  driver: MermaidDriver = defaultMermaidDriver,
  options: { maxCacheEntries?: number } = {}
): MermaidRenderer {
  const maxCacheEntries = Math.max(1, options.maxCacheEntries ?? DEFAULT_MAX_CACHE_ENTRIES)
  const svgCache = new Map<string, string>()
  const inFlight = new Map<string, Promise<MermaidRenderResult>>()

  let renderSeq = 0
  let activeMermaidTheme: MermaidTheme | null = null
  let serialQueue: Promise<void> | null = null

  const readCache = (key: string): string | null => {
    const cached = svgCache.get(key)
    if (cached === undefined) return null
    svgCache.delete(key)
    svgCache.set(key, cached)
    return cached
  }

  const writeCache = (key: string, svg: string): void => {
    if (svgCache.has(key)) {
      svgCache.delete(key)
    } else if (svgCache.size >= maxCacheEntries) {
      const oldestKey = svgCache.keys().next().value
      if (oldestKey !== undefined) {
        svgCache.delete(oldestKey)
      }
    }
    svgCache.set(key, svg)
  }

  const enqueueRender = <T>(task: () => Promise<T>): Promise<T> => {
    const previous = serialQueue
    const run = previous ? previous.then(task, task) : task()
    const tail = run.then(
      () => undefined,
      () => undefined
    )
    serialQueue = tail.finally(() => {
      if (serialQueue === tail) {
        serialQueue = null
      }
    })
    return run
  }

  return {
    getCachedSvg(code, theme) {
      const normalized = normalizeMermaidSource(code)
      if (!normalized) return null
      return readCache(buildCacheKey(normalized, theme))
    },

    render(code, theme) {
      const normalized = normalizeMermaidSource(code)
      if (!normalized) {
        return Promise.resolve({
          ok: false,
          errorMessage: 'Mermaid 다이어그램 코드가 비어 있습니다.'
        })
      }

      const key = buildCacheKey(normalized, theme)
      const cached = readCache(key)
      if (cached !== null) {
        return Promise.resolve({ ok: true, svg: cached, fromCache: true })
      }

      const existing = inFlight.get(key)
      if (existing) {
        return existing
      }

      const mermaidTheme = mapThemeToMermaidTheme(theme)
      const promise = enqueueRender<MermaidRenderResult>(async () => {
        const latestCached = readCache(key)
        if (latestCached !== null) {
          return { ok: true, svg: latestCached, fromCache: true }
        }

        try {
          if (activeMermaidTheme !== mermaidTheme) {
            const initResult = driver.initialize({
              startOnLoad: false,
              theme: mermaidTheme,
              securityLevel: 'strict'
            })
            if (initResult && typeof (initResult as PromiseLike<void>).then === 'function') {
              await initResult
            }
            activeMermaidTheme = mermaidTheme
          }

          renderSeq += 1
          const renderId = `wiki-mermaid-${renderSeq}`
          const rendered = await driver.render(renderId, normalized)
          const safeSvg = sanitizeMermaidSvg(rendered.svg)
          if (!safeSvg.includes('<svg')) {
            return {
              ok: false,
              errorMessage: '렌더링된 Mermaid SVG 출력이 비어 있거나 올바르지 않습니다.'
            }
          }
          writeCache(key, safeSvg)
          return { ok: true, svg: safeSvg, fromCache: false }
        } catch (error: unknown) {
          return {
            ok: false,
            errorMessage: toErrorMessage(error, 'Mermaid 다이어그램 문법을 렌더링할 수 없습니다.')
          }
        }
      }).finally(() => {
        inFlight.delete(key)
      })

      inFlight.set(key, promise)
      return promise
    },

    clearCache() {
      svgCache.clear()
      activeMermaidTheme = null
    }
  }
}

export const defaultMermaidRenderer = createMermaidRenderer()
