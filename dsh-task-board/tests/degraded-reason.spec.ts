/**
 * Degraded-ledger parsing contract (issues #1528, #1730).
 *
 * The shell's health route is a sibling package's payload, so the browser half
 * validates what it reads instead of rendering it: an unknown shape must fall
 * back to the board's own wording rather than showing an object as text.
 */
import { describe, expect, it } from 'vitest'
import { degradedRowOf, ledgerOwnerPid } from '../src/core/degraded-reason.ts'
import { TASK_BOARD_PACKAGE } from '../src/core/package-name.ts'

const PLUGIN = '@linxin666/dsh-client-ui-task-board'

describe('degradedRowOf', () => {
  it('operator sees this board row read back with its stage and reason', () => {
    // Given a health-route payload listing several degraded family rows
    const body = {
      ok: true,
      degraded: [
        { plugin: '@linxin666/dsh-pet', stage: 'import', message: 'stack', reason: 'pet failed', at: '2026-09-28T00:00:00.000Z' },
        { plugin: PLUGIN, stage: 'start', message: 'Error: locked', reason: 'task-board ledger is already owned by process 4242', at: '2026-09-28T00:00:01.000Z' },
      ],
    }
    // When the board looks up its own row
    // Then only its row is returned, with the reason the panel renders
    expect(degradedRowOf(body, PLUGIN)).toEqual({
      plugin: PLUGIN,
      stage: 'start',
      reason: 'task-board ledger is already owned by process 4242',
    })
  })

  it('operator whose row is healthy sees no degraded row at all', () => {
    // Given a ledger that names another plugin, or nothing
    const otherOnly = { ok: true, degraded: [{ plugin: '@linxin666/dsh-pet', stage: 'import', reason: 'x' }] }
    // When the board looks up its own row
    // Then it finds none, so the caller keeps its own failure wording
    expect(degradedRowOf(otherOnly, PLUGIN)).toBeUndefined()
    expect(degradedRowOf({ ok: true, degraded: [] }, PLUGIN)).toBeUndefined()
  })

  it('operator of a foreign or malformed payload gets no degraded row', () => {
    // Given answers that are not the shell's ledger shape
    const answers: unknown[] = [
      undefined,
      'nope',
      { ok: false, degraded: [] },
      { ok: true, degraded: null },
      { ok: true, degraded: [{ plugin: PLUGIN, stage: 'melted', reason: 'x' }] },
      { ok: true, degraded: [null, 7, { plugin: PLUGIN }] },
    ]
    // When each is parsed
    // Then none is trusted
    for (const answer of answers) expect(degradedRowOf(answer, PLUGIN)).toBeUndefined()
  })

  it('operator of a shell predating the reason field gets the row without copy', () => {
    // Given an older shell record that carries no reason line
    const legacy = { ok: true, degraded: [{ plugin: PLUGIN, stage: 'start', message: 'stack' }] }
    // When the board looks up its row
    // Then the row is recognized with empty copy, which the caller replaces
    expect(degradedRowOf(legacy, PLUGIN)).toEqual({ plugin: PLUGIN, stage: 'start', reason: '' })
  })

  it('operator looks up the package name the host half registers under', () => {
    // Given the compiled-in identity this plugin uses for its single-mount guard
    // When the browser half names its own row
    // Then the two are the same package name
    expect(TASK_BOARD_PACKAGE).toBe(PLUGIN)
  })
})

describe('ledgerOwnerPid', () => {
  it('operator is told which process owns the ledger lock', () => {
    // Given the lock refusal the Host records when a live process holds the ledger
    const reason = 'task-board ledger is already owned by process 4242'
    // When the reason is read for an owner
    // Then the owning pid is named
    expect(ledgerOwnerPid(reason)).toBe(4242)
    expect(ledgerOwnerPid('task-board ledger is already owned by process 4242 - another DSH process is using this ledger')).toBe(4242)
  })

  it('operator is not sent after a pid the reason itself says was reused', () => {
    // Given a crash leftover whose recorded pid now belongs to an unrelated
    // process: the reason carries the manual-removal step instead
    const crashLeftover = 'task-board ledger is already owned by process 3210; if this PID was reused after a crash and no other DSH host is running, remove C:/x/ledger-v2.lock manually and retry'
    // When the reason is read for an owner
    // Then no owner is named, so the raw reason keeps its own recovery step
    expect(ledgerOwnerPid(crashLeftover)).toBeUndefined()
  })

  it('operator sees no owner named for failures that are not a ledger lock', () => {
    // Given degraded reasons from other failure modes
    const reasons = [
      'Cannot find module @linxin666/dsh-x',
      'module has no usable plugin shape (expected a function or { apply })',
      '',
      'already owned by process not-a-number',
      'already owned by process 0',
    ]
    // When each is read for an owner
    // Then none names one
    for (const reason of reasons) expect(ledgerOwnerPid(reason)).toBeUndefined()
  })
})
