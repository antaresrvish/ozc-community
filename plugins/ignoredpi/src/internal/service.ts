import type { Operation } from 'std:effect'
import { IO } from 'std:io'

import {
  BUILTIN_DOMAINS,
  BUILTIN_SINKHOLES,
  DEFAULT_UPSTREAMS,
  DNS_PORT,
  HTTPS_PORT,
  HTTP_PORT,
  WILDCARD,
} from '../const'
import type { IgnoreDpiDef } from '../types'

import { createForwarder } from './forwarder'
import { isLoopback, isPrivate } from './names'
import { createResolver } from './resolver'
import type { Resolver } from './resolver'
import { bound, serveDns } from './server'

/** The ports the service takes: the system's own unless a trial run moves them. */
export interface Ports {
  dns: number
  http: number
  https: number
}

export const SYSTEM_PORTS: Ports = { dns: DNS_PORT, http: HTTP_PORT, https: HTTPS_PORT }

/** Whom the service answers: this machine — and, with `lan = true`, the private network around it. */
export const admitsOf =
  (lan: boolean) =>
  (peer: string): boolean =>
    isLoopback(peer) || (lan && isPrivate(peer))

/** The resolver the settings describe, with the ISP's resolver to tell blocked names by. */
export const resolverOf = (settings: IgnoreDpiDef.Settings, isp: string | undefined): Resolver =>
  createResolver({
    domains: [...BUILTIN_DOMAINS, ...(settings.domains ?? [])],
    direct: settings.direct ?? [],
    upstreams: settings.upstreams ?? DEFAULT_UPSTREAMS,
    isp,
    sinkholes: [...BUILTIN_SINKHOLES, ...(settings.sinkholes ?? [])],
  })

/**
 * Take the ports and serve: the DNS on `ports.dns`, the forwarder on `ports.https` (TLS) and
 * `ports.http`. Everything runs in the caller's scope; a port that cannot be taken fails here,
 * before anything on the machine was changed.
 */
export function* serve(options: {
  settings: IgnoreDpiDef.Settings
  resolver: Resolver
  ports: Ports
  /** The ports blocked names are reached on (80, 443); the suites name servers of their own. */
  targets?: { http: number; https: number } | undefined
  log: (line: string) => Operation<void>
}) {
  const { settings, resolver, ports, log } = options
  const targets = options.targets ?? { http: HTTP_PORT, https: HTTPS_PORT }
  const admits = admitsOf(settings.lan ?? false)
  const forwarder = createForwarder({
    resolver,
    split: settings.split ?? 'record',
    admits,
    own: [ports.http, ports.https],
    log,
  })

  yield* serveDns({ resolver, port: ports.dns, admits, log })
  yield* bound('HTTPS', ports.https, () =>
    IO.actions.tcpListen({ port: ports.https, hostname: WILDCARD }, forwarder.https(targets.https)),
  )
  yield* bound('HTTP', ports.http, () =>
    IO.actions.tcpListen({ port: ports.http, hostname: WILDCARD }, forwarder.http(targets.http)),
  )

  return forwarder
}
