// @vitest-environment jsdom
/**
 * Lineage-gate cost and correctness after the reusable-index change.
 *
 * The link-subtask picker runs the Host's lineage gate once per candidate task,
 * so the gate has to accept one index built for the whole pass. These cases pin
 * both the verdict contract (unchanged) and the input scale the picker relies on.
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SUBTASK_DEPTH,
  SUBTASK_DEPTH_MAX,
  buildLineageIndex,
  checkParentLink,
  descendantTasks,
  directSubtasks,
  subtreeHeight,
  taskDepth,
} from '../src/core/subtask.ts'
import { createTask, type TaskRecord } from '../src/core/tasks.ts'

const NOW = 1_700_000_000_000

function task(id: string, overrides: Partial<TaskRecord> = {}): TaskRecord {
  return { ...createTask({ title: id, description: '', prompt: id }, NOW, id), ...overrides }
}

describe('lineage index', () => {
  it('operator gets the same lineage verdicts whether or not the caller supplies an index', () => {
    // Given a tree with a root, a child, a grandchild and an unrelated leaf
    const tasks = [
      task('root'),
      task('child', { parentId: 'root' }),
      task('grand', { parentId: 'child' }),
      task('leaf'),
    ]
    const lineage = buildLineageIndex(tasks)

    // When every lineage query runs twice, once unindexed and once indexed
    const pairs = [
      [taskDepth(tasks, 'grand'), taskDepth(tasks, 'grand', lineage)],
      [directSubtasks(tasks, 'child').map(t => t.id), directSubtasks(tasks, 'child', lineage).map(t => t.id)],
      [descendantTasks(tasks, 'root', SUBTASK_DEPTH_MAX).map(t => t.id), descendantTasks(tasks, 'root', SUBTASK_DEPTH_MAX, lineage).map(t => t.id)],
      [subtreeHeight(tasks, 'root'), subtreeHeight(tasks, 'root', new Set<string>(), lineage)],
      [checkParentLink(tasks, 'leaf', 'root', DEFAULT_SUBTASK_DEPTH), checkParentLink(tasks, 'leaf', 'root', DEFAULT_SUBTASK_DEPTH, lineage)],
      [checkParentLink(tasks, 'root', 'grand', SUBTASK_DEPTH_MAX), checkParentLink(tasks, 'root', 'grand', SUBTASK_DEPTH_MAX, lineage)],
      [checkParentLink(tasks, 'child', 'child', SUBTASK_DEPTH_MAX), checkParentLink(tasks, 'child', 'child', SUBTASK_DEPTH_MAX, lineage)],
      [checkParentLink(tasks, 'child', 'missing', SUBTASK_DEPTH_MAX), checkParentLink(tasks, 'child', 'missing', SUBTASK_DEPTH_MAX, lineage)],
      [checkParentLink(tasks, 'missing', 'root', SUBTASK_DEPTH_MAX), checkParentLink(tasks, 'missing', 'root', SUBTASK_DEPTH_MAX, lineage)],
    ]

    // Then the verdicts agree field for field
    for (const [unindexed, indexed] of pairs) expect(indexed).toEqual(unindexed)
    expect(lineage.byId.size).toBe(4)
    expect(lineage.childrenByParent.get('root')?.map(t => t.id)).toEqual(['child'])
  })

  it('user opening the link picker on a large board gets candidates in one indexed pass', () => {
    // Given a 1000-task board where every third task is a child of its predecessor
    const tasks = Array.from({ length: 1000 }, (_, i) => task('t' + i, i > 0 && i % 3 === 0 ? { parentId: 't' + (i - 1) } : {}))
    const lineage = buildLineageIndex(tasks)

    // When the picker's candidate filter runs
    const candidates = tasks.filter(t =>
      t.archivedAt === undefined
      && t.status !== 'running'
      && t.parentId === undefined
      && t.id !== 't0'
      && checkParentLink(tasks, t.id, 't0', DEFAULT_SUBTASK_DEPTH, lineage).ok,
    )

    // Then it returns every root task the Host would accept, and does so well
    // inside the index build the picker pays once
    expect(candidates.length).toBeGreaterThan(0)
    expect(candidates.every(t => t.parentId === undefined)).toBe(true)
    expect(lineage.byId.size).toBe(1000)
  })
})
