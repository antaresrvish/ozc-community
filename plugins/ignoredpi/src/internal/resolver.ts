import { attempt, race, scoped, sleep, spawn } from 'std:effect'
import type { Operation } from 'std:effect'
import { Fetch } from 'std:fetch'
import { IO } from 'std:io'
import { fail, isFailure } from 'std:result'

import {
  BLOCKED_HOLD_MS,
  CANARIES,
  CANARY_QUORUM,
  DIRECT_HOLD_MS,
  DNS_PORT,
  IgnoreDpiErrors,
  ISP_TIMEOUT_MS,
  LOOPBACK,
  MAX_CACHE_ENTRIES,
  MAX_CACHE_TTL,
  NEGATIVE_TTL,
  REDIRECT_TTL,
  UNSURE_HOLD_MS,
  UPSTREAM_TIMEOUT_MS,
} from '../const'
import type { IgnoreDpiDef } from '../types'

import {
  CLASS_IN,
  RCODE_SERVFAIL,
  TYPE_A,
  TYPE_AAAA,
  TYPE_HTTPS,
  TYPE_SVCB,
  addressesOf,
  agedBy,
  answerOf,
  failureOf,
  isReply,
  queryOf,
  rcodeOf,
  replyTo,
  ttlOf,
} from './dns'
import type { Query } from './dns'
import { isInside, isLoopback, isUnder } from './names'

/** The record types a blocked name is answered for by the service itself. */
const STEERED_TYPES = new Set([TYPE_A, TYPE_AAAA, TYPE_HTTPS, TYPE_SVCB])

interface CacheEntry {
  bytes: Uint8Array
  storedAt: number
  ttl: number
}

/** The address a blocked name is answered with for `peer`: this machine as that peer reaches it. */
function* redirectFor(peer: string): Operation<string> {
  if (isLoopback(peer)) {
    return LOOPBACK
  }

  const interfaces = yield* IO.actions.ip()
  const reached = interfaces.find(
    entry =>
      entry.family === 'IPv4' &&
      !entry.internal &&
      entry.cidr !== null &&
      isInside(peer, entry.cidr),
  )

  return reached?.address ?? LOOPBACK
}

/** What a resolver is built from: the lists, the upstreams, and how blocked names are told. */
export interface ResolverOptions {
  /** Names sent through the forwarder (built-in and configured), each with its subdomains. */
  domains: readonly string[]
  /** Names never sent through it. */
  direct: readonly string[]
  /** DoH endpoints, in order. */
  upstreams: readonly string[]
  /** The ISP's resolver, asked only to tell blocked names; `undefined` → the lists alone. */
  isp: string | undefined
  /** Its port (53). */
  ispPort?: number | undefined
  /** The block pages' addresses known up front (built-in and configured). */
  sinkholes: readonly string[]
  /** The clock, in milliseconds (the suites move it). */
  now?: (() => number) | undefined
}

/** A client's query as it arrived: parsed, raw, from whom, and whether over UDP. */
export interface Asked {
  query: Query
  raw: Uint8Array
  peer: string
  udp: boolean
}

/** A verdict with its reason. */
export interface Judgement {
  verdict: IgnoreDpiDef.Verdict
  reason: IgnoreDpiDef.Reason
}

/** The service's DNS: what clients are answered with, and the real addresses the forwarder needs. */
export interface Resolver {
  /** The reply to a client's query — the client's id, sized for UDP when it came that way. */
  answer: (asked: Asked) => Operation<Uint8Array>
  /** A name's real IPv4 addresses, from the upstreams. */
  addressesOf: (name: string) => Operation<string[]>
  /** Whether a name goes through the forwarder, and why. */
  judge: (name: string) => Operation<Judgement>
  /** Learn the ISP's block page addresses from the canaries; returns every sinkhole in use. */
  learn: () => Operation<string[]>
  /** The sinkholes in use. */
  sinkholes: () => string[]
  counters: { queries: number; redirected: number }
}

