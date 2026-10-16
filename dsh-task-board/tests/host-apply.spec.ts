/**
 * Host-half activation contract under the 0.1.7 settings model: the effective
 * settings are the config the Host hands the row — the plugin's own Config
 * schema IS the settings page the Host serves for this profile entry — and a
 * write to a volatile field reaches the running row as a `loader/volatile-update`
 * on its own fiber, which must re-arm the board from the committed values
 * without a remount.
 *
 * The activation runs for real (host service, ledger under a temporary
 * DSH_HOME, routes over a real loopback HTTP server): no collaborator is
 * doubled, so what these tests observe is what a browser would.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TypertGateway } from '@deepseek-ai/dsh-api-gateway'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { Config, apply, resolveHostDefaultPermission } from '../src/index.ts'

/** The write protocol a volatile reference shares across cosmokit copies. */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

/** The board's fields the browser settings card edits. */
type CardField = 'enabled' | 'announceToAgent' | 'preventIdleSleep' | 'maxSubtaskDepth'

/** One action envelope the board's HTTP surface accepts. */
interface ActionEnvelope {
  requestId: string
  action: Record<string, unknown>
}

/** One mounted activation under test. */
interface MountedBoard {
  /** Names of the announcement sections the activation currently holds. */
  sections(): string[]
  /** Commit one volatile config field into the running activation, the way the Loader does. */
  commit(field: CardField, value: boolean | number): void
  /** POST one action envelope to the mounted HTTP surface. */
  action(envelope: ActionEnvelope): Promise<{ status: number; body: { error?: string; revision?: number } }>
  /** GET the host snapshot the browser mirrors. */
  state(): Promise<{ status: number; body: { maxSubtaskDepth?: number; sessionDefaultPermission?: string } }>
  /** Tear the activation and its HTTP surface down. */
  dispose(): Promise<void>
}

/**
 * A session-list gateway double: the board's poll reads the roster through it,
 * and an empty roster is the deployment shape these tests need.
 */
function emptyRosterGateway(): TypertGateway {
  return {
    invoke: async () => ({ items: [] }),
    stream: async () => ({ async *[Symbol.asyncIterator]() {} }),
  } as unknown as TypertGateway
}

/**
 * Mount the board's host half into a capture-only context and serve its routes
 * over loopback HTTP.
 * @param config - the parsed row config the Host hands the activation.
 * @param options - the deployment's own permission-preset service: the preset a
 *   new session starts at. A function is read per call, which is how a Settings
 *   change made while the board runs reaches it; omitted means the deployment
 *   serves no permission catalog at all.
 * @returns the mounted activation's observation surface.
 */
async function mountBoard(
  config: ReturnType<typeof Config>,
  options: { hostDefaultPreset?: string | (() => string | undefined) } = {},
): Promise<MountedBoard> {
  const routes: WebRoute[] = []
  const disposers: Array<() => void> = []
  const sections: string[] = []
  let volatileListener: (() => void) | undefined
  const hostDefaultPreset = options.hostDefaultPreset
  const presetRead = (): string | undefined =>
    typeof hostDefaultPreset === 'function' ? hostDefaultPreset() : hostDefaultPreset
  const permissionPresets = hostDefaultPreset === undefined
    ? undefined
    : { catalog: () => ({ defaultPreset: presetRead() }) }
  const ctx = {
    get: (name: string) => name === 'permissionPresets' ? permissionPresets : undefined,
    typertGateway: emptyRosterGateway(),
    workspaceRegistry: {},
    agents: { get: () => undefined },
    commands: { execute: async () => undefined },
    systemPrompt: {
      section: (section: { name: string }) => {
        sections.push(section.name)
        return () => {
          const index = sections.indexOf(section.name)
          if (index >= 0) sections.splice(index, 1)
        }
      },
    },
    webServer: {
      register: (route: WebRoute) => {
        routes.push(route)
        return () => {
          const index = routes.indexOf(route)
          if (index >= 0) routes.splice(index, 1)
        }
      },
    },
    effect: (body: () => unknown) => {
      const dispose = body()
      if (typeof dispose === 'function') disposers.push(dispose as () => void)
    },
    on: (name: string, listener: () => void) => {
      if (name === 'loader/volatile-update') volatileListener = listener
    },
  }
  apply(ctx as never, config)

  const server: Server = createServer((incoming, response) => {
    const route = routes.find(candidate => candidate.path === new URL(incoming.url ?? '/', 'http://local').pathname)
    if (route === undefined) {
      response.writeHead(404)
      response.end()
      return
    }
    void route.handler(incoming, response)
  })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('test server did not bind')
  const base = `http://127.0.0.1:${address.port}`

  return {
    sections: () => [...sections],
    commit: (field, value) => {
      const ref = config[field] as unknown as Record<symbol, (next: unknown) => void>
      ref[VOLATILE_WRITE](value)
      volatileListener?.()
    },
    action: async (envelope) => {
      const response = await fetch(`${base}/api/task-board/action`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
        body: JSON.stringify(envelope),
      })
      return { status: response.status, body: await response.json() as { error?: string; revision?: number } }
    },
    state: async () => {
      const response = await fetch(`${base}/api/task-board/state`, {
        headers: { 'sec-fetch-site': 'same-origin' },
      })
      return { status: response.status, body: await response.json() as { maxSubtaskDepth?: number; sessionDefaultPermission?: string } }
    },
    dispose: async () => {
      for (const dispose of disposers.reverse()) dispose()
      disposers.length = 0
      await new Promise<void>(resolve => { server.close(() => { resolve() }) })
    },
  }
}

