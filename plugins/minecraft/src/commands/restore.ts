import { accessInput } from 'sdk:core'
import { K8s, resolveKind } from 'sdk:k8s'
import type { K8sDef } from 'sdk:k8s'

import { defineAction } from 'cli:command'
import { Terminal } from 'cli:core'
import { attempt, sleep } from 'std:effect'
import { fail, isFailure } from 'std:result'

import { CLAIM_GONE_INTERVAL_MS, CLAIM_GONE_RETRIES, MinecraftErrors } from '../const'
import { claimOf, podOf, restoredClaimOf } from '../internal/manifests'
import { snapshotInput } from '../internal/schemas'
import { loadServers, selectServers } from '../internal/settings'
import { createdAt, snapshotKind, snapshotsOf } from '../internal/snapshots'

const POD = resolveKind('pod')
const CLAIM = resolveKind('pvc')

/** The claim a snapshot was taken from (its `spec.source.persistentVolumeClaimName`). */
const sourceClaimOf = (snapshot: K8sDef.KubeObject): string | undefined => {
  const spec = snapshot.spec as { source?: { persistentVolumeClaimName?: string } } | undefined

  return spec?.source?.persistentVolumeClaimName
}

/** Wait for a deleted claim to be gone: its finalizer keeps it Terminating until nothing holds it. */
function* goneClaim(kind: K8sDef.KindRef, claim: string, namespace: string | undefined) {
  for (let tried = 0; tried < CLAIM_GONE_RETRIES; tried += 1) {
    if (isFailure(yield* attempt(K8s.actions.get(kind, claim, { namespace })))) {
      return true
    }

    yield* sleep(CLAIM_GONE_INTERVAL_MS)
  }

  return false
}

/**
 * `ozc minecraft restore [names...] [--from <snapshot>]` — the world as a backup had it: the claim
 * is deleted and remade under the same name, sourced from the snapshot — the newest, unless
 * `--from` names one. The server has to be DOWN first (`minecraft down`, which keeps the claim):
 * a running one holds the claim, and is refused. Afterwards `minecraft up` starts it on the
 * restored world — the StatefulSet adopts its claim by name.
 */
export const RestoreAction = defineAction(
  {
    inherits: accessInput,
    description:
      "Restore server(s)' worlds from a backup: minecraft restore [names...] [--from <snapshot>]",
    args: ['names'],
    input: snapshotInput,
  },
  function* (ctx) {
    const servers = yield* loadServers(ctx.cwd)
    const targets = yield* selectServers(servers, ctx.names)

    if (POD === undefined || CLAIM === undefined) {
      return yield* fail(
        MinecraftErrors.Kind,
        'internal error: the pod or claim kind is unresolved',
      )
    }

    yield* K8s.actions.useCluster(ctx.cwd, ctx.profile, ctx.secret)

    const snapshot = yield* snapshotKind()
    let restored = 0

    for (const { name, spec } of targets) {
      const namespace = spec.namespace
      const claim = claimOf(name)
      const running = yield* attempt(K8s.actions.get(POD, podOf(name), { namespace }))

      if (!isFailure(running)) {
        return yield* fail(
          MinecraftErrors.Server,
          `${name} is running and holds its world: \`minecraft down ${name}\` first (the world is kept), then restore, then \`minecraft up ${name}\``,
        )
      }

      const snapshots = (yield* K8s.actions.list(snapshot, {
        namespace: namespace ?? 'default',
        labelSelector: snapshotsOf(name),
      })).filter(entry => sourceClaimOf(entry) === claim)
      const chosen =
        ctx.from === undefined
          ? snapshots.toSorted((a, b) => createdAt(b).localeCompare(createdAt(a)))[0]
          : snapshots.find(entry => entry.metadata?.name === ctx.from)
      const chosenName = chosen?.metadata?.name

      if (chosenName === undefined) {
        if (ctx.from === undefined) {
          yield* Terminal.actions.write(`  (no backup of ${name}; skipping)\n`)
        }

        continue
      }

      yield* attempt(K8s.actions.remove(CLAIM, claim, { namespace }))

      if (!(yield* goneClaim(CLAIM, claim, namespace))) {
        yield* Terminal.actions.write(
          `  ! ${claim} is still Terminating — something still holds it; skipping\n`,
        )

        continue
      }

      yield* K8s.actions.create(restoredClaimOf(name, spec, chosenName))
      yield* Terminal.actions.write(`✓ restored ${name} from ${chosenName}\n`)
      restored += 1
    }

    // `--from` names one backup: nothing restored means it is not any selected server's
    if (ctx.from !== undefined && restored === 0) {
      return yield* fail(
        MinecraftErrors.Snapshot,
        `no backup named "${ctx.from}" of the selected server(s)`,
      )
    }

    if (restored > 0) {
      yield* Terminal.actions.write('→ run `ozc minecraft up` to start on the restored world(s)\n')
    }
  },
)
