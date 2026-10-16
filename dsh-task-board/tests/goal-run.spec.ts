/**
 * Goal-driven runs: the runner arms dsh's built-in /goal after queueing the
 * task prompt (only for a card that opted in; the option is off by default),
 * and the inspection loop settles the execution from the goal's own end rather
 * than the first turn end.
 */
import { describe, expect, it, vi } from 'vitest'
import { createTask, type TaskRecord } from '../src/core/tasks.ts'
import { goalObjective, HostExecutionRunner } from '../src/host-runner.ts'

type GatewayRequest = {
  namespace: string
  method: string
  args: Record<string, unknown>
  signal?: AbortSignal
}

// Same wire contract as host-runner.spec.ts: every session method used here
// carries its request under the 'request' wire key (list under '_request'),
// and agentPresets/list declares no parameters. A drifted invoke wrapper must
// fail here instead of passing silently.
const wireArgsKeys: Record<string, Record<string, readonly string[]>> = {
  agentPresets: { list: [] },
  session: {
    create: ['request'],
    rename: ['request'],
    prompt: ['request'],
    list: ['_request'],
    follow: ['request'],
    projections: ['request'],
  },
}

function assertWireArgs(request: GatewayRequest): void {
  const expected = wireArgsKeys[request.namespace]?.[request.method]
  if (expected === undefined) throw new Error('unexpected endpoint ' + request.namespace + '/' + request.method)
  const actual = Object.keys(request.args)
  const missing = expected.filter(key => !actual.includes(key))
  const extra = actual.filter(key => !expected.includes(key))
  if (missing.length !== 0 || extra.length !== 0) {
    throw new Error('arguments-invalid for ' + request.namespace + '/' + request.method)
  }
}

function fakeInvoke(handle: (request: GatewayRequest) => Promise<unknown>) {
  return vi.fn(async (request: GatewayRequest) => {
    assertWireArgs(request)
    return handle(request)
  })
}

function fakeStream(handle: (request: GatewayRequest) => Promise<AsyncIterable<unknown>>) {
  return vi.fn(async (request: GatewayRequest) => {
    assertWireArgs(request)
    return handle(request)
  })
}

function sessionEvent(type: string, seq: number, time: number, data: unknown) {
  return { type: 'event' as const, event: { type, seq, time, data } }
}

function snapshot(records: readonly unknown[], cursor: number, hasMore: boolean) {
  return { type: 'snapshot' as const, header: {}, cursor, records, hasMore, projections: {} }
}

function completedTurnSnapshot() {
  return {
    async *[Symbol.asyncIterator]() {
      yield snapshot([sessionEvent('turn/end', 10, 1_100, { reason: { kind: 'completed' } })], 10, false)
    },
  }
}

/** A goal projection value as session/projections reports it. */
function goalProjection(phase: string, extra: Record<string, unknown> = {}) {
  return {
    values: {
      goal: {
        goal: {
          id: 'goal-1',
          revision: 2,
          objective: 'do work',
          phase,
          maxGoalRounds: 256,
          ...extra,
        },
        roundsStarted: 3,
        createdAt: 1,
        updatedAt: 2,
      },
    },
  }
}

/** A launch gateway that records the session calls it received. */
function launchGateway(order: string[], promptPayloads: unknown[] = []) {
  return {
    stream: fakeStream(async () => ({ async *[Symbol.asyncIterator]() { yield snapshot([], 0, false) } })),
    invoke: fakeInvoke(async (request: GatewayRequest) => {
      if (request.namespace === 'agentPresets') {
        order.push('preset')
        return { presets: [] }
      }
      if (request.method === 'create') {
        order.push('create')
        return { sessionId: 'session-a' }
      }
      if (request.method === 'rename') {
        order.push('rename')
        return { title: 'renamed', seq: 1 }
      }
      if (request.method === 'prompt') {
        order.push('prompt')
        promptPayloads.push(request.args.request)
        return { accepted: true }
      }
      throw new Error('unexpected gateway call: ' + request.method)
    }),
  }
}

