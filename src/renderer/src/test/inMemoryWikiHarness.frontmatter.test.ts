import { describe, expect, it } from 'vitest'
import {
  DEFAULT_FRONTMATTER_SCHEMA,
  FRONTMATTER_SCHEMA_RELATIVE_PATH,
  serializeFrontmatterSchema
} from '@shared/frontmatter'
import { DEFAULT_SEARCH_MATCH_OPTIONS } from '@shared/search'
import { createMultiWindowWikiHarness } from './inMemoryWikiHarness'

describe('inMemoryWikiHarness frontmatter search & field values parity', () => {
  it('implements frontmatter.getFieldValues and workspace.search frontmatter filters, summary badges, sorting, and aux buffer priority', async () => {
    const harness = createMultiWindowWikiHarness(
      { autoSave: false },
      {
        workspaces: {
          'C:\\wiki\\docs': {
            [FRONTMATTER_SCHEMA_RELATIVE_PATH]: serializeFrontmatterSchema(DEFAULT_FRONTMATTER_SCHEMA),
            'a-low.md': '---\nstatus: todo\npriority: low\nlabels: [docs, zeta-tag]\n---\n# Low\nAlpha',
            'b-high.md': '---\nstatus: in-progress\npriority: high\nlabels: [backend]\n---\n# High\nAlpha',
            'c-stale.md': '---\nstatus: done\npriority: lowest\n---\n# Stale',
            'notes.txt': '---\nstatus: in-progress\nlabels: [txt-ignored]\n---\nAlpha',
            '.wiki-editor/secret.md': '---\nstatus: in-progress\nlabels: [internal-ignored]\n---\nAlpha'
          }
        }
      }
    )

    try {
      const mainWin = harness.createWindow({ role: 'main' })
      await mainWin.api.workspace.open('C:\\wiki\\docs')

      // Auxiliary window holds an unsaved buffer for c-stale.md
      const buf = await mainWin.api.buffer.openWorkspaceFile('C:/wiki/docs/c-stale.md', 'c-stale.md')
      await mainWin.api.buffer.syncWindowTabs([buf.key])
      const { windowId: auxId } = await mainWin.api.window!.detachTabToNewWindow({
        bufferKey: buf.key,
        mode: 'raw',
        cursor: { selectionStart: 0, selectionEnd: 0 },
        scrollTop: 0,
        splitPreviewRatio: 0.5
      })
      const auxWin = harness.getAuxiliaryWindows(mainWin.windowId).find((w) => w.windowId === auxId)!
      await auxWin.api.buffer.syncWindowTabs([buf.key])
      await auxWin.api.buffer.updateContent(
        buf.key,
        '---\nstatus: in-progress\npriority: highest\nlabels: [aux-custom, security]\n---\n# Updated Aux'
      )

      // 1. getFieldValues merges schema options + disk custom + aux unsaved custom, ignoring .txt & .wiki-editor
      const fieldValues = await mainWin.api.frontmatter!.getFieldValues!(['labels'])
      expect(fieldValues.valuesByField.labels).toEqual([
        'aux-custom',
        'backend',
        'docs',
        'frontend',
        'security',
        'zeta-tag'
      ])

      // 2. Attribute-only search with sort by priority asc (highest -> high -> low)
      const attrSearch = await mainWin.api.workspace.search!({
        query: '',
        options: DEFAULT_SEARCH_MATCH_OPTIONS,
        frontmatter: {
          conditions: [{ fieldKey: 'status', operator: 'in', values: ['in-progress'] }],
          sort: { by: 'frontmatter', fieldKey: 'priority', direction: 'asc' }
        }
      })
      expect(attrSearch.files.map((f) => f.relativePath)).toEqual(['c-stale.md', 'b-high.md'])
      expect(attrSearch.files[0].frontmatterSummary).toEqual({
        status: 'in-progress',
        priority: 'highest',
        labels: ['aux-custom', 'security']
      })

      // 3. Combined text + frontmatter search
      const combined = await mainWin.api.workspace.search!({
        query: 'Alpha',
        options: DEFAULT_SEARCH_MATCH_OPTIONS,
        frontmatter: {
          conditions: [{ fieldKey: 'labels', operator: 'any-of', values: ['zeta-tag'] }]
        }
      })
      expect(combined.files.map((f) => f.relativePath)).toEqual(['a-low.md'])
    } finally {
      harness.dispose()
    }
  })

  it('matches main-process non-file schema target error and corrupt-schema search fallback via shared hub', async () => {
    const harness = createMultiWindowWikiHarness(
      { autoSave: false },
      {
        workspaces: {
          'C:\\wiki\\bad-schema-dir': {
            [`${FRONTMATTER_SCHEMA_RELATIVE_PATH}/nested.txt`]: 'not a schema file',
            'note.md': 'Alpha body'
          },
          'C:\\wiki\\corrupt-schema': {
            [FRONTMATTER_SCHEMA_RELATIVE_PATH]: '{ broken json',
            'note.md': '---\nstatus: todo\n---\nAlpha body'
          }
        }
      }
    )

    try {
      const mainWin = harness.createWindow({ role: 'main' })
      await mainWin.api.workspace.open('C:\\wiki\\bad-schema-dir')

      const badSchema = await mainWin.api.frontmatter!.getSchema()
      expect(badSchema).toEqual({
        exists: true,
        path: `C:/wiki/bad-schema-dir/${FRONTMATTER_SCHEMA_RELATIVE_PATH}`,
        schema: null,
        error: '스키마 경로가 파일이 아닙니다.'
      })
      await expect(mainWin.api.frontmatter!.createDefaultSchema()).rejects.toThrow(/파일이 아닙니다/)

      await mainWin.api.workspace.open('C:\\wiki\\corrupt-schema')
      const plainSearch = await mainWin.api.workspace.search!({
        query: 'Alpha',
        options: DEFAULT_SEARCH_MATCH_OPTIONS
      })
      expect(plainSearch.files.map((f) => f.relativePath)).toEqual(['note.md'])
      expect(await mainWin.api.frontmatter!.getFieldValues!()).toEqual({ valuesByField: {} })
    } finally {
      harness.dispose()
    }
  })
})
