/**
 * Card view model: title kind split, outcome tone, per-column time, recency
 * groups, the stored density preference, and the issue-form excerpt.
 */
import { describe, expect, it } from 'vitest'
import { cardOutcome, cardTimeline, groupByRecency, readCompactColumns, recencyGroup, splitTitleKind, writeCompactColumns, COMPACT_COLUMNS_KEY } from '../src/client/board/card-view.ts'
import { markdownExcerpt } from '../src/client/board/task-markdown.tsx'
import type { ExecutionRecord, TaskRecord } from '../src/core/tasks.ts'

const base: TaskRecord = { id: 't', title: 'T', description: '', prompt: '', status: 'todo', createdAt: 10, updatedAt: 99, executions: [] }
const run = (overrides: Partial<ExecutionRecord>): ExecutionRecord => ({ id: 'e', sessionId: 's', startedAt: 20, endedAt: 30, result: 'succeeded', error: undefined, ...overrides })

/** In-memory storage standing in for the browser's localStorage. */
function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  return { data, getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value) } }
}

describe('Given card titles with an issue-form type prefix', () => {
  it('user sees the bracketed prefix split into a badge and the rest kept as the title', () => {
    // Given titles with and without a prefix
    const titles = ['[Bug]: Broken totals', '[Issue] Slow board', '[功能] 新列', 'Plain title', '[Bug]:']
    // When each title is split
    const parts = titles.map(splitTitleKind)
    // Then only a prefix followed by text becomes a kind
    expect(parts).toEqual([
      { kind: 'Bug', text: 'Broken totals' },
      { kind: 'Issue', text: 'Slow board' },
      { kind: '功能', text: '新列' },
      { text: 'Plain title' },
      { text: '[Bug]:' },
    ])
  })
})

describe('Given the latest execution of a card', () => {
  it('user sees the column flagged as declared only when it disagrees with the latest run', () => {
    // Given cards in every column/result combination that matters
    const doneFailed = cardOutcome({ ...base, status: 'done', executions: [run({ result: 'failed' })] }, false)
    const doneOk = cardOutcome({ ...base, status: 'done', executions: [run({})] }, false)
    const failedOk = cardOutcome({ ...base, status: 'failed', executions: [run({})] }, false)
    const open = cardOutcome({ ...base, status: 'running', executions: [run({ endedAt: undefined, result: undefined })] }, false)
    const archived = cardOutcome({ ...base, status: 'done', executions: [run({ result: 'failed' })] }, true)
    const never = cardOutcome(base, false)
    // When the outcome is derived
    const summary = [doneFailed, doneOk, failedOk, open, archived, never].map(o => [o.tone, o.declared])
    // Then tone follows the run and declared marks only the contradictions
    expect(summary).toEqual([['failed', true], ['succeeded', false], ['succeeded', true], ['running', false], [undefined, false], [undefined, false]])
  })
  it('user sees each column dated by the instant its cards differ by', () => {
    // Given one card in each situation
    const todo = cardTimeline({ ...base, status: 'todo' }, false)
    const running = cardTimeline({ ...base, status: 'running', executions: [run({ startedAt: 40, endedAt: undefined, result: undefined })] }, false)
    const done = cardTimeline({ ...base, status: 'done', executions: [run({ endedAt: 50 })] }, false)
    const doneByHand = cardTimeline({ ...base, status: 'done' }, false)
    const archived = cardTimeline({ ...base, status: 'done', archivedAt: 60 }, true)
    // When the timeline is derived
    const picked = [todo, running, done, doneByHand, archived].map(entry => [entry.key, entry.at])
    // Then created, started, settled, updated and archived are chosen in turn
    expect(picked).toEqual([
      ['card.time.created', 10], ['card.time.started', 40], ['card.time.settled', 50], ['card.time.updated', 99], ['card.time.archived', 60],
    ])
  })
})

describe('Given settled cards grouped by recency', () => {
  it('user sees today, the last seven days and earlier, newest first, in the Host calendar', () => {
    // Given a Host clock at noon UTC and four settlement instants
    const now = Date.UTC(2026, 9, 3, 12, 0, 0)
    const items = [
      { id: 'old', at: Date.UTC(2026, 8, 1) },
      { id: 'morning', at: Date.UTC(2026, 9, 3, 1, 0, 0) },
      { id: 'tuesday', at: Date.UTC(2026, 8, 29) },
      { id: 'late', at: Date.UTC(2026, 9, 3, 11, 0, 0) },
    ]
    // When they are grouped in the UTC Host zone
    const buckets = groupByRecency(items, item => item.at, now, 'UTC')
    // Then groups are ordered and each is newest first
    expect(buckets.map(bucket => [bucket.group, bucket.items.map(item => item.id)])).toEqual([
      ['today', ['late', 'morning']], ['week', ['tuesday']], ['earlier', ['old']],
    ])
  })
  it('user near midnight sees "today" follow the Host zone, not UTC', () => {
    // Given 23:30 UTC on the 2nd (07:30 on the 3rd in Shanghai) and a settlement at
    // 15:00 UTC on the 2nd (23:00 on the 2nd in Shanghai)
    const now = Date.UTC(2026, 9, 2, 23, 30, 0)
    const at = Date.UTC(2026, 9, 2, 15, 0, 0)
    // When the instant is bucketed in each zone
    const utc = recencyGroup(at, now, 'UTC')
    const shanghai = recencyGroup(at, now, 'Asia/Shanghai')
    // Then the same instant is today in UTC and yesterday in Shanghai
    expect([utc, shanghai]).toEqual(['today', 'week'])
  })
})

describe('Given the per-column density preference', () => {
  it('user starts with the done column compact and keeps a saved choice across visits', () => {
    // Given an empty store, a saved store and a corrupted store
    const fresh = memoryStorage()
    const corrupted = memoryStorage({ [COMPACT_COLUMNS_KEY]: '{not json' })
    const saved = memoryStorage()
    // When the user saves two columns and the board reads each store
    writeCompactColumns(saved, ['failed', 'bogus' as never, 'todo'])
    const read = [readCompactColumns(fresh), readCompactColumns(corrupted), readCompactColumns(saved)]
    // Then defaults cover missing or broken data and only known columns persist, in board order
    expect(read).toEqual([['done'], ['done'], ['todo', 'failed']])
    expect(saved.data.get(COMPACT_COLUMNS_KEY)).toBe('["todo","failed"]')
  })
})

describe('Given task descriptions rendered as card excerpts', () => {
  it('user sees the first real paragraph when the body has no summary section', () => {
    // Given an English issue form with a checkbox list and empty fields first
    const source = '### Preflight\n\n- [x] I searched existing issues\n\n### Plugin\n\n_No response_\n\n### What happened\n\nThe `board` froze.'
    // When the excerpt is derived
    const excerpt = markdownExcerpt(source)
    // Then boilerplate is skipped and the summary-like section wins
    expect(excerpt).toBe('The board froze.')
  })
  it('user still sees text when every block is boilerplate', () => {
    // Given a body made only of a checkbox list
    const source = '- [x] done item'
    // When the excerpt is derived
    const excerpt = markdownExcerpt(source)
    // Then the full plain text is the fallback
    expect(excerpt).toBe('done item')
  })
})
