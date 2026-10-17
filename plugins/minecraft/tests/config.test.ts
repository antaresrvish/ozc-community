/**
 * What the spec's configuration tables become: `server.properties` lines the image sets, and the
 * patch set `mc-image-helper patch` applies to the server's own files at start.
 */
import { describe, expect, it } from 'bun:test'

import { overruled, patchSetOf, propertiesOf } from '../src/internal/config'
import { configMapOf, environmentOf, patchesOf, render } from '../src/internal/manifests'
import { ServerSpecSchema } from '../src/internal/schemas'
import type { MinecraftDef } from '../src/types'

type Obj = Record<string, unknown>

/** A field of an object, by a dotted path. */
const at = (object: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>((value, key) => (value as Obj | undefined)?.[key], object)

const CONFIGURED: MinecraftDef.ServerSpec = {
  motd: 'from the field',
  maxPlayers: 20,
  properties: { 'view-distance': 10, pvp: false, 'level-seed': 'ozaco', motd: 'from the table' },
  paper: {
    anticheat: { 'anti-xray': { enabled: true, 'engine-mode': 2 } },
    chunks: { 'auto-save-interval': 12_000 },
  },
  bukkit: { 'spawn-limits': { monsters: 50 } },
  files: {
    'plugins/Essentials/config.yml': { 'auto-afk': 300, 'player-commands': ['afk', 'balance'] },
    'bukkit.yml': { settings: { 'allow-end': false } },
  },
  jvmOpts: ['-XX:+UseZGC', '-Dpaper.playerconnection.keepalive=60'],
  aikarFlags: true,
}

describe('server.properties', () => {
  it('is the table, a key=value a line, and nothing when the spec has none', () => {
    expect(propertiesOf(CONFIGURED)).toBe(
      'view-distance=10\npvp=false\nlevel-seed=ozaco\nmotd=from the table',
    )
    expect(propertiesOf({})).toBeUndefined()
  })

  it('overrules a field that names the same key: the table is the file as the user wrote it', () => {
    expect(overruled(CONFIGURED, 'motd')).toBe(true)
    expect(overruled(CONFIGURED, 'maxPlayers')).toBe(false)

    const env = environmentOf(CONFIGURED)

    expect(env['MOTD']).toBeUndefined()
    expect(env['MAX_PLAYERS']).toBe('20')
    expect(env['CUSTOM_SERVER_PROPERTIES']).toBe(propertiesOf(CONFIGURED))
    expect(env['JVM_OPTS']).toBe('-XX:+UseZGC -Dpaper.playerconnection.keepalive=60')
    expect(env['USE_AIKAR_FLAGS']).toBe('TRUE')
  })
})

describe('the patch set', () => {
  it('puts every leaf into its file, under the table it is in, in bracket notation', () => {
    expect(patchSetOf(CONFIGURED)).toEqual({
      patches: [
        {
          file: '/data/config/paper-global.yml',
          ops: [
            { $put: { path: "$['anticheat']['anti-xray']", key: 'enabled', value: true } },
            { $put: { path: "$['anticheat']['anti-xray']", key: 'engine-mode', value: 2 } },
            { $put: { path: "$['chunks']", key: 'auto-save-interval', value: 12_000 } },
          ],
        },
        {
          // `bukkit` and files["bukkit.yml"] are one file: one patch of both tables
          file: '/data/bukkit.yml',
          ops: [
            { $put: { path: "$['spawn-limits']", key: 'monsters', value: 50 } },
            { $put: { path: "$['settings']", key: 'allow-end', value: false } },
          ],
        },
        {
          file: '/data/plugins/Essentials/config.yml',
          ops: [
            { $put: { path: '$', key: 'auto-afk', value: 300 } },
            { $put: { path: '$', key: 'player-commands', value: ['afk', 'balance'] } },
          ],
        },
      ],
    })
  })

  it('is nothing for a spec that configures no file, or only empty tables', () => {
    expect(patchSetOf({})).toBeUndefined()
    expect(patchSetOf({ paper: {}, files: { 'x.yml': {} } })).toBeUndefined()
    expect(patchesOf({ properties: { pvp: true } })).toBeUndefined()
  })

  it('rides a ConfigMap into the pod, named to the image, and rolls the pod when it changes', () => {
    const [configMap, , server] = render('survival', {
      paper: { chunks: { 'auto-save-interval': 1 } },
    })
    const patches = patchesOf({ paper: { chunks: { 'auto-save-interval': 1 } } })

    expect([configMap?.kind, configMap?.metadata?.name]).toEqual([
      'ConfigMap',
      configMapOf('survival'),
    ])
    expect((configMap?.['data'] as Obj | undefined)?.['patches.json']).toBe(patches)
    expect(at(server, 'spec.template.spec.volumes')).toEqual([
      { name: 'patches', configMap: { name: 'survival-config' } },
    ])
    expect(at(server, 'spec.template.spec.containers.0.volumeMounts.1')).toEqual({
      name: 'patches',
      mountPath: '/patches',
      readOnly: true,
    })
    expect(environmentOf({ paper: { a: 1 } })['PATCH_DEFINITIONS']).toBe('/patches/patches.json')

    const hashOf = (object: unknown): unknown =>
      (at(object, 'spec.template.metadata.annotations') as Obj | undefined)?.['ozc.dev/config-hash']
    const hash = hashOf(server)
    const changed = render('survival', { paper: { chunks: { 'auto-save-interval': 2 } } })[2]

    expect(typeof hash).toBe('string')
    expect(hashOf(changed)).not.toBe(hash)

    // nothing of it without a configured file
    const plain = render('survival', {})

    expect(plain.map(object => object.kind)).toEqual(['Service', 'StatefulSet'])
    expect(at(plain[1], 'spec.template.metadata.annotations')).toBeUndefined()
    expect(at(plain[1], 'spec.template.spec.volumes')).toBeUndefined()
  })
})

describe('the schema', () => {
  const refusals = (spec: Record<string, unknown>): string[] => {
    const parsed = ServerSpecSchema.safeParse(spec)

    return parsed.success
      ? []
      : parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`)
  }

  it('takes nested tables, lists of scalars and the files the image can patch', () => {
    expect(refusals(CONFIGURED as Record<string, unknown>)).toEqual([])
  })

  it('refuses a file outside /data, one that climbs, and one the image cannot patch', () => {
    expect(refusals({ files: { '/etc/passwd': {} } })).toHaveLength(1)
    expect(refusals({ files: { '../x.yml': {} } })).toHaveLength(1)
    expect(refusals({ files: { 'plugins/../../x.yml': {} } })).toHaveLength(1)
    expect(refusals({ files: { 'notes.txt': {} } })).toHaveLength(1)
    expect(
      refusals({
        files: { 'plugins/x/config.yml': {}, 'a.json': {}, 'b.toml': {}, 'c.properties': {} },
      }),
    ).toEqual([])
  })

  it('refuses a list of tables in a file: a leaf is a scalar or a list of scalars', () => {
    expect(refusals({ paper: { list: [{ a: 1 }] } })).toHaveLength(1)
    expect(refusals({ properties: { nested: { a: 1 } } })).toHaveLength(1)
  })
})
