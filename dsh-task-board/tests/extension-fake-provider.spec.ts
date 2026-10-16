/**
 * A fake external provider that consumes every capability of the extension
 * contract, end to end. Nothing here is provider-specific: the point is that
 * the board serves an arbitrary provider through the contract alone.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TypertGateway } from '@deepseek-ai/dsh-api-gateway'
import { TaskBoardHostService } from '../src/host-service.ts'
import {
  TASK_BOARD_API_VERSION,
  type TaskBoardExtensionHost,
  type TaskBoardExecutionSettledEvent,
  type TaskBoardStatusChangedEvent,
  type TaskBoardTaskDeletedEvent,
} from '../src/core/extension.ts'

let scratchHome: string | undefined
let previousHome: string | undefined
const roots: string[] = []

beforeEach(() => {
  previousHome = process.env.DSH_HOME
  scratchHome = mkdtempSync(join(tmpdir(), 'dsh-fake-provider-'))
  process.env.DSH_HOME = scratchHome
})

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  if (scratchHome !== undefined) rmSync(scratchHome, { recursive: true, force: true })
  scratchHome = undefined
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
})

function fakeGateway(): TypertGateway {
  return {
    invoke: async () => ({ presets: [], items: [] }),
    stream: async () => ({ async *[Symbol.asyncIterator]() {} }),
  } as unknown as TypertGateway
}

interface FakeProvider {
  face: TaskBoardExtensionHost
  statusChanges: TaskBoardStatusChangedEvent[]
  settlements: TaskBoardExecutionSettledEvent[]
  deletions: TaskBoardTaskDeletedEvent[]
  tools: string[]
}

/** Admit a provider that consumes every capability the contract offers. */
function admitFakeProvider(host: TaskBoardHostService, id = 'fake'): FakeProvider {
  let captured: TaskBoardExtensionHost | undefined
  const state: Omit<FakeProvider, 'face'> = { statusChanges: [], settlements: [], deletions: [], tools: [] }
  host.registerExtension({
    id,
    apiVersion: TASK_BOARD_API_VERSION,
    start(face) {
      captured = face
      face.events.onStatusChanged(event => { state.statusChanges.push(event) })
      face.events.onExecutionSettled(event => { state.settlements.push(event) })
      face.events.onTaskDeleted(event => { state.deletions.push(event) })
      face.publish({ provider: id, version: 1, note: 'opaque' })
      face.registerTool({ name: `${id}_tool`, description: 'fake', parameters: {}, execute: async () => ({}) } as unknown as ToolDefinition)
    },
    handleAction(request) {
      return { ok: true, extensionId: id, action: request.action, payload: request.payload }
    },
  })
  if (captured === undefined) throw new Error('provider was not started')
  return { face: captured, ...state }
}

