/**
 * Graceful shutdown of a mounted board, and provider tool registration against a
 * host that is already going away.
 *
 * cordis marks a fiber UNLOADING before running its disposers, so a tool
 * registration attempted from a disposer is refused with INACTIVE_EFFECT. The
 * board's teardown used to rebind the provider tool registry on its way down,
 * which turned one release into N refused re-registrations: one error line per
 * tool each provider exposes, printed on every clean exit of `dsh web`.
 *
 * The activation test mounts the real plugin entry against a context whose tool
 * registry refuses registration exactly the way an unloading fiber does, so the
 * refusals it counts are the ones a Ctrl+C shutdown produces. The registry tests
 * drive the registry itself with a recording logger, so what the board would
 * have printed is observable without patching the console.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TypertGateway } from '@deepseek-ai/dsh-api-gateway'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Config, apply } from '../src/index.ts'
import { HostTaskLedger } from '../src/host-ledger.ts'
import { TaskBoardExtensionRegistry, type TaskBoardExtensionLogger } from '../src/host/extension-registry.ts'
import {
  TASK_BOARD_API_VERSION,
  type TaskBoardExtension,
  type TaskBoardExtensionHost,
} from '../src/core/extension.ts'

const NOW = 1_700_000_000_000

/**
 * The activation mounts the real Host service, which resolves its ledger from
 * DSH_HOME. That must never be the developer's live home: point it at a scratch
 * directory for the whole file and restore the ambient value afterwards.
 */
let previousHome: string | undefined
let scratchHome: string | undefined
const roots: string[] = []

beforeEach(() => {
  previousHome = process.env.DSH_HOME
  scratchHome = mkdtempSync(join(tmpdir(), 'dsh-task-board-shutdown-'))
  process.env.DSH_HOME = scratchHome
})

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  if (scratchHome !== undefined) rmSync(scratchHome, { recursive: true, force: true })
  scratchHome = undefined
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
})

/** A scratch ledger directory the test owns. */
function ledgerRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-task-board-shutdown-ledger-'))
  roots.push(root)
  return root
}

/** A session-list gateway double: the board's poll reads the roster through it. */
function emptyRosterGateway(): TypertGateway {
  return {
    invoke: async () => ({ items: [] }),
    stream: async () => ({ async *[Symbol.asyncIterator]() {} }),
  } as unknown as TypertGateway
}

/** A cordis-shaped refusal carrying the framework's own error code. */
function inactiveContextError(): Error {
  return Object.assign(new Error('cannot create effect on inactive context'), { code: 'INACTIVE_EFFECT' })
}

/** One reported line, reduced to the level and the message the board printed. */
interface Report {
  level: 'warn' | 'error'
  message: string
}

/** A logger collecting what the board reported instead of printing it. */
function recordingLogger(reports: Report[]): TaskBoardExtensionLogger {
  return {
    warn: (message: string) => { reports.push({ level: 'warn', message }) },
    error: (message: string) => { reports.push({ level: 'error', message }) },
  }
}

/** One provider tool definition, in the shape the tool registry accepts. */
function toolDefinition(name: string): ToolDefinition {
  return { name, description: 'provider tool', parameters: {}, execute: async () => ({}) } as unknown as ToolDefinition
}

/** A provider exposing the named tools once it starts. */
function provider(id: string, toolNames: string[]): TaskBoardExtension {
  return {
    id,
    apiVersion: TASK_BOARD_API_VERSION,
    start: (face: TaskBoardExtensionHost) => {
      for (const name of toolNames) face.registerTool(toolDefinition(name))
    },
  }
}

interface MountedBoard {
  /** Admit a provider through the service the activation published. */
  admit(extension: TaskBoardExtension): void
  /** Tools the runtime accepted while the fiber was live. */
  registered: string[]
  /** Tools the runtime refused as a shutting-down host refuses. */
  refused: string[]
  /** Tear the activation down exactly as cordis does: run the effect disposers. */
  unload(): void
}

/**
 * Mount the real activation against a context whose tool registry refuses
 * registration the way an unloading fiber does.
 *
 * @returns the mounted activation's teardown handle and its registration record.
 */
