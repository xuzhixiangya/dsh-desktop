// @vitest-environment jsdom
/**
 * "Create and run" in the new-task modal (issue #1621): the task is created
 * through the Host and started in the same gesture; a refused start leaves the
 * created task in place and opens it instead of reporting a failed creation.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NewTaskModal } from '../src/client/board/NewTaskModal.tsx'
import { resolveHostTimeZone } from '../src/core/schedule.ts'
import { openFormSection } from './form-sections.ts'
import { t } from '../src/client/locales.ts'
import { parseZonedInput } from '../src/client/schedule-zone.ts'
import type { BoardController, ControllerSnapshot } from '../src/core/controller.ts'
import type { TaskRecord } from '../src/core/tasks.ts'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Root[] = []

afterEach(() => {
  for (const root of roots.splice(0)) act(() => { root.unmount() })
  document.body.replaceChildren()
  window.localStorage.clear()
})

/** The Host-confirmed task; the modal only reads its id back. */
const created = { id: 'task-new' } as TaskRecord

function renderModal(options: { started?: boolean; goalRunEnabled?: boolean } = {}): {
  container: HTMLElement
  createTaskConfirmed: ReturnType<typeof vi.fn>
  runTask: ReturnType<typeof vi.fn>
  openTask: ReturnType<typeof vi.fn>
  onClose: ReturnType<typeof vi.fn>
} {
  const snapshot: ControllerSnapshot = {
    tasks: [],
    boardOpen: true,
    archiveView: false,
    selectedTaskId: undefined,
    executionOptions: { workspaces: [], presets: [], models: [] },
    pendingTaskIds: [],
    // The master native-/goal switch is on: these cases exercise the
    // task-level option taking effect. The host zone matches the runtime's own,
    // so the schedule plan is read in the same zone the production client
    // resolves.
    host: {
      revision: 1,
      scheduler: { timeZone: resolveHostTimeZone() },
      power: { platform: 'linux', phase: 'unsupported', enabled: false, runningSessions: 0, armedSchedules: 0, sessionStateKnown: true },
      goalRunEnabled: options.goalRunEnabled ?? true,
    },
  }
  const createTaskConfirmed = vi.fn(async () => created)
  const runTask = vi.fn(async () => options.started ?? true)
  const openTask = vi.fn()
  const onClose = vi.fn()
  const controller = {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    createTaskConfirmed,
    runTask,
    openTask,
  } as unknown as BoardController
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => { root.render(<NewTaskModal controller={controller} onClose={onClose} />) })
  return { container, createTaskConfirmed, runTask, openTask, onClose }
}

/** The new-task dialog's /goal opt-in checkbox (unchecked by default). */
function goalCheckbox(container: HTMLElement): HTMLInputElement {
  // The /goal opt-in lives in the collapsed "run mode" region.
  openFormSection(container, t('new.section.run'))
  const label = [...container.querySelectorAll('label')].find(node => node.textContent?.includes(t('exec.goalRun')))
  if (label === undefined) throw new Error('no /goal option in the new-task dialog')
  return label.querySelector('input') as HTMLInputElement
}

/** The run-mode region's header button, which carries its collapsed summary. */
function runSectionHeader(container: HTMLElement): HTMLButtonElement {
  const header = [...container.querySelectorAll<HTMLButtonElement>('[data-dsh-part="form-section"] > button')]
    .find(button => (button.textContent ?? '').startsWith(t('new.section.run')))
  if (header === undefined) throw new Error('no run-mode region in the new-task dialog')
  return header
}

