/**
 * Automatic cleanup of acceptance-only detail.
 *
 * The acceptance mechanism persists findings and invalid diagnostics while a
 * cycle is open — that material is what a repair and a review need. Once an
 * execution PASSES and its settlement is durable, the detail is removed
 * automatically and only a lightweight audit credential remains. Everything a
 * failed or invalid execution produced stays.
 *
 * These cases drive the real Host service, ledger and settlement path over a
 * contract-shaped gateway, and read the real files the board owns, so "nothing
 * else was touched" is checked against the filesystem rather than asserted.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TypertGateway } from '@deepseek-ai/dsh-api-gateway'
import { afterEach, describe, expect, it } from 'vitest'
import { HostTaskLedger } from '../src/host-ledger.ts'
import { TaskBoardHostService } from '../src/host-service.ts'
import { PowerInhibitor } from '../src/power-inhibitor.ts'
import {
  resolveContract,
  withAcceptanceDetailCleared,
  type ExecutionVerification,
  type ModelCatalogView,
  type VerificationAttempt,
  type VerificationSettings,
} from '../src/core/verification.ts'

const NOW = 1_700_000_000_000
const homes: string[] = []
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

function home(): string {
  const value = mkdtempSync(join(tmpdir(), 'dsh-task-board-cleanup-'))
  homes.push(value)
  return value
}

/** The board's own home directory inside one test home. */
function boardDir(root: string): string {
  return join(root, 'task-board')
}

function catalog(): ModelCatalogView {
  return {
    default: { provider: 'deepseek-official', model: 'deepseek-flash' },
    groups: [{ id: 'deepseek-official', models: [{ id: 'deepseek-flash' }] }],
  }
}

const SETTINGS: VerificationSettings = { enabled: true, model: '', reasoningEffort: '' }

/** A quality attempt carrying locatable detail (the material a review reads). */
function detailedAttempt(overrides: Partial<VerificationAttempt> = {}): VerificationAttempt {
  return {
    index: 1,
    at: NOW,
    stage: 'quality',
    passed: true,
    score: 0.9,
    baseline: 0.1,
    criteria: [{ id: 'output_match', name: 'Output Match', score: 0.9, baseline: 0.1, threshold: 0.65, passed: true }],
    findings: ['[Output Match trajectory] "npm run build exited 0"'],
    criterionFindings: [{
      criterionId: 'output_match',
      requirement: 'the build must emit dist/index.js',
      observation: 'dist/index.js is present',
      gap: 'none',
      quote: 'npm run build exited 0',
      location: 'trajectory',
    }],
    usage: { calls: 6, inputTokens: 100, outputTokens: 20, reasoningTokens: 5 },
    evidence: { chars: 500, omittedCharacters: 0, entries: 4, hash: 'abc123' },
    route: { provider: 'deepseek-official', model: 'deepseek-flash' },
    channel: 'explicit-tag',
    rounds: 2,
    ...overrides,
  }
}

/** A verification block in the given shape. */
function block(attempts: readonly VerificationAttempt[], overrides: Partial<ExecutionVerification> = {}): ExecutionVerification {
  return { contract: resolveContract(SETTINGS, catalog()), attempts: [...attempts], applicability: 'enforced', ...overrides }
}

/** The gateway double: only what boot, the roster poll and settlement read. */
function gatewayDouble(): TypertGateway {
  return {
    invoke: async (request: { namespace: string; method: string }) => {
      if (request.namespace === 'agentPresets') return { presets: [] }
      if (request.method === 'list') return { items: [{ sessionId: 'session-a', running: false, agentAvailable: false, updatedAt: NOW, blank: false }] }
      if (request.method === 'projections') return { values: { goal: { goal: { id: 'goal-1', revision: 2, phase: 'complete' }, roundsStarted: 1 } } }
      throw new Error('unexpected gateway call ' + request.namespace + '/' + request.method)
    },
    stream: async () => ({
      async *[Symbol.asyncIterator]() {
        yield {
          type: 'snapshot',
          header: {},
          cursor: 10,
          hasMore: false,
          projections: {},
          records: [{ type: 'event', event: { type: 'turn/end', seq: 10, time: NOW + 100, data: { reason: { kind: 'completed' } } } }],
        }
      },
    }),
  } as unknown as TypertGateway
}

