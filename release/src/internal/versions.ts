/**
 * Where a plugin's version stands among the ones that are released: a release is published
 * forward, and ozc offers no pre-release as the newest.
 */
import { isReleaseVersion, releaseVersionOf } from 'sdk:core'

import type { Operation } from 'std:effect'
import { fail } from 'std:result'
import { compareVersions } from 'std:shared'

import { ReleaseErrors } from '../const'
import type { Release } from '../types'

import type { Listed } from './github'

/** What sets a pre-release apart, in a version written the one way a release writes it. */
const PRERELEASE_MARK = '-'

/** Whether a version is a pre-release: `1.3.0-rc.1`. */
export const isPrerelease = (version: string): boolean => version.includes(PRERELEASE_MARK)

/**
 * The versions of a plugin that are out, newest first: every release of the repository whose tag
 * is the plugin's, as far as a user is offered it. A draft is seen by nobody, and a release marked
 * a pre-release is skipped by everything that looks for the newest — ozc first — so neither is a
 * version to stay above.
 */
export const releasedVersions = (name: string, listed: readonly Listed[]): string[] =>
  listed
    .filter(release => !release.draft && !release.prerelease)
    .flatMap(release => releaseVersionOf(name, release.tag) ?? [])
    .toSorted((a, b) => compareVersions(b, a))

/**
 * Insist that a plugin's version is one to release: semver as a tag and a directory spell it, no
 * pre-release, and above every version that is out — each refused by name.
 */
export function* requireReleasable(
  plugin: Release.Plugin,
  released: readonly string[],
): Operation<void> {
  const { name, version } = plugin

  if (!isReleaseVersion(version)) {
    return yield* fail(
      ReleaseErrors.Version,
      `${name} is at ${JSON.stringify(version)}: a release carries a semver version, written plainly (1.2.3)`,
    )
  }

  if (isPrerelease(version)) {
    return yield* fail(
      ReleaseErrors.Version,
      `${name} is at ${version}, a pre-release: ozc offers no pre-release as the newest, so none is published`,
    )
  }

  const [newest] = released

  if (newest !== undefined && compareVersions(version, newest) < 0) {
    return yield* fail(
      ReleaseErrors.Version,
      `${name} is at ${version}, and ${newest} is released already: a release is published forward`,
    )
  }
}
