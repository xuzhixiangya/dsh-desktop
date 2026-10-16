/**
 * Acceptance VALIDITY: whether a rejecting acceptance may be booked as a
 * quality verdict at all.
 *
 * The rule under test is program-level (`assessAcceptanceValidity`), not a
 * prompt instruction: a veto with no finding, a vacuous finding, a citation
 * that is not in the reviewed evidence, a citation of the empty-work baseline
 * and a truncated review that cannot substantiate the veto are all INVALID
 * acceptances. They produce no quality verdict, spend no quality budget and
 * never fail a card; a veto backed by a locatable finding is the only shape
 * that becomes a real quality verdict.
 *
 * The evidence fixtures below are the exact texts the judge is shown, so a
 * citation that "occurs in the evidence" is checked against real content.
 */
import { describe, expect, it } from 'vitest'
import {
  EMPTY_WORK_BASELINE,
  VERIFICATION_DETAIL_MAX_PROBLEM_CHARS,
  VERIFICATION_DETAIL_MAX_QUOTE_CHARS,
  VERIFICATION_MIN_QUOTE_CHARS,
  assessAcceptanceValidity,
  normalizeVerification,
  type AcceptanceEvidenceText,
  type VerificationCriterionFinding,
  type VerificationCriterionScore,
} from '../src/core/verification.ts'

/** The trajectory the judge reviews: the work's own tool output. */
const TOOL_OUTPUT = 'npm run build exited 0 and emitted dist/index.js'

/** The evidence one acceptance handed to the judge. */
function evidence(overrides: Partial<AcceptanceEvidenceText> = {}): AcceptanceEvidenceText {
  return {
    task: 'Ship the build artifact under dist/.',
    trajectory: '--- Tool Result ---\n[Output] ' + TOOL_OUTPUT,
    workspace: 'Host-recorded workspace changes: 1 changed file',
    ...overrides,
  }
}

/** One criterion score. */
function criterion(overrides: Partial<VerificationCriterionScore> = {}): VerificationCriterionScore {
  return { id: 'output_match', name: 'Output Match', score: 0.1, baseline: 0.9, threshold: 0.65, passed: false, ...overrides }
}

/** One structured finding. */
function finding(overrides: Partial<VerificationCriterionFinding> = {}): VerificationCriterionFinding {
  return {
    criterionId: 'output_match',
    requirement: 'the build must emit dist/index.js',
    observation: 'the artifact is missing from the workspace',
    gap: 'the task asked for the artifact and none was produced',
    quote: TOOL_OUTPUT,
    location: 'trajectory',
    ...overrides,
  }
}