/** Collapse the run-mode region again so its header renders the summary. */
function collapseRunSection(container: HTMLElement): void {
  act(() => { runSectionHeader(container).dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}

function actionButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')].find(candidate => candidate.textContent === label)
  if (button === undefined) throw new Error(`no button labelled ${label}`)
  return button as HTMLButtonElement
}

describe('new-task "create and run" (#1621)', () => {
  it('user creating and running gets the task started in the same gesture', async () => {
    // Given an open new-task modal
    const { container, createTaskConfirmed, runTask, openTask, onClose } = renderModal()

    // When the user submits the "create and run" action
    await act(async () => {
      actionButton(container, t('new.createAndRun')).dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    // Then the task is created, started, and the modal closes on the start
    expect(createTaskConfirmed).toHaveBeenCalledOnce()
    expect(runTask).toHaveBeenCalledWith('task-new')
    expect(openTask).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('user whose start is refused lands on the created task', async () => {
    // Given a start that needs confirmation first, so the run is refused while
    // the creation itself already succeeded
    const { container, runTask, openTask, onClose } = renderModal({ started: false })

    // When the user submits the "create and run" action
    await act(async () => {
      actionButton(container, t('new.createAndRun')).dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    // Then the created task is opened instead of the creation reading as failed
    expect(runTask).toHaveBeenCalledWith('task-new')
    expect(openTask).toHaveBeenCalledWith('task-new')
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('user submitting the plain create action gets an unscheduled task without an execution', async () => {
    // Given an open new-task modal with an empty form
    const { container, createTaskConfirmed, runTask } = renderModal()
    const form = container.querySelector('form')
    if (form === null) throw new Error('no modal form')

    // When the user submits the plain create action
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })

    // Then the Host receives one plain, unscheduled task and no run is requested
    const payload = createTaskConfirmed.mock.calls[0]![0] as { title: string; schedule?: unknown }
    expect(payload.title).toBe('')
    expect(payload.schedule).toBeUndefined()
    expect(createTaskConfirmed).toHaveBeenCalledOnce()
    expect(runTask).not.toHaveBeenCalled()
  })

  it('user creating a task sends a plain turn by default and the goal opt-in they check', async () => {
    // Given an open new-task modal
    const { container, createTaskConfirmed } = renderModal()

    // Then the /goal option starts unchecked, and the default payload stores
    // nothing for it (absent = off)
    const checkbox = goalCheckbox(container)
    expect(checkbox.checked).toBe(false)
    const form = container.querySelector('form')!
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    expect((createTaskConfirmed.mock.calls[0]![0] as { goalRun?: boolean }).goalRun).toBeUndefined()

    // When the user checks it before creating, the opt-in rides the create
    createTaskConfirmed.mockClear()
    await act(async () => { checkbox.click() })
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    expect((createTaskConfirmed.mock.calls[0]![0] as { goalRun?: boolean }).goalRun).toBe(true)
  })

  it('user with the GLOBAL native /goal switch off sees the new-task option usable and explained', async () => {
    // Given an open new-task modal while the master switch is off
    const { container, createTaskConfirmed } = renderModal({ goalRunEnabled: false })

    // When the user reads the run-mode region and checks the option anyway
    const checkbox = goalCheckbox(container)
    expect(checkbox.disabled).toBe(false)
    expect(checkbox.checked).toBe(false)
    expect(container.textContent).toContain(t('settings.goalRunGlobalDisabledTaskOption'))
    await act(async () => { checkbox.click() })

    // Then the choice is kept and the create carries it: the master switch
    // decides whether it takes effect, never whether the user may state it.
    expect(checkbox.checked).toBe(true)
    const form = container.querySelector('form')!
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    expect((createTaskConfirmed.mock.calls[0]![0] as { goalRun?: boolean }).goalRun).toBe(true)
  })

  it('user reading the collapsed run summary with the GLOBAL switch off is told this card will run a plain turn', async () => {
    // Given a new-task modal whose master switch is off and whose goal option
    // was checked anyway (the option itself is off by default)
    const { container } = renderModal({ goalRunEnabled: false })
    const checkbox = goalCheckbox(container)
    await act(async () => { checkbox.click() })
    collapseRunSection(container)

    // When the run region is collapsed again
    const header = runSectionHeader(container)

    // Then its summary reports a single round rather than the stored preference,
    // because that is what this card will actually do.
    expect(header.textContent).toContain(t('new.summary.singleRound'))
    expect(header.textContent).not.toContain(t('new.summary.multiRound'))
  })

  it('user reading the collapsed run summary of an opted-in card is told it will run multi-round', () => {
    // Given a new-task modal whose master switch is on
    const { container } = renderModal()

    // When the user checks the goal option and collapses the run region
    const checkbox = goalCheckbox(container)
    act(() => { checkbox.click() })
    collapseRunSection(container)

    // Then the summary reports the multi-round goal run the card asked for
    expect(runSectionHeader(container).textContent).toContain(t('new.summary.multiRound'))
  })
})

/** Write a value into a controlled field the way a user would. */
function setFieldValue(element: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  setter?.call(element, value)
  element.dispatchEvent(new Event('input', { bubbles: true }))
  element.dispatchEvent(new Event('change', { bubbles: true }))
}

/** Expand the schedule region and switch scheduled runs on. */
function enableSchedule(container: HTMLElement): void {
  openFormSection(container, t('new.section.schedule'))
  const toggle = [...container.querySelectorAll('label')]
    .find(node => node.textContent?.includes(t('detail.schedule.enable')))!
  act(() => { (toggle.querySelector('input') as HTMLInputElement).click() })
}

function labeledSelect(container: HTMLElement, label: string): HTMLSelectElement {
  const select = [...container.querySelectorAll<HTMLSelectElement>('select')]
    .find(candidate => candidate.getAttribute('aria-label') === label)
  if (select === undefined) throw new Error('no select labelled ' + label)
  return select
}

describe('new-task schedule plan (#1851)', () => {
  it('user creating a one-shot card sends the planned instant and its mode', async () => {
    // Given an open new-task modal with scheduled runs enabled
    const { container, createTaskConfirmed } = renderModal()
    enableSchedule(container)

    // When the user switches to the one-shot plan and picks a future wall clock
    const modeSelect = labeledSelect(container, t('detail.schedule.mode'))
    act(() => { modeSelect.value = 'once'; modeSelect.dispatchEvent(new Event('change', { bubbles: true })) })
    const atInput = container.querySelector<HTMLInputElement>('input[type="datetime-local"]')!
    act(() => { setFieldValue(atInput, '2030-01-02T03:04') })

    // Then the create payload carries a one-shot plan and no cron expression
    const form = container.querySelector('form')!
    await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    const payload = createTaskConfirmed.mock.calls[0]![0] as { schedule?: { enabled?: boolean; mode?: string; at?: number; cron?: string } }
    expect(payload.schedule?.enabled).toBe(true)
    expect(payload.schedule?.mode).toBe('once')
    expect(payload.schedule?.at).toBe(parseZonedInput('2030-01-02T03:04'))
    expect(payload.schedule?.cron).toBeUndefined()
  })

  it('user capping a recurring card sends the run limit alongside the expression', async () => {
    // Given an open new-task modal with scheduled runs enabled
    const { container, createTaskConfirmed } = renderModal()
    enableSchedule(container)

    // When the user keeps the recurring plan, sets an expression, and types a
    // custom run limit
    const cronInput = container.querySelector<HTMLInputElement>('input[aria-label="' + t('detail.schedule.cron') + '"]')!
    act(() => { setFieldValue(cronInput, '* * * * *') })
    const capSelect = labeledSelect(container, t('detail.schedule.maxRuns'))
    act(() => { capSelect.value = 'custom'; capSelect.dispatchEvent(new Event('change', { bubbles: true })) })
    const capInput = container.querySelector<HTMLInputElement>('input[type="number"][aria-label="' + t('detail.schedule.maxRuns') + '"]')!
    act(() => { setFieldValue(capInput, '3') })

    // Then the create payload carries the recurring plan with its cap
    const form = container.querySelector('form')!
    await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    const payload = createTaskConfirmed.mock.calls[0]![0] as { schedule?: { mode?: string; cron?: string; maxRuns?: number; at?: number } }
    expect(payload.schedule?.mode).toBe('cron')
    expect(payload.schedule?.cron).toBe('* * * * *')
    expect(payload.schedule?.maxRuns).toBe(3)
    expect(payload.schedule?.at).toBeUndefined()
  })
})
