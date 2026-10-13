import type { K8sDef } from 'sdk:k8s'

import { GAME_PORT, SRV_SERVICE } from '../const'
import type { MinecraftDef } from '../types'

type Obj = Record<string, unknown>

/** Narrow an unknown value to a string-keyed record (or `undefined`). */
const asRecord = (value: unknown): Obj | undefined =>
  typeof value === 'object' && value !== null ? (value as Obj) : undefined

/** The first entry of a list the apiserver wrote, as a record. */
const firstOf = (value: unknown): Obj | undefined =>
  Array.isArray(value) ? asRecord(value[0]) : undefined

/** How a server stands, read off its pod: not there, coming up, ready for players, or stopped. */
export type Readiness = 'absent' | 'starting' | 'ready' | 'stopped'

/** Where a server is reached from outside, as far as the cluster has said. */
export interface Endpoint {
  /** `loadbalancer`: the address the cluster gave (on k3s the node's own); `nodeport`: any node. */
  readonly kind: 'loadbalancer' | 'nodeport' | 'internal'
  /** The address, once the cluster has given one. */
  readonly host: string | undefined
  /** The port players use: the Service's, or the NodePort once it is known. */
  readonly port: number | undefined
}

/** The endpoint, read off the Service as the cluster filled it in. */
export const endpointOf = (service: K8sDef.KubeObject): Endpoint => {
  const spec = asRecord(service.spec)
  const first = firstOf(spec?.['ports'])
  const port = typeof first?.['port'] === 'number' ? first['port'] : GAME_PORT

  if (spec?.['type'] === 'LoadBalancer') {
    const entry = firstOf(asRecord(asRecord(service.status)?.['loadBalancer'])?.['ingress'])
    const host = entry?.['ip'] ?? entry?.['hostname']

    return { kind: 'loadbalancer', host: typeof host === 'string' ? host : undefined, port }
  }

  if (spec?.['type'] === 'NodePort') {
    const nodePort = first?.['nodePort']

    return {
      kind: 'nodeport',
      host: undefined,
      port: typeof nodePort === 'number' ? nodePort : undefined,
    }
  }

  return { kind: 'internal', host: service.metadata?.name, port }
}

/**
 * Where players connect, as one word: the address with its port, a NodePort on any node, the
 * Service's name in-cluster — or what is still pending.
 */
export const addressOf = (service: K8sDef.KubeObject | undefined): string => {
  if (service === undefined) {
    return '-'
  }

  const { kind, host, port } = endpointOf(service)

  if (kind === 'loadbalancer') {
    return host === undefined
      ? `pending (port ${port ?? GAME_PORT})`
      : `${host}:${port ?? GAME_PORT}`
  }

  if (kind === 'nodeport') {
    return port === undefined ? 'pending' : `<any node>:${port}`
  }

  return `in-cluster ${host ?? ''}:${port ?? GAME_PORT}`
}

/**
 * The DNS records a domain needs, as a person types them at their provider: an A record to the
 * address — once the cluster has given one; any node's, for a NodePort — and, on a port other than
 * the game's own, the SRV record a client looks up before it tries 25565.
 */
export const dnsRecordsOf = (
  spec: MinecraftDef.ServerSpec,
  endpoint: Endpoint | undefined,
): string[] => {
  const { domain } = spec

  if (domain === undefined) {
    return []
  }

  const host =
    endpoint?.kind === 'nodeport'
      ? "<any node's address>"
      : (endpoint?.host ?? '<the address, once the cluster has given one>')
  const port =
    endpoint?.kind === 'nodeport' ? (endpoint.port ?? spec.nodePort) : (spec.port ?? GAME_PORT)
  const records = [`A    ${domain}  →  ${host}`]

  if (port !== undefined && port !== GAME_PORT) {
    records.push(`SRV  ${SRV_SERVICE}.${domain}  →  0 5 ${port} ${domain}`)
  }

  return records
}

/** How a server stands, from its pod's phase and its Ready condition. */
export const readinessOf = (pod: K8sDef.KubeObject | undefined): Readiness => {
  if (pod === undefined) {
    return 'absent'
  }

  const status = asRecord(pod.status)
  const phase = status?.['phase']

  if (phase === 'Pending') {
    return 'starting'
  }

  if (phase !== 'Running') {
    return 'stopped'
  }

  const conditions = Array.isArray(status?.['conditions']) ? status['conditions'] : []
  const ready = conditions.some(
    condition =>
      asRecord(condition)?.['type'] === 'Ready' && asRecord(condition)?.['status'] === 'True',
  )

  return ready ? 'ready' : 'starting'
}

/**
 * The players, read off the server's answer to `list`: "There are 2 of a max of 20 players
 * online: steve, alex". `undefined` for an answer that is not that.
 */
export const playersOf = (answer: string): string | undefined => {
  const match = /There are (\d+) of a max of (\d+) players online:?\s*(.*)$/mu.exec(answer)

  if (match === null) {
    return undefined
  }

  const [, online = '0', max = '?', names = ''] = match
  const listed = names.trim()

  return `${online}/${max}${listed === '' ? '' : `: ${listed}`}`
}
