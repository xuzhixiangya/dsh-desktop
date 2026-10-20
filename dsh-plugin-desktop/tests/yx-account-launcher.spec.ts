// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { applyDesktopSettings } from '../src/client/desktop-settings.ts'
import { YxAccountLauncher, YxAccountMenu, YxLoginDialog, YX_ACCOUNT_LAUNCHER_PRIORITY, type YxAccountLauncherProps } from '../src/client/YxAccountLauncher.tsx'
import { yxLoginLocales } from '../src/client/yx-login-locales.ts'
import { rememberYxAccount, type YxSettingsRemote } from '../src/client/yx-provider.ts'
import { YX_API_KEY_REF } from '../src/yx-gateway.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => {
  const { createElement: h } = await import('react')
  return {
    Button: ({ children }: { children?: string }) => children ?? null,
    Menu: ({ anchor, items }: { anchor?: ReactNode; items?: readonly { id: string; label: string }[] }) => (
      h('div', null, anchor, ...(items ?? []).map(item => h('span', { key: item.id }, item.label)))
    ),
    IconEllipsisOutlineMedium: () => null,
    IconSettingsOutlineMedium: () => null,
    IconUserOutlineMedium: () => null,
  }
})

const dictionary: Partial<Record<Parameters<YxAccountLauncherProps['t']>[0], string>> = yxLoginLocales.zh
const t: YxAccountLauncherProps['t'] = key => dictionary[key] ?? key
const remote: YxSettingsRemote = {
  settings: {
    describe: async () => { throw new Error('unused') },
    mutate: async () => { throw new Error('unused') },
  },
  credentials: {
    set: async () => { throw new Error('unused') },
    unset: async () => { throw new Error('unused') },
  },
}

describe('YX account launcher', () => {
  it('shadows the upstream sidebar launcher', () => {
    const register = vi.fn((..._args: readonly unknown[]) => () => {})
    const inject = vi.fn((_name: string, mount: () => unknown) => mount())
    const ctx = {
      configForms: { get: () => ({}) },
      locale: { bind: () => (key: string) => key, register: () => () => {} },
      effect: vi.fn(),
      slots: { inject, register },
      remote: { marker: 'remote' },
    } as unknown as ClientContext
    applyDesktopSettings(ctx, { version: '2.0.3', mode: 'compatibility', platform: 'darwin', material: 'off' })
    const launcher = register.mock.calls.find(call => {
      const options = call[0]
      return typeof options === 'object' && options !== null && 'name' in options && options.name === 'settings.launcher'
    })
    expect(launcher?.[0]).toMatchObject({
      name: 'settings.launcher',
      priority: YX_ACCOUNT_LAUNCHER_PRIORITY,
      locale: 'yx.login',
    })
    expect(launcher?.[1]).toBe(YxAccountLauncher)
  })

  it('offers YX sign-in from the sidebar menu', () => {
    const markup = renderToStaticMarkup(createElement(YxAccountMenu, {
      wide: true,
      openSettings: () => {},
      t,
      remote,
    }))
    expect(markup).toContain('更多')
    expect(markup).toContain('登录 YX')
    expect(markup).not.toContain('DeepSeek')
    expect(markup).not.toContain('退出登录')
  })

  it('shows the signed-in account the way the sidebar account row does', () => {
    const values = new Map<string, string>([['dsh.yx.account', 'yxadmin']])
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value) },
      removeItem: (key: string) => { values.delete(key) },
    })
    const markup = renderToStaticMarkup(createElement(YxAccountMenu, {
      wide: true,
      openSettings: () => {},
      t,
      remote,
    }))
    expect(markup).toContain('yxadmin')
    expect(markup).toContain('退出登录')
    expect(markup).not.toContain('已登录')
    expect(markup).not.toContain('登录 YX')
    expect(markup).not.toContain('更多')
    vi.unstubAllGlobals()
  })

  it('shows the account when login finishes after the sidebar is already open', async () => {
    const values = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value) },
      removeItem: (key: string) => { values.delete(key) },
    })
    let release: (value: { ok: true; value: Record<string, { configured: boolean }> }) => void = () => {}
    const checking = new Promise<{ ok: true; value: Record<string, { configured: boolean }> }>(resolve => { release = resolve })
    const liveRemote: YxSettingsRemote = {
      ...remote,
      credentials: { ...remote.credentials, describe: () => checking },
    }
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(createElement(YxAccountMenu, { wide: true, openSettings: () => {}, t, remote: liveRemote }))
    })
    expect(host.textContent).toContain('登录 YX')
    await act(async () => { rememberYxAccount('yxadmin') })
    expect(host.textContent).toContain('yxadmin')
    expect(host.textContent).not.toContain('登录 YX')
    await act(async () => { release({ ok: true, value: { [YX_API_KEY_REF]: { configured: false } } }); await checking })
    expect(host.textContent).toContain('yxadmin')
    await act(async () => { root.unmount() })
    host.remove()
    vi.unstubAllGlobals()
  })

  it('opens the company gateway form', () => {
    const markup = renderToStaticMarkup(createElement(YxLoginDialog, {
      t,
      remote,
      onClose: () => {},
    }))
    expect(markup).toContain('登录 YX')
    expect(markup).toContain('账号')
    expect(markup).toContain('aria-label="登录 YX"')
    expect(markup).not.toContain('http')
    expect(markup).not.toContain('网关地址')
  })
})
