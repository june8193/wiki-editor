import { mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

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
