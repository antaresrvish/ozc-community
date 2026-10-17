import { useOzacoConfig } from 'sdk:config'
import { homeDir } from 'sdk:core'

import type { Operation } from 'std:effect'
import { fail, formatFailure, isFailure } from 'std:result'
import { validateSync } from 'std:schema'

import { IgnoreDpiErrors } from '../const'
import type { IgnoreDpiDef } from '../types'

import { SettingsSchema } from './schemas'

/**
 * The directory the config is discovered from: `-C` when given, else home — the service is the
 * machine's, not a project's, so `~/ozaco.toml` or `~/.ozaco/ignoredpi.toml` holds its table
 * wherever a command is typed.
 */
export function* placeOf(cwd: string | undefined): Operation<string> {
  return cwd ?? (yield* homeDir())
}

/** Read the top-level `[ignoredpi]` table; none at all is the defaults. */
export function* loadSettings(cwd: string | undefined): Operation<IgnoreDpiDef.Settings> {
  const config = yield* useOzacoConfig({ cwd: yield* placeOf(cwd) })
  const raw = (yield* config.get<unknown>('ignoredpi')) ?? {}
  const settings = validateSync(SettingsSchema, raw)

  if (isFailure(settings)) {
    return yield* fail(
      IgnoreDpiErrors.Config,
      `invalid [ignoredpi] config in ozaco.toml: ${formatFailure(settings)}`,
    )
  }

  return settings.value
}
