/**
 * One-shot schedules and run budgets.
 *
 * The scheduler owns two invariants here: a rule's counter only moves when the
 * Host actually opened an execution, and a rule that reached its cap (or whose
 * single instant has fired) stops itself in the ledger — not through anything
 * the execution agent does. These tests drive the ledger directly with a fixed
 * clock, so no wall-clock wait is involved.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HostTaskLedger } from '../src/host-ledger.ts'
import { applySetSchedule } from '../src/core/use-cases/task-schedule.ts'
import { createTask, scheduleRunBudget, scheduleExhausted, type TaskRecord } from '../src/core/tasks.ts'

const roots: string[] = []
const NOW = new Date(2026, 7, 16, 10, 0, 30).getTime()
const MINUTE = 60_000

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-task-board-budget-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** Create a one-shot card through the same action path the UI uses. */
function createOnce(ledger: HostTaskLedger, id: string, at: number): void {
  ledger.applyRequest('create-' + id, {
    kind: 'create', id,
    input: { title: id, description: '', prompt: 'work', schedule: { enabled: true, mode: 'once', at } },
  })
}

/** Create a recurring card capped at `maxRuns`. */
function createCapped(ledger: HostTaskLedger, id: string, maxRuns: number): void {
  ledger.applyRequest('create-' + id, {
    kind: 'create', id,
    input: { title: id, description: '', prompt: 'work', schedule: { enabled: true, cron: '* * * * *', maxRuns } },
  })
}

function ruleOf(ledger: HostTaskLedger, id: string) {
  return ledger.state().tasks.find(task => task.id === id)!.schedule!
}

describe('schedule plan validation', () => {
  const base: readonly TaskRecord[] = [createTask({ title: 't', description: '', prompt: '' }, NOW, 't')]
  const set = (patch: Parameters<typeof applySetSchedule>[2]) => applySetSchedule(base, 't', patch, NOW, 'UTC')

  it('operator arming a one-shot with a past, equal or fractional instant is refused', () => {
    // Given a card and a clock
    // When each unusable instant is submitted
    // Then only a future whole-millisecond instant is accepted
    expect(set({ mode: 'once', enabled: true, at: NOW }).applied).toBe(false)
    expect(set({ mode: 'once', enabled: true, at: NOW - 1 }).applied).toBe(false)
    expect(set({ mode: 'once', enabled: true, at: NOW + 1.5 }).applied).toBe(false)
    const accepted = set({ mode: 'once', enabled: true, at: NOW + MINUTE })
    expect(accepted.applied).toBe(true)
    expect(accepted.tasks[0].schedule).toMatchObject({ mode: 'once', enabled: true, at: NOW + MINUTE, nextRunAt: NOW + MINUTE })
    expect(accepted.tasks[0].schedule?.cron).toBeUndefined()
  })

  it('operator setting a run cap that is not a positive whole number is refused', () => {
    // Given a card
    // When zero, negative and fractional caps are submitted
    // Then they are refused and a positive whole number is stored
    expect(set({ enabled: true, cron: '* * * * *', maxRuns: 0 }).applied).toBe(false)
    expect(set({ enabled: true, cron: '* * * * *', maxRuns: -2 }).applied).toBe(false)
    expect(set({ enabled: true, cron: '* * * * *', maxRuns: 1.5 }).applied).toBe(false)
    const two = set({ enabled: true, cron: '* * * * *', maxRuns: 2 })
    expect(two.applied).toBe(true)
    expect(two.tasks[0].schedule).toMatchObject({ mode: 'cron', maxRuns: 2, runCount: 0 })
  })

  it('operator re-arming a stopped rule starts a fresh budget and clears its stop record', () => {
    // Given a stopped capped rule that already spent its budget
    const stopped: readonly TaskRecord[] = [{
      ...base[0],
      schedule: {
        enabled: false, mode: 'cron', cron: '0 9 * * *', nextRunAt: undefined, lastTriggeredAt: NOW - 1_000,
        runCount: 2, maxRuns: 2, endedAt: NOW - 1_000, endedReason: 'limit',
      },
    }]
    // When the operator arms it again
    const rearmed = applySetSchedule(stopped, 't', { enabled: true }, NOW, 'UTC')
    // Then the counter restarts and the previous stop record is gone
    expect(rearmed.applied).toBe(true)
    expect(rearmed.tasks[0].schedule?.runCount).toBe(0)
    expect(rearmed.tasks[0].schedule?.endedReason).toBeUndefined()
    expect(rearmed.tasks[0].schedule?.endedAt).toBeUndefined()
  })

  it('operator editing a live rule keeps its consumed count, and lowering the cap ends it', () => {
    // Given a live rule that already ran one of two allowed runs
    const live: readonly TaskRecord[] = [{
      ...base[0],
      schedule: {
        enabled: true, mode: 'cron', cron: '0 9 * * *', timeZone: 'UTC', nextRunAt: NOW + 1_000, lastTriggeredAt: NOW - 1_000,
        runCount: 1, maxRuns: 2,
      },
    }]
    // When the operator raises the cap and then lowers it below what ran
    const recapped = applySetSchedule(live, 't', { maxRuns: 5 }, NOW, 'UTC')
    const lowered = applySetSchedule(live, 't', { maxRuns: 1 }, NOW, 'UTC')
    // Then the counter survives the edit, and the lowered cap ends the rule
    expect(recapped.tasks[0].schedule?.runCount).toBe(1)
    expect(recapped.tasks[0].schedule?.maxRuns).toBe(5)
    expect(lowered.tasks[0].schedule?.enabled).toBe(false)
    expect(lowered.tasks[0].schedule?.endedReason).toBe('limit')
  })
})

