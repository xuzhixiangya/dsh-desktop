/** This copy ships with the desktop source. It does not query or install a published release. */

import { PLUGIN_VERSION } from './protocol.ts'

/** Keep this in sync with package.json for each published release. */
export const CURRENT_VERSION = PLUGIN_VERSION
export const PACKAGE_NAME = '@dickpy/dsh-imagegen'

export interface UpdateInfo {
  currentVersion: string
  latestVersion: string
  updateAvailable: boolean
  releaseUrl: string
  publishedAt?: string
  /** Markdown release body shown in the update popover. */
  releaseNotes?: string
}

/** Compare stable semver triples; returns positive when `left` is newer. */
export function compareVersions(left: string, right: string): number {
  const parse = (value: string): [number, number, number] => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(value.trim())
    if (match === null) return [0, 0, 0]
    return [Number(match[1]), Number(match[2]), Number(match[3])]
  }
  const a = parse(left)
  const b = parse(right)
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
}

/** Report the installed source version. A published release must not replace this copy. */
export function checkForUpdate(): Promise<UpdateInfo> {
  return Promise.resolve({
    currentVersion: CURRENT_VERSION,
    latestVersion: CURRENT_VERSION,
    updateAvailable: false,
    releaseUrl: 'https://github.com/dickpy/dsh-imagegen/releases',
  })
}

/** Resolve the profile that launched the current DSH process. */
export function profileFromProcess(argv: readonly string[] = process.argv, env: NodeJS.ProcessEnv = process.env): string {
  const envProfile = env.DSH_PROFILE?.trim()
  if (envProfile !== undefined && /^[a-zA-Z0-9_-]+$/.test(envProfile)) return envProfile
  const profileIndex = argv.indexOf('--profile')
  const explicit = profileIndex >= 0 ? argv[profileIndex + 1]?.trim() : undefined
  if (explicit !== undefined && /^[a-zA-Z0-9_-]+$/.test(explicit)) return explicit
  if (argv.includes('web')) return 'web'
  return 'web'
}

/** Refuse a release install. The next desktop build carries the maintained source. */
export function installUpdate(version: string): Promise<void> {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    return Promise.reject(new Error('invalid update version'))
  }
  return Promise.reject(new Error('dsh-imagegen is maintained with the desktop source and cannot be replaced from a release'))
}

/** Kept for callers that used to clear the release cache. There is no cache. */
export function clearUpdateCache(): void {}
