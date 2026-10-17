/** The wire as the service reads and writes it: DNS messages, the TLS hello, the HTTP head. */
import { describe, expect, it } from 'bun:test'

import {
  TYPE_A,
  TYPE_AAAA,
  TYPE_HTTPS,
  addressesOf,
  agedBy,
  answerOf,
  failureOf,
  parseQuery,
  queryOf,
  rcodeOf,
  replyTo,
  ttlOf,
} from '../src/internal/dns'
import {
  headEndOf,
  headPiecesOf,
  helloPiecesOf,
  hostOf,
  recordLengthOf,
  serverNameOf,
} from '../src/internal/hello'

import { clientHelloOf, handshakeOf, joinedOf } from './helpers'

/** An upstream's answer to `discord.com A`, as 8.8.8.8 sent it: two A records by compression pointer. */
const UPSTREAM_REPLY = Uint8Array.from([
  0x00, 0x00, 0x81, 0x80, 0x00, 0x01, 0x00, 0x02, 0x00, 0x00, 0x00, 0x00, 0x07, 0x64, 0x69, 0x73,
  0x63, 0x6f, 0x72, 0x64, 0x03, 0x63, 0x6f, 0x6d, 0x00, 0x00, 0x01, 0x00, 0x01, 0xc0, 0x0c, 0x00,
  0x01, 0x00, 0x01, 0x00, 0x00, 0x01, 0x2c, 0x00, 0x04, 0xa2, 0x9f, 0x8a, 0xe8, 0xc0, 0x0c, 0x00,
  0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x3c, 0x00, 0x04, 0xa2, 0x9f, 0x80, 0xe9,
])

describe('a DNS query', () => {
  it('is read for its one question, lowercased, and the UDP size its client takes', () => {
    const query = parseQuery(queryOf('Discord.COM', TYPE_A, 0xbe_ef))

    expect(query).toMatchObject({ id: 0xbe_ef, name: 'discord.com', type: TYPE_A, udpSize: 512 })
    expect(parseQuery(UPSTREAM_REPLY)).toBeUndefined()
    expect(parseQuery(Uint8Array.of(1, 2, 3))).toBeUndefined()
  })

  it('of a blocked name is answered with this machine for A, and with nothing for AAAA or HTTPS', () => {
    const asked = parseQuery(queryOf('discord.com', TYPE_A, 7))
    const asked6 = parseQuery(queryOf('discord.com', TYPE_AAAA, 8))
    const askedHttps = parseQuery(queryOf('discord.com', TYPE_HTTPS, 9))

    if (asked === undefined || asked6 === undefined || askedHttps === undefined) {
      throw new TypeError('the queries did not parse')
    }

    const answer = answerOf(asked, ['127.0.0.1'], 60)

    expect(addressesOf(answer)).toEqual(['127.0.0.1'])
    expect(ttlOf(answer, 0)).toBe(60)
    expect(answer[0]).toBe(0)
    expect(answer[1]).toBe(7)
    expect(addressesOf(answerOf(asked6, ['127.0.0.1'], 60))).toEqual([])
    expect(addressesOf(answerOf(askedHttps, ['127.0.0.1'], 60))).toEqual([])
    expect(rcodeOf(answerOf(asked6, ['127.0.0.1'], 60))).toBe(0)
    expect(rcodeOf(failureOf(asked))).toBe(2)
  })
})