describe('one-shot schedules', () => {
  it('operator due one-shot opens exactly one execution and stops itself in the same commit', () => {
    // Given an armed one-shot
    const ledger = new HostTaskLedger(tempRoot(), () => NOW)
    const at = NOW + MINUTE
    createOnce(ledger, 'once', at)
    expect(ruleOf(ledger, 'once').nextRunAt).toBe(at)
    expect(ledger.nextArmedRunAt(NOW)).toBe(at)

    // When the planned instant arrives
    const opened = ledger.openScheduled('once', at)

    // Then one run opened, is counted, and the rule is spent and disarmed
    expect(opened).toHaveLength(1)
    const rule = ruleOf(ledger, 'once')
    expect(rule.runCount).toBe(1)
    expect(rule.enabled).toBe(false)
    expect(rule.endedReason).toBe('fired')
    expect(rule.nextRunAt).toBeUndefined()
    expect(scheduleExhausted(rule)).toBe(true)
    expect(scheduleRunBudget(rule)).toBe(1)
    // A stale timer (or a hand call) can never open a second run.
    expect(ledger.openScheduled('once', at + MINUTE)).toEqual([])
    expect(ledger.state().tasks.find(task => task.id === 'once')!.executions).toHaveLength(1)
    ledger.dispose()
  })

  it('operator whose one-shot instant passed while the board was down sees it skipped, not charged', () => {
    // Given an armed one-shot
    const ledger = new HostTaskLedger(tempRoot(), () => NOW)
    createOnce(ledger, 'once', NOW + MINUTE)

    // When the board wakes long after the planned instant
    ledger.skipMissed(NOW + 5 * MINUTE)

    // Then the occurrence is skipped, not replayed, and nothing was charged
    const rule = ruleOf(ledger, 'once')
    expect(rule.enabled).toBe(false)
    expect(rule.endedReason).toBe('missed')
    expect(rule.runCount).toBe(0)
    expect(ledger.state().tasks[0].executions).toEqual([])
    expect(ledger.nextArmedRunAt(NOW + 5 * MINUTE)).toBeUndefined()
    ledger.dispose()
  })

  it('operator restarting after a one-shot fired sees it stay spent', () => {
    // Given a one-shot that already fired
    const root = tempRoot()
    const at = NOW + MINUTE
    const first = new HostTaskLedger(root, () => NOW)
    createOnce(first, 'once', at)
    first.openScheduled('once', at)
    first.dispose()

    // When the host restarts after the instant
    const second = new HostTaskLedger(root, () => at + MINUTE)
    second.skipMissed(at + MINUTE)
    second.openScheduled('once', at + MINUTE)

    // Then the spent plan stays spent
    expect(second.state().tasks[0].executions).toHaveLength(1)
    expect(second.state().tasks[0].schedule?.runCount).toBe(1)
    expect(second.state().tasks[0].schedule?.enabled).toBe(false)
    second.dispose()
  })

  it('operator cancelling a future one-shot leaves no armed target and no history', () => {
    // Given an armed one-shot
    const ledger = new HostTaskLedger(tempRoot(), () => NOW)
    createOnce(ledger, 'once', NOW + MINUTE)

    // When the operator disarms it
    ledger.applyRequest('cancel', { kind: 'set-schedule', taskId: 'once', patch: { enabled: false } })

    // Then nothing is armed, nothing ran, and no stop record was invented
    const rule = ruleOf(ledger, 'once')
    expect(rule.enabled).toBe(false)
    expect(rule.nextRunAt).toBeUndefined()
    expect(rule.endedReason).toBeUndefined()
    expect(rule.runCount).toBe(0)
    expect(ledger.nextArmedRunAt(NOW)).toBeUndefined()
    ledger.dispose()
  })
})

