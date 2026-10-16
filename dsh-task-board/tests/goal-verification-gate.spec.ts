/**
 * Goal acceptance: the completion gate, its per-cycle budget, its evidence
 * window and its anomaly handling.
 *
 * Business scenarios come first: each test states the observable outcome a user
 * (or the fixing agent) sees. The doubles are the repository's usual
 * contract-shaped fakes — a real Host ledger in a temporary home, the real gate,
 * and a model runtime that renders the judge's required verdict tags — so what
 * these tests observe is the shipped rule, not a re-implementation of it.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HostTaskLedger } from '../src/host-ledger.ts'
import { createGoalVerificationGate, type GateExecution } from '../src/host/verification-gate.ts'
import { collectEvidence } from '../src/host/verification-runner.ts'
import {
  EMPTY_WORK_BASELINE,
  MAX_EXCEPTION_ATTEMPTS,
  MAX_INVALID_ATTEMPTS,
  VERIFICATION_THRESHOLD,
  budgetAttempts,
  buildAcceptancePrompt,
  evidenceNonce,
  exceptionAttempts,
  hasInvalidBudget,
  invalidAcceptanceFeedback,
  invalidAttempts,
  invalidHoldReason,
  normalizeVerification,
  withoutAcceptanceAnomalies,
  passedAttempt,
  qualityAttempts,
  resolveContract,
  verificationPhase,
  type ExecutionVerification,
  type ModelCatalogView,
  type VerificationSettings,
} from '../src/core/verification.ts'

const NOW = 1_700_000_000_000

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tb-verify-'))
  dirs.push(dir)
  return dir
}

/** The host catalog the acceptance settings resolve against. */
function catalog(): ModelCatalogView {
  return {
    default: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' },
    groups: [
      {
        id: 'deepseek-official',
        name: 'DeepSeek',
        models: [
          { id: 'deepseek-flash', name: 'Flash', reasoning: { efforts: [{ id: 'low' }, { id: 'high' }], defaultEffort: 'high' } },
          { id: 'deepseek-pro', name: 'Pro', reasoning: { efforts: [{ id: 'medium' }], defaultEffort: 'medium' } },
        ],
      },
    ],
  }
}

/** One session event in the shape the host log carries. */
function event(type: string, seq: number, time: number, data: unknown) {
  return { type, seq, time, data }
}

/** An agent double: the gate reads its session's event log. */
function agentDouble(id: string, events: readonly unknown[]): unknown {
  return { id, session: { snapshotEvents: () => events } }
}

/**
 * Wrap one chunk-yielding function in the runtime shape the board dispatches
 * through.
 *
 * Production reaches the adapter through the registration-bound
 * `prepareCall(...).stream(...)` handle (see `src/host/llm-dispatch.ts`), so
 * the double offers the same two entry points: a judge test that only stubbed
 * the public `stream` would pass even when the board regressed onto the
 * mutable public method.
 */
function judgeRuntime(
  stream: (request: { messages: readonly { content: readonly { text?: string }[] }[] }) => AsyncIterable<unknown>,
) {
  return {
    prepareCall: (config: Record<string, unknown>) => Promise.resolve({
      config,
      stream: (request: { messages: readonly { content: readonly { text?: string }[] }[] }) => stream(request),
    }),
    stream,
  }
}

/**
 * The exact trajectory text the fixture session hands the judge.
 *
 * A veto may only cite what the judge really saw, so the spec's finding double
 * quotes a passage this string carries: the acceptance's own citation check
 * then verifies it against the real evidence rather than trusting the fake.
 */
const FIXTURE_TOOL_OUTPUT = 'the command printed 42 and exited zero'

/** One session event list whose trajectory carries {@link FIXTURE_TOOL_OUTPUT}. */
function workingSession(): unknown[] {
  return [event('tool/result', 2, NOW + 20, { turn: 1, step: 1, message: { content: [{ type: 'text', text: FIXTURE_TOOL_OUTPUT }] } })]
}

/**
 * The judge answer for a REJECTING verdict that satisfies the acceptance's
 * validity rule: one structured finding per criterion the work failed, citing a
 * passage that really occurs in the trajectory the judge was shown.
 * @param options - the failing criteria (defaults to every coding criterion).
 * @returns the raw judge answer text.
 */
function rejectingAnswer(options: { criteria?: readonly string[]; call?: number } = {}): string {
  const names = options.criteria ?? ['Specification Adherence', 'Output Match', 'Error Signal Detection']
  // The prompt names the slot the WORK occupies that round; the citation must
  // name the same slot, or the acceptance reads it as a citation of the
  // empty-work baseline and refuses it.
  const slot = (options.call ?? 0) % 2 === 1 ? 'TRAJECTORY_B' : 'TRAJECTORY_A'
  const findings = names.map(name =>
    '<finding criterion="' + name + '" location="' + slot + '" requirement="the task must produce the verified output" observation="the summary claims success" gap="no command output proves it" quote="' + FIXTURE_TOOL_OUTPUT + '" action="rerun the verification command and read its stdout">the claimed success is not visible in the output</finding>',
  ).join('\n')
  return '<score_A> T </score_A>\n<score_B> T </score_B>\n' + findings
}

/** A model runtime double that answers every judge prompt with the given work grade. */
function judgeLlm(options: {
  grade?: string
  rounds?: (round: number) => string
  raw?: string
  /**
   * Answer builder for a judge that must reject with usable evidence: it
   * receives the rendered prompt (so it can name the round's own work slot) and
   * the call index. Takes precedence over `raw`.
   */
  reject?: (prompt: string, call: number) => string | undefined
  fail?: (prompt: string, call: number) => Error | undefined
  onCall?: (prompt: string) => void
}) {
  let call = 0
  return judgeRuntime((request: { messages: readonly { content: readonly { text?: string }[] }[] }) => {
    const prompt = request.messages[0]?.content[0]?.text ?? ''
    const index = call++
    options.onCall?.(prompt)
    const failure = options.fail?.(prompt, index)
    return (async function * () {
      if (failure !== undefined) throw failure
      const rejected = options.reject?.(prompt, index)
      const text = rejected ?? options.raw ?? (() => {
        // The work sits in slot A on even rounds and in slot B on odd ones,
        // because the gate swaps the two sides for its second round.
        const aBlock = prompt.slice(prompt.indexOf('<<<TRAJECTORY_A'), prompt.indexOf('<<<END_TRAJECTORY_A'))
        const workInA = !aBlock.includes(EMPTY_WORK_BASELINE)
        const grade = options.rounds?.(index % 2) ?? options.grade ?? 'A'
        return workInA
          ? '<score_A> ' + grade + ' </score_A>\n<score_B> T </score_B>'
          : '<score_A> T </score_A>\n<score_B> ' + grade + ' </score_B>'
      })()
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, reasoningTokens: 1 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  })
}

/** A host change service double: the observation the judge is offered. */
function workspaceDouble(options: { fail?: boolean } = {}) {
  return {
    summary: () => ({ turn: 2, added: 3, deleted: 1, files: [{ path: 'src/a.ts', added: 3, deleted: 1 }] }),
    diff: async () => {
      if (options.fail === true) throw new Error('workspace snapshot unavailable')
      return { kind: 'text', hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: ['-old line', '+new line'] }] }
    },
  }
}

