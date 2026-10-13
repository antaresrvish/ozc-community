/**
 * The tree a release is published from. The tool builds whatever lies in it — on the pipeline's
 * machine that is the commit that was checked out, and on a developer's it is whatever is there:
 * work that is not committed, files nobody else has. What goes out to every user is a commit and
 * nothing else, and its page says which one, so a release can be traced to its source.
 *
 * Asked in publish mode alone: a dry run is run on work in progress, to try that very work.
 */
import type { Operation } from 'std:effect'
import { fail } from 'std:result'

import { COMMIT_DIGITS, GIT_BIN, ReleaseErrors } from '../const'

import { answered } from './programs'

/** How many of the paths that differ a refusal names: enough to recognise what is in the way. */
const NAMED = 5

/** What `git` answers, asked in the tree. A tree that is no checkout is a failure. */
function* git(root: string, args: readonly string[]): Operation<string> {
  return yield* answered(ReleaseErrors.Tree, [GIT_BIN, ...args], { cwd: root })
}

/**
 * Insist that the tree is its commit: nothing changed, nothing added that git does not ignore.
 * What a build leaves is ignored, so a tree that was built in is still clean.
 */
export function* requireClean(root: string): Operation<void> {
  // whatever the user's own configuration says of untracked files: they are part of the answer
  const status = yield* git(root, ['status', '--porcelain', '--untracked-files=normal'])
  // a line is two letters of state, a space, and the path
  const changed = status
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(line => line.slice(3))

  if (changed.length > 0) {
    const more = changed.length - NAMED

    return yield* fail(
      ReleaseErrors.Tree,
      `a release is published from a commit, and this tree is not one: ${changed.slice(0, NAMED).join(', ')}${more > 0 ? ` and ${more} more` : ''} — commit what belongs to the release, or publish from a clean checkout`,
    )
  }
}

/** The commit the tree is at, by a short form of its name. */
export function* commitOf(root: string): Operation<string> {
  return (yield* git(root, ['rev-parse', `--short=${COMMIT_DIGITS}`, 'HEAD'])).trim()
}