function goalLine(line: string): string {
  return line.startsWith('/goal ') ? line.slice('/goal '.length) : line
}

describe('goalObjective', () => {
  it('operator writing an ordinary task prompt keeps the objective verbatim', () => {
    // Given prompts that name no goal operation
    // When the objective is built
    // Then the text passes through (trimmed) unchanged
    expect(goalObjective('fix the login button')).toBe('fix the login button')
    expect(goalObjective('  clear the cache  ')).toBe('clear the cache')
    expect(goalObjective('editorial pass')).toBe('editorial pass')
  })

  it('operator writing a prompt that names a goal operation still arms an objective', () => {
    // Given prompts whose opening word the /goal parser reads as an operation
    // When the objective is built
    // Then a neutral label keeps them objectives
    for (const keyword of ['clear', 'pause', 'resume', 'edit', 'CLEAR', 'Pause', 'EDIT']) {
      expect(goalObjective(keyword)).toBe('Goal: ' + keyword)
    }
    expect(goalObjective('edit the README')).toBe('Goal: edit the README')
    expect(goalObjective('Edit src/index.ts')).toBe('Goal: Edit src/index.ts')
  })
})

describe('goal run arming', () => {
  it('user running a card queues the instruction before the goal is armed', async () => {
    // Given a card that opted into the goal option, the GLOBAL native-/goal
    // switch ON, and a board with commands
    const order: string[] = []
    const promptPayloads: unknown[] = []
    const commands = { execute: vi.fn(async (_sessionId: string, line: string) => { order.push('command:' + goalLine(line)); return { kind: 'success' as const } }) }
    const gateway = launchGateway(order, promptPayloads)

    // When the card runs
    await expect(new HostExecutionRunner(gateway, commands).launch(createTask({ title: 'Run me', description: '', prompt: 'do work', goalRun: true }, 1, 'task-a'), { goalEnabled: true })).resolves.toBe('session-a')

    // Then the instruction turn is queued first and the goal extends it
    expect(order).toEqual(['create', 'rename', 'prompt', 'command:do work'])
    expect(promptPayloads).toEqual([{ sessionId: 'session-a', requestId: expect.any(String), mode: 'queue', content: [{ type: 'text', text: 'do work' }] }])
  })

  it('user running a tagged card arms the goal with the whole composed prompt', async () => {
    // Given a card whose prompt carries a tag hint, a run that names a peer, and
    // the global switch ON
    const order: string[] = []
    const commands = { execute: vi.fn(async (_sessionId: string, line: string) => { order.push(goalLine(line)); return { kind: 'success' as const } }) }
    const task: TaskRecord = {
      ...createTask({ title: 'Run me', description: '', prompt: 'do work', goalRun: true, tags: [{ name: 'line', promptPrefix: 'output to /tmp' }] }, 1, 'task-a'),
    }

    // When the card runs
    await new HostExecutionRunner(launchGateway(order), commands)
      .launch(task, { promptContext: { peers: [{ id: 'child', title: 'Child' }] }, goalEnabled: true })

    // Then the objective is exactly what the session received
    expect(order.at(-1)).toContain('标签提示')
    expect(order.at(-1)).toContain('do work')
    expect(order.at(-1)).toContain('Child')
  })

  it('user leaving the goal option alone gets one plain turn even with the GLOBAL switch on', async () => {
    // Given a card that never touched the option (absent = off) and the global
    // switch ON
    const order: string[] = []
    const commands = { execute: vi.fn(async () => ({ kind: 'success' as const })) }
    const task: TaskRecord = createTask({ title: 'Run me', description: '', prompt: 'do work' }, 1, 'task-a')

    // When the card runs
    await new HostExecutionRunner(launchGateway(order), commands).launch(task, { goalEnabled: true })

    // Then no command is dispatched at all: the card must ASK for the goal run,
    // and the option is off by default.
    expect(order).toEqual(['create', 'rename', 'prompt'])
    expect(commands.execute).not.toHaveBeenCalled()
  })

  it('user explicitly clearing the goal option on a card that had it keeps one plain turn', async () => {
    // Given a card whose stored opt-in was cleared (absent) and the switch ON
    const order: string[] = []
    const commands = { execute: vi.fn(async () => ({ kind: 'success' as const })) }
    const task: TaskRecord = { ...createTask({ title: 'Run me', description: '', prompt: 'do work', goalRun: true }, 1, 'task-a'), goalRun: undefined }

    // When the card runs
    await new HostExecutionRunner(launchGateway(order), commands).launch(task, { goalEnabled: true })

    // Then the cleared value behaves exactly like a card that never opted in
    expect(order).toEqual(['create', 'rename', 'prompt'])
    expect(commands.execute).not.toHaveBeenCalled()
  })

  it('user whose goal command is refused still gets the run', async () => {
    // Given a board whose /goal command answers with an error
    const order: string[] = []
    const commands = { execute: vi.fn(async () => ({ kind: 'error' as const, text: 'A goal is already active.' })) }

    // When an opted-in card runs
    const launched = await new HostExecutionRunner(launchGateway(order), commands)
      .launch(createTask({ title: 'Run me', description: '', prompt: 'do work', goalRun: true }, 1, 'task-a'), { goalEnabled: true })

    // Then the session is launched with the prompt and the run survives
    expect(launched).toBe('session-a')
    expect(order).toEqual(['create', 'rename', 'prompt'])
  })

  it('operator deploying the board without a command dispatcher still runs the card', async () => {
    // Given a deployment whose runner got no command dispatcher
    const order: string[] = []

    // When an opted-in card runs
    const launched = await new HostExecutionRunner(launchGateway(order))
      .launch(createTask({ title: 'Run me', description: '', prompt: 'do work', goalRun: true }, 1, 'task-a'), { goalEnabled: true })

    // Then the prompt is still queued and the session exists
    expect(launched).toBe('session-a')
    expect(order).toContain('prompt')
  })

  it('user leaving the GLOBAL native /goal switch at its default gets one plain turn for every card', async () => {
    // Given a default deployment (no goalEnabled) and a board with commands
    const order: string[] = []
    const commands = { execute: vi.fn(async (_sessionId: string, line: string) => { order.push('command:' + goalLine(line)); return { kind: 'success' as const } }) }

    // When a card that opted in runs
    await new HostExecutionRunner(launchGateway(order), commands)
      .launch(createTask({ title: 'Run me', description: '', prompt: 'do work', goalRun: true }, 1, 'task-a'))

    // Then no /goal is dispatched: the global switch alone decides, and off is
    // the default for every deployment that never configured it.
    expect(order).toEqual(['create', 'rename', 'prompt'])
    expect(commands.execute).not.toHaveBeenCalled()
  })

  it('operator running with both switches on sees the goal armed, and turning either off obtains a plain turn', async () => {
    // Given a board with commands
    const arm = async (options: { goalEnabled: boolean; goalRun?: boolean }): Promise<string[]> => {
      const order: string[] = []
      const commands = { execute: vi.fn(async (_sessionId: string, line: string) => { order.push('command:' + goalLine(line)); return { kind: 'success' as const } }) }
      const task: TaskRecord = { ...createTask({ title: 'Run me', description: '', prompt: 'do work' }, 1, 'task-a'), ...(options.goalRun === undefined ? {} : { goalRun: options.goalRun }) }
      await new HostExecutionRunner(launchGateway(order), commands).launch(task, { goalEnabled: options.goalEnabled })
      return order
    }

    // When each of the two-switch combinations runs
    const both = await arm({ goalEnabled: true, goalRun: true })
    const cardDefault = await arm({ goalEnabled: true })
    const globalOff = await arm({ goalEnabled: false, goalRun: true })
    const taskOff = await arm({ goalEnabled: true, goalRun: false })

    // Then native /goal runs only when BOTH ask for it: the card-level default
    // is off, and the global default is off.
    expect(both).toContain('command:do work')
    expect(cardDefault).toEqual(['create', 'rename', 'prompt'])
    expect(globalOff).toEqual(['create', 'rename', 'prompt'])
    expect(taskOff).toEqual(['create', 'rename', 'prompt'])
  })

  it('user turning the global switch off while a run is in flight sees that run keep its armed goal', async () => {
    // Given a launch whose global switch was frozen ON when it started
    const order: string[] = []
    const commands = { execute: vi.fn(async (_sessionId: string, line: string) => { order.push('command:' + goalLine(line)); return { kind: 'success' as const } }) }

    // When the opted-in launch runs with its frozen value
    await new HostExecutionRunner(launchGateway(order), commands)
      .launch(createTask({ title: 'Run me', description: '', prompt: 'do work', goalRun: true }, 1, 'task-a'), { goalEnabled: true })

    // Then the frozen decision is what ran: nothing re-reads a live setting, so
    // a later edit can neither disarm this run nor change its contract.
    expect(order).toContain('command:do work')
  })
})

