import { describe, expect, it } from 'vitest'
import {
  applyFrontmatterValues,
  createDefaultFrontmatterSchema,
  extractFrontmatterBody,
  FRONTMATTER_SCHEMA_RELATIVE_PATH,
  parseFrontmatterDocument,
  parseFrontmatterSchema,
  parseFrontmatterSchemaJson,
  removeFrontmatterBlock,
  replaceFrontmatterBody,
  serializeFrontmatterSchema,
  type WorkspaceFrontmatterSchema
} from './frontmatter'

const SAMPLE_SCHEMA: WorkspaceFrontmatterSchema = {
  version: 1,
  fields: [
    { key: 'title', label: '제목', type: 'text', required: true },
    { key: 'estimate', label: '예상 공수', type: 'number', required: true },
    { key: 'archived', label: '보관', type: 'boolean', required: true },
    { key: 'dueDate', label: '마감일', type: 'date' },
    {
      key: 'status',
      label: '상태',
      type: 'select',
      required: true,
      options: [{ value: 'todo' }, { value: 'in-progress' }, { value: 'done' }]
    },
    {
      key: 'labels',
      label: '라벨',
      type: 'multi-select',
      allowCustom: true,
      options: [{ value: 'backend' }, { value: 'security' }]
    },
    {
      key: 'reviewers',
      label: '리뷰어',
      type: 'multi-select',
      allowCustom: false,
      options: [{ value: 'alice' }, { value: 'bob' }]
    }
  ]
}

