import { expect, it, vi } from 'vitest'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { SettingsDescribeValue, SettingsNamespaceView } from '@deepseek-ai/dsh-settings/types'
import {
  loginYxGateway,
  parseYxLoginRequest,
  YX_API_KEY_REF,
  YX_GATEWAY_ORIGIN,
  YX_PROVIDER_NAMESPACE,
  YX_PROVIDER_ROUTE,
  YxGatewayError,
} from '../src/yx-gateway.ts'
import { adoptYxChatModel, readYxChatSessions } from '../src/client/yx-chat-model.ts'
import { applyYxLogin, confirmYxAccount, defaultYxModelIds, ensureYxDefaultModel, ensureYxResponsesProtocol, forgetYxAccount, rememberedYxAccount, rememberYxAccount, saveYxProvider, sessionShouldUseYxGateway, subscribeYxAccount, type YxSettingsRemote } from '../src/client/yx-provider.ts'

const ORIGIN = 'http://127.0.0.1:3000'
const KEY = 'a'.repeat(48)

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function gateway(routes: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init?: RequestInit }[] = []
  const fetchImpl = async (url: string, init?: RequestInit) => {
    calls.push(init === undefined ? { url } : { url, init })
    return await routes(url, init)
  }
  return { calls, fetchImpl }
}

it('signs in against the company gateway without asking for an address', () => {
  expect(YX_GATEWAY_ORIGIN).toBe('https://aiapi.yxrobot.com')
  expect(parseYxLoginRequest({ origin: YX_GATEWAY_ORIGIN, username: 'yx', password: 'secret' }).origin)
    .toBe('https://aiapi.yxrobot.com')
})

it('rejects a cleartext gateway that is not on this machine', () => {
  expect(() => parseYxLoginRequest({ origin: 'http://ai.example.com', username: 'yx', password: 'secret' }))
    .toThrow(YxGatewayError)
  expect(() => parseYxLoginRequest({ origin: 'https://user:secret@127.0.0.1:3000', username: 'yx', password: 'secret' }))
    .toThrow('网关地址无效')
})

it('uses the first enabled token that still has quota and does not create one', async () => {
  const { calls, fetchImpl } = gateway(url => {
    if (url.endsWith('/api/user/login/encryption-key')) return json({ success: true, data: { enabled: false } })
    if (url.endsWith('/api/user/login')) return json({ success: true, data: { access_token: 'session-secret', require_verification: false } })
    if (url.endsWith('/api/user/models')) return json({ success: true, data: ['gpt-4o', ' deepseek-chat ', 'gpt-4o'] })
    if (url.includes('/api/token/?')) return json({ success: true, data: { total: 6, items: [
      { id: 9, name: 'disabled', status: 2, expired_time: -1, remain_quota: 100, unlimited_quota: true },
      { id: 8, name: 'expired', status: 1, expired_time: 1, remain_quota: 100, unlimited_quota: true },
      { id: 7, name: 'empty', status: 1, expired_time: -1, remain_quota: 0, unlimited_quota: false },
      { id: 6, name: 'exhausted', status: 4, expired_time: -1, remain_quota: 0, unlimited_quota: false },
      { id: 5, name: 'office', status: 1, expired_time: -1, remain_quota: 0, unlimited_quota: true },
      { id: 4, name: 'later', status: 1, expired_time: -1, remain_quota: 80, unlimited_quota: false },
    ] } })
    if (url.endsWith('/api/token/5/key')) return json({ success: true, data: { key: KEY } })
    return json({ success: false, message: 'unexpected' }, 404)
  })

  const result = await loginYxGateway(fetchImpl, { origin: `${ORIGIN}/`, username: ' yx ', password: 'pw' })

  expect(result).toEqual({
    username: 'yx',
    models: ['deepseek-chat', 'gpt-4o'],
    apiKey: `sk-${KEY}`,
    baseURL: `${ORIGIN}/v1`,
  })
  expect(JSON.stringify(result)).not.toContain('session-secret')
  expect(calls.some(call => call.init?.method === 'POST' && new URL(call.url).pathname === '/api/token/')).toBe(false)
  const modelsCall = calls.find(call => call.url.endsWith('/api/user/models'))
  expect(new Headers(modelsCall?.init?.headers).get('authorization')).toBe('Bearer session-secret')
  const login = calls.find(call => call.url.endsWith('/api/user/login'))
  expect(login?.init?.body).toBe(JSON.stringify({ username: 'yx', password: 'pw' }))
  expect(login?.url).not.toContain('pw')
})