/** A goal service double: records the blocks the gate requests. */
function goalDouble(phase: string, objective = 'do work') {
  const blocks: string[] = []
  return {
    blocks,
    get: () => ({ id: 'goal-1', revision: 2, objective, phase }),
    block: (_agent: unknown, _ref: unknown, reason: { message: string }) => { blocks.push(reason.message) },
  }
}

interface Fixture {
  ledger: HostTaskLedger
  taskId: string
  sessionId: string
  task: { id: string; prompt: string; title: string }
}

/** Open one goal-form execution in a scratch ledger and bind a session to it. */
function fixture(options: { settings?: VerificationSettings, catalog?: ModelCatalogView } = {}): Fixture {
  const ledger = new HostTaskLedger(scratch(), () => NOW)
  ledger.applyRequest('req-create', { kind: 'create', id: 'task-a', input: { title: 'Ship it', description: '', prompt: 'do work' } })
  const opened = ledger.applyRequest('req-run', { kind: 'run', taskId: 'task-a' })
  const execution = opened.runs?.[0]?.execution
  if (execution === undefined) throw new Error('the run opened no execution')
  ledger.attachSession('task-a', execution.id, 'session-a')
  const contract = resolveContract(options.settings ?? { enabled: true, model: '', reasoningEffort: '' }, options.catalog ?? catalog())
  ledger.setVerification('task-a', execution.id, { contract, attempts: [], applicability: 'enforced' })
  return { ledger, taskId: 'task-a', sessionId: 'session-a', task: ledger.getTask('task-a')! }
}

/** Build the gate over one fixture. */
function gateOver(input: {
  ledger: HostTaskLedger
  llm?: unknown
  goal?: ReturnType<typeof goalDouble>
  workspace?: unknown
  now?: () => number
  warn?: (message: string) => void
}) {
  return createGoalVerificationGate({
    ledger: input.ledger,
    llm: () => input.llm as never,
    goals: () => input.goal as never,
    ...(input.workspace === undefined ? {} : { workspaceChanges: () => input.workspace as never }),
    logger: { warn: (message: string) => { input.warn?.(message) } },
    now: input.now ?? (() => NOW),
  })
}

/**
 * Drain the pending microtask queue. The acceptance chain is promise-only (no
 * I/O), so this is deterministic and needs no timer.
 */
async function drainMicrotasks(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve()
}

/** One completion claim, as the tool lifecycle delivers it. */
function completion(agent: unknown, overrides: Partial<GateExecution> = {}): GateExecution {
  return { name: 'update_goal', arguments: { action: 'complete', goal_id: 'goal-1', revision: 2 }, agent, signal: new AbortController().signal, ...overrides }
}

/** The execution's acceptance block from the ledger. */
function verificationOf(ledger: HostTaskLedger): ExecutionVerification {
  const verification = ledger.getTask('task-a')?.executions[0]?.verification
  if (verification === undefined) throw new Error('the execution carries no acceptance block')
  return verification
}