describe('fake external provider against the task board contract', () => {
  it('operator sees a provider materialize hidden and visible cards with its own opaque payload and find them again', () => {
    // Given an admitted provider and a board that also holds a card it does not own
    const host = new TaskBoardHostService(fakeGateway())
    const provider = admitFakeProvider(host)
    host.apply('c0', { kind: 'create', id: 'plain', input: { title: 'Plain', description: '', prompt: '' } })

    // When it creates one hidden card and one visible backlog card, each with
    // its own payload
    const hidden = provider.face.tasks.create(
      { title: 'Hidden', description: 'd', prompt: 'p' },
      { payload: { marker: 'alpha', nested: { depth: 2 } }, hidden: true },
    )
    const visible = provider.face.tasks.create(
      { title: 'Visible', description: 'd', prompt: 'p', status: 'backlog' },
      { payload: { marker: 'beta' } },
    )

    // Then the payload rides the opaque container, the board keeps the hidden
    // flag, and the provider's own identity index finds exactly its cards
    expect(hidden.hidden).toBe(true)
    expect(visible.status).toBe('backlog')
    expect(visible.integrations?.fake).toEqual({ marker: 'beta' })
    expect(provider.face.tasks.get(visible.id)?.title).toBe('Visible')
    expect(provider.face.tasks.list().map(task => task.id)).toEqual(['plain', hidden.id, visible.id])
    const linked = provider.face.tasks.linked()
    expect(linked.map(entry => entry.task.id)).toEqual([hidden.id, visible.id])
    expect(linked[0]?.payload).toEqual({ marker: 'alpha', nested: { depth: 2 } })
    host.dispose()
  })

  it('operator sees a provider read, merge and clear its own payload', () => {
    // Given a card carrying an initial provider payload
    const host = new TaskBoardHostService(fakeGateway())
    const provider = admitFakeProvider(host)
    const task = provider.face.tasks.create({ title: 'T', description: '', prompt: '' }, { payload: { a: 1, keep: 'yes' } })

    // When the provider merges a new key and clears another with undefined
    provider.face.integration.write(task.id, { b: 2, keep: undefined })

    // Then the merge keeps the untouched key, drops the cleared one, and a card
    // the provider does not own reads as absent
    expect(provider.face.integration.read(task.id)).toEqual({ a: 1, b: 2 })
    host.apply('c0', { kind: 'create', id: 'plain', input: { title: 'P', description: '', prompt: '' } })
    expect(provider.face.integration.read('plain')).toBeUndefined()
    host.dispose()
  })

  it('operator sees a provider edit content before the first run and then move the card through the board gate', () => {
    // Given a card that has never executed
    const host = new TaskBoardHostService(fakeGateway())
    const provider = admitFakeProvider(host)
    const task = provider.face.tasks.create({ title: 'Before', description: 'd', prompt: 'old' })

    // When the provider patches its content and then moves it to done
    provider.face.tasks.patchContent(task.id, { title: 'After', prompt: 'new' })
    provider.face.tasks.setStatus(task.id, 'done')

    // Then the board recorded both the content edit and the column change
    expect(provider.face.tasks.get(task.id)?.title).toBe('After')
    expect(provider.face.tasks.get(task.id)?.prompt).toBe('new')
    expect(provider.face.tasks.get(task.id)?.status).toBe('done')
    host.dispose()
  })

  it('operator sees a provider summary in the snapshot and its tool registered under the provider id', () => {
    // Given a board with a tool registry double
    const host = new TaskBoardHostService(fakeGateway())
    const tools: string[] = []
    host.extensions.setToolRegistry(() => ({
      register: (definition) => {
        tools.push(definition.name)
        return () => { tools.splice(tools.indexOf(definition.name), 1) }
      },
    }))

    // When the provider starts
    admitFakeProvider(host)

    // Then its published summary is in the board snapshot and its tool is
    // registered under the provider-owned name
    expect(host.snapshot().extensions?.fake).toEqual({ provider: 'fake', version: 1, note: 'opaque' })
    expect(tools).toEqual(['fake_tool'])
    host.dispose()
  })

  it('operator sees a provider receive status, settlement and deletion events from the board', () => {
    // Given an admitted provider and one of its cards
    const host = new TaskBoardHostService(fakeGateway())
    const provider = admitFakeProvider(host)
    const task = provider.face.tasks.create({ title: 'E', description: '', prompt: '' })

    // When the card changes column, an execution settles, and the card is deleted
    provider.face.tasks.setStatus(task.id, 'done')
    host.extensions.emitExecutionSettled({ taskId: task.id, executionId: 'exec-1', outcome: 'succeeded' })
    host.apply('d1', { kind: 'delete', taskId: task.id })

    // Then the provider observed each event with the board's own facts
    expect(provider.statusChanges).toEqual([{ taskId: task.id, status: 'done', previous: 'todo' }])
    expect(provider.settlements).toEqual([{ taskId: task.id, executionId: 'exec-1', outcome: 'succeeded' }])
    expect(provider.deletions).toEqual([{ taskId: task.id }])
    host.dispose()
  })

  it('operator switching a provider off in its own configuration leaves the board without its surface', () => {
    // Given a board with a tool registry double and a provider that reports itself disabled
    const host = new TaskBoardHostService(fakeGateway())
    const tools: string[] = []
    host.extensions.setToolRegistry(() => ({
      register: (definition) => {
        tools.push(definition.name)
        return () => { tools.splice(tools.indexOf(definition.name), 1) }
      },
    }))
    const started: string[] = []

    // When the board admits it
    host.registerExtension({
      id: 'self-disabled',
      apiVersion: TASK_BOARD_API_VERSION,
      enabled: () => false,
      start: () => { started.push('started') },
    })

    // Then nothing of the provider runs: it is not active, its start() never
    // ran, its tool never registered and it published nothing
    expect(host.extensions.isActive('self-disabled')).toBe(false)
    expect(started).toEqual([])
    expect(tools).toEqual([])
    expect(host.snapshot().extensions?.['self-disabled']).toBeUndefined()
    host.dispose()
  })

  it('operator switching the board master switch off stops a running provider and releases its tool', () => {
    // Given a running provider whose tool the board registered
    const host = new TaskBoardHostService(fakeGateway())
    const tools: string[] = []
    host.extensions.setToolRegistry(() => ({
      register: (definition) => {
        tools.push(definition.name)
        return () => { tools.splice(tools.indexOf(definition.name), 1) }
      },
    }))
    admitFakeProvider(host)
    expect(host.extensions.isActive('fake')).toBe(true)
    expect(tools).toEqual(['fake_tool'])

    // When the board's own master switch goes off
    host.extensions.setEnabled(false)

    // Then the provider stopped, its tool was released and its summary cleared
    expect(host.extensions.isActive('fake')).toBe(false)
    expect(tools).toEqual([])
    expect(host.snapshot().extensions?.['fake']).toBeUndefined()
    host.dispose()
  })

  it('operator sees a provider action route back with the opaque payload intact', async () => {
    // Given an admitted provider with a registered action handler
    const host = new TaskBoardHostService(fakeGateway())
    admitFakeProvider(host)

    // When the board routes one provider action with an opaque payload
    const result = await host.extensions.handleAction({ extensionId: 'fake', action: 'sync', payload: { cursor: 7 } })

    // Then the handler's return value comes back byte-for-byte
    expect(result).toEqual({ ok: true, extensionId: 'fake', action: 'sync', payload: { cursor: 7 } })
    host.dispose()
  })
})
