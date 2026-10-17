/** What the suites build their wire bytes from: a ClientHello the way a TLS client writes one. */

const u16 = (value: number): number[] => [value >> 8, value & 0xff]
const u24 = (value: number): number[] => [value >> 16, (value >> 8) & 0xff, value & 0xff]

/** Byte runs, one after the other. */
export const joinedOf = (pieces: readonly (readonly number[] | Uint8Array)[]): Uint8Array => {
  const bytes: number[] = []

  for (const piece of pieces) {
    bytes.push(...piece)
  }

  return Uint8Array.from(bytes)
}

/**
 * A minimal TLS 1.3-style ClientHello record for `name`: one cipher suite, no compression, the
 * `server_name` extension between two others — enough for anything that reads a hello's name.
 */
export const clientHelloOf = (name: string): Uint8Array => {
  const host = new TextEncoder().encode(name)
  const serverName = joinedOf([[0x00], u16(host.length), host])
  const extensions = joinedOf([
    // supported_versions: TLS 1.3
    [0x00, 0x2b],
    u16(3),
    [0x02, 0x03, 0x04],
    // server_name
    [0x00, 0x00],
    u16(serverName.length + 2),
    u16(serverName.length),
    serverName,
    // ALPN: h2
    [0x00, 0x10],
    u16(5),
    u16(3),
    [0x02, 0x68, 0x32],
  ])
  const body = joinedOf([
    [0x03, 0x03],
    Array.from({ length: 32 }, (_, index) => index),
    [0x00],
    u16(2),
    [0x13, 0x01],
    [0x01, 0x00],
    u16(extensions.length),
    extensions,
  ])
  const handshake = joinedOf([[0x01], u24(body.length), body])

  return joinedOf([[0x16, 0x03, 0x01], u16(handshake.length), handshake])
}

/** The handshake bytes a run of TLS records carries, joined (their headers dropped). */
export const handshakeOf = (bytes: Uint8Array): { records: number; body: Uint8Array } => {
  const parts: Uint8Array[] = []
  let offset = 0

  while (offset + 5 <= bytes.length) {
    const length = ((bytes[offset + 3] ?? 0) << 8) | (bytes[offset + 4] ?? 0)

    parts.push(bytes.subarray(offset + 5, offset + 5 + length))
    offset += 5 + length
  }

  return { records: parts.length, body: joinedOf(parts) }
}
