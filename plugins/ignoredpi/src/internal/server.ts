import { attempt, each, spawn } from 'std:effect'
import type { Operation } from 'std:effect'
import { IO } from 'std:io'
import type { IODef } from 'std:io'
import { fail, isFailure } from 'std:result'

import { IgnoreDpiErrors, WILDCARD } from '../const'

import { parseQuery } from './dns'
import type { Resolver } from './resolver'

/** One answer over TCP: two bytes of length, then the message (RFC 1035 §4.2.2). */
const framed = (message: Uint8Array): Uint8Array => {
  const bytes = new Uint8Array(message.length + 2)

  bytes[0] = message.length >> 8
  bytes[1] = message.length & 0xff
  bytes.set(message, 2)

  return bytes
}

/** What the DNS server answers with, and whom. */
export interface DnsServerOptions {
  resolver: Resolver
  port: number
  admits: (peer: string) => boolean
  log: (line: string) => Operation<void>
}

/** Bind a port the service needs; a refusal says which and why, as a `listen` failure. */
export function* bound<T>(what: string, port: number, bind: () => Operation<T>): Operation<T> {
  const done = yield* attempt(bind)

  if (isFailure(done)) {
    return yield* fail(
      IgnoreDpiErrors.Listen,
      `cannot take ${what} port ${port} (${done.message}) — is another DNS server or proxy running?`,
    )
  }

  return done.value
}

/**
 * The service's DNS, on the port given (53), UDP and TCP: every query is the resolver's to answer;
 * a peer that is not admitted gets nothing; a query that is not one gets nothing either.
 */
export function* serveDns(options: DnsServerOptions): Operation<void> {
  const { resolver, port, admits, log } = options

  function* answerDatagram(socket: IODef.UdpSocket, datagram: IODef.UdpDatagram) {
    const query = parseQuery(datagram.data)

    if (query === undefined) {
      return
    }

    const reply = yield* attempt(
      resolver.answer({ query, raw: datagram.data, peer: datagram.address, udp: true }),
    )

    if (isFailure(reply)) {
      yield* attempt(log(`✗ dns ${query.name}: ${reply.message}`))

      return
    }

    yield* attempt(socket.send(reply.value, datagram.port, datagram.address))
  }

  function* answerStream(client: IODef.TcpSocket): Operation<void> {
    if (!admits(client.remoteAddress)) {
      yield* attempt(client.close())

      return
    }

    let pending = new Uint8Array(0)

    for (const chunk of yield* each(client.data)) {
      const joined = new Uint8Array(pending.length + chunk.length)

      joined.set(pending)
      joined.set(chunk, pending.length)
      pending = joined

      while (
        pending.length >= 2 &&
        pending.length >= 2 + ((pending[0] ?? 0) << 8) + (pending[1] ?? 0)
      ) {
        const length = ((pending[0] ?? 0) << 8) + (pending[1] ?? 0)
        const raw = pending.slice(2, 2 + length)
        const query = parseQuery(raw)

        pending = pending.slice(2 + length)

        if (query !== undefined) {
          const reply = yield* attempt(
            resolver.answer({ query, raw, peer: client.remoteAddress, udp: false }),
          )

          if (!isFailure(reply)) {
            yield* client.write(framed(reply.value))
          }
        }
      }

      yield* each.next()
    }

    yield* attempt(client.close())
  }

  const udp = yield* bound('DNS (UDP)', port, () =>
    IO.actions.udpBind({ port, hostname: WILDCARD }),
  )

  yield* bound('DNS (TCP)', port, () =>
    IO.actions.tcpListen({ port, hostname: WILDCARD }, function* (client) {
      yield* attempt(answerStream(client))
    }),
  )

  yield* spawn(function* () {
    for (const datagram of yield* each(udp.messages)) {
      if (admits(datagram.address)) {
        yield* spawn(() => attempt(answerDatagram(udp, datagram)))
      }

      yield* each.next()
    }
  })
}
