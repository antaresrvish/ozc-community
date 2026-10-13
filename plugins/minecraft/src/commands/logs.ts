import { accessInput } from 'sdk:core'
import { K8s } from 'sdk:k8s'

import { defineAction } from 'cli:command'
import { Terminal } from 'cli:core'
import { each } from 'std:effect'
import { decodeText } from 'std:io'

import { CONTAINER } from '../const'
import { podOf } from '../internal/manifests'
import { logsInput, logsShort } from '../internal/schemas'
import { loadServers, selectServers } from '../internal/settings'

/**
 * `ozc minecraft logs <name> [-f] [--tail n]` — the server's log: what the image printed while it
 * came up, then the game's own. `-f`/`--follow` streams live until Ctrl-C; `--tail` limits the
 * initial lines.
 */
export const LogsAction = defineAction(
  {
    inherits: accessInput,
    description: 'Logs of a server: minecraft logs <name> [-f] [--tail n] [-p profile]',
    args: ['name'],
    short: logsShort,
    input: logsInput,
  },
  function* (ctx) {
    const servers = yield* loadServers(ctx.cwd)
    const [target] = yield* selectServers(servers, [ctx.name])

    if (target === undefined) {
      return
    }

    yield* K8s.actions.useCluster(ctx.cwd, ctx.profile, ctx.secret)

    const pod = podOf(target.name)
    const options = {
      namespace: target.spec.namespace,
      container: CONTAINER,
      ...(ctx.tail === undefined ? {} : { tailLines: ctx.tail }),
    }

    if (ctx.follow) {
      // one streaming decoder over the whole flow: a character split across chunks stays whole
      for (const text of yield* each(decodeText(yield* K8s.actions.logStream(pod, options)))) {
        yield* Terminal.actions.write(text)
        yield* each.next()
      }

      return
    }

    const text = yield* K8s.actions.logs(pod, options)

    yield* Terminal.actions.write(text.endsWith('\n') ? text : `${text}\n`)
  },
)