describe('acceptance validity: a veto must be locatable', () => {
  it('user whose judge fails the work without any finding sees the veto rejected as invalid', () => {
    // Given: a failing criterion and an empty finding list
    const input = { criteria: [criterion()], findings: [], evidence: evidence(), omittedCharacters: 0 }

    // When: the validity of the veto is assessed
    const verdict = assessAcceptanceValidity(input)

    // Then: it is invalid for the missing finding, so it can never become a
    // quality verdict
    expect(verdict.valid).toBe(false)
    expect(verdict.valid ? undefined : verdict.reason).toBe('missing-finding')
  })

  it('user whose finding states nothing concrete sees the veto rejected as vacuous', () => {
    // Given: a finding whose requirement, observation and gap are filler
    const input = {
      criteria: [criterion()],
      findings: [finding({ requirement: 'bad', observation: 'meh', gap: 'no' })],
      evidence: evidence(),
      omittedCharacters: 0,
    }

    // When: the validity is assessed
    const verdict = assessAcceptanceValidity(input)

    // Then: the empty statement is not evidence for the veto
    expect(verdict.valid).toBe(false)
    expect(verdict.valid ? undefined : verdict.reason).toBe('vacuous-finding')
  })

  it('user whose finding quotes a passage absent from the reviewed evidence sees the veto rejected as unlocatable', () => {
    // Given: a plausible-sounding citation the judge invented
    const input = {
      criteria: [criterion()],
      findings: [finding({ quote: 'the build produced dist/index.js successfully' })],
      evidence: evidence(),
      omittedCharacters: 0,
    }

    // When: the validity is assessed
    const verdict = assessAcceptanceValidity(input)

    // Then: a citation that does not occur in the evidence locates nothing
    expect(verdict.valid).toBe(false)
    expect(verdict.valid ? undefined : verdict.reason).toBe('unlocatable-quote')
  })

  it('user whose finding quotes the empty-work baseline sees the veto rejected as a baseline citation', () => {
    // Given: a finding that cites the baseline instead of this execution's work
    const input = {
      criteria: [criterion()],
      findings: [finding({ location: 'baseline', quote: EMPTY_WORK_BASELINE })],
      evidence: evidence(),
      omittedCharacters: 0,
    }

    // When: the validity is assessed
    const verdict = assessAcceptanceValidity(input)

    // Then: the baseline is not evidence about the work, so it cannot veto it
    expect(verdict.valid).toBe(false)
    expect(verdict.valid ? undefined : verdict.reason).toBe('baseline-finding')
  })

  it('user whose veto cites only the other criterion sees each failing criterion ask for its own evidence', () => {
    // Given: two failing criteria and a finding for just the first
    const other = criterion({ id: 'error_signals', name: 'Error Signal Detection' })
    const input = {
      criteria: [criterion(), other],
      findings: [finding()],
      evidence: evidence(),
      omittedCharacters: 0,
    }

    // When: the validity is assessed
    const verdict = assessAcceptanceValidity(input)

    // Then: the unfound criterion makes the whole veto invalid, and the detail
    // names it so a reader can see WHICH criterion lacked evidence
    expect(verdict.valid).toBe(false)
    expect(verdict.valid ? '' : verdict.detail).toContain('Error Signal Detection')
  })

  it('operator whose judged trace was truncated sees an unsubstantiated veto recorded as insufficient evidence', () => {
    // Given: a failing criterion, no finding, and a truncated review window
    const input = { criteria: [criterion()], findings: [], evidence: evidence(), omittedCharacters: 4_200 }

    // When: the validity is assessed
    const verdict = assessAcceptanceValidity(input)

    // Then: the missing evidence is attributed to the truncation, not to the
    // work, so the operator can see the difference between the two
    expect(verdict.valid).toBe(false)
    expect(verdict.valid ? undefined : verdict.reason).toBe('insufficient-evidence')
  })

  it('user whose judge reports a real citation sees the veto accepted as a quality verdict', () => {
    // Given: a failing criterion with its own finding, quoting the trajectory
    const input = { criteria: [criterion()], findings: [finding()], evidence: evidence(), omittedCharacters: 0 }

    // When: the validity is assessed
    const verdict = assessAcceptanceValidity(input)

    // Then: the veto is usable, so it may be booked against the quality budget
    expect(verdict).toEqual({ valid: true })
  })

  it('operator whose finding cites the host workspace record sees the citation checked against that block', () => {
    // Given: a finding that cites the host's own change record, not the trace
    const input = {
      criteria: [criterion()],
      findings: [finding({ location: 'workspace', quote: 'Host-recorded workspace changes: 1 changed file' })],
      evidence: evidence(),
      omittedCharacters: 0,
    }

    // When: the validity is assessed
    const verdict = assessAcceptanceValidity(input)

    // Then: the workspace record is legitimate evidence and the veto holds
    expect(verdict).toEqual({ valid: true })
  })

  it('user whose required artifact is genuinely missing sees the veto accepted when it cites the task it inspected against', () => {
    // Given: a finding that cites the TASK block, because the required file is
    // simply absent from the work — the judge inspected for it and found none
    const input = {
      criteria: [criterion()],
      findings: [finding({
        location: 'task',
        requirement: 'the task requires dist/index.js to be produced',
        observation: 'inspection of the workspace found no dist/index.js',
        gap: 'the required artifact was never produced',
        quote: 'Ship the build artifact under dist/.',
      })],
      evidence: evidence(),
      omittedCharacters: 0,
    }

    // When: the validity is assessed
    const verdict = assessAcceptanceValidity(input)

    // Then: a genuinely missing artifact IS vetoable — the finding states the
    // requirement, the inspection it performed and the missing fact, and its
    // citation really occurs in the task block.
    expect(verdict).toEqual({ valid: true })
  })

  it('operator whose deployment serves no workspace record sees a workspace citation rejected rather than trusted', () => {
    // Given: a finding citing a workspace block the deployment never rendered
    const input = {
      criteria: [criterion()],
      findings: [finding({ location: 'workspace', quote: 'Host-recorded workspace changes: 1 changed file' })],
      evidence: evidence({ workspace: '' }),
      omittedCharacters: 0,
    }

    // When: the validity is assessed
    const verdict = assessAcceptanceValidity(input)

    // Then: a citation of a block that does not exist is unlocatable
    expect(verdict.valid).toBe(false)
    expect(verdict.valid ? undefined : verdict.reason).toBe('unlocatable-quote')
  })

  it('user whose quote is too short to locate anything sees the veto rejected', () => {
    // Given: a citation shorter than the minimum locating length
    const input = {
      criteria: [criterion()],
      findings: [finding({ quote: 'x'.repeat(VERIFICATION_MIN_QUOTE_CHARS - 1) })],
      evidence: evidence(),
      omittedCharacters: 0,
    }

    // When: the validity is assessed
    const verdict = assessAcceptanceValidity(input)

    // Then: a fragment that matches almost anything locates nothing
    expect(verdict.valid).toBe(false)
    expect(verdict.valid ? undefined : verdict.reason).toBe('unlocatable-quote')
  })
})

