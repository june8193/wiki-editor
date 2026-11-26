import { existsSync } from 'node:fs'
import { win32 as win32Path } from 'node:path'
import type { TerminalShellProfile } from '@shared/terminal'

const { delimiter, dirname, join } = win32Path

export interface DetectWindowsShellProfilesDeps {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  fileExists?: (targetPath: string) => boolean
}

interface ShellProfileCandidate {
  id: string
  label: string
  args: string[]
  findExecutable: (env: NodeJS.ProcessEnv, fileExists: (targetPath: string) => boolean) => string | null
}

function getEnvValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const direct = env[name]
  if (typeof direct === 'string' && direct.trim().length > 0) {
    return direct.trim()
  }
  const lowerName = name.toLowerCase()
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() === lowerName && typeof value === 'string' && value.trim().length > 0) {
      return value.trim()
    }
  }
  return undefined
}

function findExecutableInPath(
  executableName: string,
  env: NodeJS.ProcessEnv,
  fileExists: (targetPath: string) => boolean
): string | null {
  const pathValue = getEnvValue(env, 'PATH')
  if (!pathValue) return null
  for (const dir of pathValue.split(delimiter)) {
    const trimmedDir = dir.trim().replace(/^"+|"+$/g, '')
    if (!trimmedDir) continue
    const candidate = join(trimmedDir, executableName)
    if (fileExists(candidate)) {
      return candidate
    }
  }
  return null
}

function findFirstExisting(
  candidates: readonly (string | null | undefined)[],
  fileExists: (targetPath: string) => boolean
): string | null {
  for (const candidate of candidates) {
    if (candidate && fileExists(candidate)) {
      return candidate
    }
  }
  return null
}

function findGitBashExecutable(
  env: NodeJS.ProcessEnv,
  fileExists: (targetPath: string) => boolean
): string | null {
  const programFiles = getEnvValue(env, 'ProgramFiles')
  const programFilesX86 = getEnvValue(env, 'ProgramFiles(x86)')
  const localAppData = getEnvValue(env, 'LOCALAPPDATA')

  const direct = findFirstExisting(
    [
      programFiles ? join(programFiles, 'Git', 'bin', 'bash.exe') : null,
      programFiles ? join(programFiles, 'Git', 'usr', 'bin', 'bash.exe') : null,
      programFilesX86 ? join(programFilesX86, 'Git', 'bin', 'bash.exe') : null,
      localAppData ? join(localAppData, 'Programs', 'Git', 'bin', 'bash.exe') : null
    ],
    fileExists
  )
  if (direct) return direct

  const gitExe = findExecutableInPath('git.exe', env, fileExists)
  if (!gitExe) return null
  const gitRoot = dirname(dirname(gitExe))
  return findFirstExisting(
    [join(gitRoot, 'bin', 'bash.exe'), join(gitRoot, 'usr', 'bin', 'bash.exe')],
    fileExists
  )
}

const WINDOWS_SHELL_CANDIDATES: readonly ShellProfileCandidate[] = [
  {
    id: 'pwsh',
    label: 'PowerShell',
    args: ['-NoLogo'],
    findExecutable: (env, fileExists) => {
      const programFiles = getEnvValue(env, 'ProgramFiles')
      const programFilesX86 = getEnvValue(env, 'ProgramFiles(x86)')
      return (
        findExecutableInPath('pwsh.exe', env, fileExists) ??
        findFirstExisting(
          [
            programFiles ? join(programFiles, 'PowerShell', '7', 'pwsh.exe') : null,
            programFilesX86 ? join(programFilesX86, 'PowerShell', '7', 'pwsh.exe') : null
          ],
          fileExists
        )
      )
    }
  },
  {
    id: 'powershell',
    label: 'Windows PowerShell',
    args: ['-NoLogo'],
    findExecutable: (env, fileExists) => {
      const systemRoot = getEnvValue(env, 'SystemRoot') ?? 'C:\\Windows'
      return (
        findFirstExisting(
          [join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')],
          fileExists
        ) ?? findExecutableInPath('powershell.exe', env, fileExists)
      )
    }
  },
  {
    id: 'cmd',
    label: 'Command Prompt',
    args: [],
    findExecutable: (env, fileExists) => {
      const comSpec = getEnvValue(env, 'ComSpec')
      const systemRoot = getEnvValue(env, 'SystemRoot') ?? 'C:\\Windows'
      return (
        findFirstExisting([comSpec, join(systemRoot, 'System32', 'cmd.exe')], fileExists) ??
        findExecutableInPath('cmd.exe', env, fileExists)
      )
    }
  },
  {
    id: 'git-bash',
    label: 'Git Bash',
    args: ['--login', '-i'],
    findExecutable: findGitBashExecutable
  }
]

/**
 * Detects available Windows shell profiles in priority order (`pwsh.exe` -> `powershell.exe` -> `cmd.exe` -> Git Bash).
 */
export function detectWindowsShellProfiles(
  deps: DetectWindowsShellProfilesDeps = {}
): TerminalShellProfile[] {
  const platform = deps.platform ?? process.platform
  const env = deps.env ?? process.env
  const fileExists = deps.fileExists ?? existsSync

  if (platform !== 'win32') {
    const shell = getEnvValue(env, 'SHELL') ?? '/bin/sh'
    return [
      {
        id: 'default-shell',
        label: 'Shell',
        executable: shell,
        args: [],
        isDefault: true
      }
    ]
  }

  const detected: TerminalShellProfile[] = []
  for (const candidate of WINDOWS_SHELL_CANDIDATES) {
    const executable = candidate.findExecutable(env, fileExists)
    if (executable) {
      detected.push({
        id: candidate.id,
        label: candidate.label,
        executable,
        args: [...candidate.args],
        isDefault: detected.length === 0
      })
    }
  }

  if (detected.length === 0) {
    const fallbackCmd = getEnvValue(env, 'ComSpec') ?? 'cmd.exe'
    return [
      {
        id: 'cmd',
        label: 'Command Prompt',
        executable: fallbackCmd,
        args: [],
        isDefault: true
      }
    ]
  }

  return detected
}