describe('frontmatter document parsing and boundary detection', () => {
  it('recognizes top-of-document YAML frontmatter closed by --- or ... with BOM and CRLF/LF support', () => {
    const lfDoc = '---\ntitle: Hello\nstatus: todo\n---\n# Heading\nBody line'
    const parsedLf = parseFrontmatterDocument(lfDoc)
    expect(parsedLf.hasFrontmatter).toBe(true)
    expect(parsedLf.rawBlock).toBe('---\ntitle: Hello\nstatus: todo\n---')
    expect(parsedLf.body).toBe('# Heading\nBody line')
    expect(parsedLf.bodyStartLine).toBe(5)
    expect(parsedLf.issues).toEqual([])

    const bomCrlfDotsDoc = '\uFEFF---\r\ntitle: Bom\r\n...\r\n\r\n# Body'
    const parsedCrlf = parseFrontmatterDocument(bomCrlfDotsDoc)
    expect(parsedCrlf.hasFrontmatter).toBe(true)
    expect(parsedCrlf.rawBlock).toBe('---\r\ntitle: Bom\r\n...')
    expect(parsedCrlf.body).toBe('\r\n# Body')
    expect(parsedCrlf.bodyStartLine).toBe(4)
    expect(parsedCrlf.issues).toEqual([])

    const emptyBlock = '---\n---\nAfter empty'
    const parsedEmpty = parseFrontmatterDocument(emptyBlock)
    expect(parsedEmpty.hasFrontmatter).toBe(true)
    expect(parsedEmpty.rawBlock).toBe('---\n---')
    expect(parsedEmpty.body).toBe('After empty')
    expect(parsedEmpty.bodyStartLine).toBe(3)
    expect(parsedEmpty.issues).toEqual([])

    const noTrailingNewline = '---\ntitle: Only\n---'
    const parsedNoTrailing = parseFrontmatterDocument(noTrailingNewline)
    expect(parsedNoTrailing.hasFrontmatter).toBe(true)
    expect(parsedNoTrailing.rawBlock).toBe('---\ntitle: Only\n---')
    expect(parsedNoTrailing.body).toBe('')
    expect(parsedNoTrailing.bodyStartLine).toBe(4)
    expect(parsedNoTrailing.issues).toEqual([])
  })

  it('does not misidentify mid-document thematic breaks or non-top --- lines as frontmatter', () => {
    const midDocRule = '# Heading\n\n---\n\nParagraph\n\n---\n'
    const parsedMid = parseFrontmatterDocument(midDocRule)
    expect(parsedMid.hasFrontmatter).toBe(false)
    expect(parsedMid.rawBlock).toBe('')
    expect(parsedMid.body).toBe(midDocRule)
    expect(parsedMid.bodyStartLine).toBe(1)
    expect(parsedMid.issues).toEqual([])

    const leadingBlankLine = '\n---\ntitle: Not frontmatter\n---\n'
    const parsedLeadingBlank = parseFrontmatterDocument(leadingBlankLine)
    expect(parsedLeadingBlank.hasFrontmatter).toBe(false)
    expect(parsedLeadingBlank.body).toBe(leadingBlankLine)
    expect(parsedLeadingBlank.bodyStartLine).toBe(1)
    expect(parsedLeadingBlank.issues).toEqual([])

    const fourDashes = '----\ntitle: Not frontmatter\n----\n'
    const parsedFour = parseFrontmatterDocument(fourDashes)
    expect(parsedFour.hasFrontmatter).toBe(false)
    expect(parsedFour.body).toBe(fourDashes)
    expect(parsedFour.bodyStartLine).toBe(1)
    expect(parsedFour.issues).toEqual([])
  })

  it('ignores indented --- inside YAML block scalars and stops at the first column-0 closing delimiter', () => {
    const doc = [
      '---',
      'notes: |',
      '  line 1',
      '  ---',
      '  line 2',
      '---',
      '# Heading',
      '---',
      'Footer'
    ].join('\n')

    const parsed = parseFrontmatterDocument(doc)
    expect(parsed.hasFrontmatter).toBe(true)
    expect(parsed.rawBlock).toBe(
      ['---', 'notes: |', '  line 1', '  ---', '  line 2', '---'].join('\n')
    )
    expect(parsed.body).toBe(['# Heading', '---', 'Footer'].join('\n'))
    expect(parsed.bodyStartLine).toBe(7)
    expect(parsed.issues).toEqual([])
  })

  it('parses all 6 schema field types, allows zero/false/leap-day values, and preserves unknownEntries', () => {
    const doc = [
      '---',
      '# header comment',
      'title: "API: Migration" # inline comment',
      'estimate: 0',
      'archived: false',
      'dueDate: 2024-02-29',
      'status: in-progress',
      'labels: [backend, custom-tag]',
      'reviewers:',
      '  - alice',
      'extraText: keep me # trailing',
      'extraNested:',
      '  owner: core',
      '  items: [1, 2]',
      '---',
      '# Body'
    ].join('\n')

    const parsed = parseFrontmatterDocument(doc, SAMPLE_SCHEMA)
    expect(parsed.hasFrontmatter).toBe(true)
    expect(parsed.values).toEqual({
      title: 'API: Migration',
      estimate: 0,
      archived: false,
      dueDate: '2024-02-29',
      status: 'in-progress',
      labels: ['backend', 'custom-tag'],
      reviewers: ['alice']
    })
    expect(parsed.unknownEntries).toEqual([
      { key: 'extraText', rawValue: 'keep me' },
      { key: 'extraNested', rawValue: 'owner: core\n  items: [1, 2]' }
    ])
    expect(parsed.issues).toEqual([])
  })

  it('reports non-blocking validation issues for required-missing, disallowed-option, type-mismatch, and invalid-date-format', () => {
    const doc = [
      '---',
      'title: ""',
      'estimate: "3"',
      'archived: "yes"',
      'dueDate: 2026-02-29',
      'status: unknown-status',
      'labels: [custom-ok]',
      'reviewers: [alice, charlie]',
      '---',
      '# Body'
    ].join('\n')

    const parsed = parseFrontmatterDocument(doc, SAMPLE_SCHEMA)
    expect(parsed.issues.map((issue) => ({ key: issue.key, code: issue.code }))).toEqual([
      { key: 'title', code: 'required-missing' },
      { key: 'estimate', code: 'type-mismatch' },
      { key: 'archived', code: 'type-mismatch' },
      { key: 'dueDate', code: 'invalid-date-format' },
      { key: 'status', code: 'disallowed-option' },
      { key: 'reviewers', code: 'disallowed-option' }
    ])

    // Multi-select with non-array or mixed elements -> type-mismatch; date format edge cases
    const badTypesDoc = [
      '---',
      'title: Valid',
      'estimate: .nan',
      'archived: 1',
      'dueDate: 2026/11/20',
      'status: done',
      'labels: single-string',
      'reviewers: [alice, 123]',
      '---'
    ].join('\n')

    const parsedBadTypes = parseFrontmatterDocument(badTypesDoc, SAMPLE_SCHEMA)
    expect(parsedBadTypes.issues.map((issue) => ({ key: issue.key, code: issue.code }))).toEqual([
      { key: 'estimate', code: 'type-mismatch' },
      { key: 'archived', code: 'type-mismatch' },
      { key: 'dueDate', code: 'invalid-date-format' },
      { key: 'labels', code: 'type-mismatch' },
      { key: 'reviewers', code: 'type-mismatch' }
    ])

    // Comment-only valid empty frontmatter triggers required-missing without syntax error
    const commentOnly = parseFrontmatterDocument('---\n# comment only\n---\n# Body', SAMPLE_SCHEMA)
    expect(commentOnly.hasFrontmatter).toBe(true)
    expect(commentOnly.issues.map((i) => ({ key: i.key, code: i.code }))).toEqual([
      { key: 'title', code: 'required-missing' },
      { key: 'estimate', code: 'required-missing' },
      { key: 'archived', code: 'required-missing' },
      { key: 'status', code: 'required-missing' }
    ])
  })

  it('reports yaml-syntax-error for unclosed frontmatter, invalid YAML syntax, duplicate keys, and non-mapping roots', () => {
    const unclosed = '---\ntitle: Broken\n# Body without closing delimiter'
    const parsedUnclosed = parseFrontmatterDocument(unclosed, SAMPLE_SCHEMA)
    expect(parsedUnclosed.hasFrontmatter).toBe(false)
    expect(parsedUnclosed.body).toBe(unclosed)
    expect(parsedUnclosed.bodyStartLine).toBe(1)
    expect(parsedUnclosed.issues).toEqual([
      expect.objectContaining({ code: 'yaml-syntax-error' })
    ])

    const invalidSyntax = '---\ntitle: [unclosed\n---\n# Body'
    const parsedInvalid = parseFrontmatterDocument(invalidSyntax, SAMPLE_SCHEMA)
    expect(parsedInvalid.hasFrontmatter).toBe(true)
    expect(parsedInvalid.rawBlock).toBe('---\ntitle: [unclosed\n---')
    expect(parsedInvalid.body).toBe('# Body')
    expect(parsedInvalid.bodyStartLine).toBe(4)
    expect(parsedInvalid.issues).toEqual([
      expect.objectContaining({ code: 'yaml-syntax-error' })
    ])

    const duplicateKeys = '---\nstatus: todo\nstatus: done\n---\n# Body'
    const parsedDup = parseFrontmatterDocument(duplicateKeys, SAMPLE_SCHEMA)
    expect(parsedDup.hasFrontmatter).toBe(true)
    expect(parsedDup.issues).toEqual([
      expect.objectContaining({ code: 'yaml-syntax-error' })
    ])

    const nonMappingRoot = '---\n- list item\n---\n# Body'
    const parsedListRoot = parseFrontmatterDocument(nonMappingRoot, SAMPLE_SCHEMA)
    expect(parsedListRoot.hasFrontmatter).toBe(true)
    expect(parsedListRoot.issues).toEqual([
      expect.objectContaining({ code: 'yaml-syntax-error' })
    ])
  })
})

