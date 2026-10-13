import { accessInput } from 'sdk:core'
import { K8s, resolveKind } from 'sdk:k8s'

import { defineAction } from 'cli:command'
import { Terminal } from 'cli:core'
import type { Operation } from 'std:effect'
import { attempt } from 'std:effect'
import { fail, isFailure } from 'std:result'

import { MinecraftErrors, S3_BACKUP_CLASS } from '../const'
import { consoleOf } from '../internal/console'
import { podOf, snapshotOf } from '../internal/manifests'
import { backupInput } from '../internal/schemas'
import { loadServers, selectServers } from '../internal/settings'
import { snapshotKind, stampNow } from '../internal/snapshots'
import { readinessOf } from '../internal/status'
import type { MinecraftDef } from '../types'

const POD = resolveKind('pod')

/**
 * Hold the world still while it is snapshotted: everything saved to disk, saving paused — and
 * resumed afterwards, whatever happened in between. A server that is not up has nothing to hold.
 */
function* holdingStill<T>(
  target: MinecraftDef.ServerTarget,
  body: () => Operation<T>,
): Operation<T> {
  if (POD === undefined) {
    return yield* fail(MinecraftErrors.Kind, 'internal error: the pod kind is unresolved')
  }

  const pod = yield* attempt(
    K8s.actions.get(POD, podOf(target.name), { namespace: target.spec.namespace }),
  )
  const up = !isFailure(pod) && readinessOf(pod.value) === 'ready'

  if (!up) {
    return yield* body()
  }

  yield* attempt(consoleOf(target, ['save-all', 'flush']))
  yield* attempt(consoleOf(target, ['save-off']))

  try {
    return yield* body()
  } finally {
    yield* attempt(consoleOf(target, ['save-on']))
  }
}

/**
 * `ozc minecraft backup [names...] [--s3] [--class <name>]` — a `VolumeSnapshot` of each server's
 * world, the world held still meanwhile (`save-all flush`, `save-off`, then `save-on`). Needs a
 * snapshotter in the cluster — Longhorn's. The class: `--class` / `--s3` on the line win; else the
 * spec's `backup` (`s3` → the `longhorn-backup` class, pushed to the external backup target — set it
 * with `ozc storage longhorn --backupTarget …`); else the cluster's default class, an in-cluster
 * snapshot. Each snapshot is labelled as the server's, so `backups`, `restore` and `prune` find it.
 */
export const BackupAction = defineAction(
  {
    inherits: accessInput,
    description:
      "Snapshot server(s)' worlds; --s3 pushes to the backup target: minecraft backup [names...] [--s3] [--class n]",
    args: ['names'],
    input: backupInput,
  },
  function* (ctx) {
    const servers = yield* loadServers(ctx.cwd)
    const targets = yield* selectServers(servers, ctx.names)

    yield* K8s.actions.useCluster(ctx.cwd, ctx.profile, ctx.secret)
    // preflight: a cluster that cannot snapshot is told so before anything is held still
    yield* snapshotKind()

    const override = ctx.class ?? (ctx.s3 ? S3_BACKUP_CLASS : undefined)
    const stamp = stampNow()

    for (const target of targets) {
      const { name, spec } = target
      const snapshotClass = override ?? (spec.backup === 's3' ? S3_BACKUP_CLASS : undefined)
      const snapshot = snapshotOf(name, spec, { stamp, snapshotClass })
      const verb = snapshotClass === undefined ? 'snapshot' : `backup → ${snapshotClass}`

      yield* holdingStill(target, function* () {
        yield* K8s.actions.apply(snapshot)
      })
      yield* Terminal.actions.write(`✓ ${verb} ${snapshot.metadata?.name ?? ''}\n`)
    }
  },
)