describe('acceptance validity: the live incident this rule was written for', () => {
  it('operator whose acceptance vetoed a run it could not see is told the acceptance is INVALID, not that the work failed', () => {
    // The real values the PRE-CHANGE Host recorded for this very session on
    // 2026-10-09: total 0.7018 (above the threshold) but one criterion
    // (Output Match) at 0.6316, ZERO findings, and 3,769,011 of 3,849,011
    // evidence characters omitted. The old code booked that as a quality
    // verdict and told the agent to repair; it is exactly the evidence-free
    // veto this rule exists to refuse.
    const verdict = assessAcceptanceValidity({
      criteria: [
        { id: 'specification', name: 'Specification Adherence', score: 0.6842, baseline: 0, threshold: 0.65, passed: true },
        { id: 'output_match', name: 'Output Match', score: 0.6316, baseline: 0, threshold: 0.65, passed: false },
        { id: 'error_signals', name: 'Error Signal Detection', score: 0.7895, baseline: 0, threshold: 0.65, passed: true },
      ],
      findings: [],
      evidence: { task: 'the task statement', trajectory: 'a window of the trace', workspace: '' },
      omittedCharacters: 3_769_011,
    })

    // Given: that recorded verdict IS the input above
    // When:  the validity of the veto is assessed
    // Then: the veto is attributable to the truncated review, so the run is
    //       held as an invalid acceptance instead of being judged and repaired
    expect(verdict.valid).toBe(false)
    expect(verdict.valid ? undefined : verdict.reason).toBe('insufficient-evidence')
    expect(verdict.valid ? '' : verdict.detail).toContain('truncated')
  })
})

