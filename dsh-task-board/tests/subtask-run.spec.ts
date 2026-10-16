/**
 * Cascade runs and deferred settlement on the Host ledger: one run request
 * opens an execution per subtree member under a shared run group, a parent
 * settles only after its own turn and its subtasks have settled, and the
 * lineage/depth gates hold at the Host boundary.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HostTaskLedger } from '../src/host-ledger.ts'
import { promptText } from '../src/host-runner.ts'
import { DEFAULT_SUBTASK_DEPTH, SUBTASK_DEPTH_MAX, teammateName } from '../src/core/subtask.ts'
import { createTask, type ExecutionRecord, type TaskRecord } from '../src/core/tasks.ts'

const roots: string[] = []
const NOW = 1_700_000_000_000

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-task-board-subtask-'))
  roots.push(root)
  return root
}

/** Seed one root with two idle subtasks through the real create action. */
function seedTree(ledger: HostTaskLedger): void {
  ledger.applyRequest('seed-root', { kind: 'create', id: 'root', input: { title: 'root', description: '', prompt: 'root' } })
  ledger.applyRequest('seed-a', { kind: 'create', id: 'a', input: { title: 'a', description: '', prompt: 'a', parentId: 'root' } })
  ledger.applyRequest('seed-b', { kind: 'create', id: 'b', input: { title: 'b', description: '', prompt: 'b', parentId: 'root' } })
}

function latest(task: TaskRecord | undefined): ExecutionRecord | undefined {
  return task?.executions.at(-1)
}

function find(ledger: HostTaskLedger, id: string): TaskRecord | undefined {
  return ledger.state().tasks.find(task => task.id === id)
}

describe('cascade run groups', () => {
  it('user running a parent opens one execution per subtask under a shared run group', () => {
    // Given a root with two idle subtasks
    const ledger = new HostTaskLedger(tempRoot(), () => NOW)
    seedTree(ledger)

    // When the user runs the parent
    const result = ledger.applyRequest('run-1', { kind: 'run', taskId: 'root' })

    // Then the root runs first, every participant shares one group, and all cards are running
    const runs = result.runs ?? []
    expect(runs.map(run => run.task.id)).toEqual(['root', 'a', 'b'])
    expect(new Set(runs.map(run => run.execution.runGroupId)).size).toBe(1)
    expect(ledger.state().tasks.map(task => task.status)).toEqual(['running', 'running', 'running'])
  })

  it('user sees the parent stay running until the last subtask settles', () => {
    // Given a running cascade whose parent turn already settled
    const ledger = new HostTaskLedger(tempRoot(), () => NOW)
    seedTree(ledger)
    ledger.applyRequest('run-1', { kind: 'run', taskId: 'root' })
    const rootExecution = latest(find(ledger, 'root'))?.id
    const aExecution = latest(find(ledger, 'a'))?.id
    const bExecution = latest(find(ledger, 'b'))?.id
    if (rootExecution === undefined || aExecution === undefined || bExecution === undefined) throw new Error('cascade did not open every execution')
    ledger.settle('root', rootExecution, 'succeeded')

    // When one subtask settles and one is still running
    ledger.settle('a', aExecution, 'succeeded')

    // Then the parent is still running and the settled subtask is done
    expect(find(ledger, 'root')?.status).toBe('running')
    expect(find(ledger, 'a')?.status).toBe('done')

    // When the last subtask settles
    ledger.settle('b', bExecution, 'succeeded')

    // Then the parent leaves running with the group verdict
    expect(find(ledger, 'root')?.status).toBe('done')
    expect(latest(find(ledger, 'root'))?.endedAt).toBe(NOW)
  })

  it('user sees a failed subtask fail the parent cascade', () => {
    // Given a running cascade
    const ledger = new HostTaskLedger(tempRoot(), () => NOW)
    seedTree(ledger)
    ledger.applyRequest('run-1', { kind: 'run', taskId: 'root' })
    const aExecution = latest(find(ledger, 'a'))?.id
    const bExecution = latest(find(ledger, 'b'))?.id
    const rootExecution = latest(find(ledger, 'root'))?.id
    if (aExecution === undefined || bExecution === undefined || rootExecution === undefined) throw new Error('cascade did not open every execution')

    // When a subtask fails and the rest succeed
    ledger.settle('a', aExecution, 'failed', 'agent turn ended with an error')
    ledger.settle('b', bExecution, 'succeeded')
    ledger.settle('root', rootExecution, 'succeeded')

    // Then the parent carries the failure and its message
    const parent = find(ledger, 'root')
    expect(parent?.status).toBe('failed')
    expect(latest(parent)?.error).toBe('agent turn ended with an error')
  })

  it('user sees a cascade parent settle once its subtasks finished before it did', () => {
    // Given a running cascade whose subtasks settle first
    const ledger = new HostTaskLedger(tempRoot(), () => NOW)
    seedTree(ledger)
    ledger.applyRequest('run-1', { kind: 'run', taskId: 'root' })
    const aExecution = latest(find(ledger, 'a'))?.id
    const bExecution = latest(find(ledger, 'b'))?.id
    const rootExecution = latest(find(ledger, 'root'))?.id
    if (aExecution === undefined || bExecution === undefined || rootExecution === undefined) throw new Error('cascade did not open every execution')
    ledger.settle('a', aExecution, 'succeeded')
    ledger.settle('b', bExecution, 'succeeded')

    // When the parent turn settles last
    ledger.settle('root', rootExecution, 'succeeded')

    // Then the parent finalizes immediately
    expect(find(ledger, 'root')?.status).toBe('done')
  })

  it('operator running a parent leaves an already running subtask out of the group', () => {
    // Given a subtask that is already running on its own
    const ledger = new HostTaskLedger(tempRoot(), () => NOW)
    seedTree(ledger)
    ledger.applyRequest('run-a', { kind: 'run', taskId: 'a' })

    // When the operator runs the parent
    const result = ledger.applyRequest('run-root', { kind: 'run', taskId: 'root' })

    // Then the cascade covers the root and the idle subtask only
    expect((result.runs ?? []).map(run => run.task.id)).toEqual(['root', 'b'])
    expect(find(ledger, 'a')?.executions).toHaveLength(1)
  })
})