it('still signs in when no token is enabled with quota, without creating one', async () => {
  const { calls, fetchImpl } = gateway(url => {
    if (url.endsWith('/encryption-key')) return json({ success: true, data: { enabled: false } })
    if (url.endsWith('/api/user/login')) return json({ success: true, data: { access_token: 'session' } })
    if (url.includes('/api/token/?')) return json({ success: true, data: { total: 2, items: [
      { id: 3, status: 3, expired_time: -1, remain_quota: 10, unlimited_quota: false },
      { id: 2, status: 1, expired_time: -1, remain_quota: 0, unlimited_quota: false },
    ] } })
    return json({ success: false, message: url })
  })

  const result = await loginYxGateway(fetchImpl, { origin: ORIGIN, username: 'yx', password: 'pw' })
  expect(result).toEqual({ username: 'yx', models: [], apiKey: null, baseURL: `${ORIGIN}/v1` })
  expect(calls.some(call => call.url.includes('/api/user/models'))).toBe(false)
  expect(calls.some(call => call.url.includes('/key'))).toBe(false)
  expect(calls.some(call => call.init?.method === 'POST' && new URL(call.url).pathname === '/api/token/')).toBe(false)
})

it('stops when the gateway asks for another verification step', async () => {
  const { fetchImpl } = gateway(url => {
    if (url.endsWith('/encryption-key')) return json({ success: true, data: { enabled: false } })
    return json({ success: true, data: { require_verification: true, flow_token: 'flow' } })
  })
  await expect(loginYxGateway(fetchImpl, { origin: ORIGIN, username: 'yx', password: 'pw' }))
    .rejects.toThrow('额外验证')
})

it('does not send a plaintext password when the gateway requires encryption', async () => {
  const { calls, fetchImpl } = gateway(() => json({ success: true, data: { enabled: true, kid: 'k', public_key: 'pem' } }))
  await expect(loginYxGateway(fetchImpl, { origin: ORIGIN, username: 'yx', password: 'pw' }))
    .rejects.toThrow('加密密码')
  expect(calls).toHaveLength(1)
})

it('hides a gateway error that echoes the password', async () => {
  const { fetchImpl } = gateway(url => url.endsWith('/encryption-key')
    ? json({ success: true, data: { enabled: false } })
    : json({ success: false, message: 'bad pw' }))
  await expect(loginYxGateway(fetchImpl, { origin: ORIGIN, username: 'yx', password: 'pw' }))
    .rejects.toThrow('拒绝了这次请求')
})

it('keeps the first two gateway models when the account has no DeepSeek model', () => {
  expect(defaultYxModelIds(['anthropic/claude-fable-5', 'anthropic/claude-opus-4.8', 'extra'])).toEqual([
    'anthropic/claude-fable-5',
    'anthropic/claude-opus-4.8',
  ])
})

it('prefers the newest DeepSeek models for the first login', () => {
  expect(defaultYxModelIds([
    'anthropic/claude-opus-4.8',
    'deepseek-chat',
    'deepseek-v3',
    'DeepSeek-V3.2',
    'deepseek-v4',
    'deepseek-reasoner',
  ])).toEqual(['deepseek-v4', 'DeepSeek-V3.2'])
})