/** One create action the board accepts while it is switched on. */
function createAction(requestId: string): ActionEnvelope {
  return {
    requestId,
    action: { kind: 'create', id: requestId, input: { title: 'Board task', description: '', prompt: 'work' } },
  }
}

const mounted: MountedBoard[] = []
let previousHome: string | undefined
let scratchHome: string | undefined

beforeEach(() => {
  // The activation builds a disk-backed ledger: keep every test off the user's real DSH home.
  previousHome = process.env.DSH_HOME
  scratchHome = mkdtempSync(join(tmpdir(), 'dsh-task-board-apply-'))
  process.env.DSH_HOME = scratchHome
})

afterEach(async () => {
  for (const board of mounted.splice(0)) await board.dispose()
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  // Only the scratch home this suite created is disposable: deleting whatever
  // DSH_HOME holds after the restore above would erase an ambient real home.
  if (scratchHome !== undefined) rmSync(scratchHome, { recursive: true, force: true })
  scratchHome = undefined
})

describe('host activation settings', () => {
  it('admin sees the announcement follow the config the Host hands the row', async () => {
    // Given a row the Host hands with the announcement switched on
    const board = await mountBoard(Config({ enabled: true, announceToAgent: true }))
    mounted.push(board)

    // When the activation is inspected
    // Then it announces the board in the system prompt
    expect(board.sections()).toEqual(['plugin:task-board'])
  })

  it('admin sees the announcement leave the prompt when the row is handed switched off', async () => {
    // Given a row the Host hands with the announcement switched off
    const board = await mountBoard(Config({ enabled: true, announceToAgent: false }))
    mounted.push(board)

    // When the activation is inspected
    // Then no announcement section is registered at all
    expect(board.sections()).toEqual([])
  })

  it('operator switching the announcement off sees it apply without a remount', async () => {
    // Given a running activation that announces the board
    const board = await mountBoard(Config({ enabled: true, announceToAgent: true }))
    mounted.push(board)
    expect(board.sections()).toEqual(['plugin:task-board'])

    // When the Host commits the user's write and the loader announces the committed field
    board.commit('announceToAgent', false)

    // Then the section is gone from the same activation, and a switch back restores it
    expect(board.sections()).toEqual([])
    board.commit('announceToAgent', true)
    expect(board.sections()).toEqual(['plugin:task-board'])
  })

  it('operator switching the board off sees its HTTP surface refuse work without a remount', async () => {
    // Given a running activation that accepts a create action
    const board = await mountBoard(Config({ enabled: true }))
    mounted.push(board)
    expect(await board.action(createAction('request-on'))).toMatchObject({ status: 200 })

    // When the Host commits the user's write to `enabled: false`
    board.commit('enabled', false)

    // Then the same surface refuses the next action, and a switch back accepts it again
    const refused = await board.action(createAction('request-off'))
    expect(refused).toMatchObject({ status: 400, body: { error: 'task board is disabled' } })
    board.commit('enabled', true)
    expect(await board.action(createAction('request-back'))).toMatchObject({ status: 200 })
  })

  it('operator sees a row activated already switched off start with no scheduler tick', async () => {
    // Given a row the Host hands with the board switched off
    const board = await mountBoard(Config({ enabled: false }))
    mounted.push(board)

    // When a board action reaches the surface
    const refused = await board.action(createAction('request-disabled'))

    // Then the activation never armed the board, so nothing is accepted
    expect(refused).toMatchObject({ status: 400, body: { error: 'task board is disabled' } })
  })

  it('operator raising the subtask depth limit sees it apply without a remount', async () => {
    // Given a running activation handed the default single-level limit
    const board = await mountBoard(Config({ enabled: true }))
    mounted.push(board)
    expect((await board.state()).body.maxSubtaskDepth).toBe(1)

    // When the Host commits the user's write of a deeper limit
    board.commit('maxSubtaskDepth', 2)

    // Then the same activation serves the new limit, and a write back follows too
    expect((await board.state()).body.maxSubtaskDepth).toBe(2)
    board.commit('maxSubtaskDepth', 1)
    expect((await board.state()).body.maxSubtaskDepth).toBe(1)
  })})

