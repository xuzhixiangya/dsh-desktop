// @vitest-environment jsdom
/**
 * Client schedule helpers (issue #1722): the time-zone picker inventory and
 * the relative next-run wording the editors show.
 *
 * The helper is exercised through its public surface only; the picker's
 * inventory comes from the runtime's own `Intl.supportedValuesOf`, so the
 * assertions are about shape and containment rather than a fixed list.
 */
import { describe, expect, it } from 'vitest'
import {
  budgetLabel,
  defaultZonedInputValue,
  endedLabel,
  nextRunLabel,
  parseZonedInput,
  relativeTimeLabel,
  runCapOption,
  skippedLabel,
  zonedInputValue,
  zoneChoices,
} from '../src/client/schedule-zone.ts'
import type { ScheduleRule } from '../src/core/tasks.ts'

describe('zoneChoices', () => {
  it('operator picking a zone sees the Host zone first as the clearable default', () => {
    // Given a deployment whose Host reported a zone
    const host = 'Asia/Shanghai'

    // When the picker inventory is built
    const choices = zoneChoices(host)

    // Then the first entry clears the stored zone and names the Host zone,
    // and the Host zone is not offered a second time as an explicit choice
    expect(choices[0].id).toBe('')
    expect(choices[0].label).toContain(host)
    expect(choices.filter(choice => choice.id === host)).toHaveLength(0)
  })

  it('operator finds a zone from any region, not just the first few', () => {
    // Given a picker inventory over the runtime's own zone table
    const choices = zoneChoices('UTC')

    // When the user looks for zones late in the inventory
    // Then none is truncated away: a capped list would omit whole regions, and
    // a select whose value matches no option silently falls back to its first
    // one, so an omitted zone would make the editor show a different zone than
    // the rule stores
    const ids = new Set(choices.map(choice => choice.id))
    for (const zone of ['Europe/London', 'America/New_York', 'Asia/Tokyo', 'Pacific/Auckland']) {
      expect(ids.has(zone)).toBe(true)
    }
  })

  it('operator opening a rule whose stored zone is unknown here can still see it', () => {
    // Given a rule written under another ICU build whose zone this runtime's
    // inventory does not list
    const choices = zoneChoices('UTC', 'America/Argentina/Buenos_Aires')

    // When the picker inventory is built
    // Then the stored zone is offered, so opening the editor cannot rewrite it
    expect(choices.some(choice => choice.id === 'America/Argentina/Buenos_Aires')).toBe(true)
  })

  it('operator sees every offered zone as one the runtime can resolve, with no repeats', () => {
    // Given a picker inventory over the runtime's own zone table
    const choices = zoneChoices('UTC')

    // When the offered ids are inspected
    const ids = choices.map(choice => choice.id)

    // Then no id repeats and each explicit id resolves
    expect(new Set(ids).size).toBe(ids.length)
    expect(choices.length).toBeGreaterThan(0)
    for (const id of ids) {
      if (id === '') continue
      expect(() => new Intl.DateTimeFormat('en-US', { timeZone: id })).not.toThrow()
    }
  })

  it('operator on a Host that reports no zone can still store no zone', () => {
    // Given a Host snapshot that has not reported a zone yet
    // When the picker inventory is built
    const choices = zoneChoices(undefined)

    // Then the clearing entry is still first, so a rule can keep following the
    // Host, and the control can never silently show an unrelated zone
    expect(choices.length).toBeGreaterThan(0)
    expect(choices[0].id).toBe('')
    expect(choices.filter(choice => choice.id === '')).toHaveLength(1)
  })
})

describe('relativeTimeLabel', () => {
  it('operator reads a future run as the distance to it', () => {
    // Given a reference instant and a run 45 seconds later
    const now = Date.UTC(2026, 0, 1, 0, 0)

    // When the relative label is produced
    const soon = relativeTimeLabel(now + 45_000, now)
    const later = relativeTimeLabel(now + 90 * 60_000, now)

    // Then each carries its own distance
    expect(soon).toContain('45')
    expect(later).toContain('1')
  })

  it('operator reads an already-past run as overdue, worded apart from a future one', () => {
    // Given a reference instant with one run an hour past and one an hour ahead
    const now = Date.UTC(2026, 0, 1, 0, 0)

    // When both labels are produced
    const overdue = relativeTimeLabel(now - 60 * 60_000, now)
    const future = relativeTimeLabel(now + 60 * 60_000, now)

    // Then the overdue wording is distinct from the future wording
    expect(overdue).toContain('1')
    expect(overdue).not.toBe(future)
  })
})

