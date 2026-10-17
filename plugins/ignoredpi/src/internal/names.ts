/**
 * Names and addresses as the lists and the peers name them. Pure.
 */

/** An IPv4 address as one number, or `undefined` when it is not one. */
const ipv4Of = (address: string): number | undefined => {
  const plain = address.startsWith('::ffff:') ? address.slice(7) : address
  const parts = plain.split('.')

  if (parts.length !== 4 || parts.some(part => !/^\d{1,3}$/u.test(part))) {
    return undefined
  }

  return parts.reduce((sum, part) => sum * 256 + Number(part), 0)
}

/** The ranges a home or office network hands out (and Tailscale's), for `lan = true`. */
const PRIVATE_RANGES = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10']

/** A name as the lists keep it: lowercased, no root dot, no leading `*.` or `.`. */
export const normalizeName = (name: string): string =>
  name
    .trim()
    .toLowerCase()
    .replace(/^\*?\./u, '')
    .replace(/\.$/u, '')

/** Whether `name` is one of `suffixes`, or a name under one of them. */
export const isUnder = (name: string, suffixes: Iterable<string>): boolean => {
  for (const suffix of suffixes) {
    if (name === suffix || name.endsWith(`.${suffix}`)) {
      return true
    }
  }

  return false
}

/** Whether `text` is an address rather than a name (an IPv4 literal, or anything with a colon). */
export const isAddress = (text: string): boolean =>
  /^\d{1,3}(?:\.\d{1,3}){3}$/u.test(text) || text.includes(':')

/** Whether `address` is inside `cidr` (IPv4 only — an IPv6 range never holds). */
export const isInside = (address: string, cidr: string): boolean => {
  const [base, bits] = cidr.split('/')
  const value = ipv4Of(address)
  const start = base === undefined ? undefined : ipv4Of(base)
  const width = Number(bits)

  if (value === undefined || start === undefined || !Number.isInteger(width)) {
    return false
  }

  const size = 2 ** (32 - width)

  return Math.floor(value / size) === Math.floor(start / size)
}

/** Whether a peer is this machine. */
export const isLoopback = (address: string): boolean =>
  address === '::1' || isInside(address, '127.0.0.0/8')

/** Whether a peer is on a private network: one `lan = true` answers. */
export const isPrivate = (address: string): boolean =>
  PRIVATE_RANGES.some(range => isInside(address, range)) ||
  /^f[cd][0-9a-f]{2}:/iu.test(address) ||
  /^fe80:/iu.test(address)
