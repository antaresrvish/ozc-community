import { accessInput } from 'sdk:core'
import { K8s } from 'sdk:k8s'

import { defineAction } from 'cli:command'
import { Terminal } from 'cli:core'

import { claimOf, imageOf, render } from '../internal/manifests'
import { serversInput } from '../internal/schemas'
import { loadServers, selectServers } from '../internal/settings'

/**
 * `ozc minecraft up [names...]` — render each server's `[minecraft.<name>]` spec to its objects and
 * apply them (create-or-update). No names → every `[minecraft.*]`. The world's claim is the
 * StatefulSet's to make, once: a `storage` changed afterwards is refused by the apiserver (the
 * template is immutable) — resize the claim itself, or start a new server.
 */
export const UpAction = defineAction(
  {
    inherits: accessInput,
    description: 'Deploy server(s) — apply their objects: minecraft up [names...] [-p profile]',
    args: ['names'],
    input: serversInput,
  },
  function* (ctx) {
    const servers = yield* loadServers(ctx.cwd)
    const targets = yield* selectServers(servers, ctx.names)

    yield* K8s.actions.useCluster(ctx.cwd, ctx.profile, ctx.secret)

    for (const { name, spec } of targets) {
      const objects = render(name, spec)

      yield* Terminal.actions.write(
        `→ deploying ${name} (${imageOf(spec)}, ${objects.length} objects)\n`,
      )

      for (const object of objects) {
        yield* K8s.actions.apply(object)
      }

      yield* Terminal.actions.write(
        `✓ ${name} deployed — the world lives in the claim ${claimOf(name)}\n`,
      )
    }
  },
)