/**
 * One create action for a card that pins its own permission, which the
 * confirmation gate judges against the deployment's baseline.
 */
function highPermissionAction(requestId: string, permission: string): ActionEnvelope {
  return {
    requestId,
    action: { kind: 'create', id: requestId, input: { title: 'High card', description: '', prompt: 'work', permission } },
  }
}

/** One run action for a card created by {@link highPermissionAction}. */
function runAction(requestId: string, taskId: string): ActionEnvelope {
  return { requestId, action: { kind: 'run', taskId } }
}

describe('host permission baseline', () => {
  it('operator sees a row that pins no baseline carry none of its own', () => {
    // Given the Config schema the Host serves as this row's settings page
    // When a row is parsed without an explicit permission baseline
    // Then nothing is baked in, so the board is free to follow the Host default
    expect(Config({}).sessionDefaultPermission).toBeUndefined()
    expect(Config({ sessionDefaultPermission: 'workspace-write' }).sessionDefaultPermission).toBe('workspace-write')
  })

  it('operator sees the board follow the Host default permission when the row pins none', async () => {
    // Given a deployment whose new sessions start at full access and a row that pins no baseline
    const board = await mountBoard(Config({ enabled: true }), { hostDefaultPreset: 'danger-full-access' })
    mounted.push(board)

    // When a card pinning that permission is created and run
    await board.action(highPermissionAction('host-card', 'danger-full-access'))
    const run = await board.action(runAction('host-run', 'host-card'))

    // Then the Host default is the board's baseline and the card needs no confirmation
    expect((await board.state()).body.sessionDefaultPermission).toBe('danger-full-access')
    expect(run.status).toBe(200)
  })

  it('operator sees an explicit baseline override the Host default permission', async () => {
    // Given a deployment at full access but a row that pins the conservative baseline
    const board = await mountBoard(Config({ enabled: true, sessionDefaultPermission: 'read-only' }), { hostDefaultPreset: 'danger-full-access' })
    mounted.push(board)

    // When a card pinning full access is created and run
    await board.action(highPermissionAction('pinned-card', 'danger-full-access'))
    const run = await board.action(runAction('pinned-run', 'pinned-card'))

    // Then the pinned baseline governs and the elevation still needs a human confirmation
    expect((await board.state()).body.sessionDefaultPermission).toBe('read-only')
    expect(run).toMatchObject({ status: 400, body: { error: expect.stringContaining('confirmation-required') } })
  })

  it('operator sees the fail-safe baseline hold when the deployment serves no permission catalog', async () => {
    // Given a deployment with no permission-preset service at all
    const board = await mountBoard(Config({ enabled: true }))
    mounted.push(board)

    // When a card pinning full access is created and run
    await board.action(highPermissionAction('fallback-card', 'danger-full-access'))
    const run = await board.action(runAction('fallback-run', 'fallback-card'))

    // Then the gate falls back to read-only rather than assuming an elevation is fine
    expect((await board.state()).body.sessionDefaultPermission).toBe('read-only')
    expect(run).toMatchObject({ status: 400, body: { error: expect.stringContaining('confirmation-required') } })
  })

  it('operator lowering the Host default while the board runs sees the gate follow it', async () => {
    // Given a running board under a deployment that starts sessions at full access
    let preset = 'danger-full-access'
    const board = await mountBoard(Config({ enabled: true }), { hostDefaultPreset: () => preset })
    mounted.push(board)
    await board.action(highPermissionAction('live-card-1', 'danger-full-access'))
    expect((await board.action(runAction('live-run-1', 'live-card-1'))).status).toBe(200)

    // When the operator lowers the deployment default without remounting the row
    preset = 'read-only'
    await board.action(highPermissionAction('live-card-2', 'danger-full-access'))

    // Then the next elevation is gated again, because the baseline is re-read per evaluation
    expect((await board.state()).body.sessionDefaultPermission).toBe('read-only')
    expect(await board.action(runAction('live-run-2', 'live-card-2'))).toMatchObject({ status: 400, body: { error: expect.stringContaining('confirmation-required') } })
  })

  it('operator sees a Host preset the board cannot pin a card to fall back to the fail-safe baseline', () => {
    // Given a catalog whose default is the current-session-only auto preset
    const ctx = { get: (name: string) => name === 'permissionPresets' ? { catalog: () => ({ defaultPreset: 'auto' }) } : undefined }

    // When the Host default is read
    // Then it is not a pinnable permission, so the caller keeps the fail-safe baseline
    expect(resolveHostDefaultPermission(ctx as never)).toBeUndefined()
    expect(resolveHostDefaultPermission({ get: () => ({ catalog: () => ({ defaultPreset: 'workspace-write' }) }) } as never)).toBe('workspace-write')
    expect(resolveHostDefaultPermission({ get: () => { throw new Error('service unavailable') } } as never)).toBeUndefined()
  })
})

