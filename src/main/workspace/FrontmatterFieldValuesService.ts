import {
  collectAllowCustomMultiSelectFields,
  createFrontmatterFieldValuesCollector,
  parseFrontmatterDocument,
  type WorkspaceFrontmatterFieldValuesResponse,
  type WorkspaceFrontmatterSchema
} from '@shared/frontmatter'
import { getWorkspacePathKey } from '@shared/workspace'
import {
  WorkspaceDocumentScanner,
  type WorkspaceDocumentScannerDependencies
} from './WorkspaceDocumentScanner'

export type FrontmatterFieldValuesServiceDependencies = WorkspaceDocumentScannerDependencies

/**
 * Collects deduplicated, sorted schema options and live document custom values for `allowCustom`
 * `multi-select` frontmatter fields across a workspace session's documents and open buffers.
 */
export class FrontmatterFieldValuesService {
  private readonly scanner: WorkspaceDocumentScanner

  constructor(deps: FrontmatterFieldValuesServiceDependencies) {
    this.scanner = new WorkspaceDocumentScanner(deps)
  }

  /** Aborts any currently running field-value scan for this session. */
  cancelActiveScan(): void {
    this.scanner.cancelActiveScan()
  }

  /**
   * Scans eligible workspace documents (preferring unsaved open buffers over disk) and returns
   * deduplicated, sorted options + custom values per `allowCustom` `multi-select` field.
   */
  collectFieldValues(
    fieldKeys?: readonly string[]
  ): Promise<WorkspaceFrontmatterFieldValuesResponse> {
    return this.scanner.runSingleFlightScan({ valuesByField: {} }, async (session) => {
      const schema = await session.loadSchema(true)
      if (session.isInvalidated() || !schema) {
        return { valuesByField: {} }
      }

      const targetFields = collectAllowCustomMultiSelectFields(schema, fieldKeys)
      if (targetFields.length === 0) {
        return { valuesByField: {} }
      }

      const openTextBuffersByKey = await session.collectOpenTextBuffers()
      if (session.isInvalidated()) {
        return { valuesByField: {} }
      }

      const entries = await session.listEligibleEntries(true)
      if (!entries || session.isInvalidated()) {
        return { valuesByField: {} }
      }

      const candidates = entries.map((entry) => ({
        entry,
        pathKey: getWorkspacePathKey(entry.path)
      }))
      const collector = createFrontmatterFieldValuesCollector(targetFields)
      const narrowSchema: WorkspaceFrontmatterSchema = { version: 1, fields: targetFields }

      await session.runWorkers(candidates, async (candidate) => {
        const text = await session.readCandidateTextSafe(
          candidate.entry,
          candidate.pathKey,
          openTextBuffersByKey
        )
        if (text === null || session.isInvalidated()) {
          return
        }
        const parsed = parseFrontmatterDocument(text, narrowSchema)
        collector.addDocumentValues(parsed.values)
      })

      if (session.isInvalidated()) {
        return { valuesByField: {} }
      }

      return collector.finalize()
    })
  }

  dispose(): void {
    this.scanner.dispose()
  }
}