describe('acceptance detail: the capacity bound survives a hand-edited ledger', () => {
  /** One persisted block carrying an over-long finding, as a hand edit could leave it. */
  function oversizedBlock() {
    return {
      contract: { enabled: true, modelSource: 'inherit', preset: 'coding', threshold: 0.65 },
      attempts: [{
        index: 1,
        at: 1_700_000_000_000,
        stage: 'quality',
        passed: false,
        score: 0.1,
        baseline: 0.1,
        criteria: [],
        findings: [],
        criterionFindings: [{
          criterionId: 'output_match',
          requirement: 'r'.repeat(VERIFICATION_DETAIL_MAX_PROBLEM_CHARS * 4),
          observation: 'o'.repeat(VERIFICATION_DETAIL_MAX_PROBLEM_CHARS * 4),
          gap: 'g'.repeat(VERIFICATION_DETAIL_MAX_PROBLEM_CHARS * 4),
          quote: 'q'.repeat(VERIFICATION_DETAIL_MAX_QUOTE_CHARS * 4),
          location: 'trajectory',
          action: 'a'.repeat(VERIFICATION_DETAIL_MAX_PROBLEM_CHARS * 4),
        }],
        usage: { calls: 6, inputTokens: 1, outputTokens: 1, reasoningTokens: 1 },
        evidence: { chars: 10, omittedCharacters: 0, entries: 1, hash: 'h' },
        route: { provider: 'deepseek-official', model: 'deepseek-flash' },
        channel: 'explicit-tag',
        rounds: 2,
      }],
      applicability: 'enforced',
    }
  }

  it('operator loading a block with oversized finding text sees every field clipped to its bound', () => {
    // Given: a persisted block one hand edit away from a megabyte of prose
    const before = oversizedBlock()
    const raw = (before.attempts[0] as { criterionFindings: Array<Record<string, string>> }).criterionFindings[0]!

    // When: the ledger repairs it
    const repaired = normalizeVerification(before)
    const kept = repaired?.attempts[0]?.criterionFindings?.[0]

    // Then: the finding is still usable (clipped, not rejected) and every text
    // field sits at or under the bound the acceptance itself writes. The block
    // survives, so the criterion it names is still readable.
    expect(kept?.criterionId).toBe('output_match')
    expect(kept?.requirement.length).toBe(VERIFICATION_DETAIL_MAX_PROBLEM_CHARS)
    expect(kept?.observation.length).toBe(VERIFICATION_DETAIL_MAX_PROBLEM_CHARS)
    expect(kept?.gap.length).toBe(VERIFICATION_DETAIL_MAX_PROBLEM_CHARS)
    expect(kept?.action?.length).toBe(VERIFICATION_DETAIL_MAX_PROBLEM_CHARS)
    expect(kept?.quote.length).toBe(VERIFICATION_DETAIL_MAX_QUOTE_CHARS)
    expect(raw.quote.length).toBeGreaterThan(VERIFICATION_DETAIL_MAX_QUOTE_CHARS)
  })

  it('operator loading a legacy findings list that outgrew its bounds sees it clipped to the writer caps', () => {
    // Given: a persisted block whose LEGACY findings list carries far too many
    // over-long lines
    const before = oversizedBlock()
    ;(before.attempts[0] as { findings: string[] }).findings =
      Array.from({ length: 40 }, () => 'f'.repeat(VERIFICATION_DETAIL_MAX_PROBLEM_CHARS * 3))

    // When: the ledger repairs it
    const repaired = normalizeVerification(before)
    const kept = repaired?.attempts[0]?.findings ?? []

    // Then: the list is bounded in count and in per-line size, matching what the
    // acceptance itself would have written.
    expect(kept).toHaveLength(12)
    expect(kept.every(line => line.length === VERIFICATION_DETAIL_MAX_PROBLEM_CHARS)).toBe(true)
  })

  it('operator loading a finding whose criterion id was replaced by prose sees the block dropped instead of trusted', () => {
    // Given: an identifier field carrying unrelated prose
    const before = oversizedBlock()
    ;(before.attempts[0] as { criterionFindings: Array<Record<string, string>> }).criterionFindings[0]!.criterionId =
      'x'.repeat(200)

    // When: the ledger repairs it
    const repaired = normalizeVerification(before)

    // Then: an identifier that no longer names a criterion drops the block (fail
    // closed) rather than attaching the veto to a criterion nobody can resolve.
    expect(repaired).toBeUndefined()
  })
})
