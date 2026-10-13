/**
 * The command line. Anything it does not know is refused: a flag that was mistyped must not turn
 * into a dry run that looks like the run that was meant — or the other way round.
 */
import type { Operation } from 'std:effect'
import { fail } from 'std:result'

import { FLAGS, PLUGINS_DIR, ReleaseErrors } from '../const'
import type { Release } from '../types'

const USAGE = `release [${FLAGS.publish}] [${FLAGS.plugin} <name>]…`

/** What a command line asks for: which plugins, and how far to go with them. */
export interface Asked {
  readonly publish: boolean
  readonly plugins: readonly Release.Plugin[]
}

/** Read the arguments against the plugins that are there: all of them, unless some are named. */
export function* askedBy(
  argv: readonly string[],
  plugins: readonly Release.Plugin[],
): Operation<Asked> {
  const named: string[] = []
  let publish = false

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const value = argv[index + 1]

    if (flag === FLAGS.publish) {
      publish = true
    } else if (flag === FLAGS.plugin && value !== undefined) {
      named.push(value)
      index += 1
    } else {
      return yield* fail(
        ReleaseErrors.Input,
        `${JSON.stringify(flag)} is not understood — ${USAGE}`,
      )
    }
  }

  const unknown = named.find(name => !plugins.some(plugin => plugin.name === name))

  if (unknown !== undefined) {
    const there =
      plugins.length === 0
        ? `nothing under ${PLUGINS_DIR}/ is one`
        : `there is ${plugins.map(plugin => plugin.name).join(', ')}`

    return yield* fail(
      ReleaseErrors.Input,
      `no plugin is called ${JSON.stringify(unknown)} — ${there}`,
    )
  }

  return {
    publish,
    plugins: named.length === 0 ? plugins : plugins.filter(plugin => named.includes(plugin.name)),
  }
}