describe('frontmatter non-destructive serialization and safety guards', () => {
  it('updates, adds, and deletes fields without losing comments, unknown keys, nested YAML, quotes, or CRLF/LF and BOM', () => {
    const originalCrlf = [
      '\uFEFF---',
      '# top comment',
      "title: 'Original: Title' # keep inline comment",
      'status: todo',
      'estimate: 3',
      'archived: false',
      '# nested custom metadata',
      'customMeta:',
      '  owner: platform',
      '  flags: [alpha, beta]',
      '  note: |',
      '    keep indentation',
      '    and line 2',
      'labels:',
      '  - backend',
      '  - security',
      '---',
      '# Heading',
      'Body text\r\nMore body'
    ].join('\r\n')

    const res = applyFrontmatterValues(originalCrlf, {
      status: 'in-progress',
      estimate: null,
      archived: true,
      dueDate: '2026-11-30',
      labels: ['backend', '42', 'ui:polish']
    })

    expect(res.applied).toBe(true)
    expect(res.content.startsWith('\uFEFF---\r\n')).toBe(true)
    expect(res.content.includes('\r\n')).toBe(true)
    // Untouched title + inline comment + nested customMeta must stay byte-for-byte identical
    expect(res.content).toContain("# top comment\r\ntitle: 'Original: Title' # keep inline comment\r\n")
    expect(res.content).toContain(
      [
        '# nested custom metadata',
        'customMeta:',
        '  owner: platform',
        '  flags: [alpha, beta]',
        '  note: |',
        '    keep indentation',
        '    and line 2'
      ].join('\r\n')
    )
    expect(res.content).not.toContain('estimate:')
    expect(res.content).toContain('status: in-progress\r\n')
    expect(res.content).toContain('archived: true\r\n')
    expect(res.content).toContain('dueDate: 2026-11-30\r\n')
    expect(res.content).toContain('# Heading\r\nBody text\r\nMore body')

    // Re-parse verifies lossless round-trip of all 6 types including string "42" inside multi-select
    const reparsed = parseFrontmatterDocument(res.content, SAMPLE_SCHEMA)
    expect(reparsed.issues.map((i) => ({ key: i.key, code: i.code }))).toEqual([
      { key: 'estimate', code: 'required-missing' }
    ])
    expect(reparsed.values).toEqual({
      title: 'Original: Title',
      archived: true,
      dueDate: '2026-11-30',
      status: 'in-progress',
      labels: ['backend', '42', 'ui:polish']
    })

    // Re-adding estimate resolves required-missing and deleting optional dueDate leaves zero issues
    const restored = applyFrontmatterValues(res.content, { estimate: 8, dueDate: null })
    expect(restored.applied).toBe(true)
    const reparsedRestored = parseFrontmatterDocument(restored.content, SAMPLE_SCHEMA)
    expect(reparsedRestored.issues).toEqual([])
    expect(reparsedRestored.values.estimate).toBe(8)
    expect(reparsedRestored.values.dueDate).toBeUndefined()
    expect(reparsed.unknownEntries).toEqual([
      {
        key: 'customMeta',
        rawValue: 'owner: platform\n  flags: [alpha, beta]\n  note: |\n    keep indentation\n    and line 2'
      }
    ])
  })

  it('preserves following comments when deleting or multiline-updating an empty YAML mapping value', () => {
    const emptyWithNextLineComment = [
      '---',
      'labels:',
      '# keep comment',
      'status: todo',
      '---',
      '# Body'
    ].join('\n')

    const deleted = applyFrontmatterValues(emptyWithNextLineComment, { labels: null })
    expect(deleted.applied).toBe(true)
    expect(deleted.content).toBe(['---', '# keep comment', 'status: todo', '---', '# Body'].join('\n'))

    const updatedMultiline = applyFrontmatterValues(emptyWithNextLineComment, {
      labels: ['alpha', 'beta']
    })
    expect(updatedMultiline.applied).toBe(true)
    expect(updatedMultiline.content).toBe(
      ['---', 'labels:', '  - alpha', '  - beta', '# keep comment', 'status: todo', '---', '# Body'].join(
        '\n'
      )
    )

    const emptyWithInlineAndNextComment = [
      '---',
      'status: # status inline',
      '# next line comment',
      'labels: # labels inline',
      '# keep after labels',
      '---',
      '# Body'
    ].join('\n')

    const updatedInlineSingle = applyFrontmatterValues(emptyWithInlineAndNextComment, {
      status: 'done',
      labels: ['alpha', 'beta']
    })
    expect(updatedInlineSingle.applied).toBe(true)
    expect(updatedInlineSingle.content).toBe(
      [
        '---',
        'status: done # status inline',
        '# next line comment',
        'labels: # labels inline',
        '  - alpha',
        '  - beta',
        '# keep after labels',
        '---',
        '# Body'
      ].join('\n')
    )
  })

  it('preserves YAML block scalar indicators (|-) and comments when writing multiline text over multiline or inline-commented values', () => {
    const doc = [
      '---',
      'notes:',
      '  - old',
      'summary: # header comment',
      '  - old summary',
      'detail: old inline # keep inline',
      '---',
      '# Body'
    ].join('\n')

    const updated = applyFrontmatterValues(doc, {
      notes: 'line1\nline2',
      summary: 'sum1\nsum2',
      detail: 'd1\nd2'
    })
    expect(updated.applied).toBe(true)
    expect(updated.content).toBe(
      [
        '---',
        'notes: |-',
        '  line1',
        '  line2',
        'summary: |- # header comment',
        '  sum1',
        '  sum2',
        'detail: |- # keep inline',
        '  d1',
        '  d2',
        '---',
        '# Body'
      ].join('\n')
    )

    const schema: WorkspaceFrontmatterSchema = {
      version: 1,
      fields: [
        { key: 'notes', label: 'Notes', type: 'text' },
        { key: 'summary', label: 'Summary', type: 'text' },
        { key: 'detail', label: 'Detail', type: 'text' }
      ]
    }
    const reparsed = parseFrontmatterDocument(updated.content, schema)
    expect(reparsed.values).toEqual({
      notes: 'line1\nline2',
      summary: 'sum1\nsum2',
      detail: 'd1\nd2'
    })
  })

  it('preserves line-1 header comments on multiline values across updates and handles colons inside YAML keys', () => {
    const doc = [
      '---',
      'notes: | # keep block comment',
      '  line 1',
      '  line 2',
      'labels: # keep list comment',
      '  - old',
      '"my:key": old # keep colon key comment',
      '---',
      '# Body'
    ].join('\n')

    const toMultiline = applyFrontmatterValues(doc, {
      notes: 'a\nb',
      labels: [],
      'my:key': 'new'
    })
    expect(toMultiline.applied).toBe(true)
    expect(toMultiline.content).toBe(
      [
        '---',
        'notes: |- # keep block comment',
        '  a',
        '  b',
        'labels: [] # keep list comment',
        '"my:key": new # keep colon key comment',
        '---',
        '# Body'
      ].join('\n')
    )

    const blockToSingle = applyFrontmatterValues(doc, {
      notes: 'single'
    })
    expect(blockToSingle.applied).toBe(true)
    expect(blockToSingle.content).toContain('notes: single # keep block comment\n')
  })

  it('preserves ... closing delimiter, flow root maps, and adds frontmatter to body-only documents', () => {
    const dotsDoc = '---\n# keep\nstatus: todo\n...\nBody'
    const updatedDots = applyFrontmatterValues(dotsDoc, { status: 'done' })
    expect(updatedDots.applied).toBe(true)
    expect(updatedDots.content).toBe('---\n# keep\nstatus: done\n...\nBody')

    const flowDoc = '---\n{ status: todo, extra: 1 }\n---\nBody'
    const updatedFlow = applyFrontmatterValues(flowDoc, { status: 'done' })
    expect(updatedFlow.applied).toBe(true)
    const parsedFlow = parseFrontmatterDocument(updatedFlow.content, {
      version: 1,
      fields: [{ key: 'status', label: '상태', type: 'select', options: [{ value: 'todo' }, { value: 'done' }] }]
    })
    expect(parsedFlow.values.status).toBe('done')
    expect(parsedFlow.unknownEntries).toEqual([{ key: 'extra', rawValue: '1' }])

    const plainDoc = '# Just markdown\r\n\r\nHello'
    const withNewFm = applyFrontmatterValues(plainDoc, {
      title: 'New Doc',
      estimate: 5,
      archived: false
    })
    expect(withNewFm.applied).toBe(true)
    expect(withNewFm.content).toBe(
      ['---', 'title: New Doc', 'estimate: 5', 'archived: false', '---', '# Just markdown', '', 'Hello'].join('\r\n')
    )

    const emptyCreate = applyFrontmatterValues('# Only body', {}, { createIfMissing: true })
    expect(emptyCreate.applied).toBe(true)
    expect(emptyCreate.content).toBe('---\n---\n# Only body')
  })

  it('removes frontmatter cleanly while preserving BOM and body', () => {
    const doc = '\uFEFF---\r\n# keep\r\nstatus: todo\r\n---\r\n# Heading\r\nText'
    const removed = removeFrontmatterBlock(doc)
    expect(removed.applied).toBe(true)
    expect(removed.content).toBe('\uFEFF# Heading\r\nText')
  })

  it('guards syntax-error frontmatter against overwriting in both applyFrontmatterValues and removeFrontmatterBlock', () => {
    const brokenYaml = '---\ntitle: [unclosed\n---\n# Body'
    const appliedBroken = applyFrontmatterValues(brokenYaml, { status: 'done' })
    expect(appliedBroken.applied).toBe(false)
    expect(appliedBroken.content).toBe(brokenYaml)
    expect(appliedBroken.error).toBeTruthy()

    const removedBroken = removeFrontmatterBlock(brokenYaml)
    expect(removedBroken.applied).toBe(false)
    expect(removedBroken.content).toBe(brokenYaml)
    expect(removedBroken.error).toBeTruthy()

    const unclosedYaml = '---\ntitle: Missing close\n# Body'
    const appliedUnclosed = applyFrontmatterValues(unclosedYaml, { status: 'done' })
    expect(appliedUnclosed.applied).toBe(false)
    expect(appliedUnclosed.content).toBe(unclosedYaml)
    expect(appliedUnclosed.error).toBeTruthy()
  })
})

