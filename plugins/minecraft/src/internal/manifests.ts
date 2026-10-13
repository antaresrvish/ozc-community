// oxlint-disable import/exports-last -- render helpers interleave with their private object builders
import type { K8sDef } from 'sdk:k8s'

import {
  APP_LABEL,
  COMPONENT,
  COMPONENT_LABEL,
  CONTAINER,
  DATA_PATH,
  DATA_VOLUME,
  DEFAULT_IMAGE,
  DEFAULT_MEMORY,
  DEFAULT_STORAGE,
  DEFAULT_TAG,
  DEFAULT_TYPE,
  DEFAULT_VERSION,
  GAME_PORT,
  HEALTH_COMMAND,
  MANAGED_BY,
  MANAGED_LABEL,
  RCON_PORT,
  READY_DELAY_SECONDS,
  READY_FAILURES,
  READY_PERIOD_SECONDS,
  SNAPSHOT_API,
  SNAPSHOT_GROUP,
  VOLUME_LABEL,
} from '../const'
import type { MinecraftDef } from '../types'

type Obj = Record<string, unknown>

/** What the Service is, by how the spec exposes the server. */
const SERVICE_TYPES: Record<MinecraftDef.Expose, string> = {
  none: 'ClusterIP',
  nodeport: 'NodePort',
  loadbalancer: 'LoadBalancer',
}

/** Standard labels stamped on every object (they drive the Service's selector and `kube`'s lookups). */
const labelsOf = (name: string): Record<string, string> => ({
  [APP_LABEL]: name,
  [COMPONENT_LABEL]: COMPONENT,
  [MANAGED_LABEL]: MANAGED_BY,
})

const metaFor = (
  name: string,
  namespace: string | undefined,
  labels: Record<string, string>,
): K8sDef.KubeMeta => ({
  name,
  ...(namespace === undefined ? {} : { namespace }),
  labels,
})

/** A value the image reads as a flag. */
const flag = (value: boolean): string => (value ? 'TRUE' : 'FALSE')

/** A list the image reads as one comma-separated value; nothing for an empty one. */
const listed = (values: readonly string[] | undefined): string | undefined =>
  values === undefined || values.length === 0 ? undefined : values.join(',')

/**
 * The heap as a Kubernetes quantity: Java's `G` and `M` are binary units, Kubernetes' plain ones
 * are decimal — `2G` of heap is `2Gi` of memory.
 */
const quantityOf = (heap: string): string => `${heap}i`

/** The effective image ref. */
export const imageOf = (spec: MinecraftDef.ServerSpec): string =>
  `${spec.image ?? DEFAULT_IMAGE}:${spec.tag ?? DEFAULT_TAG}`

/** The pod a server runs in: the StatefulSet's one replica. */
export const podOf = (name: string): string => `${name}-0`

/** The claim that holds a server's world: what the StatefulSet made from its template. */
export const claimOf = (name: string): string => `${DATA_VOLUME}-${name}-0`

/**
 * The environment the image reads, from the spec's fields — and the spec's `env` over them, as
 * written: what both set, `env` decides.
 */
export const environmentOf = (spec: MinecraftDef.ServerSpec): Record<string, string> => {
  const named: Record<string, string | undefined> = {
    EULA: 'TRUE',
    TYPE: spec.type ?? DEFAULT_TYPE,
    VERSION: spec.version ?? DEFAULT_VERSION,
    MEMORY: spec.memory ?? DEFAULT_MEMORY,
    MOTD: spec.motd,
    DIFFICULTY: spec.difficulty,
    MAX_PLAYERS: spec.maxPlayers === undefined ? undefined : String(spec.maxPlayers),
    ONLINE_MODE: spec.onlineMode === undefined ? undefined : flag(spec.onlineMode),
    OPS: listed(spec.ops),
    WHITELIST: listed(spec.whitelist),
    ENABLE_WHITELIST: listed(spec.whitelist) === undefined ? undefined : 'TRUE',
    TZ: spec.timezone,
    MODRINTH_PROJECTS: listed(spec.modrinth),
    MODRINTH_DOWNLOAD_DEPENDENCIES: spec.modrinthDependencies,
    MODS: listed(spec.mods),
    PLUGINS: listed(spec.plugins),
    SPIGET_RESOURCES: listed(spec.spiget?.map(String)),
    MODPACK: spec.modpack,
    REMOVE_OLD_MODS: spec.removeOldMods === undefined ? undefined : flag(spec.removeOldMods),
  }
  const env: Record<string, string> = {}

  for (const [key, value] of Object.entries(named)) {
    if (value !== undefined) {
      env[key] = value
    }
  }

  for (const [key, value] of Object.entries(spec.env ?? {})) {
    env[key] = String(value)
  }

  return env
}

/** The claim's spec as the StatefulSet's template makes it: one writer, the size, the class. */
const claimSpecOf = (spec: MinecraftDef.ServerSpec): Obj => ({
  accessModes: ['ReadWriteOnce'],
  resources: { requests: { storage: spec.storage ?? DEFAULT_STORAGE } },
  ...(spec.storageClass === undefined ? {} : { storageClassName: spec.storageClass }),
})

