import type { IgnoreDpiDef } from '../types'

/**
 * The first bytes a client sends — a TLS ClientHello, or an HTTP request head — read for the
 * name it is meant for, and cut so that the DPI on the way does not see that name whole. Pure.
 */

const RECORD_HEADER = 5
const CONTENT_HANDSHAKE = 0x16
const HANDSHAKE_CLIENT_HELLO = 0x01
const EXTENSION_SERVER_NAME = 0x00_00
const NAME_TYPE_HOST = 0x00

const u16 = (bytes: Uint8Array, at: number): number =>
  ((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0)

/** Where to cut: in the middle of the name, so neither piece holds it whole. */
const cutOf = (name: ServerName): number => name.at + Math.max(1, Math.floor(name.length / 2))

/**
 * How long the first TLS record is, header included, once its header is in: `undefined` while
 * fewer than five bytes are, `0` when the bytes are not a TLS handshake record at all.
 */
export const recordLengthOf = (bytes: Uint8Array): number | undefined => {
  if (bytes.length < RECORD_HEADER) {
    return bytes.length > 0 && bytes[0] !== CONTENT_HANDSHAKE ? 0 : undefined
  }

  return bytes[0] === CONTENT_HANDSHAKE ? RECORD_HEADER + u16(bytes, 3) : 0
}

/** Where the server name sits in a hello record: the name, its first byte and its length. */
export interface ServerName {
  name: string
  at: number
  length: number
}

/**
 * The server name a ClientHello record carries (`server_name`, RFC 6066), with its place in the
 * record. `undefined` when the record is not a whole ClientHello or names no host.
 */
export const serverNameOf = (record: Uint8Array): ServerName | undefined => {
  if (record[0] !== CONTENT_HANDSHAKE || record[RECORD_HEADER] !== HANDSHAKE_CLIENT_HELLO) {
    return undefined
  }

  // handshake header (4), client version (2), random (32)
  let offset = RECORD_HEADER + 4 + 2 + 32
  const session = record[offset]

  if (session === undefined) {
    return undefined
  }

  offset += 1 + session
  offset += 2 + u16(record, offset)

  const compression = record[offset]

  if (compression === undefined) {
    return undefined
  }

  offset += 1 + compression

  const end = Math.min(record.length, offset + 2 + u16(record, offset))

  offset += 2

  while (offset + 4 <= end) {
    const type = u16(record, offset)
    const length = u16(record, offset + 2)
    const data = offset + 4

    if (type === EXTENSION_SERVER_NAME && data + 5 <= end) {
      // server name list length (2), name type (1), name length (2), name
      const nameType = record[data + 2]
      const nameLength = u16(record, data + 3)
      const at = data + 5

      if (nameType !== NAME_TYPE_HOST || at + nameLength > end || nameLength === 0) {
        return undefined
      }

      return {
        name: new TextDecoder().decode(record.subarray(at, at + nameLength)).toLowerCase(),
        at,
        length: nameLength,
      }
    }

    offset = data + length
  }

  return undefined
}

/**
 * The hello record as two records, cut at `cut` (an index into the record, past its header):
 * the same handshake message, carried by two TLS records instead of one — which every TLS server
 * takes (RFC 8446 §5.1), and a DPI that reads one record at a time does not.
 */
export const recordsSplitAt = (record: Uint8Array, cut: number): [Uint8Array, Uint8Array] => {
  const body = record.subarray(RECORD_HEADER)
  const head = body.subarray(0, cut - RECORD_HEADER)
  const tail = body.subarray(cut - RECORD_HEADER)
  const headerOf = (length: number) =>
    Uint8Array.of(CONTENT_HANDSHAKE, record[1] ?? 3, record[2] ?? 1, length >> 8, length & 0xff)
  const first = new Uint8Array(RECORD_HEADER + head.length)
  const second = new Uint8Array(RECORD_HEADER + tail.length)

  first.set(headerOf(head.length))
  first.set(head, RECORD_HEADER)
  second.set(headerOf(tail.length))
  second.set(tail, RECORD_HEADER)

  return [first, second]
}

/**
 * The writes a hello goes out as, for a `split`: one write of two records (`record`), two writes
 * of the one record cut in two (`segment`), or the two records as two writes (`both`).
 */
export const helloPiecesOf = (
  record: Uint8Array,
  name: ServerName,
  split: IgnoreDpiDef.Split,
): Uint8Array[] => {
  const cut = cutOf(name)

  if (split === 'segment') {
    return [record.subarray(0, cut), record.subarray(cut)]
  }

  const [first, second] = recordsSplitAt(record, cut)

  if (split === 'both') {
    return [first, second]
  }

  const joined = new Uint8Array(first.length + second.length)

  joined.set(first)
  joined.set(second, first.length)

  return [joined]
}

/** Where an HTTP request head ends (just past its blank line), `-1` while it has not. */
export const headEndOf = (bytes: Uint8Array): number => {
  for (let index = 3; index < bytes.length; index++) {
    if (
      bytes[index] === 0x0a &&
      bytes[index - 1] === 0x0d &&
      bytes[index - 2] === 0x0a &&
      bytes[index - 3] === 0x0d
    ) {
      return index + 1
    }
  }

  return -1
}

/**
 * The host an HTTP request head names (its `Host` header, the port dropped), with the place of
 * the value in the head. `undefined` when there is none.
 */
export const hostOf = (head: Uint8Array): ServerName | undefined => {
  const text = new TextDecoder('latin1').decode(head)
  const match = /\r\nhost:[ \t]*([^\r\n]+)/iu.exec(text)

  if (match?.[1] === undefined) {
    return undefined
  }

  const value = match[1].trim()
  const host = value.startsWith('[') ? value.slice(1, value.indexOf(']')) : value.split(':')[0]

  if (host === undefined || host === '') {
    return undefined
  }

  return {
    name: host.toLowerCase(),
    at: match.index + match[0].indexOf(match[1]),
    length: value.length,
  }
}

/**
 * The head as it leaves for a blocked host: its `Host` header named `hoSt` — header names are
 * case-blind to a server (RFC 9110 §5.1), not to the DPI on Türk Telekom, which looks for `Host`
 * and `host` only — and cut inside the host's value, two writes, a segment each.
 */
export const headPiecesOf = (head: Uint8Array, host: ServerName): Uint8Array[] => {
  const found = /\r\nhost:/iu.exec(new TextDecoder('latin1').decode(head))
  const disguised = head.slice()
  const cut = cutOf(host)

  if (found !== null) {
    disguised.set(new TextEncoder().encode('hoSt'), found.index + 2)
  }

  return [disguised.subarray(0, cut), disguised.subarray(cut)]
}
