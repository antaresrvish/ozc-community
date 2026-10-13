/** What a backup is, what a restore remakes, and what the DNS and the port rules say. */
import { describe, expect, it } from 'bun:test'

import { restoredClaimOf, snapshotOf } from '../src/internal/manifests'
import { portClashOf } from '../src/internal/settings'
import { dnsRecordsOf } from '../src/internal/status'

describe('a backup', () => {
  it('is a VolumeSnapshot of the world, named after the claim and the moment, of the class chosen', () => {
    expect(
      snapshotOf(
        'survival',
        { namespace: 'games' },
        { stamp: '2026-10-13t22-00-00-000z', snapshotClass: undefined },
      ),
    ).toEqual({
      apiVersion: 'snapshot.storage.k8s.io/v1',
      kind: 'VolumeSnapshot',
      metadata: {
        name: 'data-survival-0-2026-10-13t22-00-00-000z',
        namespace: 'games',
        labels: {
          'app.kubernetes.io/name': 'survival',
          'app.kubernetes.io/component': 'minecraft-server',
          'app.kubernetes.io/managed-by': 'ozc',
          'ozc.dev/volume': 'data',
        },
      },
      spec: { source: { persistentVolumeClaimName: 'data-survival-0' } },
    })
    expect(
      snapshotOf('survival', {}, { stamp: 'now', snapshotClass: 'longhorn-backup' }).spec,
    ).toEqual({
      volumeSnapshotClassName: 'longhorn-backup',
      source: { persistentVolumeClaimName: 'data-survival-0' },
    })
  })

  it("is restored into the claim the StatefulSet looks for, with the template's own spec", () => {
    expect(
      restoredClaimOf(
        'survival',
        { storage: '20Gi', storageClass: 'longhorn' },
        'data-survival-0-now',
      ),
    ).toEqual({
      apiVersion: 'v1',
      kind: 'PersistentVolumeClaim',
      metadata: {
        name: 'data-survival-0',
        labels: {
          'app.kubernetes.io/name': 'survival',
          'app.kubernetes.io/component': 'minecraft-server',
          'app.kubernetes.io/managed-by': 'ozc',
        },
      },
      spec: {
        accessModes: ['ReadWriteOnce'],
        resources: { requests: { storage: '20Gi' } },
        storageClassName: 'longhorn',
        dataSource: {
          name: 'data-survival-0-now',
          kind: 'VolumeSnapshot',
          apiGroup: 'snapshot.storage.k8s.io',
        },
      },
    })
  })
})

describe('several servers', () => {
  it('each take a port of their own on the node; in-cluster ones take none', () => {
    expect(portClashOf({ survival: {}, creative: { port: 25_566 } })).toBeUndefined()
    expect(
      portClashOf({ survival: {}, lan: { expose: 'none' }, test: { expose: 'none' } }),
    ).toBeUndefined()
    expect(portClashOf({ survival: {}, creative: {} })).toBe(
      '[minecraft.survival] and [minecraft.creative] both take port 25565 on the node: give each its own port (or nodePort)',
    )
    expect(
      portClashOf({
        a: { expose: 'nodeport', nodePort: 30_565 },
        b: { expose: 'nodeport', nodePort: 30_565 },
      }),
    ).toContain('both take port 30565')
    // a NodePort server's `port` is in-cluster only: it does not clash with the node's 25565
    expect(portClashOf({ a: {}, b: { expose: 'nodeport', port: 25_565 } })).toBeUndefined()
  })
})

describe('a domain', () => {
  it('needs an A record to the address, and an SRV record on a port that is not the game port', () => {
    const lb = { kind: 'loadbalancer', host: '5.1.2.3', port: 25_565 } as const

    expect(dnsRecordsOf({}, lb)).toEqual([])
    expect(dnsRecordsOf({ domain: 'play.example.com' }, lb)).toEqual([
      'A    play.example.com  →  5.1.2.3',
    ])
    expect(
      dnsRecordsOf({ domain: 'play.example.com', port: 25_566 }, { ...lb, port: 25_566 }),
    ).toEqual([
      'A    play.example.com  →  5.1.2.3',
      'SRV  _minecraft._tcp.play.example.com  →  0 5 25566 play.example.com',
    ])
    expect(dnsRecordsOf({ domain: 'play.example.com' }, { ...lb, host: undefined })).toEqual([
      'A    play.example.com  →  <the address, once the cluster has given one>',
    ])
    expect(
      dnsRecordsOf(
        { domain: 'play.example.com', expose: 'nodeport' },
        { kind: 'nodeport', host: undefined, port: 30_565 },
      ),
    ).toEqual([
      "A    play.example.com  →  <any node's address>",
      'SRV  _minecraft._tcp.play.example.com  →  0 5 30565 play.example.com',
    ])
  })
})
