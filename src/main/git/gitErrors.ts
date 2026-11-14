export interface ExecGitError extends Error {
  code?: string | number
  stdout?: string
  stderr?: string
  killed?: boolean
  signal?: NodeJS.Signals | null
}

/**
 * Typed Git error indicating stderr/exit status has already been mapped for UI display.
 */
export class GitFormattedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GitFormattedError'
  }
}

const ERROR_PATTERNS: ReadonlyArray<{
  patterns: readonly string[]
  buildMessage: (detail: string) => string
}> = [
  {
    patterns: ['not a git repository'],
    buildMessage: () => '현재 워크스페이스는 Git 저장소가 아닙니다.'
  },
  {
    patterns: [
      'authentication failed',
      'could not read username',
      'terminal prompts disabled',
      'permission denied (publickey)',
      'invalid username or token'
    ],
    buildMessage: (detail) =>
      `Git 인증에 실패했습니다. 시스템 자격 증명 또는 SSH 키를 확인하세요.\n${detail}`
  },
  {
    patterns: ['conflict', 'automatic merge failed', 'unmerged files', 'unresolved conflict'],
    buildMessage: (detail) =>
      `병합 충돌(Conflict)이 발생했습니다. 충돌 파일을 해결한 뒤 다시 시도하세요.\n${detail}`
  },
  {
    patterns: ['would be overwritten by', 'please commit your changes or stash them'],
    buildMessage: (detail) =>
      `커밋되지 않은 로컬 변경 사항이 있어 작업을 완료할 수 없습니다. 변경 사항을 커밋하거나 정리한 뒤 다시 시도하세요.\n${detail}`
  },
  {
    patterns: ['non-fast-forward', 'fetch first', 'failed to push some refs'],
    buildMessage: (detail) =>
      `원격 저장소에 새 커밋이 있어 Push가 거부되었습니다. 먼저 Pull 또는 Sync를 실행하세요.\n${detail}`
  },
  {
    patterns: ['has no upstream branch', 'no tracking information'],
    buildMessage: (detail) => `현재 브랜치에 연결된 원격 추적(upstream) 브랜치가 없습니다.\n${detail}`
  },
  {
    patterns: ['unable to access', 'could not resolve host', 'connection refused', 'failed to connect'],
    buildMessage: (detail) => `원격 저장소에 연결할 수 없습니다.\n${detail}`
  },
  {
    patterns: ['invalid reference:'],
    buildMessage: (detail) => `브랜치를 찾을 수 없습니다.\n${detail}`
  },
  {
    patterns: ['no configured push destination', 'does not appear to be a git repository'],
    buildMessage: (detail) => `원격 저장소(remote)에 접근할 수 없습니다.\n${detail}`
  },
  {
    patterns: ['nothing to commit', 'no changes added to commit'],
    buildMessage: () => '커밋할 Staged 변경 사항이 없습니다.'
  }
]

/**
 * Extracts readable stderr/stdout/message context from a failed child_process Git invocation.
 */
export function extractGitErrorDetail(error: unknown): string {
  const execErr = error as ExecGitError
  const stderr = typeof execErr?.stderr === 'string' ? execErr.stderr.trim() : ''
  const stdout = typeof execErr?.stdout === 'string' ? execErr.stdout.trim() : ''
  if (stderr) return stderr
  if (stdout) return stdout
  if (error instanceof Error && error.message) return error.message
  return '알 수 없는 Git 오류'
}

/**
 * Maps raw Git CLI errors into concise localized GitFormattedError instances.
 */
export function formatGitError(error: unknown): GitFormattedError {
  if (error instanceof GitFormattedError) {
    return error
  }

  const execErr = error as ExecGitError
  if (execErr?.code === 'ENOENT') {
    return new GitFormattedError('시스템에 Git CLI가 설치되어 있지 않거나 PATH에서 찾을 수 없습니다.')
  }
  if (execErr?.killed || execErr?.signal === 'SIGTERM') {
    return new GitFormattedError('Git 명령 실행 시간이 초과되었습니다.')
  }

  const detail = extractGitErrorDetail(error)
  const lower = detail.toLowerCase()
  for (const entry of ERROR_PATTERNS) {
    if (entry.patterns.some((pattern) => lower.includes(pattern))) {
      return new GitFormattedError(entry.buildMessage(detail))
    }
  }
  return new GitFormattedError(`Git 명령 실행 중 오류가 발생했습니다: ${detail}`)
}
