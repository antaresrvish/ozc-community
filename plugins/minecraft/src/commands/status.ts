import { accessInput } from 'sdk:core'
import { K8s, resolveKind } from 'sdk:k8s'

import { defineAction } from 'cli:command'
import { Terminal } from 'cli:core'
import { attempt } from 'std:effect'
import { fail, isFailure } from 'std:result'

import { DEFAULT_TYPE, DEFAULT_VERSION, MinecraftErrors } from '../const'
import { consoleOf } from '../internal/console'
import { podOf } from '../internal/manifests'
import { serversInput } from '../internal/schemas'
import { loadServers, selectServers } from '../internal/settings'
import { addressOf, dnsRecordsOf, endpointOf, playersOf, readinessOf } from '../internal/status'

/** The curated kinds the status is read from (always resolvable). */
const POD = resolveKind('pod')
const SERVICE = resolveKind('service')

/** A table as lines: every column as wide as its widest cell. */
const tabled = (rows: readonly (readonly string[])[]): string => {
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
 * `ozc minecraft status [names...]` — every server as the cluster has it: whether its pod is up,
 * where players connect, who is on (asked of the server itself, through its console), what it runs
 * — and, for a server with a `domain`, the DNS records that name needs. No names → every
 * `[minecraft.*]`.
 */
export const StatusAction = defineAction(
  {
    inherits: accessInput,
    description:
      'Every server: ready, address, players, DNS — minecraft status [names...] [-p profile]',
    args: ['names'],
    input: serversInput,
  },
  function* (ctx) {
    const servers = yield* loadServers(ctx.cwd)
    const targets = yield* selectServers(servers, ctx.names)
    const rows: string[][] = [['NAME', 'STATE', 'ADDRESS', 'DOMAIN', 'PLAYERS', 'SERVER']]
    const dns: string[] = []

    if (POD === undefined || SERVICE === undefined) {
      return yield* fail(
        MinecraftErrors.Kind,
        'internal error: the pod or service kind is unresolved',
      )
    }

    yield* K8s.actions.useCluster(ctx.cwd, ctx.profile, ctx.secret)

    for (const target of targets) {
      const { name, spec } = target
      const namespace = spec.namespace
      const pod = yield* attempt(K8s.actions.get(POD, podOf(name), { namespace }))
      const service = yield* attempt(K8s.actions.get(SERVICE, name, { namespace }))
      const state = readinessOf(isFailure(pod) ? undefined : pod.value)
      const endpoint = isFailure(service) ? undefined : endpointOf(service.value)
      let players = '-'

      if (state === 'ready') {
        const listed = yield* attempt(consoleOf(target, ['list']))

        players =
          isFailure(listed) || !listed.value.success ? '?' : (playersOf(listed.value.stdout) ?? '?')
      }

      rows.push([
        name,
        state,
        addressOf(isFailure(service) ? undefined : service.value),
        spec.domain ?? '-',
        players,
        `${(spec.type ?? DEFAULT_TYPE).toLowerCase()} ${spec.version ?? DEFAULT_VERSION}`,
      ])

      for (const record of dnsRecordsOf(spec, endpoint)) {
        dns.push(`  ${name}: ${record}`)
      }
    }

    yield* Terminal.actions.write(`${tabled(rows)}\n`)

    if (dns.length > 0) {
      yield* Terminal.actions.write(`\nDNS records the domains need:\n${dns.join('\n')}\n`)
    }
  },
)