describe('goal acceptance gate', () => {
  it('user completing a goal after real work passes the first acceptance and is allowed to finish', async () => {
    // Given: a goal-form execution whose judge grades the work A on both rounds
    const fx = fixture()
    const gate = gateOver({ ledger: fx.ledger, llm: judgeLlm({ grade: 'A' }), goal: goalDouble('active') })
    const agent = agentDouble(fx.sessionId, [
      event('tool/call', 1, NOW + 10, { turn: 1, step: 1, name: 'run_code', arguments: '{}' }),
      event('tool/result', 2, NOW + 20, { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'ok' }] } }),
    ])

    // When: the agent claims the goal is complete
    const decision = await gate(completion(agent))

    // Then: the completion is allowed, one quality verdict is recorded, and the
    // board reports the execution as accepted.
    expect(decision).toEqual({ kind: 'allow' })
    const verification = verificationOf(fx.ledger)
    expect(qualityAttempts(verification)).toHaveLength(1)
    expect(passedAttempt(verification)?.passed).toBe(true)
    expect(verificationPhase(verification)).toBe('passed')
    expect(verification.inFlight).toBeUndefined()
  })

  it('user sees a first failure returned to the agent with its scores, then completes after the repair', async () => {
    // Given: a judge that fails the first acceptance and passes the second
    const fx = fixture()
    let quality = 0
    const gate = gateOver({
      ledger: fx.ledger,
      llm: judgeLlm({
        reject: (_prompt, call) => quality === 0 ? rejectingAnswer({ call }) : undefined,
      }),
      goal: goalDouble('active'),
    })
    const agent = agentDouble(fx.sessionId, workingSession())

    // When: the agent claims completion with unfinished work
    const first = await gate(completion(agent))

    // Then: the claim is refused with the failing scores and the remaining
    // budget, and no pass record exists yet.
    expect(first?.kind).toBe('deny')
    const refused = first as { kind: 'deny', reason: string }
    expect(refused.reason).toContain('验收未通过')
    expect(refused.reason).toContain('65.0%')
    expect(refused.reason).toContain('额度还剩 1 次')
    quality = 1

    // When: the agent repairs the work and claims completion again
    const second = await gate(completion(agent))

    // Then: the second acceptance passes and the execution may finish.
    expect(second).toEqual({ kind: 'allow' })
    expect(qualityAttempts(verificationOf(fx.ledger))).toHaveLength(2)
    expect(passedAttempt(verificationOf(fx.ledger))?.passed).toBe(true)
    expect(passedAttempt(verificationOf(fx.ledger))?.score).toBeCloseTo(1, 0.0001)
  })

  it('user whose work fails both acceptances sees the execution judged failed with a frozen budget', async () => {
    // Given: a judge whose veto is backed by a citation of the real trajectory,
    // and a goal service that records blocks
    const fx = fixture()
    const goal = goalDouble('active')
    const gate = gateOver({ ledger: fx.ledger, llm: judgeLlm({ reject: (_prompt, call) => rejectingAnswer({ call }) }), goal })
    const agent = agentDouble(fx.sessionId, workingSession())

    // When: the agent claims completion twice
    const first = await gate(completion(agent))
    const second = await gate(completion(agent))

    // Then: the second failure closes the cycle, the goal is blocked so the run
    // ends, and a third claim cannot spend a new acceptance.
    expect(first?.kind).toBe('deny')
    expect(second?.kind).toBe('deny')
    expect((second as { kind: 'deny', reason: string }).reason).toContain('本次 execution 判失败')
    const verification = verificationOf(fx.ledger)
    expect(verification.failedReason).toContain('本次 execution 判失败')
    expect(fx.ledger.getTask('task-a')?.executions[0]?.endedAt).toBeUndefined()
    expect(goal.blocks).toHaveLength(1)
    const callsBeforeThird = qualityAttempts(verification).length
    const third = await gate(completion(agent))
    expect(third?.kind).toBe('deny')
    expect(qualityAttempts(verificationOf(fx.ledger))).toHaveLength(callsBeforeThird)
  })

  it('user reading the final failure sees the baseline, every failing criterion and the judge findings, not only the total', async () => {
    // Given: a judge that always fails the work AND reports a locatable finding
    const fx = fixture()
    const goal = goalDouble('active')
    const gate = gateOver({
      ledger: fx.ledger,
      llm: judgeLlm({
        reject: (_prompt, call) => rejectingAnswer({ call }),
      }),
      goal,
    })
    const agent = agentDouble(fx.sessionId, workingSession())

    // When: the cycle is spent
    await gate(completion(agent))
    const second = await gate(completion(agent))

    // Then: the final reason carries the improvement material — the baseline
    // comparison, the failing criteria, and the judge's located finding — and
    // the goal block the run ends with repeats them.
    const reason = (second as { kind: 'deny', reason: string }).reason
    expect(reason).toContain('空工作基线')
    expect(reason).toContain('Error Signal Detection')
    expect(reason).toContain('可定位问题')
    expect(reason).toContain(FIXTURE_TOOL_OUTPUT)
    expect(reason).toContain('rerun the verification command and read its stdout')
    expect(goal.blocks[0]).toContain(FIXTURE_TOOL_OUTPUT)
    const verification = verificationOf(fx.ledger)
    expect(verification.failedReason).toContain(FIXTURE_TOOL_OUTPUT)
    // The veto is only usable because the citation really occurs in the
    // trajectory the judge was shown; the structured finding is what carries it.
    expect(verification.attempts[0]?.criterionFindings?.[0]?.location).toBe('trajectory')
  })

  it('user whose judge rejects without any finding sees an INVALID acceptance and is never asked to repair blindly', async () => {
    // Given: a judge that scores the work below the threshold and cites nothing
    const fx = fixture()
    const goal = goalDouble('active')
    const gate = gateOver({ ledger: fx.ledger, llm: judgeLlm({ grade: 'T' }), goal })
    const agent = agentDouble(fx.sessionId, workingSession())

    // When: the agent claims completion twice, spending both invalid attempts
    const first = await gate(completion(agent))
    const second = await gate(completion(agent))

    // Then: neither claim is a quality verdict, the quality budget is untouched,
    // the card is not failed, and the agent is told the veto itself was
    // unusable rather than being sent to fix work nothing located.
    expect(first?.kind).toBe('deny')
    expect((first as { kind: 'deny', reason: string }).reason).toContain('验收无效')
    expect((first as { kind: 'deny', reason: string }).reason).toContain('未消耗质量验收额度')
    expect((first as { kind: 'deny', reason: string }).reason).toContain('请不要据此盲目修改')
    expect(second?.kind).toBe('deny')
    expect((second as { kind: 'deny', reason: string }).reason).toContain('等待人工处理')
    const verification = verificationOf(fx.ledger)
    expect(invalidAttempts(verification)).toHaveLength(MAX_INVALID_ATTEMPTS)
    expect(qualityAttempts(verification)).toHaveLength(0)
    expect(verification.failedReason).toBeUndefined()
    expect(verificationPhase(verification)).toBe('invalid')
    expect(goal.blocks).toEqual([])

    // And a third claim spends no judge call at all, so an evidence-free judge
    // cannot be re-run forever.
    const third = await gate(completion(agent))
    expect((third as { kind: 'deny', reason: string }).reason).toContain('等待人工处理')
    expect(invalidAttempts(verificationOf(fx.ledger))).toHaveLength(MAX_INVALID_ATTEMPTS)
  })

  it('user claiming completion twice at once sees one acceptance, not two', async () => {
    // Given: a slow judge and a session already bound to the execution
    const fx = fixture()
    let resolveCall: (() => void) | undefined
    const gate = gateOver({
      ledger: fx.ledger,
      llm: judgeRuntime((request: { messages: readonly { content: readonly { text?: string }[] }[] }) => {
        const prompt = request.messages[0]?.content[0]?.text ?? ''
        const aBlock = prompt.slice(prompt.indexOf('<<<TRAJECTORY_A'), prompt.indexOf('<<<END_TRAJECTORY_A'))
        const workInA = !aBlock.includes(EMPTY_WORK_BASELINE)
        return (async function * () {
          await new Promise<void>(resolve => { resolveCall = resolve })
          yield { type: 'text-delta', index: 0, text: workInA ? '<score_A> A </score_A>\n<score_B> T </score_B>' : '<score_A> T </score_A>\n<score_B> A </score_B>' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      }),
      goal: goalDouble('active'),
    })
    const agent = agentDouble(fx.sessionId, [event('tool/call', 1, NOW + 10, { turn: 1, step: 1, name: 'bash', arguments: '{}' })])

    // When: two completion claims arrive while the first acceptance is running
    const first = gate(completion(agent))
    await drainMicrotasks()
    const second = gate(completion(agent))
    await drainMicrotasks()
    // Release every judge call the shared acceptance issues.
    for (let tick = 0; tick < 12 && resolveCall !== undefined; tick++) {
      const release = resolveCall
      resolveCall = undefined
      release()
      await drainMicrotasks()
    }

    // Then: both claims observe one verdict and the execution spends one acceptance.
    const [a, b] = await Promise.all([first, second])
    expect(a).toEqual({ kind: 'allow' })
    expect(b).toEqual({ kind: 'allow' })
    expect(qualityAttempts(verificationOf(fx.ledger))).toHaveLength(1)
  })

  it('user rerunning the task sees a fresh acceptance budget for the new execution', async () => {
    // Given: an execution whose acceptance cycle is already spent on real vetoes
    const fx = fixture()
    const gate = gateOver({ ledger: fx.ledger, llm: judgeLlm({ reject: (_prompt, call) => rejectingAnswer({ call }) }), goal: goalDouble('active') })
    const agent = agentDouble(fx.sessionId, workingSession())
    await gate(completion(agent))
    await gate(completion(agent))
    expect(verificationOf(fx.ledger).failedReason).toContain('本次 execution 判失败')

    // When: the card is rerun as a new execution in the same session
    fx.ledger.settle('task-a', fx.ledger.getTask('task-a')!.executions[0]!.id, 'failed', 'acceptance failed')
    const next = fx.ledger.applyRequest('req-rerun', { kind: 'rerun', taskId: 'task-a' })
    const execution = next.runs?.[0]?.execution
    if (execution === undefined) throw new Error('the rerun opened no execution')
    fx.ledger.attachSession('task-a', execution!.id, 'session-b')
    fx.ledger.setVerification('task-a', execution!.id, {
      contract: resolveContract({ enabled: true, model: '', reasoningEffort: '' }, catalog()),
      attempts: [],
      applicability: 'enforced',
    })

    // Then: the new execution starts with its own budget and its own contract.
    const fresh = fx.ledger.getTask('task-a')!.executions.find(entry => entry.id === execution!.id)!
    expect(qualityAttempts(fresh.verification)).toHaveLength(0)
    expect(fresh.verification?.failedReason).toBeUndefined()
  })

  it('user restarting the Host sees the spent acceptance budget survive, not reset', async () => {
    // Given: an execution that already spent one failed acceptance
    const dir = scratch()
    const ledger = new HostTaskLedger(dir, () => NOW)
    ledger.applyRequest('req-create', { kind: 'create', id: 'task-a', input: { title: 'Ship it', description: '', prompt: 'do work' } })
    const opened = ledger.applyRequest('req-run', { kind: 'run', taskId: 'task-a' })
    const execution = opened.runs![0]!.execution
    ledger.attachSession('task-a', execution.id, 'session-a')
    ledger.setVerification('task-a', execution.id, {
      contract: resolveContract({ enabled: true, model: '', reasoningEffort: '' }, catalog()),
      attempts: [],
      applicability: 'enforced',
    })
    const gate = gateOver({ ledger, llm: judgeLlm({ reject: (_prompt, call) => rejectingAnswer({ call }) }), goal: goalDouble('active') })
    const agent = agentDouble('session-a', workingSession())
    await gate(completion(agent))
    expect(qualityAttempts(verificationOf(ledger))).toHaveLength(1)
    ledger.dispose()

    // When: a fresh Host process loads the same ledger and the agent claims completion again
    const reloaded = new HostTaskLedger(dir, () => NOW)
    const reloadedGate = gateOver({ ledger: reloaded, llm: judgeLlm({ reject: (_prompt, call) => rejectingAnswer({ call }) }), goal: goalDouble('active') })
    const revivedAgent = agentDouble('session-a', workingSession())
    const decision = await reloadedGate(completion(revivedAgent))

    // Then: the second acceptance is the LAST one of the cycle, not a fresh first.
    expect(decision?.kind).toBe('deny')
    expect((decision as { kind: 'deny', reason: string }).reason).toContain('本次 execution 判失败')
    expect(qualityAttempts(verificationOf(reloaded))).toHaveLength(2)
    reloaded.dispose()
  })

  it('user whose judge answer cannot be parsed sees an acceptance anomaly, not a quality failure', async () => {
    // Given: a judge that answers prose with no A-T verdict tag
    const fx = fixture()
    const gate = gateOver({ ledger: fx.ledger, llm: judgeLlm({ raw: 'Looks fine to me.' }), goal: goalDouble('active') })
    const agent = agentDouble(fx.sessionId, [event('tool/call', 1, NOW + 10, { turn: 1, step: 1, name: 'bash', arguments: '{}' })])

    // When: the agent claims completion
    const decision = await gate(completion(agent))

    // Then: the anomaly is recorded separately and consumes no quality budget.
    expect(decision?.kind).toBe('deny')
    expect((decision as { kind: 'deny', reason: string }).reason).toContain('验收异常')
    const verification = verificationOf(fx.ledger)
    expect(qualityAttempts(verification)).toHaveLength(0)
    expect(exceptionAttempts(verification)).toHaveLength(1)
  })

  it('user whose judge keeps failing to answer sees the execution HELD open at the anomaly budget instead of failed', async () => {
    // Given: a judge route that always throws, and a goal service that records blocks
    const fx = fixture()
    const goal = goalDouble('active')
    const gate = gateOver({
      ledger: fx.ledger,
      llm: judgeLlm({ fail: () => new Error('401 unauthorized') }),
      goal: goal,
    })
    const agent = agentDouble(fx.sessionId, [event('tool/call', 1, NOW + 10, { turn: 1, step: 1, name: 'bash', arguments: '{}' })])

    // When: the agent claims completion up to the anomaly budget and once more
    const first = await gate(completion(agent))
    const second = await gate(completion(agent))
    const third = await gate(completion(agent))

    // Then: the anomalies are bounded and classified, and the card is NOT judged
    // failed for an environment that could not answer (issue #1828).
    expect(first?.kind).toBe('deny')
    expect((first as { kind: 'deny', reason: string }).reason).toContain('鉴权失败')
    expect(second?.kind).toBe('deny')
    const verification = verificationOf(fx.ledger)
    expect(exceptionAttempts(verification)).toHaveLength(MAX_EXCEPTION_ATTEMPTS)
    expect(qualityAttempts(verification)).toHaveLength(0)
    expect(verification.failedReason).toBeUndefined()
    expect(verificationPhase(verification)).not.toBe('failed')
    expect(goal.blocks).toEqual([])

    // And a spent budget refuses the claim again WITHOUT spending a judge call,
    // so an unusable route cannot turn the gate into an unbounded retry loop.
    expect((third as { kind: 'deny', reason: string }).reason).toContain('验收异常额度已用尽')
    expect(exceptionAttempts(verificationOf(fx.ledger))).toHaveLength(MAX_EXCEPTION_ATTEMPTS)
  })

  it('user who repairs the acceptance environment and clears the anomalies sees the execution judged again', async () => {
    // Given: an execution whose anomaly budget is spent by a broken judge route
    const fx = fixture()
    const gate = gateOver({
      ledger: fx.ledger,
      llm: judgeLlm({ fail: () => new Error('401 unauthorized') }),
      goal: goalDouble('active'),
    })
    const agent = agentDouble(fx.sessionId, [event('tool/call', 1, NOW + 10, { turn: 1, step: 1, name: 'bash', arguments: '{}' })])
    await gate(completion(agent))
    await gate(completion(agent))
    expect(verificationOf(fx.ledger).failedReason).toBeUndefined()

    // When: the environment is repaired and the user clears the recorded anomalies
    fx.ledger.applyRequest('req-reset', { kind: 'reset-verification', taskId: fx.taskId })

    // Then: the anomaly counter is cleared, no quality verdict was invented or
    // lost, and the next completion claim runs a real acceptance again.
    expect(exceptionAttempts(verificationOf(fx.ledger))).toHaveLength(0)
    const repaired = gateOver({ ledger: fx.ledger, llm: judgeLlm({ grade: 'A' }), goal: goalDouble('active') })
    const decision = await repaired(completion(agent))
    expect(decision).toEqual({ kind: 'allow' })
    expect(passedAttempt(verificationOf(fx.ledger))?.passed).toBe(true)
  })

  it('user clearing the acceptance record of an execution that was judged is refused, because a quality verdict is not an anomaly', async () => {
    // Given: an execution whose acceptance produced a real quality verdict
    const fx = fixture()
    const gate = gateOver({ ledger: fx.ledger, llm: judgeLlm({ grade: 'A' }), goal: goalDouble('active') })
    const agent = agentDouble(fx.sessionId, [event('tool/call', 1, NOW + 10, { turn: 1, step: 1, name: 'bash', arguments: '{}' })])
    await gate(completion(agent))

    // When: the user tries to clear the acceptance record
    const refused = (() => {
      try {
        fx.ledger.applyRequest('req-reset', { kind: 'reset-verification', taskId: fx.taskId })
        return ''
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
    })()

    // Then: the reset is refused and the recorded verdict survives untouched.
    expect(refused).toContain('no acceptance anomaly')
    expect(passedAttempt(verificationOf(fx.ledger))?.passed).toBe(true)
  })
  it('operator whose acceptance runs out of time sees a budget stop that spends no judge call and fails nothing', async () => {
    // Given: a clock that consumes the whole acceptance budget before the first
    // judge call could ever finish
    const fx = fixture()
    let clock = NOW
    const gate = createGoalVerificationGate({
      ledger: fx.ledger,
      llm: () => judgeLlm({ grade: 'A' }) as never,
      goals: () => goalDouble('active') as never,
      budgetMs: () => 100_000,
      callTimeoutMs: () => 150_000,
      logger: { warn: () => {} },
      now: () => { clock += 60_000; return clock },
    })
    const agent = agentDouble(fx.sessionId, [event('tool/call', 1, NOW + 10, { turn: 1, step: 1, name: 'bash', arguments: '{}' })])

    // When: the agent claims completion
    const decision = await gate(completion(agent))

    // Then: no judge call was started (issue #1828), the outcome is recorded as a
    // budget stop rather than an anomaly, and the execution is not judged failed.
    expect(decision?.kind).toBe('deny')
    expect((decision as { kind: 'deny', reason: string }).reason).toContain('验收未完成')
    const verification = verificationOf(fx.ledger)
    expect(budgetAttempts(verification)).toHaveLength(1)
    expect(exceptionAttempts(verification)).toHaveLength(0)
    expect(qualityAttempts(verification)).toHaveLength(0)
    expect(verification.attempts[0]?.usage.calls).toBe(0)
    expect(verification.failedReason).toBeUndefined()
  })

  it('operator who configures the judge ceiling sees a per-call timeout charged as an anomaly, not an abort', async () => {
    // Given: a judge whose stream only ends when its own request signal fires,
    // and a ceiling far inside the outer acceptance budget
    const fx = fixture()
    const blocking = judgeRuntime((request: { messages: readonly { content: readonly { text?: string }[] }[]; signal?: AbortSignal }) => (async function * () {
      await new Promise<void>(resolve => {
        request.signal?.addEventListener('abort', () => { resolve() }, { once: true })
      })
      yield { type: 'text-delta', index: 0, text: '<score_A> A </score_A>' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })())
    const gate = createGoalVerificationGate({
      ledger: fx.ledger,
      llm: () => blocking as never,
      goals: () => goalDouble('active') as never,
      budgetMs: () => 600_000,
      callTimeoutMs: () => 30_000,
      logger: { warn: () => {} },
      now: () => NOW,
    })
    const agent = agentDouble(fx.sessionId, [event('tool/call', 1, NOW + 10, { turn: 1, step: 1, name: 'bash', arguments: '{}' })])
    vi.useFakeTimers()
    try {
      // When: the agent claims completion and every configured ceiling elapses
      // (three bounded retries at 30s each)
      let decision: Awaited<ReturnType<typeof gate>> | undefined
      const pending = gate(completion(agent)).then((result) => { decision = result })
      for (let turn = 0; turn < 8 && decision === undefined; turn += 1) await vi.advanceTimersByTimeAsync(30_000)
      await pending

      // Then: the acceptance ended on the CONFIGURED per-call ceiling as a
      // bounded anomaly with no verdict; the outer budget was never what ended it.
      expect(decision?.kind).toBe('deny')
      const verification = verificationOf(fx.ledger)
      expect(exceptionAttempts(verification)).toHaveLength(1)
      expect(exceptionAttempts(verification)[0]?.error).toContain('timed out after 30s')
      expect(qualityAttempts(verification)).toHaveLength(0)
      expect(verification.failedReason).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('user whose provider plugin replaced the public llm.stream still gets a real acceptance verdict', async () => {
    // Given: a runtime whose public single-argument stream() was replaced by a
    // third-party provider plugin with the llm/stream listener signature — the
    // shape that produced "next(...) is not a function or its return value is
    // not async iterable" and recorded every acceptance as an anomaly.
    const fx = fixture()
    const runtime = judgeLlm({ grade: 'A' })
    const clobbered = {
      ...runtime,
      stream: (options: unknown, next?: unknown) => {
        // Faithful to the broken plugin: invoked with the public single-argument
        // call, next is undefined and delegating to it throws this TypeError.
        const delegated = next as (() => AsyncIterable<unknown>) | undefined
        if (typeof delegated !== 'function') {
          throw new TypeError('next(...) is not a function or its return value is not async iterable')
        }
        return delegated()
      },
    }
    const gate = gateOver({ ledger: fx.ledger, llm: clobbered, goal: goalDouble('active') })
    const agent = agentDouble(fx.sessionId, [
      event('tool/call', 1, NOW + 10, { turn: 1, step: 1, name: 'run_code', arguments: '{}' }),
      event('tool/result', 2, NOW + 20, { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'ok' }] } }),
    ])

    // When: the agent claims completion
    const decision = await gate(completion(agent))

    // Then: the acceptance reaches the model through the registration-bound
    // dispatch, the work is judged on its merits, and no anomaly is recorded.
    expect(decision).toEqual({ kind: 'allow' })
    const verification = verificationOf(fx.ledger)
    expect(exceptionAttempts(verification)).toHaveLength(0)
    expect(passedAttempt(verification)?.passed).toBe(true)
  })

  it('user whose runtime exposes no prepareCall still gets an acceptance through the public stream', async () => {
    // Given: a runtime that only offers the historical public stream(options)
    const fx = fixture()
    const plain = judgeLlm({ grade: 'A' }) as { prepareCall?: unknown }
    delete plain.prepareCall
    const gate = gateOver({ ledger: fx.ledger, llm: plain, goal: goalDouble('active') })
    const agent = agentDouble(fx.sessionId, [
      event('tool/call', 1, NOW + 10, { turn: 1, step: 1, name: 'run_code', arguments: '{}' }),
      event('tool/result', 2, NOW + 20, { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'ok' }] } }),
    ])

    // When: the agent claims completion
    const decision = await gate(completion(agent))

    // Then: the fallback keeps an older or proxied service working.
    expect(decision).toEqual({ kind: 'allow' })
    expect(passedAttempt(verificationOf(fx.ledger))?.passed).toBe(true)
  })

  it('user with a task that never became a goal run is not gated', async () => {
    // Given: an execution whose /goal was refused (applicability goal-unavailable)
    const fx = fixture()
    const execution = fx.ledger.getTask('task-a')!.executions[0]!
    fx.ledger.setVerification('task-a', execution.id, {
      contract: resolveContract({ enabled: true, model: '', reasoningEffort: '' }, catalog()),
      attempts: [],
      applicability: 'goal-unavailable',
    })
    const gate = gateOver({ ledger: fx.ledger, llm: judgeLlm({ grade: 'T' }), goal: goalDouble('active') })
    const agent = agentDouble(fx.sessionId, [event('tool/call', 1, NOW + 10, { turn: 1, step: 1, name: 'bash', arguments: '{}' })])

    // When: the agent claims completion
    const decision = await gate(completion(agent))

    // Then: the plain-turn execution keeps its historical behaviour and spends nothing.
    expect(decision).toBeUndefined()
    expect(qualityAttempts(verificationOf(fx.ledger))).toHaveLength(0)
  })

  it('user whose teammate claims completion sees no independent teammate acceptance', async () => {
    // Given: a team member execution (the Lead carries the team acceptance)
    const fx = fixture()
    const execution = fx.ledger.getTask('task-a')!.executions[0]!
    fx.ledger.setVerification('task-a', execution.id, {
      contract: resolveContract({ enabled: true, model: '', reasoningEffort: '' }, catalog()),
      attempts: [],
      applicability: 'team-member',
    })
    const gate = gateOver({ ledger: fx.ledger, llm: judgeLlm({ grade: 'T' }), goal: goalDouble('active') })
    const agent = agentDouble(fx.sessionId, [event('tool/call', 1, NOW + 10, { turn: 1, step: 1, name: 'bash', arguments: '{}' })])

    // When: the teammate claims completion
    const decision = await gate(completion(agent))

    // Then: the call is not this gate's business.
    expect(decision).toBeUndefined()
    expect(qualityAttempts(verificationOf(fx.ledger))).toHaveLength(0)
  })

  it('user changing the settings mid-run sees this execution keep its frozen contract', async () => {
    // Given: an execution frozen with the host-inherited contract
    const fx = fixture()
    const frozen = verificationOf(fx.ledger).contract
    const gate = gateOver({ ledger: fx.ledger, llm: judgeLlm({ grade: 'A' }), goal: goalDouble('active') })
    const agent = agentDouble(fx.sessionId, [event('tool/call', 1, NOW + 10, { turn: 1, step: 1, name: 'bash', arguments: '{}' })])

    // When: the agent claims completion
    const decision = await gate(completion(agent))

    // Then: the acceptance judges with the frozen route, and neither the
    // contract nor its source is rewritten by the running acceptance.
    expect(decision).toEqual({ kind: 'allow' })
    const verification = verificationOf(fx.ledger)
    expect(verification.contract).toEqual(frozen)
    expect(qualityAttempts(verification)[0]!.route).toEqual(frozen.route)
  })

  it('user reading the gate report sees both rounds, the swapped slots and the averaged criterion', async () => {
    // Given: a judge that grades the work A on the first round and N on the second
    const fx = fixture()
    const prompts: string[] = []
    const gate = gateOver({
      ledger: fx.ledger,
      // The work is graded A on the first round and T on the second, so the
      // averaged criterion lands mid-scale. The second round carries the
      // citation the veto needs, so this stays a real quality verdict.
      llm: judgeLlm({
        reject: (prompt, call) => {
          if (call % 2 === 0) {
            const workInA = !prompt.slice(prompt.indexOf('<<<TRAJECTORY_A'), prompt.indexOf('<<<END_TRAJECTORY_A')).includes(EMPTY_WORK_BASELINE)
            return workInA ? '<score_A> A </score_A>\n<score_B> T </score_B>' : undefined
          }
          return rejectingAnswer({ call })
        },
        onCall: prompt => { prompts.push(prompt) },
      }),
      goal: goalDouble('active'),
    })
    const agent = agentDouble(fx.sessionId, workingSession())

    // When: the agent claims completion
    await gate(completion(agent))

    // Then: each criterion was judged twice with the A/B slots swapped, and its
    // score is the average of the two rounds (A=1.0, T=0.0).
    const attempt = qualityAttempts(verificationOf(fx.ledger))[0]!
    expect(attempt.rounds).toBe(2)
    expect(attempt.criteria).toHaveLength(3)
    expect(attempt.criteria[0]!.score).toBeCloseTo(0.5, 0.0001)
    expect(attempt.passed).toBe(false)
    const workIsA = prompts.filter(prompt => !prompt.slice(prompt.indexOf('<<<TRAJECTORY_A'), prompt.indexOf('<<<END_TRAJECTORY_A')).includes(EMPTY_WORK_BASELINE))
    expect(workIsA).toHaveLength(3)
    expect(prompts.length).toBe(6)
  })

  it('user with a reused session sees only this execution evidence in the report', () => {
    // Given: a session log whose earlier task ran before this execution started
    const events = [
      event('user/message', 1, NOW - 5_000, { source: { kind: 'user' }, content: [{ type: 'text', text: 'an earlier task' }] }),
      event('tool/call', 2, NOW - 4_000, { turn: 1, step: 1, name: 'bash', arguments: '{"command":"echo old"}' }),
      event('tool/result', 3, NOW - 3_000, { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'old output' }] } }),
      event('user/message', 4, NOW + 1_000, { source: { kind: 'goal' }, content: [{ type: 'text', text: 'do work' }] }),
      event('tool/call', 5, NOW + 2_000, { turn: 2, step: 1, name: 'bash', arguments: '{"command":"echo new"}' }),
      event('tool/result', 6, NOW + 3_000, { turn: 2, step: 1, message: { content: [{ type: 'text', text: 'new output' }] } }),
    ]

    // When: the evidence for an execution started at NOW is collected
    const evidence = collectEvidence({ snapshotEvents: () => events }, 'the current task', NOW)

    // Then: the older task's events are outside the window and never reach a judge.
    expect(evidence.trace).toContain('new output')
    expect(evidence.trace).not.toContain('old output')
    expect(evidence.trace).not.toContain('an earlier task')
    expect(evidence.fromSeq).toBe(4)
    expect(evidence.toSeq).toBe(6)
  })

  it('user reading the acceptance contract sees an unsupported effort replaced by the model default', () => {
    // Given: an explicit judge model and an effort that model does not declare
    const settings: VerificationSettings = { enabled: true, model: 'deepseek-official/deepseek-pro', reasoningEffort: 'high' }

    // When: the contract resolves
    const contract = resolveContract(settings, catalog())

    // Then: the incompatible value is not sent, and the fallback is explicit.
    expect(contract.route).toEqual({ provider: 'deepseek-official', model: 'deepseek-pro', reasoningEffort: 'medium' })
    expect(contract.effortFallback).toEqual({ requested: 'high', resolved: 'medium' })
  })

  it('user reading a judge prompt sees the reference context only when host changes exist', () => {
    // Given: one criterion and a host-observed change summary
    const criterion = { id: 'output_match', name: 'Output Match', description: 'inspect observed output' }

    // When: the prompt is rendered with and without the host's record
    const without = buildAcceptancePrompt('do work', 'work', EMPTY_WORK_BASELINE, criterion)
    const with_ = buildAcceptancePrompt('do work', 'work', EMPTY_WORK_BASELINE, criterion, undefined, 'Host-recorded workspace changes: 1 changed file')

    // Then: the block is its own delimited data block, and its presence changes
    // the delimiter token so a prompt can never mix the two evidence sets.
    expect(without).not.toContain('CONTEXT')
    expect(with_).toContain('<<<CONTEXT')
    expect(with_).toContain('Host-recorded workspace changes: 1 changed file')
    expect(evidenceNonce('do work', 'Host-recorded workspace changes: 1 changed file', 'work', EMPTY_WORK_BASELINE)).not.toBe(evidenceNonce('do work', 'work', EMPTY_WORK_BASELINE))
  })

  it('user inheriting both model and effort sees the host configuration resolved', () => {
    // Given: blank settings that inherit everything
    const settings: VerificationSettings = { enabled: true, model: '', reasoningEffort: '' }

    // When: the contract resolves against the host catalog
    const contract = resolveContract(settings, catalog())

    // Then: the host catalog default route and level are frozen, marked inherited.
    expect(contract.modelSource).toBe('inherit')
    expect(contract.route).toEqual({ provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' })
    expect(contract.threshold).toBe(VERIFICATION_THRESHOLD)
  })

  it('user whose host records workspace changes sees them handed to the judge as host evidence', async () => {
    // Given: a host change service and a session whose turn recorded a change event
    const fx = fixture()
    const prompts: string[] = []
    const gate = gateOver({
      ledger: fx.ledger,
      llm: judgeLlm({ grade: 'A', onCall: prompt => { prompts.push(prompt) } }),
      goal: goalDouble('active'),
      workspace: workspaceDouble(),
    })
    const agent = agentDouble(fx.sessionId, [
      event('tool/call', 1, NOW + 10, { turn: 2, step: 1, name: 'bash', arguments: '{}' }),
      event('workspace/changes', 2, NOW + 20, { turn: 2 }),
    ])

    // When: the agent claims completion
    const decision = await gate(completion(agent))

    // Then: every judge prompt carries the host's own diff as its reference
    // context, and the recorded evidence names how many files it showed.
    expect(decision).toEqual({ kind: 'allow' })
    expect(prompts).toHaveLength(6)
    expect(prompts[0]).toContain('<<<CONTEXT')
    expect(prompts[0]).toContain('Host-recorded workspace changes')
    expect(prompts[0]).toContain('+new line')
    expect(qualityAttempts(verificationOf(fx.ledger))[0]!.evidence.workspaceFiles).toBe(1)
  })

  it('user whose change service fails sees the acceptance fall back to the trajectory alone', async () => {
    // Given: a change service whose comparison throws
    const fx = fixture()
    const warnings: string[] = []
    const prompts: string[] = []
    const gate = gateOver({
      ledger: fx.ledger,
      llm: judgeLlm({ grade: 'A', onCall: prompt => { prompts.push(prompt) } }),
      goal: goalDouble('active'),
      workspace: workspaceDouble({ fail: true }),
      warn: message => { warnings.push(message) },
    })
    const agent = agentDouble(fx.sessionId, [
      event('tool/call', 1, NOW + 10, { turn: 2, step: 1, name: 'bash', arguments: '{}' }),
      event('workspace/changes', 2, NOW + 20, { turn: 2 }),
    ])

    // When: the agent claims completion
    const decision = await gate(completion(agent))

    // Then: the verdict still lands — the failed read degraded the evidence
    // instead of failing the acceptance — and the report says which files it
    // could not compare.
    expect(decision).toEqual({ kind: 'allow' })
    expect(prompts[0]).toContain('[comparison unavailable]')
    expect(prompts[0]).toContain('<<<CONTEXT')
    expect(warnings.some(message => message.includes('one file'))).toBe(true)
    expect(qualityAttempts(verificationOf(fx.ledger))[0]!.evidence.workspaceFiles).toBe(1)
  })

  it('user whose deployment records no workspace changes sees a prompt without a reference block', async () => {
    // Given: an execution and no host change service at all
    const fx = fixture()
    const prompts: string[] = []
    const gate = gateOver({
      ledger: fx.ledger,
      llm: judgeLlm({ grade: 'A', onCall: prompt => { prompts.push(prompt) } }),
      goal: goalDouble('active'),
    })
    const agent = agentDouble(fx.sessionId, [event('tool/call', 1, NOW + 10, { turn: 2, step: 1, name: 'bash', arguments: '{}' })])

    // When: the agent claims completion
    await gate(completion(agent))

    // Then: the prompt is the trajectory-only prompt and nothing claims host
    // evidence was reviewed.
    expect(prompts[0]).not.toContain('<<<CONTEXT')
    expect(verificationOf(fx.ledger).attempts[0]!.evidence.workspaceFiles).toBeUndefined()
  })

  it('user whose deployment serves no model catalog sees an explicit route-unavailable anomaly', async () => {
    // Given: an execution frozen with no resolvable judge route
    const fx = fixture({ catalog: { groups: [] } })
    const gate = gateOver({ ledger: fx.ledger, llm: judgeLlm({ grade: 'A' }), goal: goalDouble('active') })
    const agent = agentDouble(fx.sessionId, [event('tool/call', 1, NOW + 10, { turn: 1, step: 1, name: 'bash', arguments: '{}' })])

    // When: the agent claims completion
    const decision = await gate(completion(agent))

    // Then: the claim is refused as an anomaly, so an unusable judge route can
    // never be mistaken for a passed acceptance.
    expect(decision?.kind).toBe('deny')
    expect((decision as { kind: 'deny', reason: string }).reason).toContain('裁判路由不可用')
    expect(exceptionAttempts(verificationOf(fx.ledger))).toHaveLength(1)
  })

  it('user whose completion call was already cancelled sees the host cancellation win', async () => {
    // Given: an aborted call
    const fx = fixture()
    const gate = gateOver({ ledger: fx.ledger, llm: judgeLlm({ grade: 'T' }), goal: goalDouble('active') })
    const controller = new AbortController()
    controller.abort()

    // When: the gate sees the cancelled call
    const decision = await gate(completion(agentDouble(fx.sessionId, []), { signal: controller.signal }))

    // Then: the gate decides nothing and spends nothing.
    expect(decision).toBeUndefined()
    expect(qualityAttempts(verificationOf(fx.ledger))).toHaveLength(0)
  })

  it('user completing an execution the board no longer owns sees an ungated call', async () => {
    // Given: a settled execution
    const fx = fixture()
    const execution = fx.ledger.getTask('task-a')!.executions[0]!
    fx.ledger.settle('task-a', execution.id, 'failed', 'done')
    const gate = gateOver({ ledger: fx.ledger, llm: judgeLlm({ grade: 'T' }), goal: goalDouble('active') })

    // When: the session claims completion afterwards
    const decision = await gate(completion(agentDouble(fx.sessionId, [])))

    // Then: a session the board no longer owns is not gated.
    expect(decision).toBeUndefined()
  })

  it('user whose stored acceptance block is malformed sees it dropped instead of trusted', () => {
    // Given: a hand-edited acceptance block with an unusable attempt
    const broken = { contract: { enabled: true, modelSource: 'inherit', preset: 'coding', threshold: 0.65 }, attempts: [{ index: 1 }], applicability: 'enforced' }

    // When: the ledger repairs it
    const repaired = normalizeVerification(broken)

    // Then: it is dropped (fail closed), so the execution is treated as unverified.
    expect(repaired).toBeUndefined()
  })
})