describe('zoned datetime input', () => {
  it('operator picking a wall clock gets that zone instant back', () => {
    // Given a wall clock in an explicit zone
    const value = '2026-10-09T12:00'

    // When it is parsed and rendered back
    const parsed = parseZonedInput(value, 'Asia/Shanghai')!

    // Then the instant is the zone reading of that clock, and the field shows
    // the same wall clock again
    expect(parsed).toBe(Date.UTC(2026, 9, 9, 4, 0))
    expect(zonedInputValue(parsed, 'Asia/Shanghai')).toBe(value)
  })

  it('operator reading one instant in different zones sees each zone wall clock', () => {
    // Given one instant
    const instant = Date.UTC(2026, 0, 1, 0, 0)

    // When it is rendered in two zones
    // Then each zone shows its own wall clock for that instant
    expect(zonedInputValue(instant, 'UTC')).toBe('2026-01-01T00:00')
    expect(zonedInputValue(instant, 'Asia/Shanghai')).toBe('2026-01-01T08:00')
  })

  it('operator picking a wall clock the zone skips is refused instead of moved', () => {
    // Given a spring-forward gap, a non-date and an out-of-range clock
    // When each is parsed
    // Then each is refused rather than silently relocated
    expect(parseZonedInput('2026-03-08T02:30', 'America/New_York')).toBeUndefined()
    expect(parseZonedInput('not a date', 'UTC')).toBeUndefined()
    expect(parseZonedInput('2026-13-40T99:99', 'UTC')).toBeUndefined()
  })

  it('operator opening a fresh one-shot editor sees a near-future whole minute', () => {
    // Given a reference instant with seconds on the clock
    const now = Date.UTC(2026, 9, 9, 3, 15, 30)

    // When the default input value is produced
    const parsed = parseZonedInput(defaultZonedInputValue(now, 'UTC'), 'UTC')!

    // Then it is strictly in the future and lands on a whole minute
    expect(parsed).toBeGreaterThan(now)
    expect(parsed % 60_000).toBe(0)
  })
})

describe('run budget and stop labels', () => {
  const rule = (patch: Partial<ScheduleRule>): ScheduleRule => ({
    enabled: true, mode: 'cron', cron: '0 9 * * *', nextRunAt: undefined, lastTriggeredAt: undefined, runCount: 0, ...patch,
  })

  it('operator reads a capped rule as done/total plus remaining, and an uncapped one as a bare count', () => {
    // Given one capped and one uncapped rule
    // When each budget line is produced
    // Then the capped one divides the runs, the uncapped one does not
    expect(budgetLabel(rule({ runCount: 1, maxRuns: 2 }))).toContain('1/2')
    expect(budgetLabel(rule({ runCount: 1, maxRuns: 2 }))).toContain('1')
    expect(budgetLabel(rule({ runCount: 1 }))).not.toContain('/')
  })

  it('operator reads a distinct reason for a rule that stopped and for one that skipped', () => {
    // Given rules with different stop and skip reasons
    const stopped = endedLabel(rule({ endedReason: 'limit' }))
    const fired = endedLabel(rule({ endedReason: 'fired' }))
    const skipped = skippedLabel(rule({ skippedReason: 'permission' }))

    // When the labels are produced
    // Then each reason reads distinctly and an absent record reads as none
    expect(typeof stopped).toBe('string')
    expect(stopped).not.toBe(fired)
    expect(endedLabel(rule({}))).toBeUndefined()
    expect(endedLabel(rule({ skippedReason: 'busy' }))).toBeUndefined()
    expect(typeof skipped).toBe('string')
    expect(skipped).not.toBe(skippedLabel(rule({ skippedReason: 'busy' })))
    expect(skippedLabel(rule({}))).toBeUndefined()
  })

  it('operator sees a stored run cap mapped back to its select entry', () => {
    // Given stored caps of none, one, two and a custom value
    // When each is mapped to the editor's option
    // Then the presets are named and anything else is the custom entry
    expect(runCapOption(undefined)).toBe('unlimited')
    expect(runCapOption(1)).toBe('1')
    expect(runCapOption(2)).toBe('2')
    expect(runCapOption(7)).toBe('custom')
  })
})


describe('nextRunLabel', () => {
  it('operator reads the next run as an absolute wall clock plus its distance', () => {
    // Given a run two hours after the reference instant
    const now = Date.UTC(2026, 0, 1, 0, 0)
    const target = now + 2 * 60 * 60_000

    // When the combined label is produced
    const label = nextRunLabel(target, 'UTC', (ms, zone) => `${zone}:${new Date(ms).toISOString()}`, now)

    // Then it carries the absolute wall clock and a bracketed distance
    expect(label).toContain('UTC:2026-01-01T02:00:00.000Z')
    expect(label).toContain('(')
    expect(label).toContain(')')
  })
})