describe('lineage gates at the Host boundary', () => {
  it('user creating a subtask of a subtask is refused at the configured depth', () => {
    // Given a deployment limited to one subtask level
    const ledger = new HostTaskLedger(tempRoot(), () => NOW, { maxSubtaskDepth: DEFAULT_SUBTASK_DEPTH })
    seedTree(ledger)

    // When the user tries to create a subtask under a subtask
    // Then the Host refuses it and the ledger keeps three tasks
    expect(() => ledger.applyRequest('create-c', {
      kind: 'create', id: 'c', input: { title: 'c', description: '', prompt: 'c', parentId: 'a' },
    })).toThrow('depth limit (1)')
    expect(ledger.state().tasks).toHaveLength(3)
  })

  it('user linking and detaching a task through the Host moves the parent link', () => {
    // Given a root and a free task
    const ledger = new HostTaskLedger(tempRoot(), () => NOW)
    ledger.applyRequest('create-root', { kind: 'create', id: 'root', input: { title: 'root', description: '', prompt: 'root' } })
    ledger.applyRequest('create-free', { kind: 'create', id: 'free', input: { title: 'free', description: '', prompt: 'free' } })

    // When the user links the free task and then detaches it
    const linked = ledger.applyRequest('link-1', { kind: 'set-parent', taskId: 'free', parentId: 'root' })
    expect(linked.state.tasks.find(task => task.id === 'free')?.parentId).toBe('root')
    const detached = ledger.applyRequest('link-2', { kind: 'set-parent', taskId: 'free', parentId: null })

    // Then the link is gone again
    expect(detached.state.tasks.find(task => task.id === 'free')?.parentId).toBeUndefined()
  })

  it('user detaching a running participant is refused so the cascade keeps its group', () => {
    // Given a cascade that is still in flight
    const ledger = new HostTaskLedger(tempRoot(), () => NOW)
    seedTree(ledger)
    ledger.applyRequest('run-1', { kind: 'run', taskId: 'root' })

    // When the user tries to detach a running participant
    // Then the Host refuses and the group stays intact
    expect(() => ledger.applyRequest('detach', { kind: 'set-parent', taskId: 'a', parentId: null }))
      .toThrow('running task cannot be re-parented')
    expect(find(ledger, 'a')?.parentId).toBe('root')
  })

  it('user deleting a parent that still has subtasks is refused by the Host', () => {
    // Given a root with subtasks
    const ledger = new HostTaskLedger(tempRoot(), () => NOW)
    seedTree(ledger)

    // When the user deletes the parent
    // Then the delete is refused and the tasks survive
    expect(() => ledger.applyRequest('delete-root', { kind: 'delete', taskId: 'root' })).toThrow('subtasks')
    expect(ledger.state().tasks).toHaveLength(3)
  })

  it('user archiving a parent takes its subtasks off the board with it', () => {
    // Given a root with two subtasks
    const ledger = new HostTaskLedger(tempRoot(), () => NOW)
    seedTree(ledger)

    // When the user archives the parent
    const archived = ledger.applyRequest('archive-root', { kind: 'archive', taskId: 'root' })

    // Then every member carries the archive stamp
    expect(archived.state.tasks.every(task => task.archivedAt === NOW)).toBe(true)
  })
})

