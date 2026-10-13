import { accessInput } from 'sdk:core'
import { K8s } from 'sdk:k8s'

import { defineAction } from 'cli:command'
import { Terminal } from 'cli:core'
import { attempt } from 'std:effect'

import { snapshotInput } from '../internal/schemas'
import { loadServers, selectServers } from '../internal/settings'
import { snapshotKind, snapshotsOf } from '../internal/snapshots'

/**
 * `ozc minecraft prune [names...] [--from <snapshot>]` — delete a server's backups: one with
 * `--from`, else all of them. Tolerant of ones already gone.
 */
export const PruneAction = defineAction(
  {
    inherits: accessInput,
    description: "Delete server(s)' backups: minecraft prune [names...] [--from <snapshot>]",
    args: ['names'],
    input: snapshotInput,
  },
  function* (ctx) {
    const servers = yield* loadServers(ctx.cwd)
    const targets = yield* selectServers(servers, ctx.names)

    yield* K8s.actions.useCluster(ctx.cwd, ctx.profile, ctx.secret)

    const snapshot = yield* snapshotKind()

    for (const { name, spec } of targets) {
      const namespace = spec.namespace ?? 'default'
      const snapshots = yield* K8s.actions.list(snapshot, {
        namespace,
        labelSelector: snapshotsOf(name),
      })
      const chosen =
        ctx.from === undefined
          ? snapshots
          : snapshots.filter(entry => entry.metadata?.name === ctx.from)

      if (chosen.length === 0) {
        yield* Terminal.actions.write(
          `  (no backups of ${ctx.from === undefined ? name : `${name} named "${ctx.from}"`})\n`,
        )

        continue
      }

      for (const entry of chosen) {
        const snapshotName = entry.metadata?.name

        if (snapshotName !== undefined) {
          yield* attempt(K8s.actions.remove(snapshot, snapshotName, { namespace }))
          yield* Terminal.actions.write(`✓ deleted backup ${snapshotName}\n`)
        }
      }
    }
  },
)