describe('refunded launch failures', () => {
  it('operator whose recurring launch failed sees the run refunded and the rule re-armed', () => {
    // Given a capped rule whose first occurrence opened a run
    const ledger = new HostTaskLedger(tempRoot(), () => NOW)
    createCapped(ledger, 'capped', 2)
    const due = ruleOf(ledger, 'capped').nextRunAt!
    const opened = ledger.openScheduled('capped', due)
    expect(opened).toHaveLength(1)

    // When the launch failed before any session existed and the service refunds
    // that occurrence
    ledger.refundScheduledOccurrence('capped', due)

    // Then the run is returned, the rule stays armed, and the skip is visible
    const refunded = ruleOf(ledger, 'capped')
    expect(refunded.runCount).toBe(0)
    expect(refunded.enabled).toBe(true)
    expect(refunded.skippedReason).toBe('launch-failed')

    // And the refunded failure does not consume the budget: two real opens
    // still fill the cap of two
    ledger.settle('capped', opened[0].execution.id, 'failed')
    const second = ledger.openScheduled('capped', refunded.nextRunAt!)
    ledger.settle('capped', second[0].execution.id, 'succeeded')
    const third = ledger.openScheduled('capped', ruleOf(ledger, 'capped').nextRunAt!)
    ledger.settle('capped', third[0].execution.id, 'succeeded')
    expect(ruleOf(ledger, 'capped').runCount).toBe(2)
    expect(ruleOf(ledger, 'capped').endedReason).toBe('limit')
    ledger.dispose()
  })

  it('operator whose capped rule hit its limit sees that limit lifted when the run is refunded', () => {
    // Given a rule capped at a single run whose occurrence spent the cap
    const ledger = new HostTaskLedger(tempRoot(), () => NOW)
    createCapped(ledger, 'capped', 1)
    const due = ruleOf(ledger, 'capped').nextRunAt!
    ledger.openScheduled('capped', due)
    expect(ruleOf(ledger, 'capped').endedReason).toBe('limit')

    // When that launch failed and the service refunds the occurrence
    ledger.refundScheduledOccurrence('capped', due)

    // Then the rule is re-armed at its next occurrence with a full budget
    const restored = ruleOf(ledger, 'capped')
    expect(restored.runCount).toBe(0)
    expect(restored.enabled).toBe(true)
    expect(restored.endedReason).toBeUndefined()
    expect(restored.endedAt).toBeUndefined()
    // The refund was observed at the fire instant (due), so the next minute is
    // the re-armed target.
    expect(restored.nextRunAt).toBe(due + MINUTE)
    expect(restored.skippedReason).toBe('launch-failed')
    ledger.dispose()
  })

  it('operator whose one-shot launch failed sees it end unspent and never replayed', () => {
    // Given a one-shot whose instant opened its single run
    const ledger = new HostTaskLedger(tempRoot(), () => NOW)
    const at = NOW + MINUTE
    createOnce(ledger, 'once', at)
    ledger.openScheduled('once', at)
    expect(ruleOf(ledger, 'once').endedReason).toBe('fired')

    // When that launch failed before any session existed and the occurrence is
    // refunded
    ledger.refundScheduledOccurrence('once', at)

    // Then the plan stopped unspent, with the failure visible, and the past
    // instant is not replayed
    const rule = ruleOf(ledger, 'once')
    expect(rule.runCount).toBe(0)
    expect(rule.enabled).toBe(false)
    expect(rule.endedReason).toBe('launch-failed')
    expect(ledger.openScheduled('once', at + MINUTE)).toEqual([])
    expect(ledger.state().tasks[0].executions).toHaveLength(1)
    ledger.dispose()
  })

  it('operator refunding a task with no rule changes nothing', () => {
    // Given a plain card with no schedule
    const ledger = new HostTaskLedger(tempRoot(), () => NOW)
    ledger.applyRequest('plain', { kind: 'create', id: 'plain', input: { title: 'plain', description: '', prompt: '' } })
    const before = ledger.state().revision

    // When a launch failure is reported for it
    ledger.refundScheduledOccurrence('plain', NOW)

    // Then the ledger is untouched
    expect(ledger.state().revision).toBe(before)
    expect(ledger.state().tasks[0].schedule).toBeUndefined()
    ledger.dispose()
  })
})

