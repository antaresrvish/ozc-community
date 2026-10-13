/**
 * The plugins: every directory under `plugins/` whose `package.json` carries an `ozc` field IS one,
 * called what `ozc.name` calls it and at the version the file carries. They are not listed by
 * hand, and each is a release of its own in this repository — tagged `<name>-v<version>` — where
 * `ozc install <name>` finds it once `ozaco/apps` has nothing by that name.
 */
import type { Operation } from 'std:effect'
import { attempt } from 'std:effect'
import { IO } from 'std:io'
import { fail, isFailure } from 'std:result'
import { isObject, isString } from 'std:shared'

import { JsonCodec } from 'std:codec/impl/json'

import { PLUGINS_DIR, ReleaseErrors } from './const'
import type { Release } from './types'

const MANIFEST_FILE = 'package.json'

/** A directory's `package.json`, parsed: `null` for a directory that has none. */
function* manifestIn(dir: string): Operation<unknown> {
  const file = yield* IO.actions.join(dir, MANIFEST_FILE)

  if (!(yield* IO.actions.exists(file))) {
    return null
  }

  const parsed = yield* attempt(function* () {
    return yield* JsonCodec.actions.parse<unknown>(yield* IO.actions.readText(file))
  })

  if (isFailure(parsed) || !isObject(parsed.value)) {
    return yield* fail(ReleaseErrors.Artifact, `${file} is not a JSON object`, parsed)
  }

  return parsed.value
}

/** The plugins of a repository, by directory name, in that order. */
export function* pluginsOf(root: string): Operation<Release.Plugin[]> {
  const base = yield* IO.actions.join(root, PLUGINS_DIR)
  const plugins: Release.Plugin[] = []

  if (!(yield* IO.actions.exists(base))) {
    return plugins
  }

  for (const dir of (yield* IO.actions.readdir(base)).toSorted()) {
    const project = `${PLUGINS_DIR}/${dir}`
    const manifest = yield* manifestIn(yield* IO.actions.join(base, dir))

    // a file, or a directory that is no project
    if (!isObject(manifest) || !isObject(manifest['ozc'])) {
      continue
    }

    const name = manifest['ozc']['name']
    const version = manifest['version']

    if (!isString(name) || name === '') {
      return yield* fail(
        ReleaseErrors.Version,
        `${project}/${MANIFEST_FILE} carries an ozc field without a name: ozc.name is what the plugin is installed by`,
      )
    }

    if (!isString(version)) {
      return yield* fail(ReleaseErrors.Version, `${project}/${MANIFEST_FILE} carries no version`)
    }

    plugins.push({ dir, name, version })
  }

  return plugins
}