describe('goal-aware settlement', () => {
  function inspectGateway(projections: (request: GatewayRequest) => Promise<unknown>) {
    return {
      invoke: fakeInvoke(async (request: GatewayRequest) => {
        if (request.method === 'list') return { items: [{ sessionId: 'session-a', running: false }] }
        if (request.method === 'projections') return projections(request)
        throw new Error('unexpected gateway call: ' + request.method)
      }),
      stream: fakeStream(async () => completedTurnSnapshot()),
    }
  }

  it('user watching a card whose goal is still active sees it stay running', async () => {
    // Given a finished turn on a session whose goal is still active
    const runner = new HostExecutionRunner(inspectGateway(async () => goalProjection('active')))

    // When the execution is inspected
    const outcome = await runner.inspect('session-a', 1_000)

    // Then the goal-round driver still owns the run, so it stays pending
    expect(outcome).toEqual({ outcome: 'pending' })
  })

  it('user watching a card whose goal completed sees it settle as succeeded', async () => {
    // Given a finished turn on a session whose goal completed
    const runner = new HostExecutionRunner(inspectGateway(async () => goalProjection('complete')))

    // When the execution is inspected
    const outcome = await runner.inspect('session-a', 1_000)

    // Then the turn verdict stands
    expect(outcome).toEqual({ outcome: 'succeeded' })
  })

  it('user watching a paused goal or a session without one sees the turn verdict', async () => {
    // Given a paused goal and a session that never had one
    // When both executions are inspected
    // Then neither is held pending by a goal
    await expect(new HostExecutionRunner(inspectGateway(async () => goalProjection('paused'))).inspect('session-a', 1_000))
      .resolves.toEqual({ outcome: 'succeeded' })
    await expect(new HostExecutionRunner(inspectGateway(async () => ({ values: { goal: null } }))).inspect('session-a', 1_000))
      .resolves.toEqual({ outcome: 'succeeded' })
  })

  it('user watching a card whose goal was blocked sees it fail with the goal reason', async () => {
    // Given a session whose goal dsh blocked at its round limit
    const runner = new HostExecutionRunner(inspectGateway(async () => goalProjection('blocked', {
      blockedReason: { code: 'round-limit', message: 'Goal reached its configured limit of 2 rounds.' },
      maxGoalRounds: 2,
    })))

    // When the execution is inspected
    const outcome = await runner.inspect('session-a', 1_000)

    // Then the board reports the goal's own failure reason
    expect(outcome).toEqual({
      outcome: 'failed',
      error: 'goal is blocked: Goal reached its configured limit of 2 rounds.',
    })
  })

  it('operator whose gateway cannot report the goal phase gets the turn verdict', async () => {
    // Given a gateway whose projection read fails (with the warning surfaced)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {}) // test-standards-allow: HostExecutionRunner reports through console.warn, which has no injection point
    try {
      const runner = new HostExecutionRunner(inspectGateway(async () => { throw new Error('offline') }))

      // When the execution is inspected
      const outcome = await runner.inspect('session-a', 1_000)

      // Then the board falls back to the completed turn instead of hanging
      expect(outcome).toEqual({ outcome: 'succeeded' })
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('session/projections failed while reading the goal phase'), expect.any(Error))
    } finally {
      warn.mockRestore()
    }
  })
})