it('writes two default models and stores the key outside settings', async () => {
  const mutations: unknown[] = []
  const credentials: [string, string][] = []
  let reads = 0
  const remote: YxSettingsRemote = {
    settings: {
      async describe(): Promise<RemoteResult<SettingsDescribeValue>> {
        reads += 1
        return { ok: true, value: { writable: true, hasDocument: true, namespaces: [{
          autoGenerate: false, ns: YX_PROVIDER_NAMESPACE, schema: null, value: {}, applies: 'live', secrets: [], revision: reads === 1 ? 3 : 4,
        }] } }
      },
      async mutate(_ns, ops, expectedRevision): Promise<RemoteResult<SettingsNamespaceView>> {
        mutations.push({ ops, expectedRevision })
        if (expectedRevision === 3) {
          return { ok: false, error: { code: 'settings/conflict', message: 'stale' } } as unknown as RemoteResult<SettingsNamespaceView>
        }
        return { ok: true, value: {
          autoGenerate: false, ns: YX_PROVIDER_NAMESPACE, schema: null, value: {}, applies: 'live', secrets: [], revision: 4,
        } }
      },
    },
    credentials: {
      async set(ref, value): Promise<RemoteResult<void>> {
        credentials.push([ref, value])
        return { ok: true, value: undefined }
      },
      async unset(): Promise<RemoteResult<void>> {
        return { ok: true, value: undefined }
      },
    },
  }
  await saveYxProvider(remote, {
    username: 'yx',
    models: ['gpt-4o', 'other', 'third'],
    apiKey: `sk-${KEY}`,
    baseURL: `${ORIGIN}/v1`,
  })
  expect(mutations).toHaveLength(2)
  expect(mutations[1]).toMatchObject({
    expectedRevision: 4,
    ops: [{ op: 'set', path: ['providers', YX_PROVIDER_ROUTE], value: {
      displayName: 'YX', accountName: 'yx', apiKeyEnv: YX_API_KEY_REF, api: 'openai-responses', baseURL: `${ORIGIN}/v1`,
      reasoning: 'high',
      models: [{ id: 'gpt-4o', name: 'gpt-4o' }, { id: 'other', name: 'other' }],
    } }],
  })
  expect(credentials).toEqual([[YX_API_KEY_REF, `sk-${KEY}`]])
  expect(JSON.stringify(mutations)).not.toContain(KEY)
})

it('points a new chat at the company gateway instead of the official DeepSeek route', async () => {
  const mutations: { ns: string; ops: unknown }[] = []
  const remote: YxSettingsRemote = {
    settings: {
      async describe(): Promise<RemoteResult<SettingsDescribeValue>> {
        return { ok: true, value: { writable: true, hasDocument: true, namespaces: [
          {
            autoGenerate: false, ns: YX_PROVIDER_NAMESPACE, schema: null, value: {}, applies: 'live', secrets: [], revision: 1,
          },
          {
            autoGenerate: false, ns: 'agent-default-model', schema: null, applies: 'live', secrets: [], revision: 2,
            value: { provider: 'deepseek-official', model: 'deepseek-flash' },
          },
        ] } }
      },
      async mutate(ns, ops): Promise<RemoteResult<SettingsNamespaceView>> {
        mutations.push({ ns, ops })
        return { ok: true, value: {
          autoGenerate: false, ns, schema: null, value: {}, applies: 'live', secrets: [], revision: 3,
        } }
      },
    },
    credentials: {
      async set(): Promise<RemoteResult<void>> { return { ok: true, value: undefined } },
      async unset(): Promise<RemoteResult<void>> { return { ok: true, value: undefined } },
    },
  }
  await saveYxProvider(remote, {
    username: 'yxadmin', models: ['deepseek/deepseek-v4.1-flash', 'gpt-4o'], apiKey: `sk-${KEY}`, baseURL: `${ORIGIN}/v1`,
  })
  expect(mutations.map(item => item.ns)).toEqual([YX_PROVIDER_NAMESPACE, 'agent-default-model'])
  expect(mutations[0]?.ops).toMatchObject([{ op: 'set', path: ['providers', YX_PROVIDER_ROUTE], value: {
    api: 'openai-responses',
    reasoning: 'high',
    models: [
      {
        id: 'deepseek/deepseek-v4.1-flash',
        reasoningEfforts: { off: null, low: 'low', high: 'high', max: 'max' },
      },
      { id: 'gpt-4o', name: 'gpt-4o' },
    ],
  } }])
  expect(mutations[1]?.ops).toEqual([
    { op: 'set', path: ['provider'], value: 'yx-gateway' },
    { op: 'set', path: ['model'], value: 'deepseek/deepseek-v4.1-flash' },
    { op: 'unset', path: ['reasoningEffort'] },
  ])
})

