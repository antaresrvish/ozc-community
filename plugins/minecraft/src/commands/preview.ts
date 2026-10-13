import { defineAction } from 'cli:command'
import { Terminal } from 'cli:core'

import { YamlCodec } from 'std:codec/impl/yaml'

import { render } from '../internal/manifests'
import { serversInput } from '../internal/schemas'
import { loadServers, selectServers } from '../internal/settings'

/**
 * `ozc minecraft preview [names...]` — print the Kubernetes YAML each server renders to, without
 * applying or connecting to a cluster. No names → every `[minecraft.*]`.
 */
export const PreviewAction = defineAction(
  {
    description: 'Print the manifests server(s) render to (no apply): minecraft preview [names...]',
    args: ['names'],
    input: serversInput,
  },
  function* (ctx) {
    const servers = yield* loadServers(ctx.cwd)
    const targets = yield* selectServers(servers, ctx.names)

    for (const { name, spec } of targets) {
      for (const object of render(name, spec)) {
        const yaml = yield* YamlCodec.actions.stringify(object)

        yield* Terminal.actions.write(`---\n${yaml}`)
      }
    }
  },
)
