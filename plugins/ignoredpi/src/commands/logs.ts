import { defineAction } from 'cli:command'
import { Terminal } from 'cli:core'
import { attempt, sleep } from 'std:effect'
import { IO } from 'std:io'
import { isFailure } from 'std:result'

import { logsInput, logsShort } from '../internal/schemas'
import { logFile } from '../internal/state'

/** How often a followed log is looked at again. */
const FOLLOW_INTERVAL_MS = 500

/**
 * `ozc ignoredpi logs [-f] [--tail n]` — what the service wrote: when it came up and with what,
 * whose DNS it took and gave back, every connection it could not forward. `-f` follows it until
 * Ctrl-C.
 */
export const LogsAction = defineAction(
  {
    description: 'The service’s log: ignoredpi logs [-f] [--tail n]',
    short: logsShort,
    input: logsInput,
  },
  function* (ctx) {
    const file = yield* logFile()
    const read = yield* attempt(IO.actions.read(file))
    const bytes = isFailure(read) ? new Uint8Array(0) : read.value
    const lines = new TextDecoder().decode(bytes).split('\n')
    const shown = ctx.tail === undefined ? lines : lines.slice(-(ctx.tail + 1))

    yield* Terminal.actions.write(shown.join('\n'))

    if (!ctx.follow) {
      if (bytes.length === 0) {
        yield* Terminal.actions.write(`(nothing in ${file} yet)\n`)
      }

      return
    }

    let offset = bytes.length

    for (;;) {
      yield* sleep(FOLLOW_INTERVAL_MS)

      const next = yield* attempt(IO.actions.read(file))

      if (isFailure(next)) {
        continue
      }

      // a log that was started over (a new install) is read from its start
      if (next.value.length < offset) {
        offset = 0
      }

      if (next.value.length > offset) {
        yield* Terminal.actions.write(new TextDecoder().decode(next.value.subarray(offset)))
        offset = next.value.length
      }
    }
  },
)