it('moves a saved gateway onto the responses API and keeps a custom reasoning list', async () => {
  const custom = { off: null, high: 'high' }
  let written: unknown
  const remote: YxSettingsRemote = {
    settings: {
      async describe(): Promise<RemoteResult<SettingsDescribeValue>> {
        return { ok: true, value: { writable: true, hasDocument: true, namespaces: [{
          autoGenerate: false, ns: YX_PROVIDER_NAMESPACE, schema: null, value: {}, applies: 'live', secrets: [], revision: 5,
          user: { providers: { [YX_PROVIDER_ROUTE]: {
            accountName: 'yxadmin',
            baseURL: `${ORIGIN}/v1`,
            api: 'openai-completions',
            models: [
              { id: 'deepseek/deepseek-v4.1-flash', name: 'flash' },
              { id: 'deepseek/custom', name: 'custom', reasoningEfforts: custom },
              { id: 'gpt-4o', name: 'gpt-4o' },
            ],
          } } },
        }] } }
      },
      async mutate(_ns, ops): Promise<RemoteResult<SettingsNamespaceView>> {
        written = ops
        return { ok: true, value: {
          autoGenerate: false, ns: YX_PROVIDER_NAMESPACE, schema: null, value: {}, applies: 'live', secrets: [], revision: 6,
        } }
      },
    },
    credentials: {
      async set(): Promise<RemoteResult<void>> { return { ok: true, value: undefined } },
      async unset(): Promise<RemoteResult<void>> { return { ok: true, value: undefined } },
    },
  }
  await ensureYxResponsesProtocol(remote)
  expect(written).toMatchObject([{ op: 'set', path: ['providers', YX_PROVIDER_ROUTE], value: {
    api: 'openai-responses',
    reasoning: 'high',
    models: [
      { id: 'deepseek/deepseek-v4.1-flash', reasoningEfforts: { off: null, low: 'low', high: 'high', max: 'max' } },
      { id: 'deepseek/custom', reasoningEfforts: custom },
      { id: 'gpt-4o', name: 'gpt-4o' },
    ],
  } }])
})

it('leaves a chat that already uses the company gateway on the model the user picked', async () => {
  const remote: YxSettingsRemote = {
    settings: {
      async describe(): Promise<RemoteResult<SettingsDescribeValue>> {
        return { ok: true, value: { writable: true, hasDocument: true, namespaces: [{
          autoGenerate: false, ns: 'agent-default-model', schema: null, applies: 'live', secrets: [], revision: 4,
          value: { provider: 'yx-gateway', model: 'kept-model' },
        }] } }
      },
      async mutate(): Promise<RemoteResult<SettingsNamespaceView>> {
        throw new Error('an existing gateway model must stay selected')
      },
    },
    credentials: {
      async set(): Promise<RemoteResult<void>> { return { ok: true, value: undefined } },
      async unset(): Promise<RemoteResult<void>> { return { ok: true, value: undefined } },
    },
  }
  await expect(ensureYxDefaultModel(remote, 'deepseek/deepseek-v4.1-flash')).resolves.toBeUndefined()
})