describe('workspace frontmatter schema validation and starter template', () => {
  it('creates a valid Jira-style starter template with expected fields and round-trips through JSON', () => {
    expect(FRONTMATTER_SCHEMA_RELATIVE_PATH).toBe('.wiki-editor/frontmatter.json')
    const starter = createDefaultFrontmatterSchema()
    expect(starter.version).toBe(1)
    expect(starter.fields.map((f) => f.key)).toEqual([
      'status',
      'priority',
      'labels',
      'assignee',
      'dueDate'
    ])
    const labelsField = starter.fields.find((f) => f.key === 'labels')
    expect(labelsField?.type).toBe('multi-select')
    expect(labelsField?.allowCustom).toBe(true)

    const json = serializeFrontmatterSchema(starter)
    const reparsed = parseFrontmatterSchemaJson(json)
    expect(reparsed.ok).toBe(true)
    if (reparsed.ok) {
      expect(reparsed.schema).toEqual(starter)
      expect(serializeFrontmatterSchema(reparsed.schema)).toBe(json)
    }
  })

  it('strictly validates version, field types, duplicate keys, invalid keys, labels, and options rules', () => {
    expect(parseFrontmatterSchemaJson('{ invalid json').ok).toBe(false)
    expect(parseFrontmatterSchema(null).ok).toBe(false)
    expect(parseFrontmatterSchema({ version: 2, fields: [] }).ok).toBe(false)
    expect(parseFrontmatterSchema({ version: 1, fields: 'not-array' }).ok).toBe(false)

    // Invalid field type
    expect(
      parseFrontmatterSchema({
        version: 1,
        fields: [{ key: 'k', label: 'L', type: 'url' }]
      }).ok
    ).toBe(false)

    // Duplicate keys
    expect(
      parseFrontmatterSchema({
        version: 1,
        fields: [
          { key: 'status', label: 'A', type: 'text' },
          { key: 'status', label: 'B', type: 'text' }
        ]
      }).ok
    ).toBe(false)

    // Empty / invalid keys and empty labels
    for (const badKey of ['', '   ', 'has space', 'bad:key', '-dash', '---']) {
      expect(
        parseFrontmatterSchema({
          version: 1,
          fields: [{ key: badKey, label: 'Label', type: 'text' }]
        }).ok
      ).toBe(false)
    }
    expect(
      parseFrontmatterSchema({
        version: 1,
        fields: [{ key: 'okKey', label: '   ', type: 'text' }]
      }).ok
    ).toBe(false)

    // Select & strict multi-select require non-empty unique options; allowCustom multi-select allows empty options
    expect(
      parseFrontmatterSchema({
        version: 1,
        fields: [{ key: 'status', label: '상태', type: 'select', options: [] }]
      }).ok
    ).toBe(false)
    expect(
      parseFrontmatterSchema({
        version: 1,
        fields: [{ key: 'tags', label: '태그', type: 'multi-select', allowCustom: false, options: [] }]
      }).ok
    ).toBe(false)
    expect(
      parseFrontmatterSchema({
        version: 1,
        fields: [
          {
            key: 'status',
            label: '상태',
            type: 'select',
            options: [{ value: 'todo' }, { value: 'todo' }]
          }
        ]
      }).ok
    ).toBe(false)
    expect(
      parseFrontmatterSchema({
        version: 1,
        fields: [
          {
            key: 'status',
            label: '상태',
            type: 'select',
            options: [{ value: '   ' }]
          }
        ]
      }).ok
    ).toBe(false)

    const customMultiSelectOnly = parseFrontmatterSchema({
      version: 1,
      fields: [{ key: 'tags', label: '태그', type: 'multi-select', allowCustom: true }]
    })
    expect(customMultiSelectOnly.ok).toBe(true)
  })
})

