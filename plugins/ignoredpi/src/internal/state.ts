import { attempt, call } from 'std:effect'
import type { Operation } from 'std:effect'
import { IO } from 'std:io'
import { isFailure } from 'std:result'

import type { IgnoreDpiDef } from '../types'

import { stateDir, stateFile } from './system'

/**
 * `~/.ozaco/ignoredpi/state.json`: what the running service writes for `status`, and — above all
 * — the DNS each network service had before it took them, so that `down` (or the next start)
 * gives them back even after a crash.
 */

/** The state the last run left, `undefined` when there is none (or it cannot be read). */
export function* readState(): Operation<IgnoreDpiDef.State | undefined> {
  const file = yield* stateFile()

  if (!(yield* IO.actions.exists(file))) {
    return undefined
  }

  const text = yield* attempt(IO.actions.readText(file))

  if (isFailure(text)) {
    return undefined
  }

  const parsed = yield* attempt(call(() => JSON.parse(text.value) as IgnoreDpiDef.State))

  return isFailure(parsed) ? undefined : parsed.value
}

export function* writeState(state: IgnoreDpiDef.State): Operation<void> {
  yield* IO.actions.ensureDir(yield* stateDir())
  yield* IO.actions.write(yield* stateFile(), `${JSON.stringify(state, null, 2)}\n`)
}

export function* removeState(): Operation<void> {
  yield* IO.actions.rm(yield* stateFile(), { force: true })
}

/** The last lines of a log file ('' when there is none). */
export function* tailOf(file: string, lines: number): Operation<string> {
  const text = yield* attempt(IO.actions.readText(file))

  return isFailure(text) ? '' : text.value.trimEnd().split('\n').slice(-lines).join('\n')
}

/** Whether a process is alive (signal 0 delivers nothing; it only asks). */
export function* isAlive(pid: number): Operation<boolean> {
  return !isFailure(yield* attempt(call(() => process.kill(pid, 0))))
}
