import { attempt, race, sleep, spawn } from 'std:effect'
import type { Operation, Subscription } from 'std:effect'
import { IO } from 'std:io'
import type { IODef } from 'std:io'
import { fail, isFailure } from 'std:result'

import {
  CONNECT_TIMEOUT_MS,
  HELLO_TIMEOUT_MS,
  IgnoreDpiErrors,
  MAX_HEAD_BYTES,
  MAX_HELLO_BYTES,
  RECENT_NAMES,
  SEGMENT_GAP_MS,
} from '../const'
import type { IgnoreDpiDef } from '../types'

import {
  headEndOf,
  headPiecesOf,
  helloPiecesOf,
  hostOf,
  recordLengthOf,
  serverNameOf,
} from './hello'
import type { ServerName } from './hello'
import { isAddress, isLoopback } from './names'
import type { Resolver } from './resolver'

type Inbound = Subscription<Uint8Array, IODef.FlowClose>

/** The bytes collected so far, joined. */
const joined = (chunks: readonly Uint8Array[]): Uint8Array => {
  const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0))
  let offset = 0

  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }

  return bytes
}

/**
 * Read from `inbound` until `enough` says how many bytes make the first message (`-1`: not yet,
 * `0`: never — not the protocol expected), within the hello timeout. The message and what came
 * after it in the same reads.
 */
function* readFirst(
  inbound: Inbound,
  enough: (bytes: Uint8Array) => number,
  max: number,
): Operation<{ message: Uint8Array; rest: Uint8Array } | undefined> {
  return yield* race([
    (function* (): Operation<{ message: Uint8Array; rest: Uint8Array } | undefined> {
      const chunks: Uint8Array[] = []

      for (;;) {
        const next = yield* inbound.next()

        if (next.done === true) {
          return undefined
        }

        chunks.push(next.value)

        const bytes = joined(chunks)
        const length = enough(bytes)

        if (length === 0 || (length === -1 && bytes.length >= max) || length > max) {
          return undefined
        }

        if (length > 0 && bytes.length >= length) {
          return { message: bytes.subarray(0, length), rest: bytes.subarray(length) }
        }
      }
    })(),
    (function* (): Operation<undefined> {
      yield* sleep(HELLO_TIMEOUT_MS)

      return undefined
    })(),
  ])
}

/** Copy one direction until it ends, then pass the end on (half-close). */
function* pump(from: Inbound, to: IODef.TcpSocket): Operation<void> {
  for (;;) {
    const next = yield* from.next()

    if (next.done === true) {
      break
    }

    yield* to.write(next.value)
  }

  yield* to.end()
}

/** Connect to the first of `addresses` that takes the connection, within the connect timeout. */
function* connectTo(addresses: readonly string[], port: number): Operation<IODef.TcpSocket> {
  // the socket belongs to the scope it is opened in — this one, not a race's branch, which would
  // close it as the race ends: the deadline is a watchdog that fails this scope instead
  const watchdog = yield* spawn(function* () {
    yield* sleep(CONNECT_TIMEOUT_MS)

    return yield* fail(
      IgnoreDpiErrors.Resolve,
      `${addresses.join(', ')} did not take port ${port} in ${CONNECT_TIMEOUT_MS / 1000} s`,
    )
  })

  for (const address of addresses) {
    const socket = yield* attempt(IO.actions.tcpConnect({ hostname: address, port }))

    if (!isFailure(socket)) {
      yield* watchdog.halt()

      return socket.value
    }
  }

  yield* watchdog.halt()

  return yield* fail(
    IgnoreDpiErrors.Resolve,
    `no address of ${addresses.join(', ')} took port ${port}`,
  )
}

/** What the forwarder needs: where names really are, how to cut, and whom to serve. */
export interface ForwarderOptions {
  resolver: Resolver
  split: IgnoreDpiDef.Split
  /** Whether a peer may use the forwarder (this machine, or the LAN with `lan = true`). */
  admits: (peer: string) => boolean
  /** The ports the forwarder itself listens on: a name that leads back to them is refused. */
  own: readonly number[]
  /** A line for the log. */
  log: (line: string) => Operation<void>
}