describe('permission gates on a cascade', () => {
  it('user running a parent whose subtask has an unconfirmed elevated permission is refused', () => {
    // Given a subtask pinned above the session default without a confirmation
    const ledger = new HostTaskLedger(tempRoot(), () => NOW, { sessionDefaultPermission: 'read-only' })
    ledger.applyRequest('create-root', { kind: 'create', id: 'root', input: { title: 'root', description: '', prompt: 'root' } })
    ledger.applyRequest('create-child', {
      kind: 'create', id: 'child', input: { title: 'child', description: '', prompt: 'child', parentId: 'root', permission: 'danger-full-access' },
    })

    // When the user runs the parent
    // Then the whole cascade is refused before anything starts
    expect(() => ledger.applyRequest('run-1', { kind: 'run', taskId: 'root' })).toThrow('confirmation-required')
    expect(ledger.state().tasks.every(task => task.status === 'todo')).toBe(true)
  })

  it('operator due schedule opens the whole tree and shares one run group', () => {
    // Given a scheduled root with an idle subtask
    const ledger = new HostTaskLedger(tempRoot(), () => NOW)
    ledger.applyRequest('create-root', {
      kind: 'create', id: 'root', input: { title: 'root', description: '', prompt: 'root', schedule: { enabled: true, cron: '* * * * *' } },
    })
    ledger.applyRequest('create-child', { kind: 'create', id: 'child', input: { title: 'child', description: '', prompt: 'child', parentId: 'root' } })

    // When the schedule comes due
    const opened = ledger.openScheduled('root', NOW)

    // Then both run under one group
    expect(opened.map(run => run.task.id)).toEqual(['root', 'child'])
    expect(new Set(opened.map(run => run.execution.runGroupId)).size).toBe(1)
  })

  it('operator due schedule is refused while a subtask permission is unconfirmed', () => {
    // Given a scheduled root whose subtask is pinned above the session default
    const ledger = new HostTaskLedger(tempRoot(), () => NOW, { sessionDefaultPermission: 'read-only' })
    ledger.applyRequest('create-root', {
      kind: 'create', id: 'root', input: { title: 'root', description: '', prompt: 'root', schedule: { enabled: true, cron: '* * * * *' } },
    })
    ledger.applyRequest('create-child', {
      kind: 'create', id: 'child', input: { title: 'child', description: '', prompt: 'child', parentId: 'root', permission: 'danger-full-access' },
    })

    // When the scheduled occurrence comes due
    const due = find(ledger, 'root')!.schedule!.nextRunAt!
    const opened = ledger.openScheduled('root', due)

    // Then nothing ran, the schedule rolled one occurrence forward without
    // consuming the run budget, and the reason is recorded
    expect(opened).toEqual([])
    expect(find(ledger, 'root')?.schedule?.nextRunAt).toBe(due + 60_000)
    expect(find(ledger, 'root')?.schedule?.runCount).toBe(0)
    expect(ledger.state().scheduler.error).toContain('unconfirmed')
  })
})


