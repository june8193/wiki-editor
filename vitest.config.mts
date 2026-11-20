import { resolve } from 'node:path'
import { configDefaults, defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

const RENDERER_NODE_UNIT_TESTS = [
  'src/renderer/src/utils/**/*.test.ts',
  'src/renderer/src/stores/**/*.test.ts',
  'src/renderer/src/editor/editorModes.test.ts',
  'src/renderer/src/editor/LinkAutocompleteEngine.test.ts',
  'src/renderer/src/editor/MarkdownLinkNavigation.test.ts',
  'src/renderer/src/editor/MarkdownLinkSyntax.test.ts',
  'src/renderer/src/editor/MarkdownTocEngine.test.ts',
  'src/renderer/src/editor/TableMarkdownManipulator.test.ts'
]

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(import.meta.dirname, 'src/shared'),
      '@renderer': resolve(import.meta.dirname, 'src/renderer/src')
    }
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          include: [
            'src/main/**/*.test.ts',
            'src/preload/**/*.test.ts',
            'src/shared/**/*.test.ts',
            ...RENDERER_NODE_UNIT_TESTS
          ]
        }
      },
      {
        extends: true,
        plugins: [react()],
        test: {
          name: 'renderer',
          environment: 'jsdom',
          pool: 'vmThreads',
          include: ['src/renderer/**/*.test.{ts,tsx}'],
          exclude: [...configDefaults.exclude, ...RENDERER_NODE_UNIT_TESTS],
          setupFiles: ['src/renderer/src/test/setup.ts'],
          css: {
            include: [/theme\.css/]
          }
        }
      }
    ]
  }
})