/** What the forwarder did, for the state file. */
export interface ForwarderStats {
  connections: number
  failures: number
  recent: string[]
}

/** Build the forwarder: one handler for TLS (443), one for HTTP (80). */
export const createForwarder = (options: ForwarderOptions) => {
  const stats: ForwarderStats = { connections: 0, failures: 0, recent: [] }

  const noted = (name: string): void => {
    stats.recent = [name, ...stats.recent.filter(other => other !== name)].slice(0, RECENT_NAMES)
  }

  /** Reach `name` on `port`, send the first message cut in `pieces`, then copy both ways. */
  function* bridge(
    { client, inbound }: { client: IODef.TcpSocket; inbound: Inbound },
    { name, port }: { name: ServerName; port: number },
    { pieces, rest }: { pieces: readonly Uint8Array[]; rest: Uint8Array },
  ): Operation<void> {
    if (isAddress(name.name)) {
      return yield* fail(IgnoreDpiErrors.Resolve, `${name.name} is an address, not a name`)
    }

    // a name that leads back here would come round for ever
    const addresses = (yield* options.resolver.addressesOf(name.name)).filter(
      address => !isLoopback(address) || !options.own.includes(port),
    )

    if (addresses.length === 0) {
      return yield* fail(IgnoreDpiErrors.Resolve, `${name.name} has no address`)
    }

    const server = yield* connectTo(addresses, port)
    const back = yield* server.data

    noted(name.name)

    for (const [index, piece] of pieces.entries()) {
      if (index > 0) {
        yield* sleep(SEGMENT_GAP_MS)
      }

      yield* server.write(piece)
    }

    if (rest.length > 0) {
      yield* server.write(rest)
    }

    const closeBoth = function* () {
      yield* attempt(client.close())
      yield* attempt(server.close())
    }

    const forth = yield* spawn(function* () {
      if (isFailure(yield* attempt(pump(inbound, server)))) {
        yield* closeBoth()
      }
    })

    if (isFailure(yield* attempt(pump(back, client)))) {
      yield* closeBoth()
    }

    yield* forth
    yield* closeBoth()
  }

  /** One accepted connection, whatever happens to it: a failure is counted and logged, never raised. */
  const guarded = (handle: (client: IODef.TcpSocket, inbound: Inbound) => Operation<void>) =>
    function* (client: IODef.TcpSocket): Operation<void> {
      if (!options.admits(client.remoteAddress)) {
        yield* attempt(client.close())

        return
      }

      stats.connections++

      const done = yield* attempt(function* () {
        yield* handle(client, yield* client.data)
      })

      if (isFailure(done)) {
        stats.failures++
        yield* attempt(options.log(`✗ ${client.remoteAddress}: ${done.message}`))
      }

      yield* attempt(client.close())
    }

  /** TLS: the hello names the server, reached on `port` (443); it leaves cut as `split` says. */
  const https = (port: number) =>
    guarded(function* (client, inbound) {
      const first = yield* readFirst(inbound, bytes => recordLengthOf(bytes) ?? -1, MAX_HELLO_BYTES)

      if (first === undefined) {
        return
      }

      const name = serverNameOf(first.message)

      if (name === undefined) {
        return yield* fail(IgnoreDpiErrors.Resolve, 'a TLS hello without a server name')
      }

      yield* bridge(
        { client, inbound },
        { name, port },
        { pieces: helloPiecesOf(first.message, name, options.split), rest: first.rest },
      )
    })

  /** HTTP: the head names the host, reached on `port` (80); it leaves cut inside the host's name. */
  const http = (port: number) =>
    guarded(function* (client, inbound) {
      const first = yield* readFirst(inbound, headEndOf, MAX_HEAD_BYTES)

      if (first === undefined) {
        return
      }

      const host = hostOf(first.message)

      if (host === undefined) {
        return yield* fail(IgnoreDpiErrors.Resolve, 'an HTTP request without a Host')
      }

      yield* bridge(
        { client, inbound },
        { name: host, port },
        { pieces: headPiecesOf(first.message, host), rest: first.rest },
      )
    })

  return { https, http, stats }
}
