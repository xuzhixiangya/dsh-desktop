/**
 * Write the gateway session into the existing OpenAI-compatible provider.
 * The API key is a credential reference; the settings document never stores it.
 */

import type {} from '@deepseek-ai/dsh-api-settings-controller/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { SettingsDescribeValue, SettingsNamespaceView, SettingsPathOpView } from '@deepseek-ai/dsh-settings/types'
import {
  YX_API_KEY_REF,
  YX_PROVIDER_NAMESPACE,
  YX_PROVIDER_ROUTE,
  YxGatewayError,
  assertYxApiKey,
  yxGatewayBaseURL,
  type YxLoginResult,
  type YxLoginSuccess,
} from '../yx-gateway.ts'

/** How many models a first login places in the provider, matching the Models page habit of starting small. */
const YX_DEFAULT_MODEL_COUNT = 2
const YX_ACCOUNT_STORAGE_KEY = 'dsh.yx.account'
/** Profile entry that chooses the model for a new chat. */
const YX_DEFAULT_MODEL_ENTRY = 'agent-default-model'
/** Responses API. This is what lets a model offer a reasoning-effort control. */
const YX_PROVIDER_API = 'openai-responses'
/** Default effort shown in the composer. The model can still be switched. */
const YX_DEFAULT_REASONING = 'high'
/**
 * Levels the composer offers for a DeepSeek model on the responses API.
 * `off` is empty so the request simply omits the effort.
 */
const YX_DEEPSEEK_REASONING: JsonValue = Object.freeze({
  off: null,
  low: 'low',
  high: 'high',
  max: 'max',
})
/** Built-in routes that ask for a DeepSeek key this desktop does not store. */
const OFFICIAL_DEEPSEEK_ROUTES = new Set(['deepseek-official', 'deepseek-account'])

export interface YxProviderSave {
  /** True when this login left a model list the user had already saved. */
  readonly keptModels: boolean
  readonly modelCount: number
}

export interface YxSettingsRemote {
  readonly settings: {
    describe(): Promise<RemoteResult<SettingsDescribeValue>>
    mutate(ns: string, ops: SettingsPathOpView[], expectedRevision: number | undefined): Promise<RemoteResult<SettingsNamespaceView>>
  }
  readonly credentials: {
    set(ref: string, value: string): Promise<RemoteResult<void>>
    unset(ref: string): Promise<RemoteResult<void>>
    describe?(refs: readonly string[]): Promise<RemoteResult<Readonly<Record<string, { readonly configured?: boolean }>>>>
  }
}

/** Store a usable key, or remove the saved one when the account has none. */
export async function applyYxLogin(
  remote: YxSettingsRemote,
  result: YxLoginResult,
): Promise<YxProviderSave | null> {
  if (result.apiKey === null) {
    await clearYxApiKey(remote)
    return null
  }
  const saved = await saveYxProvider(remote, result)
  rememberYxAccount(result.username)
  return saved
}

export async function clearYxApiKey(remote: YxSettingsRemote): Promise<void> {
  const cleared = await remote.credentials.unset(YX_API_KEY_REF)
  if (!cleared.ok) throw new YxGatewayError(cleared.error.message)
  forgetYxAccount()
}

let accountEpoch = 0
const accountListeners = new Set<(name: string | null) => void>()

/**
 * Username shown in the sidebar. Null when this profile has no saved gateway key.
 * A login or sign-out that lands while this check is waiting wins: the first
 * install leaves the sidebar mounted before onboarding finishes, and a late
 * "no key" answer must not wipe the account that login just stored.
 */