/** The real service over one ledger, with the interval captured so a test can poll. */
function serviceOver(ledger: HostTaskLedger): { service: TaskBoardHostService, poll: () => Promise<void> } {
  const intervals: Array<() => void> = []
  const service = new TaskBoardHostService(gatewayDouble(), {
    ledger,
    power: new PowerInhibitor({ platform: 'linux' }),
    now: () => NOW,
    goalRunEnabled: () => true,
    verificationSettings: () => SETTINGS,
    verificationCatalog: async () => catalog(),
    timers: { timeout: () => () => {}, interval: (callback: () => void) => { intervals.push(callback); return () => {} } },
  })
  return {
    service,
    poll: async () => {
      for (const callback of intervals) callback()
      for (let turn = 0; turn < 80; turn += 1) await Promise.resolve()
    },
  }
}

/** Seed one task with one unsettled execution carrying the given acceptance. */
function seedRunning(ledger: HostTaskLedger, verification: ExecutionVerification): string {
  // The card opts into the native goal: the option is off by default and every
  // case here is about an execution that reached the acceptance layer.
  ledger.applyRequest('create-1', { kind: 'create', id: 'task-a', input: { title: 'Ship it', description: '', prompt: 'do work', goalRun: true } })
  const execution = ledger.applyRequest('run-1', { kind: 'run', taskId: 'task-a' }).runs![0]!.execution
  ledger.attachSession('task-a', execution.id, 'session-a')
  ledger.setVerification('task-a', execution.id, verification)
  return execution.id
}

/** How many locatable findings one attempt still carries (a reloaded one omits it when empty). */
function locatedCount(attempt: VerificationAttempt): number {
  return (attempt.criterionFindings ?? []).length
}

/** Read one execution's verification block back from a FRESH ledger read. */
function readVerification(root: string, executionId: string): ExecutionVerification {
  const ledger = new HostTaskLedger(boardDir(root), () => NOW)
  const task = ledger.getTask('task-a')
  if (task === undefined) throw new Error('the persisted ledger carried no task-a')
  const verification = task.executions.find(entry => entry.id === executionId)?.verification
  ledger.dispose()
  if (verification === undefined) throw new Error('the persisted ledger carried no verification for ' + executionId)
  return verification
}

describe('acceptance-detail cleanup: what a passed settlement keeps and removes', () => {
  it('user whose accepted execution settles sees the findings removed and the audit credential kept', async () => {
    // Given: a running execution whose acceptance recorded locatable findings
    const root = home()
    const ledger = new HostTaskLedger(boardDir(root), () => NOW)
    const id = seedRunning(ledger, block([detailedAttempt()]))
    const { service, poll } = serviceOver(ledger)
    service.start()

    // When: the roster poll settles it as succeeded
    await poll()
    service.dispose()

    // Then: the bulky detail is gone, while the pass record the completion gate
    // needs — verdict, scores, route, evidence hash — survives.
    const verification = readVerification(root, id)
    expect(locatedCount(verification.attempts[0]!)).toBe(0)
    expect(verification.attempts[0]?.findings).toEqual([])
    expect(verification.attempts[0]?.passed).toBe(true)
    expect(verification.attempts[0]?.score).toBeCloseTo(0.9)
    expect(verification.attempts[0]?.evidence.hash).toBe('abc123')
    expect(verification.cleanup?.state).toBe('cleaned')
    expect(verification.cleanup?.cleanedAt).toBe(NOW)
    expect(verification.cleanup?.audit[0]?.findingSummary).toContain('已移除的可定位问题 1 条')
  })

  it('operator whose execution failed sees every detail kept for the repair', async () => {
    // Given: a FAILED execution that already holds a real quality veto
    const root = home()
    const ledger = new HostTaskLedger(boardDir(root), () => NOW)
    const id = seedRunning(ledger, block([detailedAttempt({ passed: false })]))
    ledger.settle('task-a', id, 'failed', 'the judge rejected the work')
    const { service } = serviceOver(ledger)

    // When: the Host boots and runs its catch-up pass
    service.start()
    service.dispose()

    // Then: nothing was removed — the findings are what the next attempt reads.
    const verification = readVerification(root, id)
    expect(verification.cleanup).toBeUndefined()
    expect(verification.attempts[0]?.criterionFindings).toHaveLength(1)
    expect(verification.attempts[0]?.findings).toHaveLength(1)
  })

  it('operator whose acceptance was invalid sees the invalid diagnostics kept for a human review', async () => {
    // Given: an execution whose acceptance budget produced only invalid verdicts
    const root = home()
    const ledger = new HostTaskLedger(boardDir(root), () => NOW)
    const invalid = detailedAttempt({ stage: 'invalid', passed: false, invalidReason: 'missing-finding', error: '验收无效：没有可定位的问题' })
    const id = seedRunning(ledger, block([invalid]))
    ledger.settle('task-a', id, 'failed', 'invalid acceptance')
    const { service } = serviceOver(ledger)

    // When: the Host boots
    service.start()
    service.dispose()

    // Then: the invalid reasons stay: an invalid acceptance is exactly what a
    // human is asked to look at.
    const verification = readVerification(root, id)
    expect(verification.attempts[0]?.invalidReason).toBe('missing-finding')
    expect(verification.cleanup).toBeUndefined()
  })
})