/**
 * The snapshot `backup` takes of a server's world: named after the claim and the moment, labelled
 * as the server's, of the class the line or the spec chose (none: the cluster's default).
 */
export const snapshotOf = (
  name: string,
  spec: MinecraftDef.ServerSpec,
  { stamp, snapshotClass }: { readonly stamp: string; readonly snapshotClass: string | undefined },
): K8sDef.KubeObject => ({
  apiVersion: SNAPSHOT_API,
  kind: 'VolumeSnapshot',
  metadata: metaFor(`${claimOf(name)}-${stamp}`, spec.namespace, {
    ...labelsOf(name),
    [VOLUME_LABEL]: DATA_VOLUME,
  }),
  spec: {
    ...(snapshotClass === undefined ? {} : { volumeSnapshotClassName: snapshotClass }),
    source: { persistentVolumeClaimName: claimOf(name) },
  },
})

/**
 * The claim as `restore` remakes it: the template's own spec under the name the StatefulSet looks
 * for, with the snapshot as its source — the next `up` finds the world there.
 */
export const restoredClaimOf = (
  name: string,
  spec: MinecraftDef.ServerSpec,
  snapshot: string,
): K8sDef.KubeObject => ({
  apiVersion: 'v1',
  kind: 'PersistentVolumeClaim',
  metadata: metaFor(claimOf(name), spec.namespace, labelsOf(name)),
  spec: {
    ...claimSpecOf(spec),
    dataSource: { name: snapshot, kind: 'VolumeSnapshot', apiGroup: SNAPSHOT_GROUP },
  },
})

/** The pod's resources: the heap as its memory request, the rest as the spec says. */
const resourcesOf = (spec: MinecraftDef.ServerSpec): Obj => {
  const requests: Record<string, string> = {
    memory: quantityOf(spec.memory ?? DEFAULT_MEMORY),
    ...(spec.cpu === undefined ? {} : { cpu: spec.cpu }),
  }
  const limits: Record<string, string> = {
    ...(spec.cpuLimit === undefined ? {} : { cpu: spec.cpuLimit }),
    ...(spec.memoryLimit === undefined ? {} : { memory: spec.memoryLimit }),
  }

  return { requests, ...(Object.keys(limits).length === 0 ? {} : { limits }) }
}

/** The Service players connect through. */
const service = (name: string, spec: MinecraftDef.ServerSpec): K8sDef.KubeObject => ({
  apiVersion: 'v1',
  kind: 'Service',
  metadata: metaFor(name, spec.namespace, labelsOf(name)),
  spec: {
    type: SERVICE_TYPES[spec.expose ?? 'loadbalancer'],
    selector: labelsOf(name),
    ports: [
      {
        name: 'minecraft',
        protocol: 'TCP',
        port: spec.port ?? GAME_PORT,
        targetPort: GAME_PORT,
        ...(spec.nodePort === undefined ? {} : { nodePort: spec.nodePort }),
      },
    ],
  },
})

/**
 * The server: one replica with the world on a claim of its own. Only a readiness probe — the
 * image's own `mc-health` — no liveness: a world that takes long to load would be killed in a loop.
 */
const statefulSet = (name: string, spec: MinecraftDef.ServerSpec): K8sDef.KubeObject => {
  const labels = labelsOf(name)

  return {
    apiVersion: 'apps/v1',
    kind: 'StatefulSet',
    metadata: metaFor(name, spec.namespace, labels),
    spec: {
      serviceName: name,
      replicas: 1,
      selector: { matchLabels: labels },
      template: {
        metadata: { labels },
        spec: {
          containers: [
            {
              name: CONTAINER,
              image: imageOf(spec),
              env: Object.entries(environmentOf(spec)).map(([key, value]) => ({
                name: key,
                value,
              })),
              ports: [
                { name: 'minecraft', containerPort: GAME_PORT, protocol: 'TCP' },
                { name: 'rcon', containerPort: RCON_PORT, protocol: 'TCP' },
              ],
              resources: resourcesOf(spec),
              readinessProbe: {
                exec: { command: [...HEALTH_COMMAND] },
                initialDelaySeconds: READY_DELAY_SECONDS,
                periodSeconds: READY_PERIOD_SECONDS,
                failureThreshold: READY_FAILURES,
              },
              volumeMounts: [{ name: DATA_VOLUME, mountPath: DATA_PATH }],
            },
          ],
        },
      },
      volumeClaimTemplates: [{ metadata: { name: DATA_VOLUME }, spec: claimSpecOf(spec) }],
    },
  }
}

/** The objects a server renders to, in the order they are applied: the Service, then the server. */
export const render = (name: string, spec: MinecraftDef.ServerSpec): K8sDef.KubeObject[] => [
  service(name, spec),
  statefulSet(name, spec),
]
