/**
 * A plugin's release, start to end:
 *
 *   1. the tag its version makes: `<name>-v<version>`
 *   2. is that tag released already? Then there is nothing to do — THIS is what decides whether
 *      a plugin is released: its version, never the tag or the branch a run was started from
 *   3. is the version one to release? A release moves its users forward: a pre-release, and a
 *      version below the newest that is out, are refused by name
 *   4. build, through Moon
 *   5. the asset, held to its banner, and `ozc.json` beside it
 *   6. publish — in publish mode only; a dry run stops short of it and says what it would write
 *
 * In publish mode the token and the tree are looked at before anything is built — both refused
 * here. One reading of what is released answers for every plugin, and a plugin that fails does
 * not stop the ones after it: every failure is told, and the run fails at its end.
 */
import { releaseTag } from 'sdk:core'

import type { Operation } from 'std:effect'
import { attempt } from 'std:effect'
import type { Result } from 'std:result'
import { fail, formatFailure, isFailure } from 'std:result'

import { FLAGS, PLUGINS_DIR, REPO, ReleaseErrors } from '../const'
import type { Release } from '../types'

import { assemble } from './assets'
import type { Listed } from './github'
import { createRelease, releasesOf, requireToken } from './github'
import { moonRun } from './moon'
import { commitOf, requireClean } from './tree'
import { releasedVersions, requireReleasable } from './versions'

const MEGABYTE = 1_000_000

/** A size as a person reads it. */
const sized = (bytes: number): string =>
  bytes >= MEGABYTE ? `${(bytes / MEGABYTE).toFixed(1)} MB` : `${Math.ceil(bytes / 1000)} kB`

/** What every line said about a plugin starts with, and the title its release carries. */
const named = ({ name, version }: Release.Plugin): string => `${name} ${version}`

/**
 * What a release says of itself on its page: how the plugin is installed and brought up to date,
 * and what it was built from.
 */
const notesOf = (plugin: Release.Plugin, commit: string): string =>
  [
    `${named(plugin)}, a community plugin for ozc.`,
    '',
    'ozc installs it, and the same line brings its newest:',
    '',
    `    ozc install ${plugin.name}`,
    '',
    `Built from commit ${commit}.`,
    '',
  ].join('\n')

/** What a release holds, line by line. */
function* reportAssets(assembled: Release.Assembled, options: Release.Options): Operation<void> {
  const width = Math.max(...assembled.assets.map(asset => asset.file.length))

  yield* options.report(`  assets in ${assembled.dir}`)

  for (const asset of assembled.assets) {
    yield* options.report(
      `    ${asset.file.padEnd(width)}  ${sized(asset.size).padStart(8)}  sha256 ${asset.sha256}`,
    )
  }
}

/** One plugin, as far as the run goes. */
function* releaseOne(
  plugin: Release.Plugin,
  listed: readonly Listed[],
  options: Release.Options,
): Operation<Release.Outcome> {
  const { name, version } = plugin
  const tag = releaseTag(name, version)
  const released = releasedVersions(name, listed)
  const base = { plugin: name, version, tag }

  if (released.includes(version)) {
    yield* options.report(`${named(plugin)} is released already (${tag}) — nothing to do`)

    return { status: 'released', ...base }
  }

  yield* requireReleasable(plugin, released)
  yield* options.report(`${named(plugin)} is due: ${tag}`)
  yield* moonRun(options.root, [`${plugin.dir}:build`])

  const assembled = yield* assemble(options.root, plugin, tag)

  yield* reportAssets(assembled, options)

  if (!options.publish) {
    yield* options.report(
      `  a dry run: ${tag} ("${named(plugin)}") on ${REPO}, with the ${assembled.assets.length} assets above, is not published — ${FLAGS.publish} does`,
    )

    return { status: 'assembled', ...base, ...assembled }
  }

  yield* createRelease(REPO, {
    tag,
    title: named(plugin),
    notes: notesOf(plugin, yield* commitOf(options.root)),
    files: assembled.assets.map(asset => asset.path),
  })
  yield* options.report(`  published ${tag} ("${named(plugin)}") on ${REPO}`)

  return { status: 'published', ...base, ...assembled }
}

/** Release every plugin that is due, in the order given. */
export function* release(
  plugins: readonly Release.Plugin[],
  options: Release.Options,
): Operation<Release.Outcome[]> {
  const outcomes: Release.Outcome[] = []
  const failures: Result.Failure<unknown>[] = []

  if (plugins.length === 0) {
    yield* options.report(`nothing under ${PLUGINS_DIR}/ is a plugin: nothing to release`)

    return outcomes
  }

  if (options.publish) {
    yield* requireToken()
    yield* requireClean(options.root)
  }

  const listed = yield* releasesOf(REPO)

  for (const plugin of plugins) {
    const outcome = yield* attempt(releaseOne(plugin, listed, options))

    if (isFailure(outcome)) {
      failures.push(outcome)
      yield* options.report(`${named(plugin)} failed: ${formatFailure(outcome)}`)
    } else {
      outcomes.push(outcome.value)
    }
  }

  const [first] = failures

  if (first !== undefined && failures.length === 1) {
    return yield* first
  }

  if (first !== undefined) {
    return yield* fail(ReleaseErrors.Plugins, `${failures.length} plugins failed`, ...failures)
  }

  return outcomes
}
