import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { isErrnoCode } from './pathSecurity'

let uniqueSuffixCounter = 0

/**
 * Generates a monotonically unique suffix for temp files and corrupt backup names.
 */
export function nextUniqueSuffix(): string {
  uniqueSuffixCounter += 1
  return `${process.pid}.${Date.now()}-${uniqueSuffixCounter}`
}

/**
 * Writes UTF-8 content to a file atomically via a same-directory temp file and rename.
 */
export async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  const dir = dirname(filePath)
  await mkdir(dir, { recursive: true })
  const tempPath = join(dir, `.${basename(filePath)}.${nextUniqueSuffix()}.tmp`)
  try {
    await writeFile(tempPath, content, 'utf8')
    await rename(tempPath, filePath)
  } catch (error) {
    await unlink(tempPath).catch(() => undefined)
    throw error
  }
}

export type JsonParseValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string }

export interface CorruptJsonRecoveryInfo {
  filePath: string
  backupPath: string
  reason: string
  contentLength: number
}

export interface LoadOrInitializeJsonFileOptions<T> {
  filePath: string
  createDefault: () => T
  serialize: (value: T) => string
  parseValid: (parsed: unknown) => JsonParseValidationResult<T>
  onRecovered?: (info: CorruptJsonRecoveryInfo) => Promise<void> | void
}

/**
 * Reads and validates a JSON state file, initializing defaults when missing and backing up
 * corrupted files to `.corrupt.<suffix>.bak` before restoring defaults.
 */
export async function loadOrInitializeJsonFile<T>({
  filePath,
  createDefault,
  serialize,
  parseValid,
  onRecovered
}: LoadOrInitializeJsonFileOptions<T>): Promise<T> {
  const writeDefaults = async (): Promise<T> => {
    const initial = createDefault()
    await writeFileAtomic(filePath, serialize(initial))
    return initial
  }

  let raw: string
  try {
    raw = await readFile(filePath, 'utf8')
  } catch (error) {
    if (isErrnoCode(error, 'ENOENT')) {
      return writeDefaults()
    }
    throw error
  }

  const recoverCorrupted = async (reason: string): Promise<T> => {
    const backupPath = `${filePath}.corrupt.${nextUniqueSuffix()}.bak`
    await writeFileAtomic(backupPath, raw)
    await onRecovered?.({
      filePath,
      backupPath,
      reason,
      contentLength: raw.length
    })
    return writeDefaults()
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return recoverCorrupted(error instanceof Error ? error.message : 'invalid-json')
  }

  const validation = parseValid(parsed)
  if (!validation.ok) {
    return recoverCorrupted(validation.reason)
  }
  return validation.value
}