describe('capped recurring schedules', () => {
  it('operator capping a rule at two sees exactly two executions and an automatic stop', () => {
    // Given a rule capped at two runs
    const ledger = new HostTaskLedger(tempRoot(), () => NOW)
    createCapped(ledger, 'capped', 2)

    // When two occurrences come due (each settled before the next)
    const firstDue = ruleOf(ledger, 'capped').nextRunAt!
    const one = ledger.openScheduled('capped', firstDue)
    expect(one).toHaveLength(1)
    ledger.settle('capped', one[0].execution.id, 'succeeded')
    expect(ruleOf(ledger, 'capped').runCount).toBe(1)
    const secondDue = ruleOf(ledger, 'capped').nextRunAt!
    const two = ledger.openScheduled('capped', secondDue)
    expect(two).toHaveLength(1)
    ledger.settle('capped', two[0].execution.id, 'failed')

    // Then the budget is spent and the rule stopped itself; a third opens nothing
    const rule = ruleOf(ledger, 'capped')
    expect(rule.runCount).toBe(2)
    expect(rule.enabled).toBe(false)
    expect(rule.endedReason).toBe('limit')
    expect(rule.nextRunAt).toBeUndefined()
    expect(ledger.openScheduled('capped', secondDue + MINUTE)).toEqual([])
    expect(ledger.state().tasks[0].executions).toHaveLength(2)
    ledger.dispose()
  })

  it('operator restarting mid-budget sees the spent runs kept and the cap still enforced', () => {
    // Given a capped rule with one of its two runs already spent
    const root = tempRoot()
    const first = new HostTaskLedger(root, () => NOW)
    createCapped(first, 'capped', 2)
    const due = ruleOf(first, 'capped').nextRunAt!
    const one = first.openScheduled('capped', due)
    first.settle('capped', one[0].execution.id, 'succeeded')
    first.dispose()

    // When the host restarts and the next occurrence comes due
    const second = new HostTaskLedger(root, () => due + MINUTE)
    expect(second.state().tasks[0].schedule?.runCount).toBe(1)
    const next = ruleOf(second, 'capped').nextRunAt!
    expect(second.openScheduled('capped', next)).toHaveLength(1)

    // Then the cap still stops a later occurrence from opening a third run
    expect(ruleOf(second, 'capped').endedReason).toBe('limit')
    expect(second.openScheduled('capped', next + MINUTE)).toEqual([])
    expect(second.state().tasks[0].executions).toHaveLength(2)
    second.dispose()
  })

  it('operator who was running a task at its occurrence sees the skip consume no budget', () => {
    // Given a capped rule whose first run is already open
    const ledger = new HostTaskLedger(tempRoot(), () => NOW)
    createCapped(ledger, 'capped', 2)
    const firstDue = ruleOf(ledger, 'capped').nextRunAt!
    const one = ledger.openScheduled('capped', firstDue)
    expect(one).toHaveLength(1)

    // When the next occurrence arrives while that run is still open
    const secondDue = ruleOf(ledger, 'capped').nextRunAt!
    expect(ledger.openScheduled('capped', secondDue)).toEqual([])

    // Then the occurrence is skipped and the rule rolls one step forward
    const rule = ruleOf(ledger, 'capped')
    expect(rule.runCount).toBe(1)
    expect(rule.enabled).toBe(true)
    expect(rule.skippedReason).toBe('busy')
    expect(rule.nextRunAt).toBe(secondDue + MINUTE)
    ledger.dispose()
  })

  it('operator running a card by hand sees the scheduled budget untouched', () => {
    // Given a rule capped at two runs
    const ledger = new HostTaskLedger(tempRoot(), () => NOW)
    createCapped(ledger, 'capped', 2)

    // When the operator runs the card manually and that run settles
    const manual = ledger.applyRequest('run', { kind: 'run', taskId: 'capped' })
    expect(manual.runs).toHaveLength(1)
    expect(ruleOf(ledger, 'capped').runCount).toBe(0)
    ledger.settle('capped', manual.runs![0].execution.id, 'succeeded')

    // Then the manual run never consumed the scheduled budget
    expect(ruleOf(ledger, 'capped').runCount).toBe(0)
    ledger.dispose()
  })
})
