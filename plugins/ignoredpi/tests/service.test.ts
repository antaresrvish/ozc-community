/**
 * The service end to end, on ports of its own: an upstream (DoH over plain HTTP), an ISP resolver
 * that answers canaries and one name with a block page, and a server blocked names are forwarded
 * to — all the suite's own. Nothing on the machine's DNS settings is touched.
 */
import { run, suspend } from 'std:effect'
import type { Task } from 'std:effect'
import { FetchClient } from 'std:fetch'

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { createSocket } from 'node:dgram'
import { connect } from 'node:net'

import { BunIO } from 'std:io/impl/bun'

import { TYPE_A, TYPE_AAAA, addressesOf, answerOf, parseQuery, queryOf } from '../src/internal/dns'
import { createResolver } from '../src/internal/resolver'
import { serve } from '../src/internal/service'

import { clientHelloOf, handshakeOf, joinedOf } from './helpers'

/** What the upstream really resolves names to. */
const UPSTREAM: Record<string, string> = {
  'blocked.test': '127.0.0.1',
  'sink.test': '127.0.0.1',
  'open.test': '10.9.8.7',
  'discord.com': '162.159.0.1',
  'wattpad.com': '162.159.0.2',
  'roblox.com': '162.159.0.3',
}

/** The ISP's block page, as the suite's ISP answers the canaries and `sink.test`. */
const BLOCK_PAGE = '203.0.113.9'

const base = 40_000 + Math.floor(Math.random() * 20_000)
const ports = { dns: base, http: base + 1, https: base + 2 }
const received: Uint8Array[] = []

let service: Task<void> | undefined
let stops: (() => void)[] = []

/** Ask the service's DNS over UDP; the addresses it answered. */
const ask = (name: string, type = TYPE_A): Promise<string[]> =>
  new Promise((resolve, reject) => {
    const socket = createSocket('udp4')
    const timer = setTimeout(() => reject(new TypeError(`no answer for ${name}`)), 3000)

    socket.on('message', message => {
      clearTimeout(timer)
      socket.close()
      resolve(addressesOf(new Uint8Array(message)))
    })
    socket.send(queryOf(name, type, 0x42_42), ports.dns, '127.0.0.1')
  })

/** Send `bytes` to a port of the service; what came back before the connection closed. */
const exchange = (port: number, bytes: Uint8Array): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = []
    const socket = connect({ host: '127.0.0.1', port }, () => socket.write(bytes))
    const timer = setTimeout(() => reject(new TypeError('no answer')), 5000)

    socket.on('data', (chunk: Buffer) => chunks.push(chunk))
    socket.on('error', reject)
    socket.on('close', () => {
      clearTimeout(timer)
      resolve(new TextDecoder().decode(joinedOf(chunks)))
    })
  })