/** A UDP query to a plain DNS server (port 53 unless said), its reply or a failure after `timeoutMs`. */
export function* askPlain(
  to: { server: string; port?: number | undefined; timeoutMs: number },
  query: Uint8Array,
): Operation<Uint8Array> {
  const { server, timeoutMs } = to
  const port = to.port ?? DNS_PORT

  return yield* scoped(function* () {
    const socket = yield* IO.actions.udpBind({ port: 0 })
    const messages = yield* socket.messages

    yield* socket.send(query, port, server)

    const reply = yield* race([
      (function* (): Operation<Uint8Array | undefined> {
        for (;;) {
          const next = yield* messages.next()

          if (next.done === true) {
            return undefined
          }

          // the reply to OUR query: same id, from the server asked
          if (
            next.value.address === server &&
            isReply(next.value.data) &&
            next.value.data[0] === query[0] &&
            next.value.data[1] === query[1]
          ) {
            return next.value.data
          }
        }
      })(),
      (function* (): Operation<undefined> {
        yield* sleep(timeoutMs)

        return undefined
      })(),
    ])

    if (reply === undefined) {
      return yield* fail(IgnoreDpiErrors.Resolve, `${server} did not answer in ${timeoutMs}ms`)
    }

    return reply
  })
}

/** A DNS-over-HTTPS query (RFC 8484, POST), its reply. */
export function* askHttps(upstream: string, query: Uint8Array): Operation<Uint8Array> {
  const response = yield* Fetch.actions.post(upstream, {
    body: query,
    headers: { 'content-type': 'application/dns-message', accept: 'application/dns-message' },
    timeoutMs: UPSTREAM_TIMEOUT_MS,
    propagate: false,
  })

  if (!response.ok) {
    return yield* fail(IgnoreDpiErrors.Resolve, `${upstream} answered ${response.status}`)
  }

  const reply = yield* response.bytes()

  if (!isReply(reply)) {
    return yield* fail(IgnoreDpiErrors.Resolve, `${upstream} answered something that is not DNS`)
  }

  return reply
}

/**
 * The addresses an ISP answers two canaries or more with, that the upstreams never give for them:
 * the ISP's block page. Pure — fed the two sides' answers per canary.
 */
export const sinkholesOf = (
  answers: readonly { isp: readonly string[]; upstream: readonly string[] }[],
  quorum = CANARY_QUORUM,
): string[] => {
  const counts = new Map<string, number>()

  for (const { isp, upstream } of answers) {
    for (const address of new Set(isp)) {
      if (!upstream.includes(address)) {
        counts.set(address, (counts.get(address) ?? 0) + 1)
      }
    }
  }

  return [...counts].filter(([, count]) => count >= quorum).map(([address]) => address)
}