describe('Agent Team runs', () => {
  it('user opting a task into Agent Team gets a Lead run and one teammate per subtask', () => {
    // Given a team-mode root with two subtasks
    const ledger = new HostTaskLedger(tempRoot(), () => NOW)
    ledger.applyRequest('seed-root', { kind: 'create', id: 'root', input: { title: 'root', description: '', prompt: 'root', teamRun: true } })
    ledger.applyRequest('seed-a', { kind: 'create', id: 'a', input: { title: 'a', description: '', prompt: 'a', parentId: 'root' } })
    ledger.applyRequest('seed-b', { kind: 'create', id: 'b', input: { title: 'b', description: '', prompt: 'b', parentId: 'root' } })

    // When the user runs it
    const runs = ledger.applyRequest('run-1', { kind: 'run', taskId: 'root' }).runs ?? []

    // Then only the root is launched by the Host and the subtasks are teammates
    expect(runs.map(run => [run.task.id, run.dispatch ?? 'session'])).toEqual([
      ['root', 'session'],
      ['a', 'teammate'],
      ['b', 'teammate'],
    ])
  })

  it('operator sees a team run close on its Lead verdict when no teammate reports one', () => {
    // Given a team-mode root whose two subtasks were dispatched as teammates
    const ledger = new HostTaskLedger(tempRoot(), () => NOW)
    ledger.applyRequest('seed-root', { kind: 'create', id: 'root', input: { title: 'root', description: '', prompt: 'root', teamRun: true } })
    ledger.applyRequest('seed-a', { kind: 'create', id: 'a', input: { title: 'a', description: '', prompt: 'a', parentId: 'root' } })
    ledger.applyRequest('seed-b', { kind: 'create', id: 'b', input: { title: 'b', description: '', prompt: 'b', parentId: 'root' } })
    const runs = ledger.applyRequest('run-1', { kind: 'run', taskId: 'root' }).runs ?? []
    const lead = runs.find(run => run.task.id === 'root')
    if (lead === undefined) throw new Error('expected the Lead execution to open')

    // When the Lead's own turn settles and no teammate ever reports a verdict
    ledger.settle('root', lead.execution.id, 'succeeded')

    // Then the Lead's verdict governs the run and nothing is left running
    const tasks = ledger.state().tasks
    expect(tasks.every(task => task.status !== 'running')).toBe(true)
    expect(tasks.find(task => task.id === 'root')?.status).toBe('done')
    expect(tasks.find(task => task.id === 'a')?.status).toBe('done')
    expect(tasks.find(task => task.id === 'b')?.status).toBe('done')
    expect(tasks.find(task => task.id === 'a')?.executions.at(-1)?.result).toBe('succeeded')
  })

  it('operator settles a stuck running card and it returns to the todo column', () => {
    // Given a cascade whose executions the Host can no longer observe
    const ledger = new HostTaskLedger(tempRoot(), () => NOW)
    seedTree(ledger)
    const runs = ledger.applyRequest('run-1', { kind: 'run', taskId: 'root' }).runs ?? []
    expect(runs).toHaveLength(3)

    // When the operator force-closes the run
    ledger.applyRequest('settle-1', { kind: 'settle', taskId: 'root' }, 'session-operator')

    // Then nothing is left running, the verdict is cancelled rather than
    // succeeded, the manual reason is recorded, and the cards can run again
    const tasks = ledger.state().tasks
    expect(tasks.every(task => task.status !== 'running')).toBe(true)
    expect(tasks.find(task => task.id === 'root')?.status).toBe('todo')
    expect(tasks.find(task => task.id === 'a')?.executions.at(-1)?.result).toBe('cancelled')
    expect(tasks.find(task => task.id === 'root')?.executions.at(-1)?.error).toContain('closed manually by session-operator')
    expect(() => ledger.applyRequest('rerun-1', { kind: 'rerun', taskId: 'root' })).not.toThrow()
  })

  it('operator plain run keeps every member on its own independent session', () => {
    // Given a root without the opt-in
    const ledger = new HostTaskLedger(tempRoot(), () => NOW)
    seedTree(ledger)

    // When the user runs the parent
    const runs = ledger.applyRequest('run-1', { kind: 'run', taskId: 'root' }).runs ?? []

    // Then no run asks for a teammate
    expect(runs.every(run => run.dispatch === undefined)).toBe(true)
  })

  it('operator team run refuses a subtask that pins its own above-default permission', () => {
    // Given a team-mode root whose subtask pins danger-full-access unconfirmed
    const ledger = new HostTaskLedger(tempRoot(), () => NOW, { sessionDefaultPermission: 'read-only' })
    ledger.applyRequest('seed-root', { kind: 'create', id: 'root', input: { title: 'root', description: '', prompt: 'root', teamRun: true } })
    ledger.applyRequest('seed-a', {
      kind: 'create', id: 'a', input: { title: 'a', description: '', prompt: 'a', parentId: 'root', permission: 'danger-full-access' },
    })

    // When the user runs it
    // Then the run is refused instead of silently dropping the subtask pin
    expect(() => ledger.applyRequest('run-1', { kind: 'run', taskId: 'root' })).toThrow(/team run cannot honor/)
    expect(ledger.state().tasks.every(task => task.status === 'todo')).toBe(true)
  })

  it('operator team run carries a subtask pin the confirmed Lead already covers', () => {
    // Given a team-mode root confirmed at full access and a subtask that pins a
    // narrower permission of its own, still above the session default
    const ledger = new HostTaskLedger(tempRoot(), () => NOW, { sessionDefaultPermission: 'read-only' })
    ledger.applyRequest('seed-root', {
      kind: 'create', id: 'root', input: { title: 'root', description: '', prompt: 'root', teamRun: true, permission: 'danger-full-access' },
    })
    ledger.applyRequest('seed-a', {
      kind: 'create', id: 'a', input: { title: 'a', description: '', prompt: 'a', parentId: 'root', permission: 'workspace-write' },
    })
    ledger.applyRequest('confirm', { kind: 'confirm-permission', taskId: 'root' })

    // When the user runs it
    const runs = ledger.applyRequest('run-1', { kind: 'run', taskId: 'root' }).runs ?? []

    // Then the teammate is dispatched: the Lead session it inherits from is at
    // least as wide as the pin, so nothing the card asked for is dropped
    expect(runs.map(run => [run.task.id, run.dispatch ?? 'session'])).toEqual([['root', 'session'], ['a', 'teammate']])
  })

  it('operator team run refuses a confirmed subtask pin above the Lead session permission', () => {
    // Given a team-mode root with no pin of its own and a subtask the human
    // already confirmed above the session default
    const ledger = new HostTaskLedger(tempRoot(), () => NOW, { sessionDefaultPermission: 'read-only' })
    ledger.applyRequest('seed-root', { kind: 'create', id: 'root', input: { title: 'root', description: '', prompt: 'root', teamRun: true } })
    ledger.applyRequest('seed-a', {
      kind: 'create', id: 'a', input: { title: 'a', description: '', prompt: 'a', parentId: 'root', permission: 'danger-full-access' },
    })
    ledger.applyRequest('confirm', { kind: 'confirm-permission', taskId: 'a' })

    // When the user runs it
    // Then it is refused rather than run at the Lead's narrower permission
    expect(() => ledger.applyRequest('run-1', { kind: 'run', taskId: 'root' })).toThrow(/team run cannot honor/)
    expect(ledger.state().tasks.every(task => task.status === 'todo')).toBe(true)
  })

  it('operator team run refuses an unconfirmed Lead binding like any other run', () => {
    // Given a team-mode root pinned above the session default without confirmation
    const ledger = new HostTaskLedger(tempRoot(), () => NOW, { sessionDefaultPermission: 'read-only' })
    ledger.applyRequest('seed-root', {
      kind: 'create', id: 'root', input: { title: 'root', description: '', prompt: 'root', teamRun: true, permission: 'danger-full-access' },
    })

    // When the user runs it
    // Then the confirmation gate still refuses the whole run
    expect(() => ledger.applyRequest('run-1', { kind: 'run', taskId: 'root' })).toThrow('confirmation-required')
  })

  it('operator team run under a confirmed Lead lets an inheriting subtask through', () => {
    // Given a team-mode root the human confirmed and a subtask with its own unset permission
    const ledger = new HostTaskLedger(tempRoot(), () => NOW, { sessionDefaultPermission: 'read-only' })
    ledger.applyRequest('seed-root', {
      kind: 'create', id: 'root', input: { title: 'root', description: '', prompt: 'root', teamRun: true, permission: 'danger-full-access' },
    })
    ledger.applyRequest('seed-a', { kind: 'create', id: 'a', input: { title: 'a', description: '', prompt: 'a', parentId: 'root' } })
    ledger.applyRequest('confirm', { kind: 'confirm-permission', taskId: 'root' })

    // When the user runs it
    const runs = ledger.applyRequest('run-1', { kind: 'run', taskId: 'root' }).runs ?? []

    // Then the inherited binding is the Lead's own and the teammate is dispatched
    expect(runs.filter(run => run.dispatch === 'teammate').map(run => run.task.id)).toEqual(['a'])
  })

  it('operator team run flattens a deeper tree into teammates of the Lead', () => {
    // Given a two-level team tree stored under a depth limit of two
    const ledger = new HostTaskLedger(tempRoot(), () => NOW, { maxSubtaskDepth: 2 })
    ledger.applyRequest('seed-root', { kind: 'create', id: 'root', input: { title: 'root', description: '', prompt: 'root', teamRun: true } })
    ledger.applyRequest('seed-a', { kind: 'create', id: 'a', input: { title: 'a', description: '', prompt: 'a', parentId: 'root' } })
    ledger.applyRequest('seed-b', { kind: 'create', id: 'b', input: { title: 'b', description: '', prompt: 'b', parentId: 'a' } })

    // When the user runs the root
    const runs = ledger.applyRequest('run-1', { kind: 'run', taskId: 'root' }).runs ?? []

    // Then every non-root member is a teammate of that one Lead
    expect(runs.filter(run => run.dispatch === 'teammate').map(run => run.task.id)).toEqual(['a', 'b'])
  })

  it('operator sees the run shape spelled out in the Lead prompt, one teammate per member', () => {
    // Given the members of a team run and the same members of a plain cascade
    const peers = [
      { id: 'a', title: '收集公开数据', name: 'subtask-0a1b2c3d' },
      { id: 'b', title: 'model', name: 'model-0a1b2c3d' },
    ]
    const root = createTask({ title: 'root', description: '', prompt: 'do it' }, NOW, 'root')

    // When each prompt is built
    const team = promptText({ ...root, teamRun: true }, { peers, team: true })
    const cascade = promptText(root, { peers })

    // Then the Lead prompt names the teammates and the cascade prompt the sessions
    expect(team).toContain('Agent Team 的 Lead')
    expect(team).toContain('subtask-0a1b2c3d')
    expect(cascade).toContain('并发开启 2 个独立 DSH 会话')
    expect(cascade).not.toContain('Agent Team 的 Lead')
  })

  it('operator reading a cron-triggered run sees its firing instant, zone and expression', () => {
    // Given a plain card and a scheduled-run provenance
    const root = createTask({ title: 'root', description: '', prompt: 'do it' }, NOW, 'root')
    const triggeredAt = Date.UTC(2026, 8, 29, 1, 0)

    // When the prompt is built for a cron trigger
    const scheduled = promptText(root, { schedule: { triggeredAt, timeZone: 'Asia/Shanghai', mode: 'cron', cron: '0 9 * * *' } })

    // Then the run is told when it fired and in which zone its clock is read
    expect(scheduled).toContain('定时规则自动触发')
    expect(scheduled).toContain('2026-09-29T01:00:00.000Z')
    expect(scheduled).toContain('Asia/Shanghai')
    expect(scheduled).toContain('0 9 * * *')
    expect(scheduled).toContain('do it')
    // A manual run carries no scheduling section at all.
    expect(promptText(root)).toBe('do it')
  })

  it('operator teammate names stay kebab-case and unique per run', () => {
    // Given CJK, mixed-case and short titles with two different run tokens
    // When the names are derived
    // Then each is an ASCII kebab-case name carrying its run token
    expect(teammateName('收集 公开混凝土数据!', 'a1b2c3d4-ffff')).toBe('subtask-a1b2c3d4')
    expect(teammateName('Collect Carbon Factors', 'a1b2c3d4-ffff')).toBe('collect-carbon-factors-a1b2c3d4')
    expect(teammateName('b', 'zzzz')).not.toBe(teammateName('b', 'yyyy'))
  })

  it('operator team run gives every CJK-titled subtask its own teammate name', () => {
    // Given the reported run: five CJK-only titles in one run group, where the
    // generic prefix collapsed all of them onto one teammate name and Agent
    // Teams refused every member after the first
    const titles = ['科研支线一：机器学习预测强度论文', '科研支线二：低碳混凝土论文', '第三阶段：系统扩展与企业应用', '专利申请工作', '收集公开数据']
    // When the names are derived with the member ids this run dispatches
    const names = titles.map((title, index) => teammateName(title, 'a1b2c3d4-ffff', `member-${index}`))
    // Then the Team never sees a duplicate name
    expect(new Set(names).size).toBe(names.length)
    expect(names.every(name => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(name))).toBe(true)
    // Two members that share a slug (identical or same-leading-word titles) differ too
    expect(teammateName('AI 强度预测', 'g1', 'member-a')).not.toBe(teammateName('AI 配比优化', 'g1', 'member-b'))
    expect(teammateName('same', 'g1', 'member-a')).not.toBe(teammateName('same', 'g1', 'member-b'))
    // And the derivation is a pure function of the member id, so the Lead prompt
    // and the spawn request always agree on the same name
    expect(teammateName('科研支线一：机器学习预测强度论文', 'a1b2c3d4-ffff', 'member-0'))
      .toBe(teammateName('科研支线一：机器学习预测强度论文', 'a1b2c3d4-ffff', 'member-0'))
  })

  it('operator reopening a board whose team run was left decided-but-open sees it folded at boot', () => {
    // Given an on-disk ledger where the Lead's own verdict is recorded while its
    // teammates are still open: the state a board can be left in when the
    // teammate sessions never expose a verdict of their own
    const dir = tempRoot()
    const first = new HostTaskLedger(dir, () => NOW)
    first.applyRequest('seed-root', { kind: 'create', id: 'root', input: { title: 'root', description: '', prompt: 'root', teamRun: true } })
    first.applyRequest('seed-a', { kind: 'create', id: 'a', input: { title: 'a', description: '', prompt: 'a', parentId: 'root' } })
    first.applyRequest('seed-b', { kind: 'create', id: 'b', input: { title: 'b', description: '', prompt: 'b', parentId: 'root' } })
    const runs = first.applyRequest('run-1', { kind: 'run', taskId: 'root' }).runs ?? []
    for (const run of runs) first.attachSession(run.task.id, run.execution.id, 'session-' + run.task.id)
    first.dispose()
    const file = join(dir, 'ledger-v2.json')
    const document = JSON.parse(readFileSync(file, 'utf8')) as {
      tasks: Array<{ id: string; executions: Array<{ ownResult?: string }> }>
    }
    const rootCard = document.tasks.find(task => task.id === 'root')
    if (rootCard === undefined) throw new Error('expected the root card in the ledger')
    rootCard.executions[0].ownResult = 'succeeded'
    writeFileSync(file, JSON.stringify(document, null, 2))

    // When the board is reopened
    const reopened = new HostTaskLedger(dir, () => NOW)

    // Then the decided run is folded instead of holding the running column
    const tasks = reopened.state().tasks
    expect(tasks.every(task => task.status !== 'running')).toBe(true)
    expect(tasks.find(task => task.id === 'root')?.status).toBe('done')
    expect(tasks.find(task => task.id === 'a')?.executions.at(-1)?.result).toBe('succeeded')
    expect(tasks.find(task => task.id === 'b')?.executions.at(-1)?.result).toBe('succeeded')
  })

  it('operator cron on a team card refuses when a subtask pins a permission', () => {
    // Given a team-mode scheduled root whose subtask pins above the session default
    const ledger = new HostTaskLedger(tempRoot(), () => NOW, { sessionDefaultPermission: 'read-only' })
    ledger.applyRequest('seed-root', {
      kind: 'create', id: 'root',
      input: { title: 'root', description: '', prompt: 'root', teamRun: true, schedule: { enabled: true, cron: '* * * * *' } },
    })
    ledger.applyRequest('seed-a', {
      kind: 'create', id: 'a', input: { title: 'a', description: '', prompt: 'a', parentId: 'root', permission: 'danger-full-access' },
    })

    // When the schedule comes due
    const opened = ledger.openScheduled('root', NOW)

    // Then nothing ran and the recorded reason names the team-mode limitation
    expect(opened).toEqual([])
    expect(ledger.state().scheduler.error).toContain('team run cannot honor')
  })
})
describe('stored lineage repair', () => {
  it('operator lowering the depth limit keeps the deeper links that were already stored', () => {
    // Given a three-level tree stored while the limit was three
    const root = tempRoot()
    const deep = new HostTaskLedger(root, () => NOW, { maxSubtaskDepth: SUBTASK_DEPTH_MAX })
    deep.applyRequest('create-l0', { kind: 'create', id: 'l0', input: { title: 'l0', description: '', prompt: 'l0' } })
    deep.applyRequest('create-l1', { kind: 'create', id: 'l1', input: { title: 'l1', description: '', prompt: 'l1', parentId: 'l0' } })
    deep.applyRequest('create-l2', { kind: 'create', id: 'l2', input: { title: 'l2', description: '', prompt: 'l2', parentId: 'l1' } })
    deep.dispose()

    // When the operator restarts with a limit of one
    const shallow = new HostTaskLedger(root, () => NOW, { maxSubtaskDepth: 1 })

    // Then the stored links survive while new deeper ones are refused
    expect(find(shallow, 'l2')?.parentId).toBe('l1')
    expect(() => shallow.applyRequest('create-l3', {
      kind: 'create', id: 'l3', input: { title: 'l3', description: '', prompt: 'l3', parentId: 'l2' },
    })).toThrow('depth limit (1)')
    shallow.dispose()
  })

  it('operator importing an on-board child of an archived parent drops only the link', () => {
    // Given an imported document pairing an archived parent with an on-board child
    const ledger = new HostTaskLedger(tempRoot(), () => NOW)
    const archivedParent: TaskRecord = { ...createTask({ title: 'p', description: '', prompt: 'p' }, NOW, 'p'), archivedAt: NOW }
    const child: TaskRecord = { ...createTask({ title: 'c', description: '', prompt: 'c' }, NOW, 'c'), parentId: 'p' }

    // When the document is imported
    ledger.applyRequest('import-hand', { kind: 'import', sourceId: 'hand', tasks: [archivedParent, child] })

    // Then the child survives as a root instead of pointing off-board
    expect(find(ledger, 'c')?.parentId).toBeUndefined()
    expect(find(ledger, 'p')?.archivedAt).toBe(NOW)
    ledger.dispose()
  })

  it('operator loading a ledger whose parent row vanished drops only the dangling link', () => {
    // Given a stored subtask whose parent row no longer resolves
    const root = tempRoot()
    const ledger = new HostTaskLedger(root, () => NOW)
    ledger.applyRequest('create-parent', { kind: 'create', id: 'parent', input: { title: 'parent', description: '', prompt: 'parent' } })
    ledger.applyRequest('create-child', { kind: 'create', id: 'child', input: { title: 'child', description: '', prompt: 'child', parentId: 'parent' } })
    ledger.dispose()
    const document = JSON.parse(readFileSync(ledger.file, 'utf8')) as { tasks: Array<{ id: string }> }
    document.tasks = document.tasks.filter(task => task.id !== 'parent')
    writeFileSync(ledger.file, JSON.stringify(document))

    // When the Host starts from that document
    const reloaded = new HostTaskLedger(root, () => NOW)

    // Then the task survives as a root instead of being dropped
    expect(find(reloaded, 'child')?.parentId).toBeUndefined()
    expect(find(reloaded, 'child')?.title).toBe('child')
    reloaded.dispose()
  })
})