describe("an upstream's reply", () => {
  it('gives its addresses through compressed names, and the smallest TTL', () => {
    expect(addressesOf(UPSTREAM_REPLY)).toEqual(['162.159.138.232', '162.159.128.233'])
    expect(ttlOf(UPSTREAM_REPLY, 0)).toBe(60)
  })

  it('is aged in place when it comes from the cache, never below zero', () => {
    const aged = agedBy(UPSTREAM_REPLY, 100)

    expect(ttlOf(aged, 0)).toBe(0)
    expect(addressesOf(aged)).toEqual(addressesOf(UPSTREAM_REPLY))
    expect(ttlOf(agedBy(UPSTREAM_REPLY, 10), 0)).toBe(50)
  })

  it("goes back with the client's id, and truncated when it is bigger than UDP takes", () => {
    const asked = parseQuery(queryOf('discord.com', TYPE_A, 0x12_34))

    if (asked === undefined) {
      throw new TypeError('the query did not parse')
    }

    const reply = replyTo(asked, UPSTREAM_REPLY, true)

    expect([reply[0], reply[1]]).toEqual([0x12, 0x34])
    expect(addressesOf(reply)).toEqual(['162.159.138.232', '162.159.128.233'])

    const big = new Uint8Array(700)

    big.set(UPSTREAM_REPLY)

    const truncated = replyTo(asked, big, true)

    expect((truncated[2] ?? 0) & 0x02).toBe(0x02)
    expect(replyTo(asked, big, false).length).toBe(700)
  })
})

describe('a TLS hello', () => {
  it('names its server, and where the name sits', () => {
    const hello = clientHelloOf('gateway.discord.gg')
    const name = serverNameOf(hello)

    expect(recordLengthOf(hello)).toBe(hello.length)
    expect(recordLengthOf(hello.subarray(0, 3))).toBeUndefined()
    expect(recordLengthOf(new TextEncoder().encode('GET / HTTP/1.1'))).toBe(0)
    expect(name?.name).toBe('gateway.discord.gg')
    expect(
      new TextDecoder().decode(
        hello.subarray(name?.at ?? 0, (name?.at ?? 0) + (name?.length ?? 0)),
      ),
    ).toBe('gateway.discord.gg')
  })

  it('leaves as two records cut inside the name — the same handshake, no record holding the name whole', () => {
    const hello = clientHelloOf('discord.com')
    const name = serverNameOf(hello)

    if (name === undefined) {
      throw new TypeError('no name')
    }

    const [joined, ...more] = helloPiecesOf(hello, name, 'record')
    const carried = handshakeOf(joined ?? new Uint8Array())

    expect(more).toEqual([])
    expect(carried.records).toBe(2)
    expect(carried.body).toEqual(joinedOf([hello.subarray(5)]))

    const first =
      joined?.subarray(0, 5 + (((joined[3] ?? 0) << 8) | (joined[4] ?? 0))) ?? new Uint8Array()

    expect(new TextDecoder().decode(first).includes('discord.com')).toBe(false)
  })

  it('leaves as two segments of one record (`segment`), or two records as two writes (`both`)', () => {
    const hello = clientHelloOf('discord.com')
    const name = serverNameOf(hello)

    if (name === undefined) {
      throw new TypeError('no name')
    }

    const segments = helloPiecesOf(hello, name, 'segment')
    const both = helloPiecesOf(hello, name, 'both')

    expect(segments).toHaveLength(2)
    expect(joinedOf(segments)).toEqual(joinedOf([hello]))
    expect(both).toHaveLength(2)
    expect(handshakeOf(joinedOf(both)).body).toEqual(joinedOf([hello.subarray(5)]))
  })
})

describe('an HTTP head', () => {
  it('ends at its blank line, names its host (port dropped), and leaves as `hoSt`, cut inside it', () => {
    const head = new TextEncoder().encode(
      'GET / HTTP/1.1\r\nUser-Agent: x\r\nHOST: Discord.com:80\r\n\r\nbody',
    )
    const end = headEndOf(head)
    const host = hostOf(head.subarray(0, end))

    expect(new TextDecoder().decode(head.subarray(end))).toBe('body')
    expect(headEndOf(head.subarray(0, 20))).toBe(-1)
    expect(host?.name).toBe('discord.com')

    const pieces = headPiecesOf(head.subarray(0, end), host ?? { name: '', at: 0, length: 0 })

    expect(pieces).toHaveLength(2)
    expect(new TextDecoder().decode(pieces[0]).includes('Discord.com')).toBe(false)
    expect(new TextDecoder().decode(joinedOf(pieces))).toBe(
      'GET / HTTP/1.1\r\nUser-Agent: x\r\nhoSt: Discord.com:80\r\n\r\n',
    )
  })
})
