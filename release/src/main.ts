import { attempt, exit, main } from 'std:effect'
import { formatFailure, isFailure } from 'std:result'

/**
 * Release what changed: `moon run community:release`.
 *
 * For every plugin of `plugins/` the question is one: is `<name>-v<version>` released already in
 * this repository? When it is, there is nothing to do. When it is not, the plugin is built and
 * packed — and published, in publish mode. So a run can be started on any tag, any branch, any
 * number of times: what it releases is decided by the versions in the tree, and by nothing else.
 * A version that would not move its users forward — a pre-release, one below the newest that is
 * out — is refused.
 *
 *   moon run community:release                     a dry run: everything but the write to GitHub
 *   moon run community:release -- --publish        publish; needs a token in GH_TOKEN, and a tree
 *                                                  that is a commit and nothing else
 *   moon run community:release -- --plugin kube    only that plugin
 */
import { JsonCodec } from 'std:codec/impl/json'
import { BunIO } from 'std:io/impl/bun'

import { REPO_DIR } from './const'
import { askedBy } from './internal/input'
import { release } from './internal/release'
import { pluginsOf } from './plugins'

void main(function* (argv) {
  yield* BunIO.use()
  yield* JsonCodec.use()

  const outcome = yield* attempt(function* () {
    const { plugins, publish } = yield* askedBy(argv, yield* pluginsOf(REPO_DIR))

    return yield* release(plugins, {
      root: REPO_DIR,
      publish,
      *report(line) {
        console.info(`release: ${line}`)
      },
    })
  })

  if (isFailure(outcome)) {
    console.error(`release: ${formatFailure(outcome, { chain: true })}`)

    return yield* exit(1)
  }
})
