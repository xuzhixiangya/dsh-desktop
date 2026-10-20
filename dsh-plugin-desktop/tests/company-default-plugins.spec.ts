import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  COMPANY_DEFAULT_PLUGINS,
  companyPluginSeedReady,
  mirrorGithubInstallSpec,
  seedCompanyDefaultPlugins,
} from '../src/company-default-plugins.ts'

const directories: string[] = []

function profileDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'company-default-plugins-'))
  directories.push(dir)
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({
    name: 'dsh-profile-desktop',
    private: true,
    dependencies: {
      '@deepseek-ai/dsh-base': '0.0.0',
    },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
  }, undefined, 2)}\n`)
  return dir
}

function manifest(dir: string): { dependencies: Record<string, string>, dsh: { profile: { bundles: string[] } } } {
  return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
    dependencies: Record<string, string>
    dsh: { profile: { bundles: string[] } }
  }
}

function rememberInstall(dir: string) {
  const specs: string[] = []
  return {
    specs,
    install: async (spec: string) => {
      specs.push(spec)
      const plugin = COMPANY_DEFAULT_PLUGINS.find(item => mirrorGithubInstallSpec(item.spec) === spec)
      if (plugin === undefined) throw new Error(`unexpected spec ${spec}`)
      const current = manifest(dir)
      current.dependencies[plugin.name] = plugin.spec
      current.dsh.profile.bundles.push(plugin.name)
      writeFileSync(join(dir, 'package.json'), `${JSON.stringify(current, undefined, 2)}\n`)
    },
  }
}

afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('company default plugins', () => {
  it('waits to install until setup and account login have released the profile manifest', () => {
    const ready = { safeMode: false, setupPending: false, accountPending: false, relaunching: false }
    expect(companyPluginSeedReady(ready)).toBe(true)
    expect(companyPluginSeedReady({ ...ready, setupPending: true })).toBe(false)
    expect(companyPluginSeedReady({ ...ready, accountPending: true })).toBe(false)
    expect(companyPluginSeedReady({ ...ready, relaunching: true })).toBe(false)
    expect(companyPluginSeedReady({ ...ready, safeMode: true })).toBe(false)
  })

  it('sends GitHub repositories through the mirror and leaves npm specs unchanged', () => {
    expect(mirrorGithubInstallSpec('github:xuzhixiangya/dsh-deep-research')).toBe(
      'git+https://gh-proxy.com/https://github.com/xuzhixiangya/dsh-deep-research.git',
    )
    expect(mirrorGithubInstallSpec('git+https://github.com/Imzl-zl/dsh-mcp-manager-ui.git')).toBe(
      'git+https://gh-proxy.com/https://github.com/Imzl-zl/dsh-mcp-manager-ui.git',
    )
    expect(mirrorGithubInstallSpec('dsh-pet@0.3.7')).toBe('dsh-pet@0.3.7')
    expect(COMPANY_DEFAULT_PLUGINS.map(plugin => [plugin.name, plugin.spec, plugin.enabled])).toEqual([
      ['dsh-better-sidebar', 'dsh-better-sidebar@0.26.0', true],
      ['billion-context', 'billion-context@0.1.197', true],
      ['@xmanrui/dsh-im', '@xmanrui/dsh-im@4.39.0', true],
      ['dsh-pet', 'dsh-pet@0.3.7', false],
      ['dsh-univer-office', 'dsh-univer-office@0.3.7', true],
    ])
  })

  it('installs missing plugins, leaves the pet turned off, and does not install them again', async () => {
    const dir = profileDir()
    const installer = rememberInstall(dir)
    const logs: string[] = []
    await seedCompanyDefaultPlugins({
      profileDir: dir,
      profileName: 'desktop',
      appExecutable: '/app',
      dshBootstrapPath: '/bootstrap',
      homeDir: '/home',
      nodeBinDir: '/node',
      nodeShimPath: '/node/node',
      pnpmBinDir: '/pnpm',
      electronVersion: '1.2.3',
      install: installer.install,
      log: message => { logs.push(message) },
    })

    expect(installer.specs).toEqual(COMPANY_DEFAULT_PLUGINS.map(plugin => mirrorGithubInstallSpec(plugin.spec)))
    const installed = manifest(dir)
    expect(installed.dependencies['dsh-pet']).toBe('dsh-pet@0.3.7')
    expect(installed.dsh.profile.bundles).not.toContain('dsh-pet')
    expect(installed.dsh.profile.bundles).toContain('dsh-better-sidebar')
    expect(logs.some(line => line.includes('installed dsh-pet and left it turned off'))).toBe(true)

    delete installed.dependencies['dsh-better-sidebar']
    installed.dsh.profile.bundles = installed.dsh.profile.bundles.filter(name => name !== 'dsh-better-sidebar')
    writeFileSync(join(dir, 'package.json'), `${JSON.stringify(installed, undefined, 2)}\n`)
    installer.specs.length = 0
    await seedCompanyDefaultPlugins({
      profileDir: dir,
      profileName: 'desktop',
      appExecutable: '/app',
      dshBootstrapPath: '/bootstrap',
      homeDir: '/home',
      nodeBinDir: '/node',
      nodeShimPath: '/node/node',
      pnpmBinDir: '/pnpm',
      electronVersion: '1.2.3',
      install: installer.install,
    })
    expect(installer.specs).toEqual([])
    expect(manifest(dir).dependencies['dsh-better-sidebar']).toBeUndefined()
  })

  it('keeps a plugin the Profile already has, including a pet the user turned on', async () => {
    const dir = profileDir()
    const current = manifest(dir)
    current.dependencies['dsh-pet'] = '0.3.7'
    current.dsh.profile.bundles.push('dsh-pet')
    writeFileSync(join(dir, 'package.json'), `${JSON.stringify(current, undefined, 2)}\n`)
    const specs: string[] = []
    await seedCompanyDefaultPlugins({
      profileDir: dir,
      profileName: 'desktop',
      appExecutable: '/app',
      dshBootstrapPath: '/bootstrap',
      homeDir: '/home',
      nodeBinDir: '/node',
      nodeShimPath: '/node/node',
      pnpmBinDir: '/pnpm',
      electronVersion: '1.2.3',
      plugins: [{ name: 'dsh-pet', spec: 'dsh-pet@0.3.7', enabled: false }],
      install: async spec => { specs.push(spec) },
    })
    expect(specs).toEqual([])
    expect(manifest(dir).dsh.profile.bundles).toContain('dsh-pet')
  })

  it('skips a plugin that fails to install and still installs the rest', async () => {
    const dir = profileDir()
    const installer = rememberInstall(dir)
    const logs: string[] = []
    await seedCompanyDefaultPlugins({
      profileDir: dir,
      profileName: 'desktop',
      appExecutable: '/app',
      dshBootstrapPath: '/bootstrap',
      homeDir: '/home',
      nodeBinDir: '/node',
      nodeShimPath: '/node/node',
      pnpmBinDir: '/pnpm',
      electronVersion: '1.2.3',
      plugins: [
        { name: 'dsh-better-sidebar', spec: 'dsh-better-sidebar@0.26.0', enabled: true },
        { name: 'billion-context', spec: 'billion-context@0.1.197', enabled: true },
      ],
      install: async spec => {
        if (spec.startsWith('billion-context')) throw new Error('registry down')
        await installer.install(spec)
      },
      log: message => { logs.push(message) },
    })
    expect(manifest(dir).dependencies['dsh-better-sidebar']).toBe('dsh-better-sidebar@0.26.0')
    expect(manifest(dir).dependencies['billion-context']).toBeUndefined()
    expect(logs.some(line => line.includes('billion-context was skipped: registry down'))).toBe(true)

    await seedCompanyDefaultPlugins({
      profileDir: dir,
      profileName: 'desktop',
      appExecutable: '/app',
      dshBootstrapPath: '/bootstrap',
      homeDir: '/home',
      nodeBinDir: '/node',
      nodeShimPath: '/node/node',
      pnpmBinDir: '/pnpm',
      electronVersion: '1.2.3',
      plugins: [
        { name: 'dsh-better-sidebar', spec: 'dsh-better-sidebar@0.26.0', enabled: true },
        { name: 'billion-context', spec: 'billion-context@0.1.197', enabled: true },
      ],
      install: async () => { throw new Error('should not retry') },
    })
    expect(manifest(dir).dependencies['billion-context']).toBeUndefined()
  })

  it('stops when the app closes and retries the unfinished plugin next time', async () => {
    const dir = profileDir()
    const controller = new AbortController()
    const installer = rememberInstall(dir)
    const logs: string[] = []
    await seedCompanyDefaultPlugins({
      profileDir: dir,
      profileName: 'desktop',
      appExecutable: '/app',
      dshBootstrapPath: '/bootstrap',
      homeDir: '/home',
      nodeBinDir: '/node',
      nodeShimPath: '/node/node',
      pnpmBinDir: '/pnpm',
      electronVersion: '1.2.3',
      plugins: [
        { name: 'dsh-better-sidebar', spec: 'dsh-better-sidebar@0.26.0', enabled: true },
        { name: 'billion-context', spec: 'billion-context@0.1.197', enabled: true },
      ],
      signal: controller.signal,
      install: async spec => {
        if (spec.startsWith('billion-context')) {
          controller.abort()
          throw new Error('The operation was aborted')
        }
        await installer.install(spec)
      },
      log: message => { logs.push(message) },
    })
    expect(manifest(dir).dependencies['dsh-better-sidebar']).toBe('dsh-better-sidebar@0.26.0')
    expect(logs.some(line => line.includes('billion-context stopped because the app is closing'))).toBe(true)
    const receipt = readFileSync(join(dir, 'company-default-plugins.json'), 'utf8')
    expect(receipt).not.toContain('billion-context')
    expect(receipt).not.toContain('failed')

    installer.specs.length = 0
    await seedCompanyDefaultPlugins({
      profileDir: dir,
      profileName: 'desktop',
      appExecutable: '/app',
      dshBootstrapPath: '/bootstrap',
      homeDir: '/home',
      nodeBinDir: '/node',
      nodeShimPath: '/node/node',
      pnpmBinDir: '/pnpm',
      electronVersion: '1.2.3',
      plugins: [
        { name: 'dsh-better-sidebar', spec: 'dsh-better-sidebar@0.26.0', enabled: true },
        { name: 'billion-context', spec: 'billion-context@0.1.197', enabled: true },
      ],
      install: installer.install,
    })
    expect(installer.specs).toEqual(['billion-context@0.1.197'])
    expect(existsSync(join(dir, 'company-default-plugins.json'))).toBe(true)
  })

  it('does not install when the seed receipt cannot be trusted', async () => {
    const dir = profileDir()
    writeFileSync(join(dir, 'company-default-plugins.json'), '{')
    const specs: string[] = []
    const logs: string[] = []
    await seedCompanyDefaultPlugins({
      profileDir: dir,
      profileName: 'desktop',
      appExecutable: '/app',
      dshBootstrapPath: '/bootstrap',
      homeDir: '/home',
      nodeBinDir: '/node',
      nodeShimPath: '/node/node',
      pnpmBinDir: '/pnpm',
      electronVersion: '1.2.3',
      plugins: [{ name: 'dsh-pet', spec: 'dsh-pet@0.3.7', enabled: false }],
      install: async spec => { specs.push(spec) },
      log: message => { logs.push(message) },
    })
    expect(specs).toEqual([])
    expect(logs.some(line => line.includes('cannot be read'))).toBe(true)
  })
})