describe('invalid acceptance: a veto nobody could verify', () => {
  it('user whose judge vetoes with a citation of the reviewed trajectory sees one quality attempt spent and locatable feedback', async () => {
    // Given: a judge that vetoes with a finding quoting the reviewed trajectory
    const fx = fixture()
    const gate = gateOver({ ledger: fx.ledger, llm: judgeLlm({ reject: (_prompt, call) => rejectingAnswer({ call }) }), goal: goalDouble('active') })
    const agent = agentDouble(fx.sessionId, workingSession())

    // When: the agent claims completion
    const decision = await gate(completion(agent))

    // Then: the veto became a REAL quality verdict, so it spent exactly one
    // quality attempt and the returned feedback carries the citation.
    expect(decision?.kind).toBe('deny')
    const reason = (decision as { kind: 'deny', reason: string }).reason
    expect(reason).toContain(FIXTURE_TOOL_OUTPUT)
    const verification = verificationOf(fx.ledger)
    expect(qualityAttempts(verification)).toHaveLength(1)
    expect(invalidAttempts(verification)).toHaveLength(0)
    expect(qualityAttempts(verification)[0]?.criterionFindings?.[0]?.location).toBe('trajectory')
  })

  it('user whose judge vetoes without evidence sees the invalid retries bounded, then a hold and no further judge call', async () => {
    // Given: a judge that always vetoes with no finding at all
    const fx = fixture()
    const goal = goalDouble('active')
    let calls = 0
    const gate = gateOver({ ledger: fx.ledger, llm: judgeLlm({ grade: 'T', onCall: () => { calls += 1 } }), goal })
    const agent = agentDouble(fx.sessionId, workingSession())

    // When: the agent claims completion three times
    await gate(completion(agent))
    const second = await gate(completion(agent))
    const callsAfterTwo = calls
    const third = await gate(completion(agent))

    // Then: two invalid acceptances each ran their own judge calls, the third
    // made none, the quality budget is intact and the card was never failed.
    expect(callsAfterTwo).toBe(MAX_INVALID_ATTEMPTS * 2 * 3)
    expect(calls).toBe(callsAfterTwo)
    const verification = verificationOf(fx.ledger)
    expect(invalidAttempts(verification)).toHaveLength(MAX_INVALID_ATTEMPTS)
    expect(qualityAttempts(verification)).toHaveLength(0)
    expect(hasInvalidBudget(verification)).toBe(false)
    expect(verification.failedReason).toBeUndefined()
    expect(verification.applicability).toBe('enforced')
    expect(verificationPhase(verification)).toBe('invalid')
    expect(goal.blocks).toEqual([])
    const reason = (third as { kind: 'deny', reason: string }).reason
    expect(reason).toContain('验收无效')
    expect(reason).toContain('等待人工处理')
    expect(reason).not.toContain('质量判负')
    expect((second as { kind: 'deny', reason: string }).reason).toContain('未消耗质量验收额度')
  })

  it('operator reopening the board after a Host restart sees the invalid attempts and their bound preserved', async () => {
    // Given: an execution that already spent both invalid attempts
    const dir = scratch()
    const ledger = new HostTaskLedger(dir, () => NOW)
    ledger.applyRequest('req-create', { kind: 'create', id: 'task-a', input: { title: 'Ship it', description: '', prompt: 'do work' } })
    const execution = ledger.applyRequest('req-run', { kind: 'run', taskId: 'task-a' }).runs![0]!.execution
    ledger.attachSession('task-a', execution.id, 'session-a')
    ledger.setVerification('task-a', execution.id, {
      contract: resolveContract({ enabled: true, model: '', reasoningEffort: '' }, catalog()),
      attempts: [],
      applicability: 'enforced',
    })
    const gate = gateOver({ ledger, llm: judgeLlm({ grade: 'T' }), goal: goalDouble('active') })
    const agent = agentDouble('session-a', workingSession())
    await gate(completion(agent))
    await gate(completion(agent))
    expect(invalidAttempts(verificationOf(ledger))).toHaveLength(MAX_INVALID_ATTEMPTS)
    ledger.dispose()

    // When: a fresh Host process loads the same ledger and the agent claims
    // completion yet again
    const reloaded = new HostTaskLedger(dir, () => NOW)
    let calls = 0
    const reloadedGate = gateOver({ ledger: reloaded, llm: judgeLlm({ grade: 'T', onCall: () => { calls += 1 } }), goal: goalDouble('active') })
    const decision = await reloadedGate(completion(agentDouble('session-a', workingSession())))

    // Then: the bound survived the restart, so no judge call is made at all and
    // the execution still is not failed.
    expect(calls).toBe(0)
    expect((decision as { kind: 'deny', reason: string }).reason).toContain('等待人工处理')
    expect(invalidAttempts(verificationOf(reloaded))).toHaveLength(MAX_INVALID_ATTEMPTS)
    expect(verificationOf(reloaded).failedReason).toBeUndefined()
    reloaded.dispose()
  })

  it('user clearing an invalid hold sees the acceptance reopen and a later evidence-backed veto book a quality verdict', async () => {
    // Given: an execution held after spending its invalid attempts
    const fx = fixture()
    const gate = gateOver({ ledger: fx.ledger, llm: judgeLlm({ grade: 'T' }), goal: goalDouble('active') })
    const agent = agentDouble(fx.sessionId, workingSession())
    await gate(completion(agent))
    await gate(completion(agent))
    const held = verificationOf(fx.ledger)
    expect(held.failedReason).toBeUndefined()
    expect(verificationPhase(held)).toBe('invalid')

    // When: the operator clears the recorded invalid acceptances
    const executionId = fx.ledger.getTask('task-a')!.executions[0]!.id
    const cleared = withoutAcceptanceAnomalies(held)
    if (cleared === undefined) throw new Error('the invalid attempts were not cleared')
    fx.ledger.setVerification('task-a', executionId, cleared)

    // Then: the invalid budget is open again, and a fresh EVIDENCE-BACKED veto
    // is booked as a quality verdict rather than held.
    const reopened = verificationOf(fx.ledger)
    expect(invalidAttempts(reopened)).toHaveLength(0)
    expect(reopened.failedReason).toBeUndefined()
    const recovered = gateOver({ ledger: fx.ledger, llm: judgeLlm({ reject: (_prompt, call) => rejectingAnswer({ call }) }), goal: goalDouble('active') })
    await recovered(completion(agent))
    expect(qualityAttempts(verificationOf(fx.ledger))).toHaveLength(1)
    expect(invalidAttempts(verificationOf(fx.ledger))).toHaveLength(0)
  })

  it('user reading an invalid hold and its retry feedback is told there was no usable veto and no failure', () => {
    // Given: an invalid attempt and the remaining invalid budget it left
    const attempt = {
      index: 1,
      at: NOW,
      stage: 'invalid' as const,
      passed: false,
      score: 0.1,
      baseline: 0.1,
      criteria: [],
      findings: [],
      usage: { calls: 6, inputTokens: 10, outputTokens: 5, reasoningTokens: 1 },
      evidence: { chars: 100, omittedCharacters: 0, entries: 2, hash: 'h' },
      route: { provider: 'deepseek-official', model: 'deepseek-flash' },
      channel: 'explicit-tag' as const,
      rounds: 2,
      invalidReason: 'missing-finding' as const,
    }

    // When: the hold reason and the retry feedback are rendered
    const hold = invalidHoldReason(MAX_INVALID_ATTEMPTS)
    const feedback = invalidAcceptanceFeedback(attempt, 1)

    // Then: each names the invalid acceptance, the untouched quality budget and
    // the human action, and neither reads as an evidence-backed quality veto.
    expect(hold).toContain('验收无效')
    expect(hold).toContain('等待人工处理')
    expect(hold).not.toContain('质量判负')
    expect(feedback).toContain('验收无效')
    expect(feedback).toContain('未消耗质量验收额度')
    expect(feedback).toContain('不把本次执行判为失败')
    expect(feedback).toContain('未达标的判据没有对应的结构化问题反馈')
  })
})

