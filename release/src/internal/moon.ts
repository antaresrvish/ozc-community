/**
 * Moon, which builds every plugin: this tool compiles nothing itself. A build says a lot, so its
 * output goes straight to the terminal.
 *
 * On a machine that says it is a CI machine Moon refuses every task that is kept out of `moon ci`
 * even when it is named ("No tasks found") — so Moon is started the way a developer's machine
 * starts it, without the variable that says CI. And without the token a release is published
 * with: a build runs the code of every package it installs — build scripts, bundler plugins — and
 * all of it sees the environment Moon was started with.
 */
import type { Operation } from 'std:effect'
import { IO } from 'std:io'
import { fail } from 'std:result'

import { ENV_CI, ENV_MOON, MOON_BIN, ReleaseErrors } from '../const'

import { programOf, TOKENLESS } from './programs'

/**
 * `moon run <targets>` from the repository's root, with the caller's environment less what says CI
 * and less every GitHub token. A target that fails fails the release.
 */
export function* moonRun(root: string, targets: readonly string[]): Operation<void> {
  const child = yield* IO.actions.spawn(yield* programOf(ENV_MOON, MOON_BIN), ['run', ...targets], {
    cwd: root,
    env: { [ENV_CI]: undefined, ...TOKENLESS },
    stdio: 'inherit',
  })
  const status = yield* child.exited()

  if (!status.success) {
    return yield* fail(
      ReleaseErrors.Task,
      `moon run ${targets.join(' ')} failed (${status.signal ?? `exit code ${status.code}`})`,
    )
  }
}