describe('frontmatter body extraction and lossless recombination', () => {
  it('extracts body, bodyStartLine, and bodyStartOffset across valid, syntax-error, unclosed, and non-frontmatter documents', () => {
    const valid = '\uFEFF---\r\n# comment\r\ntitle: Doc\r\n...\r\n\r\n# Heading'
    const validSlice = extractFrontmatterBody(valid)
    expect(validSlice.hasFrontmatter).toBe(true)
    expect(validSlice.rawBlock).toBe('---\r\n# comment\r\ntitle: Doc\r\n...')
    expect(validSlice.body).toBe('\r\n# Heading')
    expect(validSlice.bodyStartLine).toBe(5)
    expect(validSlice.bodyStartOffset).toBe('\uFEFF---\r\n# comment\r\ntitle: Doc\r\n...\r\n'.length)
    expect(validSlice.lineEnding).toBe('\r\n')

    const closedSyntaxError = '---\nbad: [unclosed\n---\n# Body'
    const syntaxSlice = extractFrontmatterBody(closedSyntaxError)
    expect(syntaxSlice.hasFrontmatter).toBe(true)
    expect(syntaxSlice.rawBlock).toBe('---\nbad: [unclosed\n---')
    expect(syntaxSlice.body).toBe('# Body')
    expect(syntaxSlice.bodyStartLine).toBe(4)

    const unclosed = '---\ntitle: open\n# Body'
    const unclosedSlice = extractFrontmatterBody(unclosed)
    expect(unclosedSlice.hasFrontmatter).toBe(false)
    expect(unclosedSlice.body).toBe(unclosed)
    expect(unclosedSlice.bodyStartLine).toBe(1)
    expect(unclosedSlice.bodyStartOffset).toBe(0)
  })

  it('recombines edited body with original frontmatter losslessly including comments, unknown keys, nested YAML, BOM, CRLF, and blank separators', () => {
    const originalCrlf = [
      '\uFEFF---',
      '# top comment',
      'customMeta:',
      '  nested: true',
      'tags: [a, b]',
      '---',
      '',
      '# Title',
      '',
      'Old body'
    ].join('\r\n')

    const recombinedCrlf = replaceFrontmatterBody(originalCrlf, '# Title\n\nNew body')
    expect(recombinedCrlf).toBe(
      [
        '\uFEFF---',
        '# top comment',
        'customMeta:',
        '  nested: true',
        'tags: [a, b]',
        '---',
        '',
        '# Title',
        '',
        'New body'
      ].join('\r\n')
    )

    // Closed YAML syntax error block is preserved verbatim when body changes
    const brokenFrontmatter = '---\n# keep\nbroken: [\n---\n# Old'
    expect(replaceFrontmatterBody(brokenFrontmatter, '# New')).toBe(
      '---\n# keep\nbroken: [\n---\n# New'
    )

    // Closing delimiter without trailing newline inserts separator when non-empty body is written
    expect(replaceFrontmatterBody('---\ntitle: Only\n---', 'Typed body')).toBe(
      '---\ntitle: Only\n---\nTyped body'
    )
    expect(replaceFrontmatterBody('---\ntitle: Only\n---', '')).toBe('---\ntitle: Only\n---')

    // Documents without frontmatter pass through edited body (preserving BOM if present)
    expect(replaceFrontmatterBody('\uFEFF# Plain', '# Edited')).toBe('\uFEFF# Edited')
    expect(replaceFrontmatterBody('# Plain', '# Edited')).toBe('# Edited')
  })
})
