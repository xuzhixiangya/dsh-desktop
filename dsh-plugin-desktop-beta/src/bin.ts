/** Headless-safe npm launcher for the DSH Desktop Electron executable. */

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultDesktopUserDataDirectory } from './desktop-user-data-directory.ts'
import { exportDesktopDiagnostics } from './diagnostic-export.ts'
import { DESKTOP_WORKSPACE_ARGUMENT } from './launch-workspace-path.ts'
import { DESKTOP_COMMAND_NAME, DESKTOP_DISPLAY_NAME, DESKTOP_PACKAGE_NAME } from './product-identity.ts'

/** Parsed launcher action. */
export type DesktopCliAction = 'export-diagnostics' | 'help' | 'version' | 'launch'

/** Parsed launcher invocation, including anything the action carries. */
export interface DesktopCliRequest {
  /** What the launcher was asked to do. */
  readonly action: DesktopCliAction
  /** Absolute folder to register and open, when the launch named one. */
  readonly workspacePath?: string
}

/** Human-readable launcher help. */
export const DESKTOP_CLI_HELP = `Usage: ${DESKTOP_COMMAND_NAME} [options] [folder]

Launch ${DESKTOP_DISPLAY_NAME} with the selected Web-capable profile.

Arguments:
  folder                register the folder as a workspace and open it

Options:
  --export-diagnostics  export logs and crash evidence without launching the app
  -h, --help            display help
  -V, --version         display version
`

/**
 * Parse the intentionally small npm-launcher argument set.
 * @param argv - arguments after the executable and script path.
 * @param cwd - directory a relative folder argument is resolved against.
 * @returns the requested invocation.
 */
export function parseDesktopCliRequest(
  argv: readonly string[],
  cwd: string = process.cwd(),
): DesktopCliRequest {
  if (argv.length === 0) return { action: 'launch' }
  if (argv.length === 1 && argv[0] === '--export-diagnostics') return { action: 'export-diagnostics' }
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) return { action: 'help' }
  if (argv.length === 1 && (argv[0] === '--version' || argv[0] === '-V')) return { action: 'version' }
  if (argv.length === 1 && !argv[0]!.startsWith('-')) {
    return { action: 'launch', workspacePath: resolve(cwd, argv[0]!) }
  }
  throw new Error(`unknown arguments: ${argv.join(' ')}`)
}

/**
 * Parse the launcher argument set down to its action alone.
 * @param argv - arguments after the executable and script path.
 * @returns the requested action.
 */
export function parseDesktopCli(argv: readonly string[]): DesktopCliAction {
  return parseDesktopCliRequest(argv).action
}

/** Read the package version without importing Electron. */
function packageVersion(): string {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: unknown }
  if (typeof manifest.version !== 'string') throw new Error('package.json has no string version')
  return manifest.version
}

export { defaultDesktopUserDataDirectory } from './desktop-user-data-directory.ts'

export interface DesktopCliOptions {
  /** Override used by focused tests and recovery tooling with a non-default data root. */
  readonly userDataDir?: string
}

/**
 * Launch Electron and mirror its terminal exit status.
 * @param workspacePath - absolute folder to hand the application, when named.
 */
async function launchElectron(workspacePath?: string): Promise<number> {
  let electronPath: string
  try {
    const imported = await import('electron') as { default?: unknown }
    const candidate = imported.default
    if (typeof candidate !== 'string') {
      throw new Error('electron package did not provide its executable path')
    }
    electronPath = candidate
  } catch {
    process.stderr.write(
      `${DESKTOP_PACKAGE_NAME}: electron is not available in this installation.\n`
      + 'Install the desktop launcher globally (npm installs the electron peer automatically):\n'
      + `  npm install -g ${DESKTOP_PACKAGE_NAME}\n`
      + 'Or add electron to the profile before launching:\n'
      + '  dsh plugin --profile <name> add electron\n'
      + `Or use the packaged ${DESKTOP_DISPLAY_NAME} application.\n`,
    )
    return 1
  }
  const mainPath = fileURLToPath(new URL('./main.js', import.meta.url))
  // The folder travels attached to the launcher's own flag. A bare path next to
  // the entry script is indistinguishable from a background Node re-entry once
  // a running instance receives this command line, and a space separated value
  // is torn away from its flag when Chromium rebuilds that command line.
  const args = workspacePath === undefined
    ? [mainPath]
    : [mainPath, `${DESKTOP_WORKSPACE_ARGUMENT}=${workspacePath}`]
  return new Promise<number>((resolveExit, reject) => {
    const child = spawn(electronPath, args, {
      stdio: 'inherit',
      env: process.env,
      // This child is the graphical app. SW_HIDE suppresses its first window,
      // including startup dialogs that wait for user input.
      windowsHide: false,
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      resolveExit(code ?? (signal === null ? 1 : 128))
    })
  })
}

/**
 * Run the npm launcher.
 * @param argv - arguments after the executable and script path.
 * @returns process exit code.
 */
export async function runDesktopCli(
  argv: readonly string[],
  options: DesktopCliOptions = {},
): Promise<number> {
  let request: DesktopCliRequest
  try {
    request = parseDesktopCliRequest(argv)
  } catch (cause) {
    process.stderr.write(`${DESKTOP_PACKAGE_NAME}: ${cause instanceof Error ? cause.message : String(cause)}\n`)
    process.stderr.write(DESKTOP_CLI_HELP)
    return 1
  }
  const action = request.action
  if (action === 'help') {
    process.stdout.write(DESKTOP_CLI_HELP)
    return 0
  }
  if (action === 'version') {
    process.stdout.write(`${packageVersion()}\n`)
    return 0
  }
  if (action === 'export-diagnostics') {
    const path = await exportDesktopDiagnostics(
      options.userDataDir ?? defaultDesktopUserDataDirectory(),
      { appVersion: packageVersion() },
    )
    process.stdout.write(`${path}\n`)
    return 0
  }
  return launchElectron(request.workspacePath)
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1])
if (invokedPath === fileURLToPath(import.meta.url)) {
  void runDesktopCli(process.argv.slice(2)).then(
    code => { process.exitCode = code },
    cause => {
      process.stderr.write(`${DESKTOP_PACKAGE_NAME}: ${cause instanceof Error ? cause.stack ?? cause.message : String(cause)}\n`)
      process.exitCode = 1
    },
  )
}
