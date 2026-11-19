import type { GitChangedFile } from '@shared/git'
import { getGitFileBaseName } from './gitFilePresentation'

export type GitFileTreeNode =
  | {
      kind: 'dir'
      path: string
      label: string
      children: GitFileTreeNode[]
    }
  | {
      kind: 'file'
      file: GitChangedFile
    }

interface RawDirBucket {
  name: string
  path: string
  dirs: Map<string, RawDirBucket>
  files: GitChangedFile[]
}

function createDirBucket(name: string, path: string): RawDirBucket {
  return {
    name,
    path,
    dirs: new Map(),
    files: []
  }
}

function compareNames(a: string, b: string): number {
  const baseOrder = a.localeCompare(b, undefined, { sensitivity: 'base' })
  return baseOrder !== 0 ? baseOrder : a.localeCompare(b)
}

function compareTreeNodes(a: GitFileTreeNode, b: GitFileTreeNode): number {
  if (a.kind !== b.kind) {
    return a.kind === 'dir' ? -1 : 1
  }
  if (a.kind === 'dir' && b.kind === 'dir') {
    return compareNames(a.label, b.label)
  }
  if (a.kind === 'file' && b.kind === 'file') {
    const nameOrder = compareNames(
      getGitFileBaseName(a.file.path),
      getGitFileBaseName(b.file.path)
    )
    if (nameOrder !== 0) {
      return nameOrder
    }
    const pathOrder = a.file.path.localeCompare(b.file.path)
    return pathOrder !== 0 ? pathOrder : a.file.status.localeCompare(b.file.status)
  }
  return 0
}

function compressBucket(bucket: RawDirBucket): GitFileTreeNode {
  let current = bucket
  let label = bucket.name

  // Compress chains of intermediate directories that hold no direct files and only one child directory.
  while (current.files.length === 0 && current.dirs.size === 1) {
    const [onlyChild] = current.dirs.values()
    label = `${label}/${onlyChild.name}`
    current = onlyChild
  }

  return {
    kind: 'dir',
    path: current.path,
    label,
    children: finalizeChildren(current)
  }
}

function finalizeChildren(bucket: RawDirBucket): GitFileTreeNode[] {
  const nodes: GitFileTreeNode[] = []
  for (const childDir of bucket.dirs.values()) {
    nodes.push(compressBucket(childDir))
  }
  for (const file of bucket.files) {
    nodes.push({ kind: 'file', file })
  }
  return nodes.sort(compareTreeNodes)
}

/**
 * Builds a path-compressed folder tree from changed Git files, sorting folders before files alphabetically.
 */
export function buildCompressedGitFileTree(files: readonly GitChangedFile[]): GitFileTreeNode[] {
  if (files.length === 0) {
    return []
  }

  const root = createDirBucket('', '')

  for (const file of files) {
    const segments = file.path.replace(/\\/g, '/').split('/').filter(Boolean)
    if (segments.length <= 1) {
      root.files.push(file)
      continue
    }

    let current = root
    for (let i = 0; i < segments.length - 1; i += 1) {
      const seg = segments[i]
      let next = current.dirs.get(seg)
      if (!next) {
        const nextPath = current.path ? `${current.path}/${seg}` : seg
        next = createDirBucket(seg, nextPath)
        current.dirs.set(seg, next)
      }
      current = next
    }
    current.files.push(file)
  }

  return finalizeChildren(root)
}
