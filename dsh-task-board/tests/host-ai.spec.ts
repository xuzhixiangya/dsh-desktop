import { describe, expect, it, vi } from 'vitest'
import type { GenerateOptions, LlmRuntime, StreamChunk } from '@deepseek-ai/dsh-llm'
import {
  draftFromReply,
  extractTaskParseReply,
  parseTaskDraft,
  splitModelRoute,
  TaskParseError,
} from '../src/host-ai.ts'

/**
 * An llm service in the shape the board dispatches through.
 *
 * Production reaches the adapter via the registration-bound
 * `prepareCall(config).stream(request)` handle (see src/host/llm-dispatch.ts),
 * so the double offers that pair and records the merged request in `calls`. A
 * double that only stubbed the public `stream` would hide a regression onto
 * the mutable public method.
 */
function fakeLlm(chunks: readonly string[], calls: GenerateOptions[] = []): LlmRuntime {
  const text = (): AsyncIterable<StreamChunk> => (async function * () {
    for (const piece of chunks) yield { type: 'text-delta', index: 0, text: piece }
  })()
  return {
    prepareCall: async (config: GenerateOptions) => ({
      config,
      stream: (request: GenerateOptions) => {
        // What the adapter would see: the resolved config with the assembled
        // request layered over it.
        calls.push({ ...config, ...request })
        return text()
      },
    }),
  } as unknown as LlmRuntime
}

/** An llm service that only settles when the caller aborts. */
function stallingLlm(): LlmRuntime {
  return {
    prepareCall: async (config: GenerateOptions) => ({
      config,
      stream: (request: GenerateOptions): AsyncIterable<StreamChunk> => (async function * () {
        await new Promise((_resolve, reject) => {
          request.signal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
        })
        yield { type: 'text-delta', index: 0, text: 'never' }
      })(),
    }),
  } as unknown as LlmRuntime
}

describe('task parse route model routing', () => {
  it('splits the qualified route the model picker produces', () => {
    expect(splitModelRoute('deepseek/deepseek-chat')).toEqual({ provider: 'deepseek', model: 'deepseek-chat' })
    // The model id itself may contain slashes; only the first one splits.
    expect(splitModelRoute('vendor/family/model')).toEqual({ provider: 'vendor', model: 'family/model' })
  })

  it('rejects routes that cannot identify a provider', () => {
    expect(splitModelRoute(undefined)).toBeUndefined()
    expect(splitModelRoute('   ')).toBeUndefined()
    expect(splitModelRoute('deepseek-chat')).toBeUndefined()
    expect(splitModelRoute('/deepseek-chat')).toBeUndefined()
    expect(splitModelRoute('deepseek/')).toBeUndefined()
  })
})

describe('task parse reply extraction', () => {
  it('reads a JSON object out of fences and surrounding prose', () => {
    const reply = 'Sure!\n```json\n{"title":"Buy milk","description":"Two litres","prompt":"Go to the shop"}\n```\nHope that helps.'
    expect(extractTaskParseReply(reply)).toEqual({ title: 'Buy milk', description: 'Two litres', prompt: 'Go to the shop' })
  })

  it('returns undefined for replies without a usable object', () => {
    expect(extractTaskParseReply('I cannot help with that')).toBeUndefined()
    expect(extractTaskParseReply('{not json}')).toBeUndefined()
    expect(extractTaskParseReply('{"title":"","description":"","prompt":""}')).toBeUndefined()
  })

  it('falls back to the pasted text instead of losing it', () => {
    const source = '会议纪要：下周三前把报价发给张工\n附件在他的邮件里'
    const draft = draftFromReply('sorry, I cannot parse that', source)
    expect(draft.title).toBe('会议纪要：下周三前把报价发给张工')
    expect(draft.prompt).toBe(source)
    expect(draft.description).toBe('')
  })

  it('keeps a model title and prompt when it supplies them', () => {
    const draft = draftFromReply('{"title":"Send the quote","prompt":"Email the quote to Zhang"}', 'raw text')
    expect(draft.title).toBe('Send the quote')
    expect(draft.prompt).toBe('Email the quote to Zhang')
  })
})

