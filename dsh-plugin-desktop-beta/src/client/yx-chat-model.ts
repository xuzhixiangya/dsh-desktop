/**
 * Send open chats through the company gateway after login.
 * The composer otherwise keeps DeepSeek's own route, which has no company key.
 */

import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { YX_PROVIDER_ROUTE } from '../yx-gateway.ts'
import {
  ensureYxDefaultModel,
  ensureYxResponsesProtocol,
  sessionShouldUseYxGateway,
  yxChatModelId,
  type YxSettingsRemote,
} from './yx-provider.ts'

export interface YxChatSession {
  readonly id: string
  readonly blank: boolean
  readonly running: boolean
  /** Provider the next request would use, when the session has one. */
  readonly provider?: string
}

export interface YxChatModelRemote extends YxSettingsRemote {
  readonly session: {
    selectModel(request: { readonly sessionId: string; readonly provider: string; readonly model: string }): Promise<RemoteResult<unknown>>
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

/** Ordinary chats from a session-list snapshot. Subagents stay on their parent route. */
export function readYxChatSessions(snapshot: { readonly ids?: readonly string[]; readonly byId?: Readonly<Record<string, unknown>> }): YxChatSession[] {
  const sessions: YxChatSession[] = []
  for (const id of snapshot.ids ?? []) {
    const row = asRecord(snapshot.byId?.[id])
    if (row === undefined || row.origin === 'subagent' || typeof row.parentId === 'string') continue
    const next = asRecord(asRecord(asRecord(row.projectionValues)?.modelSelection)?.next)
    const provider = typeof next?.provider === 'string' ? next.provider : undefined
    sessions.push({
      id,
      blank: row.blank === true,
      running: row.running === true,
      ...(provider === undefined ? {} : { provider }),
    })
  }
  return sessions
}

/**
 * Switch the default, then any open chat that would still call DeepSeek directly.
 * @returns whether a company model was available to adopt.
 */
export async function adoptYxChatModel(remote: YxChatModelRemote, sessions: readonly YxChatSession[]): Promise<boolean> {
  const described = await remote.settings.describe()
  if (!described.ok) return false
  const providers = described.value.namespaces.find(item => item.ns === 'llm-pi-ai')
  const modelId = yxChatModelId(providers?.user) ?? yxChatModelId(providers?.value)
  if (modelId === null) return false
  await ensureYxResponsesProtocol(remote)
  await ensureYxDefaultModel(remote, modelId)
  const pending = sessions.filter(session => !session.running && sessionShouldUseYxGateway(session.provider, session.blank))
  await Promise.all(pending.map(async (session) => {
    const selected = await remote.session.selectModel({
      sessionId: session.id,
      provider: YX_PROVIDER_ROUTE,
      model: modelId,
    })
    if (!selected.ok) throw new Error(selected.error.message)
  }))
  return true
}
