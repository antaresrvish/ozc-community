import { run } from 'std:effect'
import { isFailure, unwrap } from 'std:result'

/** Which servers a command acts on, from the names it was given. */
import { describe, expect, it } from 'bun:test'

import { MinecraftErrors } from '../src/const'
import { selectServers } from '../src/internal/settings'

const SERVERS = { survival: {}, creative: { type: 'VANILLA' } }

describe('the servers to act on', () => {
  it('are every server when none is named, else the named ones in that order', async () => {
    expect(unwrap(await run(() => selectServers(SERVERS, [])))).toEqual([
      { name: 'survival', spec: {} },
      { name: 'creative', spec: { type: 'VANILLA' } },
    ])
    expect(unwrap(await run(() => selectServers(SERVERS, ['creative'])))).toEqual([
      { name: 'creative', spec: { type: 'VANILLA' } },
    ])
  })

  it('refuse a name that is not defined, and a config with no server at all', async () => {
    const unknown = await run(() => selectServers(SERVERS, ['hardcore']))
    const none = await run(() => selectServers({}, []))

    expect(isFailure(unknown) && [unknown.error, unknown.message]).toEqual([
      MinecraftErrors.Server,
      'no server "hardcore" is defined ([minecraft.hardcore])',
    ])
    expect(isFailure(none) && none.error).toBe(MinecraftErrors.Config)
  })
})
