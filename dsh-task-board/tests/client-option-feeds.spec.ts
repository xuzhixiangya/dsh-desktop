// @vitest-environment jsdom
/**
 * Execution-target option feeds on the client apply path.
 *
 * The mode picker reads the agent-preset roster from the controller, which the
 * apply wiring fills from the runtime. A feed that is defined but never invoked
 * leaves the picker permanently empty, so this spec observes the controller's
 * options after apply() rather than trusting the wiring's shape.
 *
 * The roster lives in a generated Remote namespace (`remote.agentPresets`),
 * which the page's official api-remotes assembly mounts *beside* this entry: at
 * apply time the namespace is typically still absent, and cordis refuses an
 * uninjected nested service outright rather than answering undefined. The
 * context below reproduces exactly that — a throwing `remote` service, no
 * pre-migration `connection.api` face, and a namespace that only becomes
 * available after the entry applied.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../src/client/index.ts'

const PRESET_ROSTER = [
  { id: 'standard', name: '', description: '', isDefault: true },
  { id: 'house-style', name: 'House Style', description: 'our preset', isDefault: false },
]

function unavailableSettingsForm() {
  return {
    getSnapshot: () => ({ status: 'unavailable', value: undefined, base: undefined, user: undefined, revision: undefined, writable: false, mode: 'host' }),
    subscribe: () => () => {},
    mutate: async () => false,
    set: async () => false,
    unset: async () => false,
  }
}

function applyContext() {
  const disposers: Array<() => void> = []
  const registrations: Array<{ name: string; options: Record<string, unknown> }> = []
  /** Scoped-inject callbacks parked until their namespace is mounted. */
  const parked: Array<() => void> = []
  let presetNamespace: { list: () => Promise<unknown> } | undefined
  const services: Record<string, unknown> = {
    sessions: { list: { getSnapshot: () => ({ byId: {} }), subscribe: () => () => {} } },
    workspaces: { list: { getSnapshot: () => ({ items: [] }), subscribe: () => () => {} }, create: async () => ({ workspaceId: 'w1' }) },
    // The `remote` service is the cordis traced proxy: reading a nested
    // namespace the caller never injected throws, exactly as in the page.
    remote: new Proxy({}, {
      get: (_target, prop) => { throw new Error(`cannot get property "${String(prop)}" without inject`) },
    }),
    // The pre-migration connection RPC face (`connection.api`) is gone from
    // this cohort: the handle carries the wire, not per-namespace callers.
    connection: { isLoopback: true, rpc: {}, start: () => ({ stop: () => {} }), generation: { getSnapshot: () => undefined } },
    layout: { selectPanel: () => {}, panelInfo: { getSnapshot: () => ({ activePanelId: null }), subscribe: () => () => {} } },
  }
  const slots = {
    register: (options: Record<string, unknown>) => {
      registrations.push({ name: String(options.name), options })
      const release = (): void => {}
      disposers.push(release)
      return release
    },
    inject: (_key: string, callback: () => () => void) => {
      const release = callback()
      disposers.push(release)
      return release
    },
  }
  const ctx = {
    effect(callback: () => void | (() => void)) {
      const disposer = callback()
      if (typeof disposer === 'function') disposers.push(disposer)
    },
    get: (name: string) => services[name],
    on: () => () => {},
    inject(names: readonly string[], callback: (scope: unknown) => unknown) {
      const run = (): void => {
        const scope = {
          get: (name: string) => (names.includes(name) ? presetNamespace : undefined),
          on: () => () => {},
          effect: (cb: () => void | (() => void)) => { const disposer = cb(); if (typeof disposer === 'function') disposers.push(disposer) },
        }
        const cleanup = callback(scope)
        if (typeof cleanup === 'function') disposers.push(cleanup as () => void)
      }
      parked.push(run)
      return { dispose: async () => {} }
    },
    locale: { register: () => () => {}, bind: () => (key: string) => key, subscribe: () => () => {} },
    configForms: { get: () => unavailableSettingsForm(), describe: () => { throw new Error('no describe mirror') } },
    slots,
  }
  return {
    ctx: ctx as never,
    disposers,
    registrations,
    /** Mount the roster namespace the way the api-remotes assembly does. */
    mountPresetNamespace: () => {
      presetNamespace = { list: async () => ({ ok: true, value: { presets: PRESET_ROSTER } }) }
      for (const run of parked.splice(0)) run()
    },
    /** A host whose assembly serves a namespace that always fails. */
    mountFailingPresetNamespace: () => {
      presetNamespace = { list: async () => { throw new Error('offline') } }
      for (const run of parked.splice(0)) run()
    },
  }
}

/** The board controller the panel page receives through its slot injection. */
function boardController(registrations: Array<{ name: string; options: Record<string, unknown> }>) {
  const page = registrations.find(entry => entry.name === 'main')
  const inject = page?.options.inject as (() => { controller: { getSnapshot: () => { executionOptions: { presets?: readonly unknown[] } } } }) | undefined
  return inject?.().controller
}

/** Let the feed's awaited roster read settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await Promise.resolve()
}

describe('task-board client execution-target option feeds', () => {
  beforeEach(() => {
    delete (globalThis as { __dshTaskboardApplied?: boolean }).__dshTaskboardApplied
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('operator opening the mode picker sees the deployment preset roster', async () => {
    // Given a page whose api-remotes assembly mounts the roster namespace after
    // the board entry applied, with a two-row roster
    const { ctx, registrations, mountPresetNamespace } = applyContext()

    // When the plugin applies first and the namespace lands afterwards
    apply(ctx)
    await settle()
    mountPresetNamespace()
    await settle()

    // Then the controller behind the board carries that roster
    const controller = boardController(registrations)
    expect(controller?.getSnapshot().executionOptions.presets).toEqual([
      { id: 'standard', name: '', description: '', broken: undefined, isDefault: true },
      { id: 'house-style', name: 'House Style', description: 'our preset', broken: undefined, isDefault: false },
    ])
  })

  it('operator on a host whose assembly never mounts the roster namespace keeps the picker empty and the board alive', async () => {
    // Given a page whose assembly serves no preset namespace at all
    const { ctx, registrations, disposers } = applyContext()

    // When the plugin applies
    apply(ctx)
    await settle()

    // Then the board still mounts (its panel seat is registered), the picker
    // has nothing to offer, and the teardown of the parked feed is safe
    expect(registrations.map(entry => entry.name)).toContain('main')
    expect(boardController(registrations)?.getSnapshot().executionOptions.presets).toEqual([])
    expect(() => { for (const dispose of disposers) dispose() }).not.toThrow()
  })

  it('operator whose roster read fails keeps the board on its previous picker options', async () => {
    // Given a namespace whose call throws
    const { ctx, registrations, mountFailingPresetNamespace } = applyContext()
    const reported: string[] = []
    const originalError = console.error
    console.error = (...args: unknown[]) => { reported.push(args.map(value => String(value)).join(' ')) }

    try {
      // When the namespace lands and its read fails
      apply(ctx)
      await settle()
      mountFailingPresetNamespace()
      await settle()

      // Then the board keeps running with its previous (empty) options and the
      // failure is reported instead of swallowed
      expect(registrations.map(entry => entry.name)).toContain('main')
      expect(boardController(registrations)?.getSnapshot().executionOptions.presets).toEqual([])
      expect(reported.some(line => line.includes('agent preset roster read failed'))).toBe(true)
    } finally {
      console.error = originalError
    }
  })
})