it('switches a blank chat and an official DeepSeek chat, and leaves other providers alone', () => {
  expect(sessionShouldUseYxGateway(undefined, true)).toBe(true)
  expect(sessionShouldUseYxGateway(undefined, false)).toBe(false)
  expect(sessionShouldUseYxGateway('deepseek-official', false)).toBe(true)
  expect(sessionShouldUseYxGateway('deepseek-account', false)).toBe(true)
  expect(sessionShouldUseYxGateway('yx-gateway', true)).toBe(false)
  expect(sessionShouldUseYxGateway('openai', false)).toBe(false)
  expect(readYxChatSessions({
    ids: ['blank', 'official', 'child'],
    byId: {
      blank: { blank: true, running: false },
      official: { blank: false, running: false, projectionValues: { modelSelection: { next: { provider: 'deepseek-official' } } } },
      child: { blank: false, running: false, parentId: 'official', origin: 'subagent' },
    },
  }).map(session => session.id)).toEqual(['blank', 'official'])
})

it('selects the saved gateway model for a chat that is still on the official route', async () => {
  const selected: unknown[] = []
  await adoptYxChatModel({
    settings: {
      async describe(): Promise<RemoteResult<SettingsDescribeValue>> {
        return { ok: true, value: { writable: true, hasDocument: true, namespaces: [
          {
            autoGenerate: false, ns: YX_PROVIDER_NAMESPACE, schema: null, applies: 'live', secrets: [], revision: 1,
            value: {}, user: { providers: { 'yx-gateway': { models: [{ id: 'deepseek/deepseek-v4.1-flash', name: 'flash' }] } } },
          },
          {
            autoGenerate: false, ns: 'agent-default-model', schema: null, applies: 'live', secrets: [], revision: 2,
            value: { provider: 'deepseek-official', model: 'deepseek-flash' },
          },
        ] } }
      },
      async mutate(): Promise<RemoteResult<SettingsNamespaceView>> {
        return { ok: true, value: {
          autoGenerate: false, ns: 'agent-default-model', schema: null, value: {}, applies: 'live', secrets: [], revision: 3,
        } }
      },
    },
    credentials: {
      async set(): Promise<RemoteResult<void>> { return { ok: true, value: undefined } },
      async unset(): Promise<RemoteResult<void>> { return { ok: true, value: undefined } },
    },
    session: {
      async selectModel(request) {
        selected.push(request)
        return { ok: true as const, value: undefined }
      },
    },
  }, [
    { id: 'session-1', blank: false, running: false, provider: 'deepseek-official' },
    { id: 'session-2', blank: false, running: true, provider: 'deepseek-official' },
  ])
  expect(selected).toEqual([{ sessionId: 'session-1', provider: 'yx-gateway', model: 'deepseek/deepseek-v4.1-flash' }])
})

it('leaves models added in settings alone on the next login', async () => {
  const existing = [{ id: 'kept-a', name: 'A' }, { id: 'kept-b', name: 'B' }, { id: 'kept-c', name: 'C' }]
  const remote: YxSettingsRemote = {
    settings: {
      async describe(): Promise<RemoteResult<SettingsDescribeValue>> {
        return { ok: true, value: { writable: true, hasDocument: true, namespaces: [{
          autoGenerate: false, ns: YX_PROVIDER_NAMESPACE, schema: null, value: {}, applies: 'live', secrets: [], revision: 8,
          user: { providers: { [YX_PROVIDER_ROUTE]: { models: existing } } },
        }] } }
      },
      async mutate(_ns, ops): Promise<RemoteResult<SettingsNamespaceView>> {
        expect(ops).toEqual([{ op: 'set', path: ['providers', YX_PROVIDER_ROUTE], value: {
          displayName: 'YX', accountName: 'yx', apiKeyEnv: YX_API_KEY_REF, api: 'openai-responses', baseURL: `${ORIGIN}/v1`,
          reasoning: 'high',
          models: existing,
        } }])
        return { ok: true, value: {
          autoGenerate: false, ns: YX_PROVIDER_NAMESPACE, schema: null, value: {}, applies: 'live', secrets: [], revision: 9,
        } }
      },
    },
    credentials: {
      async set(): Promise<RemoteResult<void>> { return { ok: true, value: undefined } },
      async unset(): Promise<RemoteResult<void>> { return { ok: true, value: undefined } },
    },
  }
  await expect(saveYxProvider(remote, {
    username: 'yx', models: ['brand-new'], apiKey: `sk-${KEY}`, baseURL: `${ORIGIN}/v1`,
  })).resolves.toEqual({ keptModels: true, modelCount: 3 })
})

