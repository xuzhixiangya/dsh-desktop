/**
 * Client settings-form binding on the 0.1.7 cohort.
 *
 * A settings form is addressed by profile entry id there, while this card
 * knows only its family namespace: the family binder (dsh-web-settings) is
 * what resolves one onto the other, and the shared configuration forms
 * service bound at this package's own profile row ids is the fallback for a
 * page that serves no binder.
 */
import { describe, expect, it, vi } from 'vitest'
import { bindSettingsForm } from '../src/client/index.ts'
import { TaskBoardSettingsCardController } from '../src/client/TaskBoardSettingsCard.tsx'

/**
 * A settings form double that applies the batched writes so the card's
 * read-back judgment can settle.
 */
function depthForm(initial: Record<string, unknown>) {
  const user: Record<string, unknown> = { ...initial }
  const ops: Array<{ op: 'set' | 'unset'; path: string[]; value?: unknown }> = []
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
    mutate: async (batch: Array<{ op: 'set' | 'unset'; path: string[]; value?: unknown }>) => {
      ops.push(...batch)
      for (const op of batch) {
        if (op.op === 'set') user[op.path[0]] = op.value
        else delete user[op.path[0]]
      }
      return true
    },
  }
  return { form, ops }
}

/** A form double: the card only reads the settled snapshot and subscribes to it. */
function fakeForm(entryId = 'unbound') {
  return {
    entryId,
    getSnapshot: () => ({
      status: 'ready' as const,
      value: { enabled: true },
      base: undefined,
      user: undefined,
      revision: 1,
      writable: true,
      mode: 'host' as const,
    }),
    subscribe: () => () => {},
    set: async () => true,
    unset: async () => true,
    mutate: async () => true,
  }
}

/**
 * Context double over the two service lookups the binding resolves through.
 * @param services - the family binder (absent when the group is not loaded) and
 *   the entry ids the shared describe mirror reports.
 */
function context(services: { binder?: unknown; servedNamespaces?: string[] }) {
  const get = vi.fn(() => services.binder)
  const forms = fakeForm()
  const boundEntryIds = vi.fn((entryId: string) => ({ ...forms, entryId }))
  const ctx = {
    get,
    configForms: {
      get: boundEntryIds,
      describe: () => ({
        getSnapshot: () => ({
          view: services.servedNamespaces === undefined
            ? undefined
            : { namespaces: services.servedNamespaces.map(ns => ({ ns })) },
        }),
      }),
    },
  }
  return { ctx, boundEntryIds }
}

describe('task-board settings card fields', () => {
  it('user choosing a deeper subtask limit stages the numeric value the Host schema expects', async () => {
    // Given a card bound to a form whose depth already is the default
    const { form, ops } = depthForm({ maxSubtaskDepth: 1 })
    const controller = new TaskBoardSettingsCardController(form as never, async () => false)
    const face = controller.inject()

    // When the user picks three levels and saves
    face.edit('maxSubtaskDepth', '3')
    await (controller as unknown as { form: { save(): Promise<void> } }).form.save()

    // Then the Host receives a number and the field settles as overridden
    expect(ops).toEqual([{ op: 'set', path: ['maxSubtaskDepth'], value: 3 }])
    expect(face.hooks.taskBoardSettingsCard.getSnapshot().maxSubtaskDepth).toEqual({ text: '3', overridden: true, invalid: false })
    controller.dispose()
  })

  it('user clearing the subtask limit lets the deployment default apply again', async () => {
    // Given a card whose stored depth was overridden to two levels
    const { form, ops } = depthForm({ maxSubtaskDepth: 2 })
    const controller = new TaskBoardSettingsCardController(form as never, async () => false)
    const face = controller.inject()

    // When the user resets the field to the inherited value and saves
    face.resetField('maxSubtaskDepth')
    await (controller as unknown as { form: { save(): Promise<void> } }).form.save()

    // Then the user layer entry is dropped instead of writing a value
    expect(ops).toEqual([{ op: 'unset', path: ['maxSubtaskDepth'] }])
    expect(face.hooks.taskBoardSettingsCard.getSnapshot().maxSubtaskDepth.overridden).toBe(false)
    controller.dispose()
  })
})

describe('task-board settings binding', () => {
  it('user with the family group loaded sees the card bound through the family namespace', () => {
    // Given a page that serves the family binder and this package's aggregate row
    const form = fakeForm('resolved')
    const bind = vi.fn(() => form)
    const { ctx, boundEntryIds } = context({ binder: { bind }, servedNamespaces: ['web-ui-task-board'] })

    // When the card binds its settings form
    const bound = bindSettingsForm(ctx as never)

    // Then the family binder answered, resolving the namespace itself, and no entry id was guessed
    expect(bound).toBe(form)
    expect(bind).toHaveBeenCalledWith({ namespace: 'task-board' })
    expect(boundEntryIds).not.toHaveBeenCalled()
  })

  it('user without the family group sees the card bound at this package own aggregate row', () => {
    // Given a page with no family binder whose mirror serves the aggregate row id
    const { ctx, boundEntryIds } = context({ servedNamespaces: ['web-ui-task-board', 'web-ui-pet'] })

    // When the card binds its settings form
    bindSettingsForm(ctx as never)

    // Then it binds the row this package's own patch generates, not a sibling's
    expect(boundEntryIds).toHaveBeenCalledWith('web-ui-task-board')
  })

  it('user on a standalone install sees the card bound at the standalone row id', () => {
    // Given a page whose profile carries this package's standalone bundle row
    const { ctx, boundEntryIds } = context({ servedNamespaces: ['ui-task-board'] })

    // When the card binds its settings form
    bindSettingsForm(ctx as never)

    // Then that row id is the one bound
    expect(boundEntryIds).toHaveBeenCalledWith('ui-task-board')
  })

  it('user on a Host with no answer yet sees the card bind the aggregate row id', () => {
    // Given a page whose describe mirror holds no answer, as at plugin activation
    const { ctx, boundEntryIds } = context({})

    // When the card binds its settings form
    bindSettingsForm(ctx as never)

    // Then it binds the row the family aggregate generates, so the form settles with the mirror
    expect(boundEntryIds).toHaveBeenCalledWith('web-ui-task-board')
  })

  it('user of a profile serving none of this package rows sees the card bind its bare namespace', () => {
    // Given a page whose mirror answers with rows that belong to other plugins
    const { ctx, boundEntryIds } = context({ servedNamespaces: ['web-ui-pet', 'web-ui-ssh'] })

    // When the card binds its settings form
    bindSettingsForm(ctx as never)

    // Then the namespace itself is addressed, which is the pre-0.1.7 keying shape
    expect(boundEntryIds).toHaveBeenCalledWith('task-board')
  })
})
