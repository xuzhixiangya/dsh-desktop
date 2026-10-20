/**
 * Install the company plugin set once per Profile, after setup has finished
 * writing the profile manifest. A later uninstall stays removed. Plugins
 * installed during a session load on the next launch.
 */

import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readProfileManifest, writeProfileManifest } from '@deepseek-ai/dsh-app-boot'
import { DESKTOP_PACKAGE_NAME } from './product-identity.ts'
import {
  recoveryPluginEnvironment,
  type RecoveryPluginUninstallOptions,
} from './recovery-plugin-uninstall.ts'

const RECEIPT_FILENAME = 'company-default-plugins.json'
const RECEIPT_VERSION = 1
const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024
const DEFAULT_GITHUB_MIRROR = 'https://gh-proxy.com'

/** One plugin offered to every company Profile. */
export interface CompanyDefaultPlugin {
  readonly name: string
  readonly spec: string
  /** False keeps the package installed and leaves it out of the enabled bundle list. */
  readonly enabled: boolean
}

/**
 * Versions match the set currently used on the company desktop Profile.
 * Git repositories are rewritten through the GitHub mirror at install time.
 */
export const COMPANY_DEFAULT_PLUGINS: readonly CompanyDefaultPlugin[] = Object.freeze([
  Object.freeze({ name: 'dsh-better-sidebar', spec: 'dsh-better-sidebar@0.26.0', enabled: true }),
  Object.freeze({ name: 'billion-context', spec: 'billion-context@0.1.197', enabled: true }),
  Object.freeze({ name: '@xmanrui/dsh-im', spec: '@xmanrui/dsh-im@4.39.0', enabled: true }),
  Object.freeze({ name: 'dsh-pet', spec: 'dsh-pet@0.3.7', enabled: false }),
  Object.freeze({ name: 'dsh-univer-office', spec: 'dsh-univer-office@0.3.7', enabled: true }),
])

type SeedStatus = 'present' | 'installed' | 'failed'

interface CompanyDefaultPluginReceipt {
  version: 1
  packages: Record<string, SeedStatus>
}

/** Launcher paths used to run `dsh plugin add` without blocking the open window. */
export interface CompanyDefaultPluginSeedOptions extends Omit<RecoveryPluginUninstallOptions, 'packageName'> {
  readonly plugins?: readonly CompanyDefaultPlugin[]
  readonly mirror?: string
  readonly log?: (message: string) => void
  /** Test double. Production uses the packaged plugin command. */
  readonly install?: (spec: string) => Promise<void>
}