it('removes the saved key when login finds no usable token', async () => {
  const calls: string[] = []
  const remote: YxSettingsRemote = {
    settings: {
      async describe(): Promise<RemoteResult<SettingsDescribeValue>> {
        throw new Error('settings should stay untouched')
      },
      async mutate(): Promise<RemoteResult<SettingsNamespaceView>> {
        throw new Error('settings should stay untouched')
      },
    },
    credentials: {
      async set(): Promise<RemoteResult<void>> {
        throw new Error('should not store a key')
      },
      async unset(ref): Promise<RemoteResult<void>> {
        calls.push(ref)
        return { ok: true, value: undefined }
      },
    },
  }
  await expect(applyYxLogin(remote, {
    username: 'yx', models: [], apiKey: null, baseURL: `${ORIGIN}/v1`,
  })).resolves.toBeNull()
  expect(calls).toEqual([YX_API_KEY_REF])
})

it('remembers the account name after login and clears it when the key is gone', async () => {
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) },
  })
  const remote: YxSettingsRemote = {
    settings: {
      async describe(): Promise<RemoteResult<SettingsDescribeValue>> {
        return { ok: true, value: { writable: true, hasDocument: true, namespaces: [{
          autoGenerate: false, ns: YX_PROVIDER_NAMESPACE, schema: null, value: {}, applies: 'live', secrets: [], revision: 1,
          user: { providers: { [YX_PROVIDER_ROUTE]: { models: [{ id: 'kept', name: 'kept' }] } } },
        }] } }
      },
      async mutate(): Promise<RemoteResult<SettingsNamespaceView>> {
        return { ok: true, value: {
          autoGenerate: false, ns: YX_PROVIDER_NAMESPACE, schema: null, value: {}, applies: 'live', secrets: [], revision: 2,
        } }
      },
    },
    credentials: {
      async set(): Promise<RemoteResult<void>> { return { ok: true, value: undefined } },
      async unset(): Promise<RemoteResult<void>> { return { ok: true, value: undefined } },
      async describe() {
        return { ok: true as const, value: { [YX_API_KEY_REF]: { configured: true } } }
      },
    },
  }
  await applyYxLogin(remote, {
    username: 'yxadmin', models: ['deepseek-v4'], apiKey: `sk-${KEY}`, baseURL: `${ORIGIN}/v1`,
  })
  expect(rememberedYxAccount()).toBe('yxadmin')
  await expect(confirmYxAccount(remote)).resolves.toBe('yxadmin')
  remote.credentials.describe = async () => ({ ok: true, value: { [YX_API_KEY_REF]: { configured: false } } })
  await expect(confirmYxAccount(remote)).resolves.toBeNull()
  expect(rememberedYxAccount()).toBeNull()
  vi.unstubAllGlobals()
})

it('keeps a login that finishes while the sidebar is still checking the key', async () => {
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) },
  })
  let release: (value: RemoteResult<Readonly<Record<string, { readonly configured?: boolean }>>>) => void = () => {}
  const described = new Promise<RemoteResult<Readonly<Record<string, { readonly configured?: boolean }>>>>(resolve => { release = resolve })
  const remote: YxSettingsRemote = {
    settings: {
      async describe(): Promise<RemoteResult<SettingsDescribeValue>> {
        return { ok: true, value: { writable: true, hasDocument: true, namespaces: [{
          autoGenerate: false, ns: YX_PROVIDER_NAMESPACE, schema: null, value: {}, applies: 'live', secrets: [], revision: 2,
          user: { providers: { [YX_PROVIDER_ROUTE]: { accountName: 'yxadmin', models: [{ id: 'kept', name: 'kept' }] } } },
        }] } }
      },
      async mutate(): Promise<RemoteResult<SettingsNamespaceView>> { throw new Error('unused') },
    },
    credentials: {
      async set(): Promise<RemoteResult<void>> { return { ok: true, value: undefined } },
      async unset(): Promise<RemoteResult<void>> { return { ok: true, value: undefined } },
      describe: () => described,
    },
  }
  const pending = confirmYxAccount(remote)
  rememberYxAccount('yxadmin')
  release({ ok: true, value: { [YX_API_KEY_REF]: { configured: false } } })
  await expect(pending).resolves.toBe('yxadmin')
  expect(rememberedYxAccount()).toBe('yxadmin')
  vi.unstubAllGlobals()
})

