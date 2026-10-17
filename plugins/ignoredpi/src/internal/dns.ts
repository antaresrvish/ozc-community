/**
 * DNS messages as the wire has them (RFC 1035, EDNS from RFC 6891): just enough to read the one
 * question a client asks, answer a blocked name with this machine, and age, cache and truncate
 * what an upstream answered. Pure — no socket here.
 */

const HEADER = 12
const FLAG_QR = 0x80_00
const FLAG_TC = 0x02_00
const FLAG_RD = 0x01_00
const FLAG_RA = 0x00_80

const u16 = (bytes: Uint8Array, at: number): number =>
  ((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0)

const u32 = (bytes: Uint8Array, at: number): number => u16(bytes, at) * 65_536 + u16(bytes, at + 2)

const put16 = (bytes: Uint8Array, at: number, value: number): void => {
  bytes[at] = (value >> 8) & 0xff
  bytes[at + 1] = value & 0xff
}

const put32 = (bytes: Uint8Array, at: number, value: number): void => {
  put16(bytes, at, Math.floor(value / 65_536) & 0xff_ff)
  put16(bytes, at + 2, value & 0xff_ff)
}

/** Where the record starting at `at` ends, with its type and where its TTL sits. */
const readRecord = (
  bytes: Uint8Array,
  at: number,
): { type: number; ttlAt: number; data: number; end: number } | undefined => {
  const name = readName(bytes, at)

  if (name === undefined || name.next + 10 > bytes.length) {
    return undefined
  }

  const type = u16(bytes, name.next)
  const length = u16(bytes, name.next + 8)
  const end = name.next + 10 + length

  return end > bytes.length ? undefined : { type, ttlAt: name.next + 4, data: name.next + 10, end }
}

/** The records of a message past its question section, in order. `undefined` when malformed. */
const recordsOf = (
  bytes: Uint8Array,
): { type: number; ttlAt: number; data: number; end: number; section: number }[] | undefined => {
  if (bytes.length < HEADER) {
    return undefined
  }

  let offset = HEADER

  for (let index = 0; index < u16(bytes, 4); index++) {
    const name = readName(bytes, offset)

    if (name === undefined) {
      return undefined
    }

    offset = name.next + 4
  }

  const records: { type: number; ttlAt: number; data: number; end: number; section: number }[] = []
  const sections = [u16(bytes, 6), u16(bytes, 8), u16(bytes, 10)]

  for (const [section, count] of sections.entries()) {
    for (let index = 0; index < count; index++) {
      const record = readRecord(bytes, offset)

      if (record === undefined) {
        return undefined
      }

      records.push({ ...record, section })
      offset = record.end
    }
  }

  return records
}

/** The canonical text of an IPv6 address from its eight groups: the longest zero run as `::`. */
const compressIpv6 = (groups: string[]): string => {
  let best = { at: -1, length: 0 }
  let run = { at: -1, length: 0 }

  for (const [index, group] of groups.entries()) {
    if (group === '0') {
      run = run.at === -1 ? { at: index, length: 1 } : { at: run.at, length: run.length + 1 }

      if (run.length > best.length) {
        best = run
      }
    } else {
      run = { at: -1, length: 0 }
    }
  }

  if (best.length < 2) {
    return groups.join(':')
  }

  const head = groups.slice(0, best.at).join(':')
  const tail = groups.slice(best.at + best.length).join(':')

  return `${head}::${tail}`
}

/** The record types the service has a say in; every other type is the upstream's to answer. */
export const TYPE_A = 1
export const TYPE_AAAA = 28
export const TYPE_OPT = 41
export const TYPE_SVCB = 64
export const TYPE_HTTPS = 65
export const CLASS_IN = 1

export const RCODE_NOERROR = 0
export const RCODE_SERVFAIL = 2
export const RCODE_NXDOMAIN = 3

/** The size a client takes over UDP when it does not say (no EDNS). */
export const PLAIN_UDP_SIZE = 512

/** One client query, as far as the service reads it. */
export interface Query {
  id: number
  /** The flags word as sent: its opcode and RD bit are echoed. */
  flags: number
  /** The name lowercased, without the root dot; the raw question is kept to echo as sent. */
  name: string
  type: number
  class: number
  /** The bytes of the question section (name, type, class) exactly as the client wrote them. */
  question: Uint8Array
  /** The largest UDP answer the client takes. */
  udpSize: number
}

/**
 * Read a (possibly compressed) name starting at `at`: its dotted lowercase text, and where the
 * bytes after it begin — after the first pointer when there is one. `undefined` on a malformed
 * name (a pointer loop, a label past the end).
 */
export const readName = (
  bytes: Uint8Array,
  at: number,
): { name: string; next: number } | undefined => {
  const labels: string[] = []
  let offset = at
  let next: number | undefined
  let jumps = 0

  for (;;) {
    const length = bytes[offset]

    if (length === undefined) {
      return undefined
    }

    if (length === 0) {
      next ??= offset + 1

      break
    }

    if ((length & 0xc0) === 0xc0) {
      if (++jumps > 32 || offset + 1 >= bytes.length) {
        return undefined
      }

      next ??= offset + 2
      offset = ((length & 0x3f) << 8) | (bytes[offset + 1] ?? 0)

      continue
    }

    if (offset + 1 + length > bytes.length) {
      return undefined
    }

    labels.push(new TextDecoder().decode(bytes.subarray(offset + 1, offset + 1 + length)))
    offset += 1 + length
  }

  return { name: labels.join('.').toLowerCase(), next }
}

/** Read a client's query: one question, and the UDP size its OPT record names. */
export const parseQuery = (bytes: Uint8Array): Query | undefined => {
  if (bytes.length < HEADER || u16(bytes, 4) !== 1 || (u16(bytes, 2) & FLAG_QR) !== 0) {
    return undefined
  }

  const name = readName(bytes, HEADER)

  if (name === undefined || name.next + 4 > bytes.length) {
    return undefined
  }

  const records = recordsOf(bytes)
  const opt = records?.find(record => record.type === TYPE_OPT)
  const optClass = opt === undefined ? 0 : u16(bytes, opt.ttlAt - 2)

  return {
    id: u16(bytes, 0),
    flags: u16(bytes, 2),
    name: name.name,
    type: u16(bytes, name.next),
    class: u16(bytes, name.next + 2),
    question: bytes.slice(HEADER, name.next + 4),
    udpSize: Math.max(PLAIN_UDP_SIZE, optClass),
  }
}

/** A query for `name` of `type`, as the service asks it of an upstream (recursion desired). */
export const queryOf = (name: string, type: number, id = 0): Uint8Array => {
  const labels = name.split('.').filter(label => label !== '')
  const encoded = labels.map(label => new TextEncoder().encode(label))
  const size = encoded.reduce((sum, label) => sum + 1 + label.length, 1)
  const bytes = new Uint8Array(HEADER + size + 4)
  let offset = HEADER

  put16(bytes, 0, id)
  put16(bytes, 2, FLAG_RD)
  put16(bytes, 4, 1)

  for (const label of encoded) {
    bytes[offset] = label.length
    bytes.set(label, offset + 1)
    offset += 1 + label.length
  }

  bytes[offset] = 0
  put16(bytes, offset + 1, type)
  put16(bytes, offset + 3, CLASS_IN)

  return bytes
}

/** The address bytes of an IPv4 literal, or `undefined` when it is not one. */
export const ipv4Bytes = (address: string): number[] | undefined => {
  const parts = address.split('.')

  if (parts.length !== 4 || parts.some(part => !/^\d{1,3}$/u.test(part) || Number(part) > 255)) {
    return undefined
  }

  return parts.map(Number)
}

/**
 * The answer to `query` the service makes itself: the given IPv4 addresses as A records when the
 * question asks for A, and no records at all (NOERROR, NODATA) for anything else — a blocked name
 * has no IPv6 address and no HTTPS record here, so a client neither goes around the forwarder nor
 * gets an encrypted hello it would open with another name.
 */
export const answerOf = (query: Query, addresses: readonly string[], ttl: number): Uint8Array => {
  const records =
    query.type === TYPE_A && query.class === CLASS_IN
      ? addresses.flatMap(address => {
          const octets = ipv4Bytes(address)

          return octets === undefined ? [] : [octets]
        })
      : []
  const bytes = new Uint8Array(HEADER + query.question.length + records.length * 16)
  let offset = HEADER + query.question.length

  put16(bytes, 0, query.id)
  put16(bytes, 2, FLAG_QR | (query.flags & 0x79_00) | FLAG_RA | RCODE_NOERROR)
  put16(bytes, 4, 1)
  put16(bytes, 6, records.length)
  bytes.set(query.question, HEADER)

  for (const octets of records) {
    put16(bytes, offset, 0xc0_0c)
    put16(bytes, offset + 2, TYPE_A)
    put16(bytes, offset + 4, CLASS_IN)
    put32(bytes, offset + 6, ttl)
    put16(bytes, offset + 10, 4)
    bytes.set(octets, offset + 12)
    offset += 16
  }

  return bytes
}

/** A bare reply to `query` with only its question and an error code (SERVFAIL by default). */
export const failureOf = (query: Query, rcode = RCODE_SERVFAIL): Uint8Array => {
  const bytes = new Uint8Array(HEADER + query.question.length)

  put16(bytes, 0, query.id)
  put16(bytes, 2, FLAG_QR | (query.flags & 0x79_00) | FLAG_RA | rcode)
  put16(bytes, 4, 1)
  bytes.set(query.question, HEADER)

  return bytes
}

/** The same reply with the client's id, and no more than the client takes over UDP. */
export const replyTo = (query: Query, answer: Uint8Array, udp: boolean): Uint8Array => {
  if (udp && answer.length > query.udpSize) {
    const truncated = failureOf(query, RCODE_NOERROR)

    put16(truncated, 2, u16(truncated, 2) | FLAG_TC)

    return truncated
  }

  const bytes = answer.slice()

  put16(bytes, 0, query.id)

  return bytes
}

/** The response code of a reply. */
export const rcodeOf = (bytes: Uint8Array): number => u16(bytes, 2) & 0x0f

/** Whether `bytes` is a reply at all (QR set, the header whole). */
export const isReply = (bytes: Uint8Array): boolean =>
  bytes.length >= HEADER && (u16(bytes, 2) & FLAG_QR) !== 0

/**
 * How long a reply may be kept, in seconds: the smallest TTL among its records (the OPT record's
 * field is flags, not a TTL), a negative answer's {@link negative} when it has none.
 */
export const ttlOf = (bytes: Uint8Array, negative: number): number => {
  const records = recordsOf(bytes)?.filter(record => record.type !== TYPE_OPT)

  if (records === undefined || records.length === 0) {
    return negative
  }

  return Math.min(...records.map(record => u32(bytes, record.ttlAt)))
}

/** The reply with every TTL lowered by `seconds` (never below zero): a cached answer, aged. */
export const agedBy = (bytes: Uint8Array, seconds: number): Uint8Array => {
  const aged = bytes.slice()

  for (const record of recordsOf(aged) ?? []) {
    if (record.type !== TYPE_OPT) {
      put32(aged, record.ttlAt, Math.max(0, u32(aged, record.ttlAt) - seconds))
    }
  }

  return aged
}

/** The addresses a reply's answer section gives, as text: IPv4 for A, IPv6 for AAAA. */
export const addressesOf = (bytes: Uint8Array): string[] => {
  const addresses: string[] = []

  for (const record of recordsOf(bytes) ?? []) {
    if (record.section !== 0) {
      continue
    }

    if (record.type === TYPE_A && record.end - record.data === 4) {
      addresses.push([...bytes.subarray(record.data, record.end)].join('.'))
    }

    if (record.type === TYPE_AAAA && record.end - record.data === 16) {
      const groups: string[] = []

      for (let index = 0; index < 8; index++) {
        groups.push(u16(bytes, record.data + index * 2).toString(16))
      }

      addresses.push(compressIpv6(groups))
    }
  }

  return addresses
}