/** Rewrite a GitHub repository through the desktop mirror. npm specs stay unchanged. */
export function mirrorGithubInstallSpec(spec: string, mirror = DEFAULT_GITHUB_MIRROR): string {
  const trimmed = spec.trim()
  if (/^git\+https:\/\/.+\/https:\/\/github\.com\//i.test(trimmed)) return trimmed
  const hash = trimmed.indexOf('#')
  const body = hash < 0 ? trimmed : trimmed.slice(0, hash)
  const ref = hash < 0 ? '' : trimmed.slice(hash)
  const patterns = [
    /^github:([^/\s]+)\/([^/\s#]+?)(?:\.git)?$/i,
    /^git\+https:\/\/github\.com\/([^/\s]+)\/([^/\s#]+?)(?:\.git)?$/i,
    /^https:\/\/github\.com\/([^/\s]+)\/([^/\s#]+?)(?:\.git)?$/i,
  ]
  const prefix = mirror.replace(/\/+$/u, '')
  for (const pattern of patterns) {
    const match = pattern.exec(body)
    const owner = match?.[1]
    const repoName = match?.[2]
    if (owner === undefined || repoName === undefined) continue
    const repo = repoName.replace(/\.git$/i, '')
    return `git+${prefix}/https://github.com/${owner}/${repo}.git${ref}`
  }
  return trimmed
}

function receiptPath(profileDir: string): string {
  return join(profileDir, RECEIPT_FILENAME)
}

function isStatus(value: unknown): value is SeedStatus {
  return value === 'present' || value === 'installed' || value === 'failed'
}

/** Missing file means this Profile has not been seeded. A bad file means do not install. */
function readReceipt(profileDir: string): CompanyDefaultPluginReceipt | undefined {
  const path = receiptPath(profileDir)
  if (!existsSync(path)) return { version: RECEIPT_VERSION, packages: {} }
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const record = parsed as { version?: unknown, packages?: unknown }
  if (record.version !== RECEIPT_VERSION || typeof record.packages !== 'object' || record.packages === null || Array.isArray(record.packages)) {
    return undefined
  }
  const packages: Record<string, SeedStatus> = {}
  for (const [name, status] of Object.entries(record.packages)) {
    if (!isStatus(status)) return undefined
    packages[name] = status
  }
  return { version: RECEIPT_VERSION, packages }
}

function writeReceipt(profileDir: string, receipt: CompanyDefaultPluginReceipt): void {
  const path = receiptPath(profileDir)
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, `${JSON.stringify(receipt, undefined, 2)}\n`, { mode: 0o600, flag: 'wx' })
    renameSync(temporary, path)
  } catch (cause) {
    rmSync(temporary, { force: true })
    throw cause
  }
}

function dependencyNames(profileDir: string): Set<string> | undefined {
  const manifest = readProfileManifest(DESKTOP_PACKAGE_NAME, profileDir)
  const dependencies = manifest.dependencies
  if (dependencies === undefined) return new Set()
  if (typeof dependencies !== 'object' || dependencies === null || Array.isArray(dependencies)) return undefined
  return new Set(Object.keys(dependencies))
}

function disableInstalledBundle(profileDir: string, packageName: string): void {
  const manifest = readProfileManifest(DESKTOP_PACKAGE_NAME, profileDir)
  const bundles = manifest.dsh?.profile?.bundles
  if (!Array.isArray(bundles) || !bundles.includes(packageName)) return
  writeProfileManifest(profileDir, {
    ...manifest,
    dsh: {
      ...manifest.dsh,
      profile: {
        ...manifest.dsh?.profile,
        bundles: bundles.filter(name => name !== packageName),
      },
    },
  })
}

function assertInstallSpec(spec: string): void {
  if (spec.length === 0 || spec.length > 500 || spec.includes('\0') || /[\r\n]/.test(spec) || spec.startsWith('-')) {
    throw new Error(`${DESKTOP_PACKAGE_NAME}: company default plugin spec is invalid`)
  }
}

async function addProfilePlugin(
  options: Omit<RecoveryPluginUninstallOptions, 'packageName'> & { readonly spec: string },
): Promise<void> {
  assertInstallSpec(options.spec)
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxBuffer = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  options.signal?.throwIfAborted()
  const args = [
    '--expose-internals',
    options.dshBootstrapPath,
    'plugin',
    '--profile',
    options.profileName,
    'add',
    options.spec,
  ]
  await new Promise<void>((resolve, reject) => {
    execFile(options.appExecutable, args, {
      cwd: options.profileDir,
      encoding: 'utf8',
      env: recoveryPluginEnvironment(options),
      maxBuffer,
      timeout: timeoutMs,
      windowsHide: true,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    }, (cause, stdout, stderr) => {
      if (cause === null) {
        resolve()
        return
      }
      const detail = `${stderr}\n${stdout}`.trim().slice(0, 2000)
      reject(new Error(
        `dsh plugin add failed (code=${String(cause.code)}, signal=${String(cause.signal)})${detail.length === 0 ? '' : `: ${detail}`}`,
      ))
    })
  })
}

/**
 * Whether background plugin installation may take the profile manifest lock.
 *
 * `dsh plugin add` holds `package.json.lock` for the whole pnpm run. Setup
 * finish and account login write that same manifest and only wait two seconds,
 * so seeding while either is still in progress fails the wizard. A process
 * that is about to relaunch must not start an install it will abort.
 */
export function companyPluginSeedReady(input: {
  readonly safeMode: boolean
  readonly setupPending: boolean
  readonly accountPending: boolean
  readonly relaunching: boolean
}): boolean {
  return !input.safeMode && !input.setupPending && !input.accountPending && !input.relaunching
}

/**
 * Offer each company plugin once. An install failure is recorded and skipped.
 * A plugin removed after a successful seed is not installed again.
 */
export async function seedCompanyDefaultPlugins(options: CompanyDefaultPluginSeedOptions): Promise<void> {
  const log = options.log ?? (() => {})
  if (!existsSync(join(options.profileDir, 'package.json'))) {
    log('company default plugins: Profile manifest is missing, so nothing was installed')
    return
  }
  let receipt: CompanyDefaultPluginReceipt | undefined
  try {
    receipt = readReceipt(options.profileDir)
  } catch (cause) {
    log(`company default plugins: seed receipt cannot be read, so nothing was installed: ${cause instanceof Error ? cause.message : String(cause)}`)
    return
  }
  if (receipt === undefined) {
    log('company default plugins: seed receipt is not this version, so nothing was installed')
    return
  }
  const plugins = options.plugins ?? COMPANY_DEFAULT_PLUGINS
  const install = options.install ?? (async spec => { await addProfilePlugin({ ...options, spec }) })
  const closing = (): boolean => options.signal?.aborted === true
  for (const plugin of plugins) {
    if (closing()) {
      log('company default plugins: stopped because the app is closing')
      return
    }
    if (receipt.packages[plugin.name] !== undefined) continue
    try {
      const names = dependencyNames(options.profileDir)
      if (names === undefined) {
        log(`company default plugins: ${plugin.name} was skipped because the Profile manifest is unreadable`)
        receipt.packages[plugin.name] = 'failed'
      } else if (names.has(plugin.name)) {
        receipt.packages[plugin.name] = 'present'
        log(`company default plugins: ${plugin.name} is already installed`)
      } else {
        await install(mirrorGithubInstallSpec(plugin.spec, options.mirror))
        const installed = dependencyNames(options.profileDir)
        if (installed === undefined || !installed.has(plugin.name)) {
          receipt.packages[plugin.name] = 'failed'
          log(`company default plugins: ${plugin.name} was skipped because it did not stay installed`)
        } else {
          if (!plugin.enabled) {
            try {
              disableInstalledBundle(options.profileDir, plugin.name)
              log(`company default plugins: installed ${plugin.name} and left it turned off`)
            } catch (cause) {
              log(`company default plugins: installed ${plugin.name}, but it could not be turned off: ${cause instanceof Error ? cause.message : String(cause)}`)
            }
          } else {
            log(`company default plugins: installed ${plugin.name}`)
          }
          receipt.packages[plugin.name] = 'installed'
        }
      }
      writeReceipt(options.profileDir, receipt)
    } catch (cause) {
      if (closing()) {
        log(`company default plugins: ${plugin.name} stopped because the app is closing`)
        return
      }
      receipt.packages[plugin.name] = 'failed'
      log(`company default plugins: ${plugin.name} was skipped: ${cause instanceof Error ? cause.message : String(cause)}`)
      try {
        writeReceipt(options.profileDir, receipt)
      } catch (writeCause) {
        log(`company default plugins: could not record ${plugin.name}: ${writeCause instanceof Error ? writeCause.message : String(writeCause)}`)
      }
    }
  }
}
