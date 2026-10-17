import { attempt, race, scoped, sleep, withResolvers } from 'std:effect'
import type { Operation } from 'std:effect'
import { IO } from 'std:io'
import { fail, isFailure } from 'std:result'

import { connect } from 'node:tls'

import { CONNECT_TIMEOUT_MS, HTTPS_PORT, IgnoreDpiErrors, LOOPBACK, SEGMENT_GAP_MS } from '../const'

import { recordLengthOf } from './hello'

/** How long a probed server has to answer a hello. */
const PROBE_TIMEOUT_MS = 5000

/** What became of a hello sent to a server. */
export type ProbeResult =
  | { kind: 'answered'; ms: number }
  | { kind: 'reset' }
  | { kind: 'silent' }
  | { kind: 'refused' }

/** The words `check` prints for a result. */
export const describeProbe = (result: ProbeResult): string => {
  switch (result.kind) {
    case 'answered': {
      return `answered in ${result.ms} ms`
    }

    case 'reset': {
      return 'cut off (the connection was reset — the DPI)'
    }

    case 'silent': {
      return `no answer in ${PROBE_TIMEOUT_MS / 1000} s`
    }

    default: {
      return 'refused (the address itself is unreachable)'
    }
  }
}

/**
 * A real ClientHello for `name`, as this machine's TLS stack writes it: a TLS client is pointed at
 * a listener of the probe's own, which keeps the first record and hangs up.
 */
export function* helloFor(name: string): Operation<Uint8Array> {
  return yield* scoped(function* () {
    const captured = withResolvers<Uint8Array>()
    const server = yield* IO.actions.tcpListen({ port: 0, hostname: LOOPBACK }, function* (socket) {
      const inbound = yield* socket.data
      const chunks: Uint8Array[] = []
      let size = 0

      for (;;) {
        const next = yield* inbound.next()

        if (next.done === true) {
          break
        }

        chunks.push(next.value)
        size += next.value.length

        const bytes = new Uint8Array(size)
        let offset = 0

        for (const chunk of chunks) {
          bytes.set(chunk, offset)
          offset += chunk.length
        }

        const length = recordLengthOf(bytes)

        if (length !== undefined && length > 0 && size >= length) {
          captured.resolve(bytes.subarray(0, length))

          break
        }
      }

      yield* attempt(socket.close())
    })
    const client = connect({
      host: LOOPBACK,
      port: server.port,
      servername: name,
      rejectUnauthorized: false,
      ALPNProtocols: ['h2', 'http/1.1'],
    })

    // the listener hangs up once it has the hello: that is the end the client meets
    client.on('error', () => {})

    const hello = yield* race([
      captured.operation,
      (function* (): Operation<undefined> {
        yield* sleep(CONNECT_TIMEOUT_MS)

        return undefined
      })(),
    ])

    client.destroy()

    if (hello === undefined) {
      return yield* fail(IgnoreDpiErrors.Resolve, `no TLS hello for ${name} could be made`)
    }

    return hello
  })
}

/**
 * Send a hello to `address` as `pieces` (one write each) and wait for the server's first bytes:
 * a server that answers is reached, a reset is the DPI, silence is a drop.
 */
export function* probe(
  address: string,
  pieces: readonly Uint8Array[],
  port = HTTPS_PORT,
): Operation<ProbeResult> {
  return yield* scoped(function* () {
    const started = Date.now()
    const socket = yield* attempt(IO.actions.tcpConnect({ hostname: address, port }))

    if (isFailure(socket)) {
      return { kind: 'refused' } as const
    }

    const inbound = yield* socket.value.data

    for (const [index, piece] of pieces.entries()) {
      if (index > 0) {
        yield* sleep(SEGMENT_GAP_MS)
      }

      yield* socket.value.write(piece)
    }

    const result = yield* race([
      (function* (): Operation<ProbeResult> {
        const next = yield* attempt(inbound.next())

        return isFailure(next) || next.value.done === true
          ? { kind: 'reset' }
          : { kind: 'answered', ms: Date.now() - started }
      })(),
      (function* (): Operation<ProbeResult> {
        yield* sleep(PROBE_TIMEOUT_MS)

        return { kind: 'silent' }
      })(),
    ])

    yield* attempt(socket.value.close())

    return result
  })
}
