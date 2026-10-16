import { describe, expect, it, vi } from 'vitest'
import { BoardController, type SessionsControllerFace, type TaskBoardTransport } from '../src/core/controller.ts'
import { InMemoryTaskStore } from '../src/core/store.ts'
import { createTask, type TaskRecord } from '../src/core/tasks.ts'
import type { TaskBoardEventPayload, TaskBoardSnapshot } from '../src/protocol.ts'

function snapshot(revision: number, tasks: TaskRecord[] = [], ledgerId = 'ledger-a'): TaskBoardSnapshot {
  return {
    schemaVersion: 6,
    revision,
    tasks,
    scheduler: { timeZone: 'UTC', ledgerId },
    power: {
      platform: 'linux', phase: 'unsupported', enabled: false,
      runningSessions: 0, armedSchedules: 0, sessionStateKnown: true,
    },
  }
}

function sessions(): SessionsControllerFace {
  return {
    current: () => undefined,
    subscribe: () => () => undefined,
    open: vi.fn(),
  }
}

describe('Host-backed BoardController', () => {
  it('keeps a create pending and invisible until the Host confirms it', async () => {
    let resolveAction!: (value: TaskBoardSnapshot) => void
    const action = vi.fn(() => new Promise<TaskBoardSnapshot>(resolve => { resolveAction = resolve }))
    const transport: TaskBoardTransport = {
      bootstrap: async () => snapshot(0),
      state: async () => snapshot(0),
      action,
      subscribe: () => () => undefined,
    }
    const controller = new BoardController({
      store: new InMemoryTaskStore(), sessions: sessions(), transport, uuid: () => 'task-a', now: () => 1,
    })
    controller.start()
    await controller.retryHostSync()
    const creating = controller.createTaskConfirmed({ title: 'A', description: 'draft', prompt: 'work' })
    expect(controller.getSnapshot().pendingTaskIds).toEqual(['task-a'])
    expect(controller.getSnapshot().tasks).toEqual([])
    const confirmed = createTask({ title: 'A', description: 'draft', prompt: 'work' }, 1, 'task-a')
    await vi.waitFor(() => { expect(resolveAction).toBeTypeOf('function') })
    resolveAction(snapshot(1, [confirmed]))
    await expect(creating).resolves.toEqual(confirmed)
    expect(controller.getSnapshot().pendingTaskIds).toEqual([])
    controller.dispose()
  })

  it('preserves confirmed state on an action failure and ignores stale revisions', async () => {
    const confirmed = createTask({ title: 'A', description: '', prompt: '' }, 1, 'task-a')
    let onEvent: (() => void) | undefined
    let remoteState = snapshot(2, [confirmed])
    const transport: TaskBoardTransport = {
      bootstrap: async () => remoteState,
      state: async () => remoteState,
      action: async () => { throw new Error('host unavailable') },
      subscribe: listener => { onEvent = listener; return () => undefined },
    }
    const controller = new BoardController({ store: new InMemoryTaskStore(), sessions: sessions(), transport })
    controller.start()
    await Promise.resolve()
    expect(await controller.runTask('task-a')).toBe(false)
    expect(controller.getSnapshot().tasks).toEqual([confirmed])
    expect(controller.getSnapshot().transportError).toBe('host unavailable')

    remoteState = snapshot(1, [])
    onEvent?.()
    await Promise.resolve()
    expect(controller.getSnapshot().host?.revision).toBe(2)
    expect(controller.getSnapshot().tasks).toEqual([confirmed])
    controller.dispose()
  })

  it('user keeps the subtask depth and session default in the mirror across a heartbeat frame', async () => {
    // Given a Host snapshot carrying the deployment constants
    let onEvent: ((event?: TaskBoardEventPayload) => void) | undefined
    const full: TaskBoardSnapshot = {
      ...snapshot(2),
      sessionDefaultPermission: 'workspace-write',
      maxSubtaskDepth: 3,
    }
    const transport: TaskBoardTransport = {
      bootstrap: async () => full,
      state: async () => full,
      action: async () => full,
      subscribe: listener => { onEvent = listener; return () => undefined },
    }
    const controller = new BoardController({ store: new InMemoryTaskStore(), sessions: sessions(), transport })
    controller.start()
    await vi.waitFor(() => { expect(controller.getSnapshot().host?.maxSubtaskDepth).toBe(3) })

    // When a same-revision heartbeat frame arrives without the constants
    onEvent?.({ revision: 2, scheduler: full.scheduler, power: full.power })

    // Then the mirror keeps them instead of dropping the frame's absent fields
    expect(controller.getSnapshot().host?.maxSubtaskDepth).toBe(3)
    expect(controller.getSnapshot().host?.sessionDefaultPermission).toBe('workspace-write')
    controller.dispose()
  })

  it('user creating a subtask of a subtask reaches the Host when the deployment allows the depth', async () => {
    // Given a Host snapshot whose depth limit is three and a root with one subtask
    const rootTask = createTask({ title: 'root', description: '', prompt: '' }, 1, 'root')
    const childTask: TaskRecord = { ...createTask({ title: 'child', description: '', prompt: '' }, 1, 'child'), parentId: 'root' }
    const grandchild: TaskRecord = { ...createTask({ title: 'grand', description: '', prompt: '' }, 1, 'grand'), parentId: 'child' }
    const initial: TaskBoardSnapshot = { ...snapshot(2, [rootTask, childTask]), maxSubtaskDepth: 3 }
    const action = vi.fn(async () => snapshot(3, [rootTask, childTask, grandchild]))
    const transport: TaskBoardTransport = {
      bootstrap: async () => initial,
      state: async () => initial,
      action,
      subscribe: () => () => undefined,
    }
    const controller = new BoardController({
      store: new InMemoryTaskStore(), sessions: sessions(), transport, uuid: () => 'grand', now: () => 1,
    })
    controller.start()
    await vi.waitFor(() => { expect(controller.getSnapshot().host?.maxSubtaskDepth).toBe(3) })

    // When the user creates a subtask under the depth-one task
    const created = await controller.createTaskConfirmed({ title: 'grand', description: '', prompt: '', parentId: 'child' })

    // Then the local preview accepts it and the Host receives the create action
    expect(created?.id).toBe('grand')
    expect(action).toHaveBeenCalledWith(
      { kind: 'create', id: 'grand', input: expect.objectContaining({ parentId: 'child' }) },
      undefined,
    )
    controller.dispose()
  })

  it('retains the v1 view and does not subscribe to SSE until migration succeeds', async () => {
    const legacy = createTask({ title: 'legacy', description: '', prompt: '' }, 1, 'legacy')
    const confirmed = createTask({ title: 'confirmed', description: '', prompt: '' }, 2, 'confirmed')
    const store = new InMemoryTaskStore()
    store.save([legacy])
    let online = false
    const subscribe = vi.fn(() => () => undefined)
    const transport: TaskBoardTransport = {
      bootstrap: async () => {
        if (!online) throw new Error('migration offline')
        return snapshot(1, [confirmed])
      },
      state: async () => snapshot(1, [confirmed]),
      action: async () => snapshot(1, [confirmed]),
      subscribe,
    }
    const controller = new BoardController({ store, sessions: sessions(), transport })
    controller.start()
    await vi.waitFor(() => { expect(controller.getSnapshot().transportError).toBe('migration offline') })
    expect(controller.getSnapshot().tasks).toEqual([legacy])
    expect(subscribe).not.toHaveBeenCalled()
    online = true
    await expect(controller.retryHostSync()).resolves.toBe(true)
    expect(controller.getSnapshot().tasks).toEqual([confirmed])
    expect(subscribe).toHaveBeenCalledOnce()
    controller.dispose()
  })

  it('queues conflicting actions for one task and keeps pending until the queue drains', async () => {
    const initial = createTask({ title: 'A', description: '', prompt: '' }, 1, 'task-a')
    const resolvers: Array<(value: TaskBoardSnapshot) => void> = []
    const action = vi.fn(async () => await new Promise<TaskBoardSnapshot>(resolve => { resolvers.push(resolve) }))
    const transport: TaskBoardTransport = {
      bootstrap: async () => snapshot(1, [initial]),
      state: async () => snapshot(1, [initial]),
      action,
      subscribe: () => () => undefined,
    }
    const controller = new BoardController({ store: new InMemoryTaskStore(), sessions: sessions(), transport })
    controller.start()
    await controller.retryHostSync()
    controller.updateTask('task-a', { title: 'B' })
    controller.updateTask('task-a', { title: 'C' })
    await vi.waitFor(() => { expect(action).toHaveBeenCalledTimes(1) })
    resolvers[0](snapshot(2, [{ ...initial, title: 'B', updatedAt: 2 }]))
    await vi.waitFor(() => { expect(action).toHaveBeenCalledTimes(2) })
    expect(controller.getSnapshot().pendingTaskIds).toEqual(['task-a'])
    resolvers[1](snapshot(3, [{ ...initial, title: 'C', updatedAt: 3 }]))
    await vi.waitFor(() => { expect(controller.getSnapshot().pendingTaskIds).toEqual([]) })
    expect(controller.getSnapshot().tasks[0].title).toBe('C')
    controller.dispose()
  })

  it('refreshes after a stale action response and accepts a lower revision from a new ledger generation', async () => {
    const initial = createTask({ title: 'A', description: '', prompt: '' }, 1, 'task-a')
    const refreshed = { ...initial, title: 'fresh', updatedAt: 3 }
    const state = vi.fn(async () => snapshot(3, [refreshed]))
    let onEvent: (() => void) | undefined
    const transport: TaskBoardTransport = {
      bootstrap: async () => snapshot(2, [initial]),
      state,
      action: async () => snapshot(1, []),
      subscribe: listener => { onEvent = listener; return () => undefined },
    }
    const controller = new BoardController({ store: new InMemoryTaskStore(), sessions: sessions(), transport })
    controller.start()
    await controller.retryHostSync()
    expect(await controller.runTask('task-a')).toBe(true)
    expect(state).toHaveBeenCalledOnce()
    expect(controller.getSnapshot().tasks[0].title).toBe('fresh')

    state.mockResolvedValueOnce(snapshot(0, [], 'ledger-b'))
    onEvent?.()
    await vi.waitFor(() => { expect(controller.getSnapshot().host?.scheduler.ledgerId).toBe('ledger-b') })
    expect(controller.getSnapshot().host?.revision).toBe(0)
    expect(controller.getSnapshot().tasks).toEqual([])
    controller.dispose()
  })

  it('applies a same-revision SSE frame in place without refetching the full state', async () => {
    const confirmed = createTask({ title: 'A', description: '', prompt: '' }, 1, 'task-a')
    const state = vi.fn(async () => snapshot(2, [confirmed]))
    let onEvent: ((event?: TaskBoardEventPayload) => void) | undefined
    const transport: TaskBoardTransport = {
      bootstrap: async () => snapshot(2, [confirmed]),
      state,
      action: async () => snapshot(2, [confirmed]),
      subscribe: listener => { onEvent = listener; return () => undefined },
    }
    const controller = new BoardController({ store: new InMemoryTaskStore(), sessions: sessions(), transport })
    controller.start()
    await controller.retryHostSync()
    expect(state).not.toHaveBeenCalled()
    onEvent?.({
      revision: 2,
      scheduler: { timeZone: 'UTC', ledgerId: 'ledger-a', lastTickAt: 7 },
      power: {
        platform: 'linux', phase: 'unsupported', enabled: false,
        runningSessions: 3, armedSchedules: 0, sessionStateKnown: true,
      },
    })
    await Promise.resolve()
    expect(state).not.toHaveBeenCalled()
    expect(controller.getSnapshot().host?.scheduler.lastTickAt).toBe(7)
    expect(controller.getSnapshot().host?.power.runningSessions).toBe(3)
    expect(controller.getSnapshot().tasks).toEqual([confirmed])
    controller.dispose()
  })

  it('still refetches the full state when the SSE revision differs', async () => {
    const confirmed = createTask({ title: 'A', description: '', prompt: '' }, 1, 'task-a')
    const state = vi.fn(async () => snapshot(3, [confirmed]))
    let onEvent: ((event?: TaskBoardEventPayload) => void) | undefined
    const transport: TaskBoardTransport = {
      bootstrap: async () => snapshot(2, [confirmed]),
      state,
      action: async () => snapshot(2, [confirmed]),
      subscribe: listener => { onEvent = listener; return () => undefined },
    }
    const controller = new BoardController({ store: new InMemoryTaskStore(), sessions: sessions(), transport })
    controller.start()
    await controller.retryHostSync()
    onEvent?.({ revision: 3, scheduler: { timeZone: 'UTC', ledgerId: 'ledger-a' }, power: snapshot(2).power })
    await vi.waitFor(() => { expect(state).toHaveBeenCalledOnce() })
    expect(controller.getSnapshot().host?.revision).toBe(3)
    controller.dispose()
  })

  it('falls back to a full refresh when the SSE frame is missing', async () => {
    const confirmed = createTask({ title: 'A', description: '', prompt: '' }, 1, 'task-a')
    const state = vi.fn(async () => snapshot(2, [confirmed]))
    let onEvent: ((event?: TaskBoardEventPayload) => void) | undefined
    const transport: TaskBoardTransport = {
      bootstrap: async () => snapshot(2, [confirmed]),
      state,
      action: async () => snapshot(2, [confirmed]),
      subscribe: listener => { onEvent = listener; return () => undefined },
    }
    const controller = new BoardController({ store: new InMemoryTaskStore(), sessions: sessions(), transport })
    controller.start()
    await controller.retryHostSync()
    onEvent?.()
    await vi.waitFor(() => { expect(state).toHaveBeenCalledOnce() })
    controller.dispose()
  })
})