beforeAll(async () => {
  const upstream = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const query = parseQuery(new Uint8Array(await request.arrayBuffer()))
      const address = query === undefined ? undefined : UPSTREAM[query.name]

      if (query === undefined) {
        return new Response('not DNS', { status: 400 })
      }

      return new Response(answerOf(query, address === undefined ? [] : [address], 30), {
        headers: { 'content-type': 'application/dns-message' },
      })
    },
  })
  const isp = createSocket('udp4')

  isp.on('message', (message, from) => {
    const query = parseQuery(new Uint8Array(message))

    if (query === undefined) {
      return
    }

    const blocked = ['discord.com', 'wattpad.com', 'roblox.com', 'sink.test'].includes(query.name)
    const address = blocked ? BLOCK_PAGE : (UPSTREAM[query.name] ?? '10.0.0.1')

    isp.send(answerOf(query, [address], 30), from.port, from.address)
  })
  await new Promise<void>(resolve => {
    isp.bind(0, '127.0.0.1', resolve)
  })
  // the server a blocked name is forwarded to: it keeps what arrives and answers once it is whole
  const target = Bun.listen<{ bytes: number[] }>({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      open(socket) {
        socket.data = { bytes: [] }
      },
      data(socket, data) {
        socket.data.bytes.push(...data)

        const bytes = Uint8Array.from(socket.data.bytes)
        const http = bytes[0] !== 0x16
        const whole = http
          ? new TextDecoder().decode(bytes).endsWith('\r\n\r\n')
          : handshakeOf(bytes).body.length === clientHelloOf('blocked.test').length - 5

        if (whole) {
          received.push(bytes)
          socket.end(http ? 'http pong' : 'tls pong')
        }
      },
    },
  })

  stops = [() => upstream.stop(true), () => isp.close(), () => target.stop(true)]

  const { promise: ready, resolve } = Promise.withResolvers<void>()

  service = run(function* () {
    yield* BunIO.use()
    yield* FetchClient.use()

    const resolver = createResolver({
      domains: ['blocked.test'],
      direct: [],
      upstreams: [`http://127.0.0.1:${upstream.port}/dns-query`],
      isp: '127.0.0.1',
      ispPort: isp.address().port,
      sinkholes: [],
    })

    yield* resolver.learn()
    yield* serve({
      settings: {},
      resolver,
      ports,
      targets: { http: target.port, https: target.port },
      *log() {},
    })
    resolve()
    yield* suspend()
  })

  await Promise.race([ready, service])
})

afterAll(async () => {
  await service?.halt()

  for (const stop of stops) {
    stop()
  }
})

describe('the DNS', () => {
  it('answers a name on the list with this machine, and with no IPv6 address', async () => {
    expect(await ask('blocked.test')).toEqual(['127.0.0.1'])
    expect(await ask('www.blocked.test')).toEqual(['127.0.0.1'])
    expect(await ask('blocked.test', TYPE_AAAA)).toEqual([])
  })

  it('answers a name the ISP sends to its block page — learned from the canaries — with this machine', async () => {
    expect(await ask('sink.test')).toEqual(['127.0.0.1'])
  })

  it('answers every other name as the upstream does', async () => {
    expect(await ask('open.test')).toEqual(['10.9.8.7'])
    expect(await ask('open.test')).toEqual(['10.9.8.7'])
  })

  it('answers over TCP as well', async () => {
    const query = queryOf('open.test', TYPE_A, 0x77_77)
    const framed = joinedOf([[query.length >> 8, query.length & 0xff], query])
    const reply = await new Promise<Uint8Array>((resolve, reject) => {
      const socket = connect({ host: '127.0.0.1', port: ports.dns }, () => socket.write(framed))

      socket.on('data', (chunk: Buffer) => {
        resolve(new Uint8Array(chunk).subarray(2))
        socket.destroy()
      })
      socket.on('error', reject)
    })

    expect(addressesOf(reply)).toEqual(['10.9.8.7'])
  })
})

describe('the forwarder', () => {
  it('reaches the server a TLS hello names, the hello cut in two records, and brings its answer back', async () => {
    const hello = clientHelloOf('blocked.test')

    expect(await exchange(ports.https, hello)).toBe('tls pong')

    const arrived = received.find(bytes => bytes[0] === 0x16) ?? new Uint8Array()
    const carried = handshakeOf(arrived)

    expect(carried.records).toBe(2)
    expect(carried.body).toEqual(joinedOf([hello.subarray(5)]))
  })

  it('reaches the host an HTTP head names, the head as it was but for the header’s name', async () => {
    const head = 'GET / HTTP/1.1\r\nHost: blocked.test\r\n\r\n'

    expect(await exchange(ports.http, new TextEncoder().encode(head))).toBe('http pong')
    expect(new TextDecoder().decode(received.find(bytes => bytes[0] === 0x47))).toBe(
      'GET / HTTP/1.1\r\nhoSt: blocked.test\r\n\r\n',
    )
  })

  it('hangs up on what is not a hello', async () => {
    expect(await exchange(ports.https, new TextEncoder().encode('hello?'))).toBe('')
  })
})
