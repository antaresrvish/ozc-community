import { K8s, resolveKind } from 'sdk:k8s'
import type { K8sDef } from 'sdk:k8s'

import type { Operation } from 'std:effect'
import { attempt } from 'std:effect'
import { fail, isFailure } from 'std:result'

import { APP_LABEL, COMPONENT, COMPONENT_LABEL, MinecraftErrors } from '../const'

/** Said when the cluster has no VolumeSnapshot CRD: a backup needs a snapshotter and a driver that can. */
const NO_SNAPSHOTS =
  'this cluster has no VolumeSnapshot support — Longhorn with its snapshotter does (`ozc storage longhorn --snapshots`); the local-path provisioner cannot snapshot'

/**
 * The `VolumeSnapshot` kind, AND the CRD seen to be installed: a bare `resolveKind` cannot tell —
 * it is a CRD, not a built-in. Probed with an all-namespaces list; a refusal means no snapshotter,
 * said plainly instead of as an apiserver 404. Needs an active connection.
 */
export function* snapshotKind(): Operation<K8sDef.KindRef> {
  const kind = resolveKind('volumesnapshot')

  if (kind === undefined) {
    return yield* fail(
      MinecraftErrors.Kind,
      'internal error: the volumesnapshot kind is unresolved',
    )
  }

  const probe = yield* attempt(K8s.actions.list(kind))

  if (isFailure(probe)) {
    return yield* fail(MinecraftErrors.Snapshot, NO_SNAPSHOTS)
  }

  return kind
}

/** The selector that finds a server's snapshots: its name, and that it is a server's. */
export const snapshotsOf = (name: string): string =>
  `${APP_LABEL}=${name},${COMPONENT_LABEL}=${COMPONENT}`

/** The moment a backup is taken, as a name can carry it. */
export const stampNow = (): string =>
  new Date().toISOString().replaceAll(/[:.]/gu, '-').toLowerCase()

/** A snapshot's creation time as a sortable string (ISO 8601 sorts chronologically). */
export const createdAt = (snapshot: K8sDef.KubeObject): string =>
  String(snapshot.metadata?.creationTimestamp ?? '')
