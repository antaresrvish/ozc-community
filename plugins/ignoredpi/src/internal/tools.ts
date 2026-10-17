import type { Operation } from 'std:effect'
import { IO } from 'std:io'
import { fail } from 'std:result'

import { IgnoreDpiErrors } from '../const'

/**
 * The system tools the service drives (`networksetup`, `launchctl`, `powershell`, `schtasks` …),
 * each through a seam the suites — and a curious user — point at a stand-in.
 */

/** XML text, escaped. */
export const escaped = (text: string): string =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

/** A tool's path: the seam's value when set, else the system's own. */
export function* toolOf(env: string, fallback: string): Operation<string> {
  const value = yield* IO.actions.env(data => ({ tool: data[env] }), ['tool'])

  return value.tool ?? fallback
}

/**
 * Run `tool`, its stdout as text; a non-zero exit is a `system` failure carrying its stderr, the
 * call named as `shown`.
 */
export function* execTool(tool: string, args: readonly string[], shown: string): Operation<string> {
  const ran = yield* IO.actions.exec(tool, args)
  const stdout = new TextDecoder().decode(ran.stdout)

  if (!ran.success) {
    const said = `${new TextDecoder().decode(ran.stderr)}${stdout}`.trim()

    return yield* fail(
      IgnoreDpiErrors.System,
      `${tool} ${shown} failed${said === '' ? '' : `: ${said}`}`,
    )
  }

  return stdout
}

/** Run the tool a seam names (else the system's own), named in a failure by its arguments. */
export function* runTool(
  env: string,
  fallback: string,
  args: readonly string[],
): Operation<string> {
  return yield* execTool(yield* toolOf(env, fallback), args, args.join(' '))
}