describe('restart recovery', () => {
  it('operator restarting the host finalizes a deferred parent whose subtasks were interrupted', () => {
    // Given a cascade where only the parent session was recorded before the crash
    const root = tempRoot()
    const ledger = new HostTaskLedger(root, () => NOW)
    seedTree(ledger)
    const runs = ledger.applyRequest('run-1', { kind: 'run', taskId: 'root' }).runs ?? []
    const rootRun = runs.find(run => run.task.id === 'root')
    if (rootRun === undefined) throw new Error('cascade did not open the root execution')
    ledger.attachSession('root', rootRun.execution.id, 'session-root')
    ledger.settle('root', rootRun.execution.id, 'succeeded')
    ledger.dispose()

    // When the host restarts and cancels the subtasks that never got a session
    const restarted = new HostTaskLedger(root, () => NOW + 1)

    // Then the deferred parent leaves the running column with the group verdict
    expect(find(restarted, 'root')?.status).toBe('todo')
    expect(latest(find(restarted, 'root'))?.endedAt).toBe(NOW + 1)
    expect(find(restarted, 'a')?.executions[0]?.result).toBe('cancelled')
  })

  it('operator restarting the host still settles a deferred parent once its subtasks finish', () => {
    // Given a cascade whose parent turn settled while its subtasks were open
    const root = tempRoot()
    const ledger = new HostTaskLedger(root, () => NOW)
    seedTree(ledger)
    const runs = ledger.applyRequest('run-1', { kind: 'run', taskId: 'root' }).runs ?? []
    // The Host attaches the launched session before a restart can happen; an
    // interrupted start without one is cancelled by the recovery pass.
    for (const run of runs) ledger.attachSession(run.task.id, run.execution.id, 'session-' + run.task.id)
    const aExecution = latest(find(ledger, 'a'))?.id
    const bExecution = latest(find(ledger, 'b'))?.id
    const rootExecution = latest(find(ledger, 'root'))?.id
    if (aExecution === undefined || bExecution === undefined || rootExecution === undefined) throw new Error('cascade did not open every execution')
    ledger.settle('root', rootExecution, 'succeeded')
    ledger.dispose()

    // When the host restarts and the remaining subtasks settle
    const restarted = new HostTaskLedger(root, () => NOW + 1)
    restarted.settle('a', aExecution, 'succeeded')
    restarted.settle('b', bExecution, 'succeeded')

    // Then the run group survived and the parent finalizes
    expect(find(restarted, 'root')?.status).toBe('done')
    expect(find(restarted, 'a')?.status).toBe('done')
  })
})
