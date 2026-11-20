import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { GitService, type GitServiceOptions } from './GitService'

const execFileAsync = promisify(execFile)

const DEFAULT_GIT_CONFIG =
  '[init]\n\tdefaultBranch = main\n[user]\n\tname = Wiki Tester\n\temail = tester@example.com\n'

/**
 * Isolated temporary directories, git configuration, service factory, and cleanup handle for Git integration tests.
 */
export interface GitTestSandbox {
  tempRoot: string
  repoDir: string
  nonGitDir: string
  gitConfigFile: string
  env: NodeJS.ProcessEnv
  service: GitService
  createService: (overrides?: GitServiceOptions) => GitService
  runGit: (cwd: string, args: readonly string[]) => Promise<string>
  cleanup: () => Promise<void>
}

export interface BareRemoteClonesOptions {
  prefix?: string
  files?: Record<string, string>
  commitMessage?: string
}

export interface BareRemoteClones {
  bareRemote: string
  cloneA: string
  cloneB: string
}

/**
 * Creates a fresh isolated Git test sandbox with a pre-populated .gitconfig and Windows-safe cleanup.
 */
export async function createGitTestSandbox(
  options: GitServiceOptions = {}
): Promise<GitTestSandbox> {
  const tempRoot = await mkdtemp(join(tmpdir(), 'wiki-editor-git-'))
  const repoDir = join(tempRoot, 'repo')
  const nonGitDir = join(tempRoot, 'plain-folder')
  const gitConfigFile = join(tempRoot, '.gitconfig')

  await mkdir(repoDir, { recursive: true })
  await mkdir(nonGitDir, { recursive: true })
  await writeFile(gitConfigFile, DEFAULT_GIT_CONFIG, 'utf8')

  const configEnv: NodeJS.ProcessEnv = {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: gitConfigFile
  }

  const env: NodeJS.ProcessEnv = {
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    ...configEnv
  }

  const createService = (overrides: GitServiceOptions = {}): GitService =>
    new GitService({
      ...overrides,
      env: {
        ...configEnv,
        ...overrides.env
      }
    })

  const service = createService(options)

  const runGit = async (cwd: string, args: readonly string[]): Promise<string> => {
    const { stdout } = await execFileAsync('git', [...args], {
      cwd,
      windowsHide: true,
      env: {
        ...process.env,
        ...env
      }
    })
    return stdout
  }

  const cleanup = async (): Promise<void> => {
    await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }

  return {
    tempRoot,
    repoDir,
    nonGitDir,
    gitConfigFile,
    env,
    service,
    createService,
    runGit,
    cleanup
  }
}

/**
 * Runs a test callback with an automatically cleaned-up isolated Git test sandbox.
 */
export async function withGitTestSandbox<T>(
  run: (sandbox: GitTestSandbox) => Promise<T>,
  options: GitServiceOptions = {}
): Promise<T> {
  const sandbox = await createGitTestSandbox(options)
  try {
    return await run(sandbox)
  } finally {
    await sandbox.cleanup()
  }
}

/**
 * Initializes a bare remote and two clones with distinct Alice/Bob identities for multi-clone remote and graph tests.
 */
export async function setupBareRemoteClones(
  sandbox: GitTestSandbox,
  options: BareRemoteClonesOptions = {}
): Promise<BareRemoteClones> {
  const prefix = options.prefix ?? 'remote'
  const bareRemote = join(sandbox.tempRoot, `${prefix}-remote.git`)
  const cloneA = join(sandbox.tempRoot, `${prefix}-clone-a`)
  const cloneB = join(sandbox.tempRoot, `${prefix}-clone-b`)

  await mkdir(bareRemote, { recursive: true })
  await sandbox.runGit(bareRemote, ['init', '--bare'])

  await sandbox.runGit(sandbox.tempRoot, ['clone', bareRemote, cloneA])
  await sandbox.runGit(cloneA, ['checkout', '-b', 'main'])
  await sandbox.runGit(cloneA, ['config', 'user.name', 'Alice'])
  await sandbox.runGit(cloneA, ['config', 'user.email', 'alice@example.com'])

  const files = options.files ?? { 'shared.md': 'line 1\n' }
  for (const [relativePath, content] of Object.entries(files)) {
    await writeFile(join(cloneA, relativePath), content, 'utf8')
  }

  await sandbox.service.stageAll(cloneA)
  await sandbox.service.commit(cloneA, options.commitMessage ?? 'seed')
  await sandbox.service.push(cloneA)

  await sandbox.runGit(bareRemote, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  await sandbox.runGit(sandbox.tempRoot, ['clone', bareRemote, cloneB])
  await sandbox.runGit(cloneB, ['config', 'user.name', 'Bob'])
  await sandbox.runGit(cloneB, ['config', 'user.email', 'bob@example.com'])

  return { bareRemote, cloneA, cloneB }
}
