import { attempt } from 'std:effect'
import type { Operation } from 'std:effect'
import { IO } from 'std:io'
import { isFailure } from 'std:result'

import {
  BUILTIN_DOMAINS,
  BUILTIN_SINKHOLES,
  DEFAULT_UPSTREAMS,
  DNS_PORT,
  HTTPS_PORT,
  HTTP_PORT,
  LOOPBACK,
  TLS_PORTS,
  WILDCARD,
} from '../const'
import type { IgnoreDpiDef } from '../types'

import { createForwarder } from './forwarder'
import { isLoopback, isPrivate } from './names'
import { createResolver } from './resolver'
import type { Resolver } from './resolver'
import { bound, serveDns } from './server'

/**
 * The ports the service takes: the system's own unless a trial run moves them. `tls` are the other
 * ports a TLS client may reach a blocked name on — each forwarded to the same port of the name.
 */
export interface Ports {
  dns: number
  http: number
  https: number
  tls: readonly number[]
}

export const SYSTEM_PORTS: Ports = {
  dns: DNS_PORT,
  http: HTTP_PORT,
  https: HTTPS_PORT,
  tls: TLS_PORTS,
}

/**
 * Where the ports are bound: the wildcard on macOS — the only address it lets a user bind them on —
 * and wherever `lan = true` asks for the network; else this machine alone, which on Windows needs
 * no firewall rule (and asks no question).
 */
export const listenOn = (os: string, lan: boolean): string =>
  lan || os === 'darwin' ? WILDCARD : LOOPBACK

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
 * `ports.http`, all on `hostname` (the wildcard by default; {@link listenOn}). Everything runs in
 * the caller's scope; a port that cannot be taken fails here, before anything on the machine was
 * changed — but one of `ports.tls`, which only some names are reached on, is logged and passed
 * over.
 */
export function* serve(options: {
  settings: IgnoreDpiDef.Settings
  resolver: Resolver
  ports: Ports
  hostname?: string | undefined
  /**
   * The ports blocked names are reached on (80, 443, and each of `ports.tls` on itself); the
   * suites name servers of their own.
   */
  targets?: { http: number; https: number; tls?: number | undefined } | undefined
  log: (line: string) => Operation<void>
}) {
  const { settings, resolver, ports, log } = options
  const hostname = options.hostname ?? WILDCARD
  const targets = options.targets ?? { http: HTTP_PORT, https: HTTPS_PORT }
  const admits = admitsOf(settings.lan ?? false)
  const forwarder = createForwarder({
    resolver,
    split: settings.split ?? 'record',
    admits,
    own: [ports.http, ports.https, ...ports.tls],
    log,
  })

  yield* serveDns({ resolver, port: ports.dns, hostname, admits, log })
  yield* bound('HTTPS', ports.https, () =>
    IO.actions.tcpListen({ port: ports.https, hostname }, forwarder.https(targets.https)),
  )
  yield* bound('HTTP', ports.http, () =>
    IO.actions.tcpListen({ port: ports.http, hostname }, forwarder.http(targets.http)),
  )

  for (const port of ports.tls) {
    const taken = yield* attempt(
      IO.actions.tcpListen({ port, hostname }, forwarder.https(targets.tls ?? port)),
    )

    if (isFailure(taken)) {
      yield* log(
        `✗ cannot take TLS port ${port} (${taken.message}): a blocked name reached on it goes nowhere`,
      )
    }
  }

  return forwarder
}
