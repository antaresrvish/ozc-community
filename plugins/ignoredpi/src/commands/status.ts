import { defineAction } from 'cli:command'
import { Terminal } from 'cli:core'

import { BUILTIN_DOMAINS } from '../const'
import { placeInput } from '../internal/schemas'
import { loadSettings } from '../internal/settings'
import { isAlive, readState } from '../internal/state'
import { agentState, dnsOf, expectMacos, networkServices } from '../internal/system'

/** A table as lines: every column as wide as its widest cell. */
export const tabled = (rows: readonly (readonly string[])[]): string => {
  const widths = rows.reduce<number[]>(
    (acc, row) => row.map((cell, index) => Math.max(acc[index] ?? 0, cell.length)),
    [],
  )

  return rows
    .map(row =>
      row
        .map((cell, index) => cell.padEnd(widths[index] ?? 0))
        .join('  ')
        .trimEnd(),
    )
    .join('\n')
}

/**
 * `ozc ignoredpi status` — whether the service runs, which network services' DNS point at it, how
 * blocked names are told (the ISP's resolver, the sinkholes, the lists) and what it has done:
 * queries answered, names sent through, connections forwarded, the latest of those names.
 */
export const StatusAction = defineAction(
  {
    inherits: placeInput,
    description:
      'Whether the service runs, whose DNS it holds, what it forwarded: ignoredpi status',
  },
  function* (ctx) {
    yield* expectMacos('ignoredpi status')

    const settings = yield* loadSettings(ctx.cwd)
    const agent = yield* agentState()
    const state = yield* readState()
    const alive = state !== undefined && (yield* isAlive(state.pid))
    const dns: string[] = []

    for (const service of yield* networkServices()) {
      const servers = yield* dnsOf(service.name)

      dns.push(`${service.name} → ${servers.length === 0 ? "DHCP's" : servers.join(', ')}`)
    }

    const running = alive
      ? `running (pid ${state.pid}, since ${state.startedAt})`
      : agent.loaded
        ? 'starting, or failing to start — see `ozc ignoredpi logs`'
        : 'not running — `ozc ignoredpi up` starts it'
    const rows: string[][] = [
      ['service', running],
      ['agent', agent.loaded ? 'loaded (starts at login)' : 'not installed'],
      ['dns', dns.join('; ') || 'no network service'],
      ['split', settings.split ?? 'record'],
      [
        'lists',
        `${BUILTIN_DOMAINS.length} built in, ${settings.domains?.length ?? 0} of yours, ${settings.direct?.length ?? 0} kept direct`,
      ],
    ]

    if (alive) {
      rows.push(
        ['isp', state.isp ?? 'none found — the lists alone tell blocked names'],
        ['sinkholes', state.sinkholes.join(', ')],
        [
          'queries',
          `${state.counters.queries} answered, ${state.counters.redirected} sent through`,
        ],
        [
          'connections',
          `${state.counters.connections} forwarded, ${state.counters.failures} failed`,
        ],
        ['recent', state.recent.join(', ') || '-'],
      )
    }

    yield* Terminal.actions.write(`${tabled(rows)}\n`)
  },
)