describe('acceptance-detail cleanup: idempotency, catch-up and failure', () => {
  it('operator booting the Host again sees an already-cleaned execution left completely alone', () => {
    // Given: a settled, passed execution cleaned exactly once
    const root = home()
    const ledger = new HostTaskLedger(boardDir(root), () => NOW)
    const id = seedRunning(ledger, block([detailedAttempt()]))
    ledger.setVerification('task-a', id, withAcceptanceDetailCleared(ledger.getTask('task-a')!.executions[0]!.verification!, NOW)!)
    ledger.settle('task-a', id, 'succeeded')
    const revision = ledger.state().revision
    const { service } = serviceOver(ledger)

    // When: the Host boots and re-runs its catch-up pass
    service.start()
    service.dispose()

    // Then: the cleanup did not rewrite the ledger at all — the revision stands
    // and the recorded cleanup count is still the first one. (The Host's own
    // scheduler bookkeeping is written by boot, not by the cleanup.)
    expect(ledger.state().revision).toBe(revision)
    expect(readVerification(root, id).cleanup?.attempts).toBe(1)
    expect(readVerification(root, id).cleanup?.state).toBe('cleaned')
  })

  it('operator restarting the Host after a crash sees the interrupted cleanup completed', async () => {
    // Given: a settled, passed execution whose cleanup never ran (the process
    // stopped between the settlement and the cleanup)
    const root = home()
    const first = new HostTaskLedger(boardDir(root), () => NOW)
    const id = seedRunning(first, block([detailedAttempt(), detailedAttempt({ index: 2 })]))
    first.settle('task-a', id, 'succeeded')
    expect(first.getTask('task-a')!.executions[0]!.verification!.attempts[0]!.findings).toHaveLength(1)
    first.dispose()

    // When: a fresh Host process loads the same ledger and boots
    const reloaded = new HostTaskLedger(boardDir(root), () => NOW)
    const { service } = serviceOver(reloaded)
    service.start()
    service.dispose()

    // Then: the catch-up pass cleaned it and the audit names both attempts.
    const verification = readVerification(root, id)
    expect(verification.cleanup?.state).toBe('cleaned')
    expect(verification.cleanup?.audit).toHaveLength(2)
    expect(verification.attempts.every(attempt => attempt.findings.length === 0)).toBe(true)
  })

  it('operator whose cleanup write fails sees the pass survive, the failure recorded and the restart heal it', () => {
    // Given: a settled, passed execution and a ledger whose cleanup write fails
    const root = home()
    const seeding = new HostTaskLedger(boardDir(root), () => NOW)
    const id = seedRunning(seeding, block([detailedAttempt()]))
    seeding.settle('task-a', id, 'succeeded')
    seeding.dispose()
    const ledger = new HostTaskLedger(boardDir(root), () => NOW)
    let failures = 1
    const flaky = new Proxy(ledger, {
      get(target, property, receiver) {
        if (property === 'setVerification') {
          return (taskId: string, executionId: string, verification: ExecutionVerification): boolean => {
            if (verification.cleanup !== undefined && failures > 0) {
              failures -= 1
              throw new Error('disk full')
            }
            return target.setVerification(taskId, executionId, verification)
          }
        }
        return Reflect.get(target, property, receiver)
      },
    }) as HostTaskLedger
    const { service } = serviceOver(flaky)

    // When: the Host boots and the cleanup write fails
    service.start()
    service.dispose()

    // Then: the PASS is untouched (the completion gate still sees it), the
    // failure is recorded so a reader can see the cleanup is pending, and the
    // failed attempt deleted nothing.
    const afterFailure = readVerification(root, id)
    expect(afterFailure.attempts[0]?.passed).toBe(true)
    expect(afterFailure.cleanup?.state).toBe('failed')
    expect(afterFailure.cleanup?.lastError).toContain('disk full')
    expect(afterFailure.attempts[0]?.criterionFindings).toHaveLength(1)

    // And the next Host start retries it successfully.
    const healed = new HostTaskLedger(boardDir(root), () => NOW)
    const second = serviceOver(healed)
    second.service.start()
    second.service.dispose()
    const recovered = readVerification(root, id)
    expect(recovered.cleanup?.state).toBe('cleaned')
    expect(recovered.attempts[0]?.passed).toBe(true)
  })
})

