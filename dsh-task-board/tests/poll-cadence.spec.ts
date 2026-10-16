import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SESSION_POLL_SECONDS,
  normalizeSessionPollSeconds,
  sessionPollMs,
  SESSION_POLL_MAX_SECONDS,
  SESSION_POLL_MIN_SECONDS,
} from '../src/core/poll-cadence.ts'

describe('roster poll cadence', () => {
  it('operator who configured no cadence gets the default', () => {
    // Given no configured value
    // When the effective cadence is resolved
    // Then the documented default applies, in seconds and milliseconds
    expect(normalizeSessionPollSeconds(undefined)).toBe(DEFAULT_SESSION_POLL_SECONDS)
    expect(sessionPollMs(undefined)).toBe(DEFAULT_SESSION_POLL_SECONDS * 1_000)
  })

  it('operator whose hand-edited cadence is out of range gets a clamped one, never a disabled poll', () => {
    // Given values below the floor, above the ceiling, fractional, and unusable
    // When each is normalized
    // Then every one leaves the board polling at a supported cadence
    expect(normalizeSessionPollSeconds(0)).toBe(SESSION_POLL_MIN_SECONDS)
    expect(normalizeSessionPollSeconds(-30)).toBe(SESSION_POLL_MIN_SECONDS)
    expect(normalizeSessionPollSeconds(SESSION_POLL_MAX_SECONDS + 1)).toBe(SESSION_POLL_MAX_SECONDS)
    expect(normalizeSessionPollSeconds(12.7)).toBe(12)
    expect(normalizeSessionPollSeconds(Number.NaN)).toBe(DEFAULT_SESSION_POLL_SECONDS)
    expect(normalizeSessionPollSeconds(Number.POSITIVE_INFINITY)).toBe(DEFAULT_SESSION_POLL_SECONDS)
  })
})
