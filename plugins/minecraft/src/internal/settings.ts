import { useOzacoConfig } from 'sdk:config'

import type { Operation } from 'std:effect'
import { fail, formatFailure, isFailure } from 'std:result'
import { validateSync } from 'std:schema'

import { GAME_PORT, MinecraftErrors } from '../const'
import type { MinecraftDef } from '../types'

import { ServersSchema } from './schemas'

/** The port a server takes on the node's address, when it takes one: `undefined` in-cluster only. */
const publishedPortOf = (spec: MinecraftDef.ServerSpec): number | undefined => {
  const expose = spec.expose ?? 'loadbalancer'

  if (expose === 'loadbalancer') {
    return spec.port ?? GAME_PORT
  }

  return expose === 'nodeport' ? spec.nodePort : undefined
}

/**
 * Two servers on one node cannot take the same port: the second Service would wait for an address
 * for ever. Refused before the cluster is asked — the config says which two, and how.
 */
export const portClashOf = (
  servers: Record<string, MinecraftDef.ServerSpec>,
): string | undefined => {
  const taken = new Map<number, string>()

  for (const [name, spec] of Object.entries(servers)) {
    const port = publishedPortOf(spec)

    if (port === undefined) {
      continue
    }

    const other = taken.get(port)

    if (other !== undefined) {
      return `[minecraft.${other}] and [minecraft.${name}] both take port ${port} on the node: give each its own port (or nodePort)`
    }

    taken.set(port, name)
  }

  return undefined
}

/**
 * Read the servers from the top-level `[minecraft.*]` namespace in `ozaco.toml` (NOT under
 * `[kube]`). The target cluster comes from `[kube].profile` / `-p`, resolved by `sdk:k8s`. Several
 * servers are several tables, each with a port of its own on the node.
 */
export function* loadServers(cwd: string): Operation<Record<string, MinecraftDef.ServerSpec>> {
  const config = yield* useOzacoConfig({ cwd })
  const raw = (yield* config.get<unknown>('minecraft')) ?? {}
  const servers = validateSync(ServersSchema, raw)

  if (isFailure(servers)) {
    return yield* fail(
      MinecraftErrors.Config,
      `invalid [minecraft.*] config in ozaco.toml: ${formatFailure(servers)}`,
    )
  }

  const clash = portClashOf(servers.value)

  if (clash !== undefined) {
    return yield* fail(MinecraftErrors.Config, clash)
  }

  return servers.value
}

/** The servers to act on: the named ones, or ALL when no names are given. Fails on an unknown name. */
export function* selectServers(
  servers: Record<string, MinecraftDef.ServerSpec>,
  names: readonly string[],
): Operation<MinecraftDef.ServerTarget[]> {
  const chosen = names.length === 0 ? Object.keys(servers) : names
  const targets: MinecraftDef.ServerTarget[] = []

  if (chosen.length === 0) {
    return yield* fail(MinecraftErrors.Config, 'no [minecraft.*] entries in ozaco.toml')
  }

  for (const name of chosen) {
    const spec = servers[name]

    if (spec === undefined) {
      return yield* fail(
        MinecraftErrors.Server,
        `no server "${name}" is defined ([minecraft.${name}])`,
      )
    }

    targets.push({ name, spec })
  }

  return targets
}