describe('acceptance-detail cleanup: ownership and scope', () => {
  it('operator with a failed and a passed execution sees only the passed one cleaned', async () => {
    // Given: one task with an earlier FAILED execution and a later running one
    const root = home()
    const ledger = new HostTaskLedger(boardDir(root), () => NOW)
    ledger.applyRequest('create-1', { kind: 'create', id: 'task-a', input: { title: 'Ship it', description: '', prompt: 'do work', goalRun: true } })
    const failed = ledger.applyRequest('run-1', { kind: 'run', taskId: 'task-a' }).runs![0]!.execution
    ledger.attachSession('task-a', failed.id, 'session-1')
    ledger.setVerification('task-a', failed.id, block([detailedAttempt({ passed: false })]))
    ledger.settle('task-a', failed.id, 'failed', 'first attempt failed')
    const passed = ledger.applyRequest('run-2', { kind: 'rerun', taskId: 'task-a' }).runs![0]!.execution
    ledger.attachSession('task-a', passed.id, 'session-a')
    ledger.setVerification('task-a', passed.id, block([detailedAttempt()]))
    const { service, poll } = serviceOver(ledger)
    service.start()

    // When: the later execution settles as succeeded
    await poll()
    service.dispose()

    // Then: ONLY the passed execution lost its detail; the failed one still
    // holds everything a repair needs, and the card itself is untouched.
    const task = new HostTaskLedger(boardDir(root), () => NOW).getTask('task-a')!
    const failedVerification = task.executions.find(entry => entry.id === failed.id)!.verification!
    const passedVerification = task.executions.find(entry => entry.id === passed.id)!.verification!
    expect(failedVerification.cleanup).toBeUndefined()
    expect(failedVerification.attempts[0]?.criterionFindings).toHaveLength(1)
    expect(passedVerification.cleanup?.state).toBe('cleaned')
    expect(task.title).toBe('Ship it')
    expect(task.prompt).toBe('do work')
  })

  it('operator running a cleanup sees no user file and no unrelated file removed', async () => {
    // Given: a board home beside a user file of the operator's own
    const root = home()
    const ledger = new HostTaskLedger(boardDir(root), () => NOW)
    const id = seedRunning(ledger, block([detailedAttempt()]))
    const userFile = join(root, 'user-notes.md')
    writeFileSync(userFile, 'do not delete me')
    const boardFiles = readdirSync(boardDir(root)).filter(name => name !== 'ledger-v2.lock').sort()
    const rootFiles = readdirSync(root).sort()
    const { service, poll } = serviceOver(ledger)
    service.start()

    // When: the execution settles as succeeded and the cleanup runs
    await poll()
    service.dispose()

    // Then: the cleanup removed the detail from the LEDGER, and touched nothing
    // else: no user file changed, no unrelated file appeared or vanished. The
    // board directory is compared without its own lock file, which the live
    // ledger legitimately holds open.
    expect(readVerification(root, id).cleanup?.state).toBe('cleaned')
    expect(readFileSync(userFile, 'utf8')).toBe('do not delete me')
    expect(readdirSync(root).sort()).toEqual(rootFiles)
    // Nothing the cleanup ran over was deleted: every file that existed before
    // still exists, in both the home and the board directory.
    for (const name of boardFiles) expect(readdirSync(boardDir(root))).toContain(name)
    for (const name of rootFiles) expect(readdirSync(root)).toContain(name)
  })
})
