import { accessInput } from 'sdk:core'
import { K8s } from 'sdk:k8s'

import { defineAction } from 'cli:command'
import { Terminal } from 'cli:core'

import { serversInput } from '../internal/schemas'
import { loadServers, selectServers } from '../internal/settings'
import { snapshotKind, snapshotsOf } from '../internal/snapshots'

/**
 * `ozc minecraft backups [names...]` — each server's backups (its `VolumeSnapshot`s: name, ready,
 * source, age) as a table: what `restore` can go back to, and `prune` can delete.
 */
export const BackupsAction = defineAction(
  {
    inherits: accessInput,
    description: "List server(s)' backups: minecraft backups [names...] [-p profile]",
    args: ['names'],
    input: serversInput,
  },
  function* (ctx) {
    const servers = yield* loadServers(ctx.cwd)
    const targets = yield* selectServers(servers, ctx.names)

    yield* K8s.actions.useCluster(ctx.cwd, ctx.profile, ctx.secret)

    const snapshot = yield* snapshotKind()

    for (const { name, spec } of targets) {
      const table = yield* K8s.actions.table(snapshot, {
        namespace: spec.namespace ?? 'default',
        labelSelector: snapshotsOf(name),
      })

      yield* Terminal.actions.write(`# ${name}\n`)

      if (table.rows.length === 0) {
        yield* Terminal.actions.write('  (no backups)\n\n')
        continue
      }

      yield* K8s.actions.showTable(table, false)
      yield* Terminal.actions.write('\n')
    }
  },
)