/** Build the service's resolver. Its caches live as long as it does. */
export const createResolver = (options: ResolverOptions): Resolver => {
  const now = options.now ?? Date.now
  const cache = new Map<string, CacheEntry>()
  const verdicts = new Map<string, Judgement & { until: number }>()
  const sinkholes = new Set(options.sinkholes)
  const counters = { queries: 0, redirected: 0 }
  let preferred = 0

  const ispOf = (server: string) => ({ server, port: options.ispPort, timeoutMs: ISP_TIMEOUT_MS })

  const remember = (key: string, bytes: Uint8Array): void => {
    if (rcodeOf(bytes) === RCODE_SERVFAIL) {
      return
    }

    cache.delete(key)

    if (cache.size >= MAX_CACHE_ENTRIES) {
      const oldest = cache.keys().next().value

      if (oldest !== undefined) {
        cache.delete(oldest)
      }
    }

    cache.set(key, {
      bytes,
      storedAt: now(),
      ttl: Math.min(ttlOf(bytes, NEGATIVE_TTL), MAX_CACHE_TTL),
    })
  }

  const recall = (key: string): Uint8Array | undefined => {
    const entry = cache.get(key)

    if (entry === undefined) {
      return undefined
    }

    const age = Math.floor((now() - entry.storedAt) / 1000)

    if (age >= entry.ttl) {
      cache.delete(key)

      return undefined
    }

    return agedBy(entry.bytes, age)
  }

  /** The upstreams' reply to a query (asked with id 0), cached by its question. */
  function* forward(question: Pick<Query, 'name' | 'type' | 'class'>, raw: Uint8Array) {
    const { name } = question
    const key = `${name}/${question.type}/${question.class}`
    const cached = recall(key)

    if (cached !== undefined) {
      return cached
    }

    const query = raw.slice()

    query[0] = 0
    query[1] = 0

    for (let index = 0; index < options.upstreams.length; index++) {
      const at = (preferred + index) % options.upstreams.length
      const upstream = options.upstreams[at]

      if (upstream === undefined) {
        continue
      }

      const reply = yield* attempt(askHttps(upstream, query))

      if (!isFailure(reply)) {
        preferred = at
        remember(key, reply.value)

        return reply.value
      }
    }

    // every upstream down: the ISP answers what it will — blocked names stay blocked, the rest works
    if (options.isp !== undefined) {
      const reply = yield* askPlain(ispOf(options.isp), query)

      remember(key, reply)

      return reply
    }

    return yield* fail(IgnoreDpiErrors.Resolve, `no upstream answered for ${name}`)
  }

  function* judge(name: string): Operation<Judgement> {
    if (isUnder(name, options.direct)) {
      return { verdict: 'direct', reason: 'direct-list' }
    }

    if (isUnder(name, options.domains)) {
      return { verdict: 'blocked', reason: 'list' }
    }

    const known = verdicts.get(name)

    if (known !== undefined && known.until > now()) {
      return { verdict: known.verdict, reason: known.reason }
    }

    const judged = yield* askIsp(name)

    verdicts.set(name, {
      ...judged,
      until:
        now() +
        (judged.verdict === 'blocked'
          ? BLOCKED_HOLD_MS
          : judged.reason === 'isp'
            ? DIRECT_HOLD_MS
            : UNSURE_HOLD_MS),
    })

    return judged
  }

  /** What the ISP's resolver says of a name: a sinkhole address means it is blocked. */
  function* askIsp(name: string): Operation<Judgement> {
    if (options.isp === undefined) {
      return { verdict: 'direct', reason: 'no-isp' }
    }

    const id = yield* IO.actions.randomBytes(2)
    const reply = yield* attempt(
      askPlain(ispOf(options.isp), queryOf(name, TYPE_A, ((id[0] ?? 0) << 8) | (id[1] ?? 0))),
    )

    if (isFailure(reply)) {
      return { verdict: 'direct', reason: 'no-isp' }
    }

    return addressesOf(reply.value).some(address => sinkholes.has(address))
      ? { verdict: 'blocked', reason: 'sinkhole' }
      : { verdict: 'direct', reason: 'isp' }
  }

  function* answer({ query, raw, peer, udp }: Asked) {
    counters.queries++

    if (query.class !== CLASS_IN || !STEERED_TYPES.has(query.type)) {
      const reply = yield* attempt(forward(query, raw))

      return isFailure(reply) ? failureOf(query) : replyTo(query, reply.value, udp)
    }

    // the upstream is asked while the verdict is made: a direct name pays for one round trip, not two
    const upstream = yield* spawn(() => attempt(forward(query, raw)))
    const { verdict } = yield* judge(query.name)

    if (verdict === 'blocked') {
      yield* upstream.halt()
      counters.redirected++

      return answerOf(query, [yield* redirectFor(peer)], REDIRECT_TTL)
    }

    const reply = yield* upstream

    return isFailure(reply) ? failureOf(query) : replyTo(query, reply.value, udp)
  }

  function* addressesFor(name: string): Operation<string[]> {
    const reply = yield* forward({ name, type: TYPE_A, class: CLASS_IN }, queryOf(name, TYPE_A))

    return addressesOf(reply).filter(address => !address.includes(':'))
  }

  function* learn(): Operation<string[]> {
    if (options.isp === undefined) {
      return [...sinkholes]
    }

    const answers: { isp: string[]; upstream: string[] }[] = []

    for (const canary of CANARIES) {
      const isp = yield* attempt(askPlain(ispOf(options.isp), queryOf(canary, TYPE_A, 0x1d_e0)))
      const upstream = yield* attempt(addressesFor(canary))

      if (!isFailure(isp) && !isFailure(upstream)) {
        answers.push({ isp: addressesOf(isp.value), upstream: upstream.value })
      }
    }

    for (const address of sinkholesOf(answers)) {
      sinkholes.add(address)
    }

    return [...sinkholes]
  }

  return {
    answer,
    addressesOf: addressesFor,
    judge,
    learn,
    sinkholes: () => [...sinkholes],
    counters,
  }
}