it('does not restore an account signed out while the key check is still running', async () => {
  const values = new Map<string, string>([['dsh.yx.account', 'yxadmin']])
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) },
  })
  let release: (value: RemoteResult<Readonly<Record<string, { readonly configured?: boolean }>>>) => void = () => {}
  const described = new Promise<RemoteResult<Readonly<Record<string, { readonly configured?: boolean }>>>>(resolve => { release = resolve })
  const remote: YxSettingsRemote = {
    settings: {
      async describe(): Promise<RemoteResult<SettingsDescribeValue>> {
        return { ok: true, value: { writable: true, hasDocument: true, namespaces: [{
          autoGenerate: false, ns: YX_PROVIDER_NAMESPACE, schema: null, value: {}, applies: 'live', secrets: [], revision: 2,
          user: { providers: { [YX_PROVIDER_ROUTE]: { accountName: 'yxadmin', models: [{ id: 'kept', name: 'kept' }] } } },
        }] } }
      },
      async mutate(): Promise<RemoteResult<SettingsNamespaceView>> { throw new Error('unused') },
    },
    credentials: {
      async set(): Promise<RemoteResult<void>> { return { ok: true, value: undefined } },
      async unset(): Promise<RemoteResult<void>> { return { ok: true, value: undefined } },
      describe: () => described,
    },
  }
  const pending = confirmYxAccount(remote)
  forgetYxAccount()
  release({ ok: true, value: { [YX_API_KEY_REF]: { configured: true } } })
  await expect(pending).resolves.toBeNull()
  expect(rememberedYxAccount()).toBeNull()
  vi.unstubAllGlobals()
})

it('tells an open sidebar when the account is stored or cleared', () => {
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) },
  })
  const seen: Array<string | null> = []
  const stop = subscribeYxAccount(name => { seen.push(name) })
  try {
    rememberYxAccount('yxadmin')
    forgetYxAccount()
  } finally {
    stop()
  }
  rememberYxAccount('later')
  expect(seen).toEqual(['yxadmin', null])
  vi.unstubAllGlobals()
})

it('shows the account name saved with the provider when this window has not remembered it', async () => {
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) },
  })
  const remote: YxSettingsRemote = {
    settings: {
      async describe(): Promise<RemoteResult<SettingsDescribeValue>> {
        return { ok: true, value: { writable: true, hasDocument: true, namespaces: [{
          autoGenerate: false, ns: YX_PROVIDER_NAMESPACE, schema: null, value: {}, applies: 'live', secrets: [], revision: 2,
          user: { providers: { [YX_PROVIDER_ROUTE]: { accountName: 'yxadmin', models: [{ id: 'kept', name: 'kept' }] } } },
        }] } }
      },
      async mutate(): Promise<RemoteResult<SettingsNamespaceView>> {
        throw new Error('unused')
      },
    },
    credentials: {
      async set(): Promise<RemoteResult<void>> { return { ok: true, value: undefined } },
      async unset(): Promise<RemoteResult<void>> { return { ok: true, value: undefined } },
      async describe() {
        return { ok: true as const, value: { [YX_API_KEY_REF]: { configured: true } } }
      },
    },
  }
  await expect(confirmYxAccount(remote)).resolves.toBe('yxadmin')
  expect(rememberedYxAccount()).toBe('yxadmin')
  vi.unstubAllGlobals()
})
