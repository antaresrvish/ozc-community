/**
 * What the schema takes and refuses of a `[minecraft.<name>]` table — the refusals are the ones the
 * cluster, or the server, would only make later.
 */
import { describe, expect, it } from 'bun:test'

import { ServerSpecSchema, ServersSchema } from '../src/internal/schemas'

/** The messages a spec is refused with, each under the path it is reported at. */
const refusals = (spec: Record<string, unknown>): string[] => {
  const parsed = ServerSpecSchema.safeParse(spec)

  return parsed.success
    ? []
    : parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`)
}

describe('a spec', () => {
  it('takes an empty table, and a full one', () => {
    expect(refusals({})).toEqual([])
    expect(
      refusals({
        type: 'FABRIC',
        version: '1.21.1',
        memory: '1536M',
        expose: 'nodeport',
        nodePort: 30_565,
        storage: '50Gi',
        difficulty: 'normal',
        ops: ['steve'],
        env: { VIEW_DISTANCE: 12, SNOOPER_ENABLED: false },
      }),
    ).toEqual([])
  })

  it('refuses a heap, a volume, a type or a difficulty written another way', () => {
    expect(refusals({ memory: '2GB' })).toEqual([
      'memory: expected a Java heap size, e.g. "2G" or "1536M"',
    ])
    expect(refusals({ storage: '10GB' })).toEqual(['storage: expected a volume size, e.g. "10Gi"'])
    expect(refusals({ type: 'paper' })).toEqual([
      'type: expected a server type as the image spells it, e.g. "PAPER"',
    ])
    expect(refusals({ difficulty: 'insane' })).toHaveLength(1)
    expect(refusals({ expose: 'public' })).toHaveLength(1)
  })

  it('refuses a fixed NodePort on a Service that is not one, and one outside the range', () => {
    expect(refusals({ nodePort: 30_565 })).toEqual([
      'nodePort: `nodePort` needs `expose = "nodeport"`',
    ])
    expect(refusals({ expose: 'nodeport', nodePort: 8080 })).toHaveLength(1)
  })

  it('refuses a domain that is no domain, and takes the mod lists as they are', () => {
    expect(refusals({ domain: 'play' })).toEqual([
      'domain: expected a domain, e.g. "play.example.com"',
    ])
    expect(refusals({ domain: 'play.example.com', modrinth: ['sodium'], spiget: [9089] })).toEqual(
      [],
    )
    expect(refusals({ spiget: ['9089'] })).toHaveLength(1)
    expect(refusals({ backup: 'tape' })).toHaveLength(1)
  })

  it('is one of many, by name', () => {
    expect(ServersSchema.safeParse({ survival: {}, creative: { type: 'VANILLA' } }).success).toBe(
      true,
    )
    expect(ServersSchema.safeParse({ survival: { memory: 2 } }).success).toBe(false)
  })
})
