/** The example config is one the plugin takes: every table, and no two servers on one port. */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { ServersSchema } from '../src/internal/schemas'
import { portClashOf } from '../src/internal/settings'

const EXAMPLE = join(import.meta.dir, '..', 'examples', 'minecraft.toml')

describe('examples/minecraft.toml', () => {
  it('is a valid [minecraft.*] config of two servers on two ports', () => {
    const document = Bun.TOML.parse(readFileSync(EXAMPLE, 'utf8')) as { minecraft?: unknown }
    const servers = ServersSchema.safeParse(document.minecraft)

    expect(servers.success, JSON.stringify(servers.error?.issues)).toBe(true)
    expect(Object.keys(servers.data ?? {})).toEqual(['survival', 'creative'])
    expect(portClashOf(servers.data ?? {})).toBeUndefined()
  })
})
