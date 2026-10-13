/**
 * The repository, as far as a release goes — and every word to it goes through `gh`: what is
 * released there, and the one kind of write, a release itself. The first is a question, asked on
 * any run; the write is the only one this tool makes anywhere outside the tree, and happens in
 * publish mode alone.
 */
import { ENV_TOKENS } from 'sdk:loader'

import type { Operation } from 'std:effect'
import type { IODef } from 'std:io'
import { IO } from 'std:io'
import { fail } from 'std:result'

import { ENV_GH, GH_BIN, GH_ENV, GH_RELEASES_FILTER, ReleaseErrors } from '../const'

import { programOf, saidBy, textOf } from './programs'

/** The most releases GitHub lists on one page: the fewest pages to ask for. */
const PAGE_SIZE = 100

/** What a release is created from. */
interface Draft {
  readonly tag: string
  readonly title: string
  readonly notes: string
  /** The assets, by path. */
  readonly files: readonly string[]
}

/**
 * Run `gh`; whether a refusal matters is the caller's. It is the one program that is started with
 * the token in its environment — every other is started without (`programs.ts`).
 */
function* gh(args: readonly string[]): Operation<IODef.ExecResult> {
  return yield* IO.actions.exec(yield* programOf(ENV_GH, GH_BIN), args, { env: GH_ENV })
}

/** A release, as the repository lists it. */
export interface Listed {
  readonly tag: string
  /** Not published: nobody but its author sees it, and its tag does not exist yet. */
  readonly draft: boolean
  /** Marked a pre-release on GitHub: no channel offers it as the newest. */
  readonly prerelease: boolean
}

/**
 * Insist on a token in the environment before anything is published. `gh` would find the login a
 * developer keeps in the keychain by itself: publishing is not done on the strength of that. The
 * token is `gh`'s to read and send; here it is only seen to be there.
 */
export function* requireToken(): Operation<void> {
  const env = yield* IO.actions.env(
    data => ({ tokens: ENV_TOKENS.map(name => data[name]?.trim() ?? '') }),
    [],
  )

  if (env.tokens.every(token => token === '')) {
    return yield* fail(
      ReleaseErrors.Token,
      `publishing needs a token that can write releases to the repository, in ${ENV_TOKENS.join(' or ')} — the pipeline takes it from its own GITHUB_TOKEN, which is missing or empty when this is the pipeline`,
    )
  }
}

/**
 * Every release the repository lists, of whatever it releases. A repository that could not be
 * asked is a failure, never "nothing is released": taking it for that would build and publish
 * over what is there.
 */
export function* releasesOf(repo: string): Operation<Listed[]> {
  const asked = yield* gh([
    'api',
    `repos/${repo}/releases?per_page=${PAGE_SIZE}`,
    '--paginate',
    '--jq',
    GH_RELEASES_FILTER,
  ])

  if (!asked.success) {
    return yield* fail(
      ReleaseErrors.Github,
      `${repo} could not be asked what is released there: ${saidBy(asked)}`,
    )
  }

  return textOf(asked.stdout)
    .split('\n')
    .filter(line => line !== '')
    .map(line => {
      const [tag = '', draft, prerelease] = line.split('\t')

      return { tag, draft: draft === 'true', prerelease: prerelease === 'true' }
    })
}

/** Create a release with its assets. `gh` publishes it only once every asset is uploaded. */
export function* createRelease(repo: string, draft: Draft): Operation<void> {
  const created = yield* gh([
    'release',
    'create',
    draft.tag,
    ...draft.files,
    '--repo',
    repo,
    '--title',
    draft.title,
    '--notes',
    draft.notes,
  ])

  if (!created.success) {
    return yield* fail(
      ReleaseErrors.Github,
      `${draft.tag} could not be released on ${repo}: ${saidBy(created)}`,
    )
  }
}
