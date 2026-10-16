// @vitest-environment jsdom
/**
 * The task-board settings card as an operator meets it: the card's own topics
 * are nested disclosure cards (the board and its runtime behavior, task
 * acceptance) beside the provider seat an external integration
 * contributes into, and every one of them starts collapsed.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TaskBoardSettingsCard, type TaskBoardSettingsCardProps, type TaskBoardSettingsCardState } from '../src/client/TaskBoardSettingsCard.tsx'
import { zh } from '../src/client/locales.ts'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Root[] = []

/**
 * The host event channel the card subscribes to while it is mounted. Neither
 * Node nor jsdom serves an EventSource, and the card only listens for power
 * frames here, so a seat that records its own close is enough.
 */
class StubEventSource {
  onmessage: ((message: MessageEvent<string>) => void) | null = null
  closed = false
  close(): void { this.closed = true }
}

const globalWithEventSource = globalThis as { EventSource?: unknown; fetch?: unknown }

beforeEach(() => {
  document.documentElement.lang = 'zh'
  globalWithEventSource.EventSource = StubEventSource
})

afterEach(() => {
  for (const root of roots.splice(0)) {
    act(() => { root.unmount() })
  }
  document.body.replaceChildren()
  delete globalWithEventSource.EventSource
})

/** One complete, writable card snapshot with no staged edits. */
function cardState(): TaskBoardSettingsCardState {
  const field = { text: '', overridden: false, invalid: false }
  return {
    available: true,
    exposed: true,
    writable: true,
    dirty: false,
    invalid: false,
    saving: false,
    failed: false,
    enabled: { ...field, text: 'true' },
    announceToAgent: field,
    preventIdleSleep: field,
    maxSubtaskDepth: field,
    sessionPollSeconds: field,
    goalRunEnabled: { ...field, text: 'false' },
    goalVerification: { ...field, text: 'true' },
    goalVerificationModel: field,
    goalVerificationReasoningEffort: field,
  }
}

/** The label the stand-in provider card carries (the real one is a provider section). */
const PROVIDER_CARD_LABEL = 'Provider section'

/** Render-ready props for the card: a fixed snapshot, an inert form, and optionally the provider seat. */
function cardProps(withProvider = false): TaskBoardSettingsCardProps {
  const state = cardState()
  return {
    t: (key: string) => (zh as Record<string, string>)[key] ?? key,
    renderSlot: () => withProvider
      ? (
        <li data-testid="provider-seat">
          <button type="button" aria-expanded="false">{PROVIDER_CARD_LABEL}</button>
        </li>
      )
      : undefined,
    dispatch: async () => false,
    useTaskBoardSettingsCard: (select: (snapshot: TaskBoardSettingsCardState) => unknown) => select(state),
    edit: () => {},
    resetField: () => {},
    save: () => {},
    discard: () => {},
  } as unknown as TaskBoardSettingsCardProps
}

/** Render the card into a fresh container and return the container. */
function render(props: TaskBoardSettingsCardProps): HTMLElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => { root.render(<TaskBoardSettingsCard {...props} />) })
  return container
}

/** The disclosure headers the card renders, in document order. */
function headers(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll('button[aria-expanded]'))
}

/** The disclosure header that starts with this copy line (a card's title leads its header text). */
function header(container: HTMLElement, label: string): HTMLButtonElement {
  const found = headers(container).find(button => button.textContent?.startsWith(label) === true)
  if (found === undefined) throw new Error(`the "${label}" disclosure header did not render`)
  return found
}

