import { readFile, stat } from 'node:fs/promises'
import { getImageMimeType, parseWikiAssetUrl, WIKI_ASSET_SCHEME } from '@shared/assets'
import { isErrnoCode } from '../fs/pathSecurity'
import type { WorkspaceFsService } from '../workspace/WorkspaceFsService'

export const WIKI_ASSET_PRIVILEGED_SCHEME = {
  scheme: WIKI_ASSET_SCHEME,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: true
  }
}

const WIKI_ASSET_CSP = "default-src 'none'; style-src 'unsafe-inline'"

function textResponse(status: number, body: string, headers?: Record<string, string>): Response {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      ...headers
    }
  })
}

export type WikiAssetWorkspaceSource =
  | WorkspaceFsService
  | readonly WorkspaceFsService[]
  | (() => readonly WorkspaceFsService[])

function normalizeWorkspaceServices(
  workspaceSource: WikiAssetWorkspaceSource
): readonly WorkspaceFsService[] {
  if (typeof workspaceSource === 'function') {
    return workspaceSource()
  }
  return Array.isArray(workspaceSource)
    ? (workspaceSource as readonly WorkspaceFsService[])
    : [workspaceSource as WorkspaceFsService]
}

async function resolveAssetAcrossWorkspaces(
  targetPath: string,
  workspaceSource: WikiAssetWorkspaceSource
): Promise<
  { status: 'ok'; resolvedPath: string } | { status: 'forbidden' } | { status: 'not-found' }
> {
  const services = normalizeWorkspaceServices(workspaceSource)
  let hasNotFound = false

  for (const service of services) {
    const resolution = await service.resolveAssetPath(targetPath)
    if (resolution.status === 'ok') {
      return resolution
    }
    if (resolution.status === 'not-found') {
      hasNotFound = true
    }
  }

  return hasNotFound ? { status: 'not-found' } : { status: 'forbidden' }
}

export async function handleWikiAssetRequest(
  request: { url: string; method: string },
  workspaceSource: WikiAssetWorkspaceSource
): Promise<Response> {
  const method = request.method.toUpperCase()
  if (method !== 'GET' && method !== 'HEAD') {
    return textResponse(405, 'Method Not Allowed', { Allow: 'GET, HEAD' })
  }

  const targetPath = parseWikiAssetUrl(request.url)
  if (!targetPath) {
    return textResponse(400, 'Bad Request')
  }

  if (!getImageMimeType(targetPath)) {
    return textResponse(403, 'Forbidden')
  }

  const resolution = await resolveAssetAcrossWorkspaces(targetPath, workspaceSource)
  if (resolution.status === 'forbidden') {
    return textResponse(403, 'Forbidden')
  }
  if (resolution.status === 'not-found') {
    return textResponse(404, 'Not Found')
  }

  const resolvedMimeType = getImageMimeType(resolution.resolvedPath)
  if (!resolvedMimeType) {
    return textResponse(403, 'Forbidden')
  }

  try {
    const fileStat = await stat(resolution.resolvedPath)
    if (!fileStat.isFile()) {
      return textResponse(404, 'Not Found')
    }

    const headers = {
      'Content-Type': resolvedMimeType,
      'Cache-Control': 'no-store',
      'Content-Security-Policy': WIKI_ASSET_CSP,
      'X-Content-Type-Options': 'nosniff'
    }

    if (method === 'HEAD') {
      return new Response(null, { status: 200, headers })
    }

    const content = await readFile(resolution.resolvedPath)
    return new Response(new Uint8Array(content), { status: 200, headers })
  } catch (error) {
    if (isErrnoCode(error, 'ENOENT') || isErrnoCode(error, 'ENOTDIR')) {
      return textResponse(404, 'Not Found')
    }
    return textResponse(403, 'Forbidden')
  }
}
