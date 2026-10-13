/**
 * What a `[minecraft.<name>]` spec renders to: the objects, the environment the image reads, the
 * Service by how the server is exposed, the claim the world lives on — decided before any cluster
 * is asked.
 */
import { describe, expect, it } from 'bun:test'

import { claimOf, environmentOf, imageOf, podOf, render } from '../src/internal/manifests'
import type { MinecraftDef } from '../src/types'

type Obj = Record<string, unknown>

/** A field of an object, by a dotted path. */
const at = (object: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>((value, key) => (value as Obj | undefined)?.[key], object)

const FULL: MinecraftDef.ServerSpec = {
  image: 'ghcr.io/x/minecraft',
  tag: 'java21',
  type: 'FABRIC',
  version: '1.21.1',
  memory: '3G',
  cpu: '500m',
  cpuLimit: '2',
  memoryLimit: '4Gi',
  namespace: 'games',
  port: 25_566,
  expose: 'nodeport',
  nodePort: 30_565,
  storage: '50Gi',
  storageClass: 'longhorn',
  motd: 'welcome',
  difficulty: 'hard',
  maxPlayers: 8,
  onlineMode: false,
  ops: ['steve', 'alex'],
  whitelist: ['steve'],
  timezone: 'Europe/Istanbul',
  domain: 'play.example.com',
  modrinth: ['fabric-api', 'sodium:mc1.21.1-0.6.0'],
  modrinthDependencies: 'required',
  mods: ['https://example.com/a.jar'],
  plugins: ['https://example.com/b.jar', 'https://example.com/c.jar'],
  spiget: [9089, 1997],
  modpack: 'https://example.com/pack.zip',
  removeOldMods: true,
  backup: 's3',
  env: { TYPE: 'PAPER', VIEW_DISTANCE: 12, SNOOPER_ENABLED: false },
}

describe('a server', () => {
  it('renders its Namespace first when it names one, so a new one is there before the Service', () => {
    const objects = render('creative', FULL)

    expect(objects.map(object => [object.kind, object.metadata?.name])).toEqual([
      ['Namespace', 'games'],
      ['Service', 'creative'],
      ['StatefulSet', 'creative'],
    ])
    expect(objects[0]?.metadata?.labels).toEqual({ 'app.kubernetes.io/managed-by': 'ozc' })
  })

  it('renders to a Service and a StatefulSet of one, labelled alike, in the order they are applied', () => {
    const objects = render('survival', {})
    const labels = {
      'app.kubernetes.io/name': 'survival',
      'app.kubernetes.io/component': 'minecraft-server',
      'app.kubernetes.io/managed-by': 'ozc',
    }

    expect(objects.map(object => [object.kind, object.metadata?.name])).toEqual([
      ['Service', 'survival'],
      ['StatefulSet', 'survival'],
    ])
    expect(objects.map(object => object.metadata?.labels)).toEqual([labels, labels])
    expect(objects.map(object => object.metadata?.namespace)).toEqual([undefined, undefined])
    expect(at(objects[0], 'spec.selector')).toEqual(labels)
    expect(at(objects[1], 'spec.selector.matchLabels')).toEqual(labels)
    expect(at(objects[1], 'spec.replicas')).toBe(1)
    expect(at(objects[1], 'spec.serviceName')).toBe('survival')
  })

  it('is the newest Paper with 2G of heap on 10Gi, reached through a LoadBalancer on 25565, unless told otherwise', () => {
    const [service, server] = render('survival', {})

    expect(imageOf({})).toBe('itzg/minecraft-server:latest')
    expect(environmentOf({})).toEqual({
      EULA: 'TRUE',
      TYPE: 'PAPER',
      VERSION: 'LATEST',
      MEMORY: '2G',
    })
    expect(at(service, 'spec.type')).toBe('LoadBalancer')
    expect(at(service, 'spec.ports')).toEqual([
      { name: 'minecraft', protocol: 'TCP', port: 25_565, targetPort: 25_565 },
    ])
    expect(at(server, 'spec.template.spec.containers.0.image')).toBe('itzg/minecraft-server:latest')
    expect(at(server, 'spec.template.spec.containers.0.resources')).toEqual({
      requests: { memory: '2Gi' },
    })
    expect(at(server, 'spec.volumeClaimTemplates')).toEqual([
      {
        metadata: { name: 'data' },
        spec: { accessModes: ['ReadWriteOnce'], resources: { requests: { storage: '10Gi' } } },
      },
    ])
    expect(at(server, 'spec.template.spec.containers.0.volumeMounts')).toEqual([
      { name: 'data', mountPath: '/data' },
    ])
    // the image's own health check as readiness; no liveness, a slow world is not killed
    expect(at(server, 'spec.template.spec.containers.0.readinessProbe.exec.command')).toEqual([
      'mc-health',
    ])
    expect(at(server, 'spec.template.spec.containers.0.livenessProbe')).toBeUndefined()
  })

  it('takes every field of the spec, and lets env have the last word', () => {
    const [, service, server] = render('creative', FULL)

    expect(environmentOf(FULL)).toEqual({
      EULA: 'TRUE',
      TYPE: 'PAPER',
      VERSION: '1.21.1',
      MEMORY: '3G',
      MOTD: 'welcome',
      DIFFICULTY: 'hard',
      MAX_PLAYERS: '8',
      ONLINE_MODE: 'FALSE',
      OPS: 'steve,alex',
      WHITELIST: 'steve',
      ENABLE_WHITELIST: 'TRUE',
      TZ: 'Europe/Istanbul',
      MODRINTH_PROJECTS: 'fabric-api,sodium:mc1.21.1-0.6.0',
      MODRINTH_DOWNLOAD_DEPENDENCIES: 'required',
      MODS: 'https://example.com/a.jar',
      PLUGINS: 'https://example.com/b.jar,https://example.com/c.jar',
      SPIGET_RESOURCES: '9089,1997',
      MODPACK: 'https://example.com/pack.zip',
      REMOVE_OLD_MODS: 'TRUE',
      VIEW_DISTANCE: '12',
      SNOOPER_ENABLED: 'false',
    })
    expect(at(server, 'spec.template.spec.containers.0.env')).toContainEqual({
      name: 'TYPE',
      value: 'PAPER',
    })
    expect(at(server, 'metadata.namespace')).toBe('games')
    expect(at(service, 'metadata.namespace')).toBe('games')
    expect(at(service, 'spec.type')).toBe('NodePort')
    expect(at(service, 'spec.ports.0')).toEqual({
      name: 'minecraft',
      protocol: 'TCP',
      port: 25_566,
      targetPort: 25_565,
      nodePort: 30_565,
    })
    expect(at(server, 'spec.template.spec.containers.0.image')).toBe('ghcr.io/x/minecraft:java21')
    expect(at(server, 'spec.template.spec.containers.0.resources')).toEqual({
      requests: { memory: '3Gi', cpu: '500m' },
      limits: { cpu: '2', memory: '4Gi' },
    })
    expect(at(server, 'spec.volumeClaimTemplates.0.spec')).toEqual({
      accessModes: ['ReadWriteOnce'],
      resources: { requests: { storage: '50Gi' } },
      storageClassName: 'longhorn',
    })
  })

  it('is reached in-cluster only with expose = "none"', () => {
    expect(at(render('lan', { expose: 'none' })[0], 'spec.type')).toBe('ClusterIP')
  })

  it('runs in the pod the StatefulSet names, with its world on the claim it made', () => {
    expect(podOf('survival')).toBe('survival-0')
    expect(claimOf('survival')).toBe('data-survival-0')
  })
})
