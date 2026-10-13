import { accessInput } from 'sdk:core'
import { K8s } from 'sdk:k8s'

import { defineAction } from 'cli:command'
import { Terminal } from 'cli:core'
import { fail } from 'std:result'

import { MinecraftErrors } from '../const'
import { consoleOf } from '../internal/console'
import { consoleInput } from '../internal/schemas'
import { loadServers, selectServers } from '../internal/settings'

/**
 * `ozc minecraft console <name> <command...>` — a command at the server's console, as it would be
 * typed there (`list`, `say hello`, `op steve`, `save-all`, `stop`), through the image's own
 * `rcon-cli` inside the pod (`internal/console.ts`). What the server answers is printed.
 */
export const ConsoleAction = defineAction(
  {
    inherits: accessInput,
    description:
      'Run a command at the server console: minecraft console <name> <command...> [-p profile]',
    args: ['name', 'words'],
    input: consoleInput,
    examples: [
      { run: 'minecraft console survival list', note: 'who is online' },
      { run: 'minecraft console survival say server restarts in 5 minutes', note: 'tell everyone' },
      { run: 'minecraft console survival op steve', note: 'make steve an operator' },
    ],
  },
  function* (ctx) {
    const servers = yield* loadServers(ctx.cwd)
    const [target] = yield* selectServers(servers, [ctx.name])

    if (target === undefined) {
      return
    }

    yield* K8s.actions.useCluster(ctx.cwd, ctx.profile, ctx.secret)

    const line = ctx.words.join(' ')
    const ran = yield* consoleOf(target, ctx.words)

    if (!ran.success) {
      const said = `${ran.stderr}${ran.stdout}`.trim()

      return yield* fail(
        MinecraftErrors.Console,
        `${target.name}: "${line}" failed${ran.message === '' ? '' : ` (${ran.message})`}${said === '' ? '' : `: ${said}`}`,
      )
    }

    const answer = ran.stdout.trimEnd()

    yield* Terminal.actions.write(`${answer === '' ? '(no answer)' : answer}\n`)
  },
)
