// @vitest-environment jsdom
/**
 * Host timestamp rendering: one cached formatter per time zone, and identical
 * copy to the uncached construction it replaced.
 *
 * The formatter cache is observed by substituting a counting delegate for the
 * global constructor (no test double of the plugin's own code) and restoring it
 * afterwards, so the assertion is about how many formatters the real renderer
 * builds rather than about an internal field.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { formatHostTimestamp } from '../src/client/board/TaskCard.tsx'

/** Time zone the counting delegate recorded a construction for. */
const constructedZones: Array<string | undefined> = []
let restoreConstructor: (() => void) | undefined

function countingDateTimeFormat(): void {
  const Original = Intl.DateTimeFormat
  class CountingDateTimeFormat extends Original {
    constructor(locales?: string | string[], options?: Intl.DateTimeFormatOptions) {
      super(locales as string, options)
      constructedZones.push(options?.timeZone)
    }
  }
  ;(Intl as { DateTimeFormat: typeof Intl.DateTimeFormat }).DateTimeFormat = CountingDateTimeFormat as unknown as typeof Intl.DateTimeFormat
  restoreConstructor = () => { (Intl as { DateTimeFormat: typeof Intl.DateTimeFormat }).DateTimeFormat = Original }
}

afterEach(() => {
  restoreConstructor?.()
  restoreConstructor = undefined
  constructedZones.length = 0
})

describe('host timestamp rendering', () => {
  it('user reading card times gets the host-timezone rendering, cached per zone', () => {
    // Given one instant and the copy the uncached construction produced for two
    // Host time zones
    const instant = Date.UTC(2026, 0, 2, 3, 4, 5)
    const options = { dateStyle: 'medium', timeStyle: 'medium' } as const
    const expectedShanghai = new Intl.DateTimeFormat(undefined, { ...options, timeZone: 'Asia/Shanghai' }).format(new Date(instant))
    const expectedUtc = new Intl.DateTimeFormat(undefined, { ...options, timeZone: 'UTC' }).format(new Date(instant))
    countingDateTimeFormat()

    // When the board renders timestamps for both zones, repeatedly
    const shanghai = [formatHostTimestamp(instant, 'Asia/Shanghai'), formatHostTimestamp(instant, 'Asia/Shanghai'), formatHostTimestamp(instant + 60_000, 'Asia/Shanghai')]
    const utc = [formatHostTimestamp(instant, 'UTC'), formatHostTimestamp(instant, 'UTC')]

    // Then the copy is unchanged, the formatter is built once per zone, and a
    // different instant still renders differently
    expect(shanghai[0]).toBe(expectedShanghai)
    expect(shanghai[1]).toBe(expectedShanghai)
    expect(shanghai[2]).not.toBe(expectedShanghai)
    expect(utc[0]).toBe(expectedUtc)
    expect(utc[0]).not.toBe(shanghai[0])
    expect(constructedZones.filter(zone => zone === 'Asia/Shanghai')).toHaveLength(1)
    expect(constructedZones.filter(zone => zone === 'UTC')).toHaveLength(1)
  })

  it('user reading a card whose time zone id is unusable still sees an instant', () => {
    // Given a Host whose scheduler names a time zone this browser cannot build
    // When a card timestamp is rendered with it
    const rendered = formatHostTimestamp(Date.UTC(2026, 0, 2, 3, 4, 5), 'Not/AZone')

    // Then the ISO instant is shown instead of an empty or thrown value
    expect(rendered).toBe(new Date(Date.UTC(2026, 0, 2, 3, 4, 5)).toISOString())
  })
})