describe('task parse through the llm service', () => {
  it('sends one user message on the selected route and returns the draft', async () => {
    const calls: GenerateOptions[] = []
    const llm = fakeLlm(['{"title":"Ship the release","description":"Cut 0.3.22","prompt":"Tag and publish"}'], calls)
    const draft = await parseTaskDraft(llm, { text: 'ship the release', model: 'deepseek/deepseek-chat' })
    expect(draft).toEqual({ title: 'Ship the release', description: 'Cut 0.3.22', prompt: 'Tag and publish' })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.provider).toBe('deepseek')
    expect(calls[0]!.model).toBe('deepseek-chat')
    expect(calls[0]!.system).toContain('JSON')
    expect(calls[0]!.messages).toHaveLength(1)
    expect(calls[0]!.messages[0]!.content).toEqual([{ type: 'text', text: 'ship the release' }])
  })

  it('user pasting text still gets a draft when a provider plugin replaced the public llm stream', async () => {
    // Given: a provider plugin that replaced the public single-argument
    // stream() with its llm/stream listener signature (the shape that raised
    // "next(...) is not a function or its return value is not async iterable").
    const calls: GenerateOptions[] = []
    const runtime = fakeLlm(['{"title":"Ship it","description":"","prompt":"ship"}'], calls) as unknown as {
      stream: () => never
    }
    runtime.stream = () => { throw new TypeError('next(...) is not a function or its return value is not async iterable') }
    // When: the paste is parsed against that runtime
    const draft = await parseTaskDraft(runtime as unknown as LlmRuntime, { text: 'ship it', model: 'deepseek/deepseek-chat' })
    // Then: the parse still succeeds and the request went to the prepared path.
    expect(draft.title).toBe('Ship it')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.provider).toBe('deepseek')
  })

  it('user on a runtime that exposes no prepareCall still gets a draft from the public stream', async () => {
    // Given: a runtime that only offers the historical public stream(options)
    const calls: GenerateOptions[] = []
    const llm = {
      stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        calls.push(options)
        return (async function * () {
          yield { type: 'text-delta', index: 0, text: '{"title":"Old","description":"","prompt":"old"}' }
        })()
      },
    } as unknown as LlmRuntime
    // When: the paste is parsed
    const draft = await parseTaskDraft(llm, { text: 'old note', model: 'deepseek/deepseek-chat' })
    // Then: an older or proxied service keeps working.
    expect(draft.title).toBe('Old')
    expect(calls).toHaveLength(1)
  })

  it('fails with no-model when no route was selected', async () => {
    await expect(parseTaskDraft(fakeLlm([]), { text: 'hello' })).rejects.toMatchObject({ code: 'no-model' })
  })

  it('reports an adapter failure as a model error', async () => {
    const llm = { prepareCall: async () => { throw new Error('NO_ADAPTER') } } as unknown as LlmRuntime
    const failure = await parseTaskDraft(llm, { text: 'hello', model: 'p/m' }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(TaskParseError)
    expect((failure as TaskParseError).code).toBe('model-error')
    expect((failure as TaskParseError).message).toContain('NO_ADAPTER')
  })

  it('gives up on a model that never answers', async () => {
    vi.useFakeTimers()
    try {
      const pending = parseTaskDraft(stallingLlm(), { text: 'hello', model: 'p/m' })
      const rejected = expect(pending).rejects.toMatchObject({ code: 'timeout' })
      await vi.advanceTimersByTimeAsync(45_000)
      await rejected
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuses to parse an empty paste', async () => {
    await expect(parseTaskDraft(fakeLlm(['{}']), { text: '   ', model: 'p/m' })).rejects.toMatchObject({ code: 'parse-failed' })
  })
})
