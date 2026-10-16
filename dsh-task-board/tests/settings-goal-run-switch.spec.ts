/**
 * The GLOBAL native-/goal switch in the settings card: its default, what a save
 * commits, and its independence from the acceptance switch.
 *
 * These cases drive the real card controller over a form double, so what they
 * observe is the shipped staging/committing rule rather than a re-implementation.
 */
import { describe, expect, it } from 'vitest'
import { TaskBoardSettingsCardController } from '../src/client/TaskBoardSettingsCard.tsx'

type Op = { op: 'set' | 'unset'; path: string[]; value?: unknown }

/** A settings-form double that applies the batches the card commits. */
function goalRunForm(initial: Record<string, unknown>) {
  const user: Record<string, unknown> = { ...initial }
  const ops: Op[] = []
  const form = {
    entryId: 'task-board',
    getSnapshot: () => ({
      status: 'ready' as const,
      value: { ...user },
      base: undefined,
      user: { ...user },
      revision: 1,
      writable: true,
      mode: 'host' as const,
    }),
    subscribe: () => () => {},
    set: async () => true,
    unset: async () => true,
    mutate: async (batch: Op[]) => {
      ops.push(...batch)
      for (const op of batch) {
        if (op.op === 'set') user[op.path[0]!] = op.value
        else delete user[op.path[0]!]
      }
      return true
    },
  }
  return { form, ops, user }
}

/** Save through the card's own form, as its one footer button does. */
async function save(controller: TaskBoardSettingsCardController): Promise<void> {
  await (controller as unknown as { form: { save(): Promise<void> } }).form.save()
}

describe('task-board settings: the GLOBAL native /goal switch', () => {
  it('operator opening the settings card sees the global switch as its own unset field beside the acceptance switch', () => {
    // Given: a board that never configured the global switch
    const { form } = goalRunForm({ enabled: true, goalVerification: true })

    // When: the card projects its field state
    const controller = new TaskBoardSettingsCardController(form as never, async () => false)
    const state = controller.inject().hooks.taskBoardSettingsCard.getSnapshot()

    // Then: the global switch is its own field with no stored value (so the
    // schema default, off, applies), and acceptance is untouched.
    expect(state.goalRunEnabled).toEqual({ text: '', overridden: false, invalid: false })
    expect(state.goalVerification.text).toBe('true')
    controller.dispose()
  })

  it('operator turning the GLOBAL switch on sees it committed alone, leaving the acceptance switch as it was', async () => {
    // Given: the card whose global switch is off and acceptance on
    const target = goalRunForm({ enabled: true, goalRunEnabled: false, goalVerification: true })
    const controller = new TaskBoardSettingsCardController(target.form as never, async () => false)

    // When: the operator turns only the global switch on and saves
    controller.inject().edit('goalRunEnabled', 'true')
    await save(controller)

    // Then: the committed batch carries that one field, and acceptance is
    // neither read nor changed: the two switches are independent.
    expect(target.ops).toEqual([{ op: 'set', path: ['goalRunEnabled'], value: true }])
    expect(target.user.goalVerification).toBe(true)
    controller.dispose()
  })

  it('operator turning the GLOBAL switch back off sees the explicit false stored rather than the option left ambiguous', async () => {
    // Given: the card whose global switch was explicitly turned on
    const target = goalRunForm({ enabled: true, goalRunEnabled: true })
    const controller = new TaskBoardSettingsCardController(target.form as never, async () => false)

    // When: the operator switches it back off and saves
    controller.inject().edit('goalRunEnabled', 'false')
    await save(controller)

    // Then: an explicit false is committed, exactly as every other boolean field
    // of this card does, so the choice to run plain single turns is recorded
    // rather than left to inference.
    expect(target.ops).toEqual([{ op: 'set', path: ['goalRunEnabled'], value: false }])
    expect(target.user.goalRunEnabled).toBe(false)
    controller.dispose()
  })

  it('operator resetting the GLOBAL switch sees the stored override removed so the schema default applies', async () => {
    // Given: the card whose global switch was explicitly turned on
    const target = goalRunForm({ enabled: true, goalRunEnabled: true })
    const controller = new TaskBoardSettingsCardController(target.form as never, async () => false)

    // When: the operator resets the field and saves
    controller.inject().resetField('goalRunEnabled')
    await save(controller)

    // Then: the user-layer entry is dropped, so the schema default (off — and
    // whatever a later release makes it) governs this deployment.
    expect(target.ops).toEqual([{ op: 'unset', path: ['goalRunEnabled'] }])
    expect(target.user.goalRunEnabled).toBeUndefined()
    controller.dispose()
  })
})