export async function confirmYxAccount(remote: YxSettingsRemote): Promise<string | null> {
  const epoch = accountEpoch
  const describe = remote.credentials.describe
  if (describe !== undefined) {
    const described = await describe([YX_API_KEY_REF])
    if (accountEpoch !== epoch) return rememberedYxAccount()
    if (!described.ok) {
      const remembered = rememberedYxAccount()
      if (remembered !== null) return remembered
      const stored = await accountNameFromSettings(remote)
      if (accountEpoch !== epoch) return rememberedYxAccount()
      return stored
    }
    if (described.value[YX_API_KEY_REF]?.configured !== true) {
      forgetYxAccount()
      return null
    }
  }
  if (accountEpoch !== epoch) return rememberedYxAccount()
  const remembered = rememberedYxAccount()
  if (remembered !== null) return remembered
  const stored = await accountNameFromSettings(remote)
  if (accountEpoch !== epoch) return rememberedYxAccount()
  if (stored !== null) rememberYxAccount(stored)
  return stored
}

export function rememberedYxAccount(): string | null {
  const storage = accountStorage()
  if (storage === undefined) return null
  const value = storage.getItem(YX_ACCOUNT_STORAGE_KEY)
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

/** Changes when a login or sign-out replaces the sidebar account. */
export function yxAccountEpoch(): number {
  return accountEpoch
}

/** Hear the account the moment login or sign-out stores it, including from onboarding. */
export function subscribeYxAccount(listener: (name: string | null) => void): () => void {
  accountListeners.add(listener)
  return () => { accountListeners.delete(listener) }
}

function publishAccount(name: string | null): void {
  accountEpoch += 1
  for (const listener of [...accountListeners]) listener(name)
}

export function rememberYxAccount(username: string): void {
  const name = username.trim()
  if (name.length === 0) return
  accountStorage()?.setItem(YX_ACCOUNT_STORAGE_KEY, name)
  publishAccount(name)
}

export function forgetYxAccount(): void {
  accountStorage()?.removeItem(YX_ACCOUNT_STORAGE_KEY)
  publishAccount(null)
}

function accountStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | undefined {
  const storage = (globalThis as { localStorage?: Storage }).localStorage
  if (storage === undefined || typeof storage.getItem !== 'function') return undefined
  return storage
}

/**
 * First login keeps two models. DeepSeek models come first, newest version
 * first. A later login keeps whatever the Models page already saved.
 * @param available - model ids the gateway just returned for this account.
 * @returns at most {@link YX_DEFAULT_MODEL_COUNT} ids.
 */
export function defaultYxModelIds(available: readonly string[]): readonly string[] {
  const seen = new Set<string>()
  const accepted: string[] = []
  for (const model of available) {
    const id = model.trim()
    if (id.length === 0 || id.length > 200 || /[\u0000-\u001f\u007f]/u.test(id) || seen.has(id)) continue
    seen.add(id)
    accepted.push(id)
  }
  if (accepted.length === 0) throw new YxGatewayError('这个账号下没有可用模型')
  const deepseek = accepted.filter(id => /deepseek/iu.test(id))
  deepseek.sort((left, right) => compareModelVersion(modelVersion(left), modelVersion(right)))
  const picked: string[] = []
  for (const id of [...deepseek, ...accepted]) {
    if (picked.includes(id)) continue
    picked.push(id)
    if (picked.length === YX_DEFAULT_MODEL_COUNT) break
  }
  return Object.freeze(picked)
}

/** Highest version marker in the id, such as `v4` or `3.2`. An id without one sorts last. */
function modelVersion(id: string): readonly number[] {
  const marked = /v(\d+(?:\.\d+)*)/iu.exec(id)
  const source = marked?.[1] ?? /(\d+\.\d+(?:\.\d+)*)/u.exec(id)?.[1] ?? /(\d+)/u.exec(id)?.[1]
  if (source === undefined) return []
  return source.split('.').map(part => Number(part))
}

function compareModelVersion(left: readonly number[], right: readonly number[]): number {
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const difference = (right[index] ?? 0) - (left[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

export async function saveYxProvider(
  remote: YxSettingsRemote,
  result: YxLoginSuccess,
): Promise<YxProviderSave> {
  const baseURL = acceptedBaseURL(result.baseURL)
  const apiKey = assertYxApiKey(result.apiKey)
  let saved: YxProviderSave = { keptModels: false, modelCount: 0 }
  let models: JsonValue[] = []
  let retried = false
  for (;;) {
    const described = await remote.settings.describe()
    if (!described.ok) throw new YxGatewayError(described.error.message)
    const namespace = described.value.namespaces.find(item => item.ns === YX_PROVIDER_NAMESPACE)
    if (namespace === undefined) throw new YxGatewayError('当前 Profile 还不能配置自定义模型')
    const kept = keptProviderModels(namespace.user)
    models = (kept ?? defaultYxModelIds(result.models).map(id => ({ id, name: id }))).map(upgradeYxModel)
    saved = { keptModels: kept !== undefined, modelCount: models.length }
    const profile = yxProviderDocument(models, { accountName: result.username.trim(), baseURL })
    const written = await remote.settings.mutate(YX_PROVIDER_NAMESPACE, [{
      op: 'set',
      path: ['providers', YX_PROVIDER_ROUTE],
      value: profile,
    }], namespace.revision)
    if (written.ok) break
    if (!retried && written.error.code === 'settings/conflict') {
      retried = true
      continue
    }
    throw new YxGatewayError(written.error.message)
  }
  const modelId = yxChatModelId({ providers: { [YX_PROVIDER_ROUTE]: { models } } })
  if (modelId !== null) await ensureYxDefaultModel(remote, modelId)
  const stored = await remote.credentials.set(YX_API_KEY_REF, apiKey)
  if (!stored.ok) throw new YxGatewayError(stored.error.message)
  return saved
}

/**
 * Point a new chat at the company gateway when it would otherwise call
 * DeepSeek's own route. A gateway model the user already chose stays put.
 */
export async function ensureYxDefaultModel(remote: YxSettingsRemote, modelId: string): Promise<void> {
  let retried = false
  for (;;) {
    const described = await remote.settings.describe()
    if (!described.ok) throw new YxGatewayError(described.error.message)
    const namespace = described.value.namespaces.find(item => item.ns === YX_DEFAULT_MODEL_ENTRY)
    if (namespace === undefined) return
    const provider = asRecord(namespace.value)?.provider
    if (provider === YX_PROVIDER_ROUTE) return
    if (typeof provider === 'string' && !OFFICIAL_DEEPSEEK_ROUTES.has(provider)) return
    const written = await remote.settings.mutate(YX_DEFAULT_MODEL_ENTRY, [
      { op: 'set', path: ['provider'], value: YX_PROVIDER_ROUTE },
      { op: 'set', path: ['model'], value: modelId },
      { op: 'unset', path: ['reasoningEffort'] },
    ], namespace.revision)
    if (written.ok) return
    if (!retried && written.error.code === 'settings/conflict') {
      retried = true
      continue
    }
    throw new YxGatewayError(written.error.message)
  }
}

/**
 * Move an already saved gateway onto the responses API and give its DeepSeek
 * models a reasoning control. A model whose efforts were edited stays as saved.
 */
export async function ensureYxResponsesProtocol(remote: YxSettingsRemote): Promise<void> {
  let retried = false
  for (;;) {
    const described = await remote.settings.describe()
    if (!described.ok) throw new YxGatewayError(described.error.message)
    const namespace = described.value.namespaces.find(item => item.ns === YX_PROVIDER_NAMESPACE)
    if (namespace === undefined) return
    const stored = asRecord(asRecord(namespace.user)?.providers)?.[YX_PROVIDER_ROUTE]
    const provider = asRecord(stored)
    if (provider === undefined || !responsesProtocolNeedsUpgrade(provider)) return
    const models = keptProviderModels(namespace.user)
    if (models === undefined) return
    const accountName = typeof provider.accountName === 'string' ? provider.accountName : ''
    const baseURL = typeof provider.baseURL === 'string' ? provider.baseURL : ''
    if (accountName.length === 0 || baseURL.length === 0) return
    const written = await remote.settings.mutate(YX_PROVIDER_NAMESPACE, [{
      op: 'set',
      path: ['providers', YX_PROVIDER_ROUTE],
      value: yxProviderDocument(models.map(upgradeYxModel), { accountName, baseURL }),
    }], namespace.revision)
    if (written.ok) return
    if (!retried && written.error.code === 'settings/conflict') {
      retried = true
      continue
    }
    throw new YxGatewayError(written.error.message)
  }
}

function yxProviderDocument(
  models: readonly JsonValue[],
  extras: { readonly accountName: string; readonly baseURL: string },
): JsonValue {
  return {
    displayName: 'YX',
    accountName: extras.accountName,
    apiKeyEnv: YX_API_KEY_REF,
    api: YX_PROVIDER_API,
    baseURL: extras.baseURL,
    reasoning: YX_DEFAULT_REASONING,
    models: [...models],
  }
}

function responsesProtocolNeedsUpgrade(provider: Record<string, JsonValue>): boolean {
  if (provider.api !== YX_PROVIDER_API || provider.reasoning !== YX_DEFAULT_REASONING) return true
  const models = provider.models
  if (!Array.isArray(models)) return false
  return models.some(row => {
    const record = asRecord(row)
    return record !== undefined && typeof record.id === 'string'
      && /deepseek/iu.test(record.id) && record.reasoningEfforts === undefined
  })
}

/** Add the responses reasoning control to a DeepSeek row that does not have one. */
function upgradeYxModel(row: JsonValue): JsonValue {
  const record = asRecord(row)
  if (record === undefined || typeof record.id !== 'string') return row
  if (!/deepseek/iu.test(record.id) || record.reasoningEfforts !== undefined) return record
  return { ...record, reasoningEfforts: YX_DEEPSEEK_REASONING }
}

/** First model id saved on the company provider. */
export function yxChatModelId(document: JsonValue | undefined): string | null {
  const id = asRecord(keptProviderModels(document)?.[0])?.id
  return typeof id === 'string' && id.length > 0 ? id : null
}

/**
 * A blank chat, or one still aimed at DeepSeek's own route, should use the
 * company gateway. A chat already on that gateway is left alone.
 */
export function sessionShouldUseYxGateway(provider: string | undefined, blank: boolean): boolean {
  if (provider === YX_PROVIDER_ROUTE) return false
  if (provider === undefined) return blank
  return OFFICIAL_DEEPSEEK_ROUTES.has(provider)
}

async function accountNameFromSettings(remote: YxSettingsRemote): Promise<string | null> {
  const described = await remote.settings.describe()
  if (!described.ok) return null
  const namespace = described.value.namespaces.find(item => item.ns === YX_PROVIDER_NAMESPACE)
  return yxAccountName(namespace?.user)
}

/** Account name saved beside the provider, so the sidebar can show it after a restart. */
export function yxAccountName(document: JsonValue | undefined): string | null {
  const name = asRecord(asRecord(asRecord(document)?.providers)?.[YX_PROVIDER_ROUTE])?.accountName
  return typeof name === 'string' && name.trim().length > 0 ? name.trim() : null
}

function keptProviderModels(document: JsonValue | undefined): JsonValue[] | undefined {
  const provider = asRecord(asRecord(asRecord(document)?.providers)?.[YX_PROVIDER_ROUTE])
  const models = provider?.models
  if (!Array.isArray(models)) return undefined
  const rows = models.filter((row): row is JsonValue => {
    const record = asRecord(row)
    return record !== undefined && typeof record.id === 'string' && record.id.trim().length > 0
  })
  return rows.length > 0 ? rows : undefined
}

function asRecord(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value
}

function acceptedBaseURL(value: string): string {
  let origin: string
  try {
    const url = new URL(value)
    if (url.pathname !== '/v1' || url.search !== '' || url.hash !== '' || url.username !== '' || url.password !== '') {
      throw new YxGatewayError('模型地址无效')
    }
    origin = url.origin
  } catch (cause) {
    if (cause instanceof YxGatewayError) throw cause
    throw new YxGatewayError('模型地址无效')
  }
  return yxGatewayBaseURL(origin)
}
