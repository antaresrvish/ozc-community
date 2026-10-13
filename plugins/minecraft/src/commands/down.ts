import { accessInput } from 'sdk:core'
import { K8s, kindRefOf, resolveKind } from 'sdk:k8s'

import { defineAction } from 'cli:command'
import { Terminal } from 'cli:core'
import { attempt } from 'std:effect'
import { fail } from 'std:result'

import { MinecraftErrors } from '../const'
import { claimOf, render } from '../internal/manifests'
import { downInput } from '../internal/schemas'
import { loadServers, selectServers } from '../internal/settings'

/** The claim's kind (curated, always resolvable). */
const CLAIM = resolveKind('pvc')

/**
 * `ozc minecraft down [names...] [--volumes]` — delete each server's objects (reverse order,
 * tolerant of ones already gone). The world's claim is KEPT — the StatefulSet made it and does not
 * take it along, and the next `up` finds the world where it was — unless `--volumes` says the
 * world goes too. The Namespace is kept as well. No names → every `[minecraft.*]`.
 */
export const DownAction = defineAction(
  {
    inherits: accessInput,
    description:
      'Remove server(s) — delete their objects: minecraft down [names...] [--volumes] [-p profile]',
    args: ['names'],
    input: downInput,
  },
  function* (ctx) {
    const servers = yield* loadServers(ctx.cwd)
    const targets = yield* selectServers(servers, ctx.names)

    if (CLAIM === undefined) {
      return yield* fail(MinecraftErrors.Kind, 'internal error: the claim kind is unresolved')
    }

    yield* K8s.actions.useCluster(ctx.cwd, ctx.profile, ctx.secret)

    for (const { name, spec } of targets) {
      yield* Terminal.actions.write(`→ removing ${name}\n`)

      for (const object of render(name, spec).toReversed()) {
        const ref = kindRefOf(object)
        const objectName = object.metadata?.name

        // the Namespace stays: it may hold other servers, Secrets, other tenants — and deleting it
        // would take the world's claim with it
        if (object.kind !== 'Namespace' && ref !== undefined && objectName !== undefined) {
          yield* attempt(
            K8s.actions.remove(ref, objectName, { namespace: object.metadata?.namespace }),
          )
        }
      }

      if (ctx.volumes) {
        yield* attempt(K8s.actions.remove(CLAIM, claimOf(name), { namespace: spec.namespace }))
      }

      yield* Terminal.actions.write(
        `✓ ${name} removed${ctx.volumes ? ', world included' : ' (the world is kept)'}\n`,
      )
    }
  },
)