describe('task-board settings card disclosure', () => {
  it('operator opening the settings page sees one collapsed board card and no controls before expanding', () => {
    // Given the settings card rendered from the family plugin seat
    const container = render(cardProps())

    // When the operator has not opened anything
    // Then the card itself is a single collapsed disclosure that renders no
    // controls, so the settings page opens as a list of topics
    const all = headers(container)
    expect(all).toHaveLength(1)
    expect(all[0]?.textContent).toContain(zh['settings.title'])
    expect(all[0]?.getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelector('#settings-task-board-enabled')).toBeNull()
  })

  it('operator tells the board card apart from its topics by the glyph leading its header', () => {
    // Given the expanded settings card with its board topic
    const container = render(cardProps())
    act(() => { header(container, zh['settings.title']).click() })

    // When the operator scans the disclosure headers
    const board = header(container, zh['settings.title'])
    const topic = header(container, zh['settings.enabled'])

    // Then the plugin card leads with a decorative glyph before its title,
    // while a nested topic keeps the plain header shape without one
    const mark = board.firstElementChild
    expect(mark?.getAttribute('aria-hidden')).toBe('true')
    expect(mark?.firstElementChild?.tagName.toLowerCase()).toBe('svg')
    expect(mark?.nextElementSibling?.textContent).toContain(zh['settings.title'])
    expect(topic.firstElementChild?.getAttribute('aria-hidden')).toBeNull()
    expect(topic.querySelectorAll('span[aria-hidden="true"]')).toHaveLength(0)
  })

  it('operator expanding the board card finds every topic collapsed in its documented order', () => {
    // Given the collapsed settings card of a deployment whose provider seat
    // contributes one card
    const container = render(cardProps(true))

    // When the operator opens it
    act(() => { header(container, zh['settings.title']).click() })

    // Then the topics stand collapsed under it in the order board, run behavior,
    // acceptance, provider card, and nothing is expanded yet
    const topics = headers(container)
    expect(topics).toHaveLength(5)
    expect(topics[1]?.textContent).toContain(zh['settings.enabled'])
    expect(topics[2]?.textContent).toContain(zh['settings.runBehaviorTitle'])
    expect(topics[3]?.textContent).toContain(zh['settings.goalVerificationTitle'])
    expect(topics[4]?.textContent).toContain(PROVIDER_CARD_LABEL)
    expect(topics[0]?.getAttribute('aria-expanded')).toBe('true')
    for (const topic of topics.slice(1)) expect(topic.getAttribute('aria-expanded')).toBe('false')
  })

  it('operator expanding the run-behavior topic reaches the GLOBAL native /goal switch alone', () => {
    // Given the expanded settings card with the run-behavior topic closed
    const container = render(cardProps())
    act(() => { header(container, zh['settings.title']).click() })
    expect(container.querySelector('#settings-task-board-goal-run')).toBeNull()

    // When the operator opens the run-behavior topic
    act(() => { header(container, zh['settings.runBehaviorTitle']).click() })

    // Then the global switch is there with its default (off) and its hint, and
    // the sibling topics are untouched
    expect(container.querySelector('#settings-task-board-goal-run')?.textContent).toBe(zh['settings.off'])
    expect(container.textContent).toContain(zh['settings.goalRunGlobalHint'])
    expect(header(container, zh['settings.enabled']).getAttribute('aria-expanded')).toBe('false')
    expect(header(container, zh['settings.goalVerificationTitle']).getAttribute('aria-expanded')).toBe('false')
  })

  it('operator expanding the board topic reaches the master switch without opening the other topics', () => {
    // Given the expanded settings card
    const container = render(cardProps())
    act(() => { header(container, zh['settings.title']).click() })

    // When the operator opens the board topic
    act(() => { header(container, zh['settings.enabled']).click() })

    // Then its own controls are editable and show the stored board values, the
    // runtime-behavior fields sit with them, and the sibling topics stayed closed
    expect(header(container, zh['settings.enabled']).getAttribute('aria-expanded')).toBe('true')
    expect(container.querySelector('#settings-task-board-enabled')?.textContent).toBe(zh['settings.on'])
    expect(container.querySelector('#settings-task-board-announce')?.textContent).toBe(zh['settings.inherit'])
    expect(container.querySelector('#settings-task-board-prevent-idle-sleep')?.textContent).toBe(zh['settings.inherit'])
    expect(container.querySelector('#settings-task-board-subtask-depth')?.textContent).toBe(zh['settings.inherit'])
    expect(container.querySelector('#settings-task-board-goal-verification')).toBeNull()
    expect(header(container, zh['settings.goalVerificationTitle']).getAttribute('aria-expanded')).toBe('false')
  })

  it('operator expanding the acceptance topic reaches the judge settings and its resolved preview', () => {
    // Given the expanded settings card with the acceptance topic still closed
    const container = render(cardProps())
    act(() => { header(container, zh['settings.title']).click() })
    expect(container.querySelector('#settings-task-board-goal-verification')).toBeNull()

    // When the operator opens the acceptance topic
    act(() => { header(container, zh['settings.goalVerificationTitle']).click() })

    // Then the acceptance switch, the judge model and the resolved preview are
    // there with the stored values, and the board topic is untouched
    expect(container.querySelector('#settings-task-board-goal-verification')?.textContent).toBe(zh['settings.on'])
    expect(container.querySelector('#settings-task-board-goal-verification-model')?.textContent).toBe(zh['settings.inherit'])
    expect(container.querySelector('#settings-task-board-goal-verification-effort')?.textContent).toBe(zh['settings.inherit'])
    expect(container.textContent).toContain(zh['settings.goalVerificationResolved'])
    expect(header(container, zh['settings.enabled']).getAttribute('aria-expanded')).toBe('false')
  })

  it('operator sees the provider seat rendered inside the same topic list as the board topics', () => {
    // Given a settings card whose provider seat contributes one entry
    // When the operator expands the settings card
    const container = render(cardProps(true))
    act(() => { header(container, zh['settings.title']).click() })

    // Then the contributed card is a sibling of the board's own topics
    const seats = container.querySelectorAll('[data-testid="provider-seat"]')
    expect(seats).toHaveLength(1)
    expect(seats[0]?.parentElement?.tagName).toBe('UL')
    expect(seats[0]?.parentElement?.children).toHaveLength(4)
  })
})