import { describe, expect, it } from 'vitest'
import { detectWindowsShellProfiles } from './shellProfiles'

describe('detectWindowsShellProfiles', () => {
  it('prefers pwsh.exe as default when available alongside powershell.exe, cmd.exe, and Git Bash', () => {
    const existingFiles = new Set([
      'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      'C:\\Windows\\System32\\cmd.exe',
      'C:\\Program Files\\Git\\bin\\bash.exe'
    ])

    const profiles = detectWindowsShellProfiles({
      platform: 'win32',
      env: {
        SystemRoot: 'C:\\Windows',
        ProgramFiles: 'C:\\Program Files',
        PATH: 'C:\\Program Files\\PowerShell\\7;C:\\Windows\\System32'
      },
      fileExists: (targetPath) => existingFiles.has(targetPath)
    })

    expect(profiles.map((p) => p.id)).toEqual(['pwsh', 'powershell', 'cmd', 'git-bash'])
    expect(profiles.find((p) => p.id === 'pwsh')?.isDefault).toBe(true)
    expect(profiles.filter((p) => p.isDefault)).toHaveLength(1)
  })

  it('falls back to powershell.exe as default when pwsh.exe is not installed', () => {
    const existingFiles = new Set([
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      'C:\\Windows\\System32\\cmd.exe'
    ])

    const profiles = detectWindowsShellProfiles({
      platform: 'win32',
      env: {
        SystemRoot: 'C:\\Windows',
        PATH: 'C:\\Windows\\System32;C:\\Windows\\System32\\WindowsPowerShell\\v1.0'
      },
      fileExists: (targetPath) => existingFiles.has(targetPath)
    })

    expect(profiles.map((p) => p.id)).toEqual(['powershell', 'cmd'])
    expect(profiles[0]).toMatchObject({
      id: 'powershell',
      isDefault: true
    })
  })

  it('detects Git Bash via LocalAppData when ProgramFiles installation is absent', () => {
    const existingFiles = new Set([
      'C:\\Windows\\System32\\cmd.exe',
      'C:\\Users\\dev\\AppData\\Local\\Programs\\Git\\bin\\bash.exe'
    ])

    const profiles = detectWindowsShellProfiles({
      platform: 'win32',
      env: {
        SystemRoot: 'C:\\Windows',
        LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local',
        PATH: 'C:\\Windows\\System32'
      },
      fileExists: (targetPath) => existingFiles.has(targetPath)
    })

    expect(profiles.map((p) => p.id)).toEqual(['cmd', 'git-bash'])
    expect(profiles[0].isDefault).toBe(true)
    expect(profiles[1]).toMatchObject({
      id: 'git-bash',
      executable: 'C:\\Users\\dev\\AppData\\Local\\Programs\\Git\\bin\\bash.exe',
      isDefault: false
    })
  })

  it('falls back to ComSpec cmd.exe when no probed executable is found on Windows', () => {
    const profiles = detectWindowsShellProfiles({
      platform: 'win32',
      env: {
        ComSpec: 'C:\\Windows\\System32\\cmd.exe'
      },
      fileExists: () => false
    })

    expect(profiles).toEqual([
      {
        id: 'cmd',
        label: 'Command Prompt',
        executable: 'C:\\Windows\\System32\\cmd.exe',
        args: [],
        isDefault: true
      }
    ])
  })
})
