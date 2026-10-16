/**
 * Label management (issue: labels could not be cleaned up): the two
 * ledger-wide transitions behind the board's label manager, plus the refusals
 * that keep a stale tab from silently rewriting the wrong label.
 *
 * The filter row is the union of the labels in use, so these transitions are
 * the only way a label ever leaves the board: they are asserted against the
 * whole ledger, not against one card.
 */
import { describe, expect, it } from 'vitest'
import { applyDeleteTag, applyRenameTag } from '../src/core/use-cases/task-tag.ts'
import { TAG_NAME_MAX_LENGTH, createTask, type TaskRecord, type TaskTag } from '../src/core/tasks.ts'

const NOW = 1_700_000_000_000

/** One task carrying the given labels, stamped before NOW. */
function task(id: string, tags?: TaskTag[], updatedAt = NOW - 10): TaskRecord {
  return {
    ...createTask({ title: id, description: '', prompt: id }, NOW - 1000, id),
    ...(tags === undefined ? {} : { tags }),
    updatedAt,
  }
}

describe('label management', () => {
  it('operator renaming a label rewrites it on every task that carries it', () => {
    // Given two tasks sharing a label and one carrying another
    const tasks = [task('a', [{ name: 'ship' }]), task('b', [{ name: 'ship' }]), task('c', [{ name: 'other' }])]

    // When the operator renames the shared label
    const result = applyRenameTag(tasks, 'ship', 'release', NOW)

    // Then both carrying tasks were rewritten and the third was left untouched
    expect(result.error).toBeUndefined()
    expect(result.tasks.map(entry => entry.tags?.map(tag => tag.name))).toEqual([['release'], ['release'], ['other']])
    expect(result.tasks[2]?.updatedAt).toBe(tasks[2]?.updatedAt)
    expect(result.tasks[0]?.updatedAt).toBe(NOW)
  })

  it('operator renaming onto a name already in use merges the two labels on that task', () => {
    // Given a task carrying both labels, the target one holding an execution hint
    const tasks = [task('a', [{ name: 'ship', promptPrefix: 'archive to 02-work/' }, { name: 'release' }])]

    // When the operator merges "ship" into "release"
    const result = applyRenameTag(tasks, 'ship', 'release', NOW)

    // Then one row survives, and it is the target's own row with its hint
    expect(result.tasks[0]?.tags).toEqual([{ name: 'release' }])
  })

  it('operator renaming onto another label keeps the source hint when the task carried only that one', () => {
    // Given a task carrying one hinted label and a peer task carrying the target
    const tasks = [task('a', [{ name: 'ship', promptPrefix: 'archive to 02-work/' }]), task('b', [{ name: 'release' }])]

    // When the operator renames it onto the existing label
    const result = applyRenameTag(tasks, 'ship', 'release', NOW)

    // Then the hinted row survives under the new name
    expect(result.tasks[0]?.tags).toEqual([{ name: 'release', promptPrefix: 'archive to 02-work/' }])
  })

  it('operator removing a label drops it from every card, archived ones included', () => {
    // Given an on-board card, an archived card and a card carrying another label
    const tasks = [
      task('a', [{ name: 'ship' }, { name: 'keep' }]),
      { ...task('b', [{ name: 'ship' }]), archivedAt: NOW - 1 },
      task('c', [{ name: 'keep' }]),
    ]

    // When the operator deletes the label
    const result = applyDeleteTag(tasks, 'ship', NOW)

    // Then no card carries it any more, and the unrelated label is untouched
    expect(result.tasks[0]?.tags).toEqual([{ name: 'keep' }])
    expect(result.tasks[1]?.tags).toBeUndefined()
    expect(result.tasks[2]?.tags).toEqual([{ name: 'keep' }])
  })

  it('operator clearing a task\'s last label leaves it without a label list at all', () => {
    // Given a card whose only label is the one being removed
    const tasks = [task('a', [{ name: 'ship' }])]

    // When the operator deletes that label
    const result = applyDeleteTag(tasks, 'ship', NOW)

    // Then the card reports no labels rather than an empty list
    expect(result.tasks[0]?.tags).toBeUndefined()
  })

  it('operator renaming a label no card carries is refused instead of quietly doing nothing', () => {
    // Given a ledger without the requested label
    const tasks = [task('a', [{ name: 'keep' }])]

    // When the operator renames a label that is not in use
    const result = applyRenameTag(tasks, 'ghost', 'release', NOW)

    // Then the edit is refused and the ledger is handed back unchanged
    expect(result.error).toBe('label not found')
    expect(result.changed).toBe(false)
    expect(result.tasks).toBe(tasks)
  })

  it('operator renaming a label to an over-long or blank name is refused', () => {
    // Given a ledger carrying the label to rename
    const tasks = [task('a', [{ name: 'ship' }])]

    // When the operator submits a name the wire gate would reject
    const tooLong = applyRenameTag(tasks, 'ship', 'x'.repeat(TAG_NAME_MAX_LENGTH + 1), NOW)
    const blank = applyRenameTag(tasks, 'ship', '   ', NOW)

    // Then both are refused and nothing was rewritten
    expect(tooLong.error).toBe('label name is too long')
    expect(blank.error).toBe('a label name is required')
    expect(tooLong.tasks).toBe(tasks)
  })

  it('operator renaming a label to its own name changes nothing', () => {
    // Given a ledger carrying the label
    const tasks = [task('a', [{ name: 'ship' }])]

    // When the operator submits the same name
    const result = applyRenameTag(tasks, 'ship', 'ship', NOW)

    // Then it is a no-op, not an error
    expect(result.error).toBeUndefined()
    expect(result.changed).toBe(false)
    expect(result.tasks).toBe(tasks)
  })

  it('operator renaming with surrounding spaces is accepted as the trimmed name', () => {
    // Given a card carrying a label
    const tasks = [task('a', [{ name: 'ship' }])]

    // When the operator types the new name with padding
    const result = applyRenameTag(tasks, ' ship ', '  release  ', NOW)

    // Then the stored name is the trimmed one
    expect(result.tasks[0]?.tags).toEqual([{ name: 'release' }])
  })
})