function mountBoard(): MountedBoard {
  const registered: string[] = []
  const refused: string[] = []
  let unloading = false
  const toolRegistry = {
    register: (definition: ToolDefinition) => {
      if (unloading) {
        refused.push(definition.name)
        throw inactiveContextError()
      }
      registered.push(definition.name)
      return () => {
        const index = registered.indexOf(definition.name)
        if (index >= 0) registered.splice(index, 1)
      }
    },
  }
  const disposers: Array<() => void> = []
  let service: { registerExtension?: (extension: TaskBoardExtension) => () => void } = {}
  const ctx = {
    get: (name: string) => name === 'tools' ? toolRegistry : undefined,
    provide: (name: string, value: unknown) => {
      if (name === 'taskBoard') service = value as typeof service
    },
    typertGateway: emptyRosterGateway(),
    workspaceRegistry: {},
    agents: { get: () => undefined },
    commands: { execute: async () => undefined },
    systemPrompt: { section: () => () => {} },
    webServer: { register: () => () => {} },
    effect: (body: () => unknown) => {
      const dispose = body()
      if (typeof dispose === 'function') disposers.push(dispose as () => void)
    },
    on: () => {},
  }
  apply(ctx as never, Config({ enabled: true }))
  return {
    admit: (extension) => { service.registerExtension?.(extension) },
    registered,
    refused,
    unload: () => {
      unloading = true
      for (const dispose of disposers.splice(0).reverse()) dispose()
    },
  }
}

describe('board teardown releasing the tool surface', () => {
  it('operator stopping dsh web releases every provider tool without asking the host to register anything', () => {
    // Given a running board carrying two providers' tools, all registered
    const live = mountBoard()
    live.admit(provider('reports', ['reports_list', 'reports_get']))
    live.admit(provider('other', ['other_run']))
    const whileRunning = [...live.registered]
    expect(whileRunning).toEqual(expect.arrayContaining(['reports_list', 'reports_get', 'other_run']))

    // When the operator stops the process and the mount effect's disposer runs
    live.unload()

    // Then every tool is released and the teardown requested no registration,
    // so an unloading fiber never refuses one and never reports a failure
    expect(live.registered).toEqual([])
    expect(live.refused).toEqual([])
  })

  it('operator who re-enables the board after a provider restart sees its tools registered again', () => {
    // Given a board that released a provider's tools on the way down
    const live = mountBoard()
    live.admit(provider('reports', ['reports_list']))
    live.unload()

    // When the board is mounted again over the same runtime
    const restarted = mountBoard()
    restarted.admit(provider('reports', ['reports_list']))

    // Then the tools register against the live fiber, so the teardown did not
    // leave the provider permanently unable to hold a tool
    expect(restarted.registered).toContain('reports_list')
    expect(restarted.refused).toEqual([])
    restarted.unload()
  })
})

describe('provider tool registration against a shutting-down host', () => {
  it('operator whose provider is rebound while the host is unloading sees no error report', () => {
    // Given a running provider whose tool the live registry accepted
    const reports: Report[] = []
    const registry = new TaskBoardExtensionRegistry({
      ledger: new HostTaskLedger(ledgerRoot(), () => NOW),
      logger: recordingLogger(reports),
    })
    let unloading = false
    registry.setToolRegistry(() => ({
      register: () => {
        if (unloading) throw inactiveContextError()
        return () => {}
      },
    }))
    registry.registerExtension(provider('reports', ['reports_list']))
    expect(reports).toEqual([])

    // When a rebind arrives after the host started unloading
    unloading = true
    registry.setToolRegistry(() => ({
      register: () => {
        if (unloading) throw inactiveContextError()
        return () => {}
      },
    }))

    // Then nothing is reported: the host is going away, not refusing the tool
    expect(reports).toEqual([])
    registry.dispose()
  })

  it('operator whose provider tool the registry genuinely refuses still sees an error report', () => {
    // Given a running provider whose tool the deployment rejects on its merits
    const reports: Report[] = []
    const registry = new TaskBoardExtensionRegistry({
      ledger: new HostTaskLedger(ledgerRoot(), () => NOW),
      logger: recordingLogger(reports),
    })
    registry.setToolRegistry(() => ({
      register: () => { throw new Error('tool name is reserved') },
    }))

    // When the provider starts and offers its tool
    registry.registerExtension(provider('reports', ['reports_list']))

    // Then the refusal is reported, because it is not the host going away: every
    // line the board printed names this tool's registration, and there is one
    const failures = reports.filter(report => report.message === '[dsh-task-board] extension "reports" tool "reports_list" registration failed')
    expect(reports).toEqual(failures)
    expect(failures.length).toBeGreaterThan(0)
    registry.dispose()
  })
})
