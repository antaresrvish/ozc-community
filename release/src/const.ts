import { ENV_ENTERPRISE_TOKENS, ENV_TOKENS } from 'sdk:loader'

import { createTags } from 'std:shared'

/** Everything the release tool pins as a constant, in one place. */
import { resolve } from 'node:path'

// --- places -------------------------------------------------------------------------------------

/** The repository this tool is checked out in: every path it names is one under it. */
export const REPO_DIR = resolve(import.meta.dir, '..', '..')

/**
 * Where every plugin of this repository is released: the repository itself, `owner/repo`. It is
 * the second source ozc asks — after `ozaco/apps`, where ozc and its own plugins are — when
 * nothing configures another.
 */
export const REPO = 'ozaco/ozc-community'

/** Where the plugins are, under the repository: a directory whose `package.json` carries `ozc` is one. */
export const PLUGINS_DIR = 'plugins'

/** What a plugin's build leaves, under its project. */
export const PLUGIN_FILE = 'dist/plugin.js'

/**
 * Where a run leaves what it made, as segments under the repository: `.ozaco/release/<tag>/`.
 * `.ozaco` is ignored by git, so nothing of a release can be committed by accident.
 */
export const OUTPUT_DIR = ['.ozaco', 'release'] as const

/** In there: the files a release is made of — exactly what is uploaded, and nothing else. */
export const ASSETS_DIR_NAME = 'assets'

// --- programs (each behind a variable where a test must never run the real one) -----------------

/**
 * `gh`, the only way this tool talks to GitHub: found on the `PATH`, unless the variable names
 * another program — which is how a test runs a recording stand-in instead.
 */
export const ENV_GH = 'OZACO_RELEASE_GH'
export const GH_BIN = 'gh'

/** `moon`, through which everything is built. The same seam, for the same reason. */
export const ENV_MOON = 'OZACO_RELEASE_MOON'
export const MOON_BIN = 'moon'

/**
 * What tells Moon it runs on a CI machine, where it refuses every task that is kept out of
 * `moon ci`: taken out of the environment of the Moon this tool starts (see `internal/moon.ts`).
 */
export const ENV_CI = 'CI'

/**
 * `git`, which is asked two things of the tree a release is published from: whether it is a commit
 * and nothing else, and which one. Found on the `PATH`, as a checkout's own tools are.
 */
export const GIT_BIN = 'git'

/** How many digits of a commit's name a release's page carries. */
export const COMMIT_DIGITS = 12

/** What `gh` is started with besides the caller's environment: it never asks, and never advertises. */
export const GH_ENV = { GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' } as const

/**
 * What `gh` is asked to print of each release the repository lists: its tag, and the two things
 * that make it less than a release — a draft nobody sees, a pre-release no channel offers.
 */
export const GH_RELEASES_FILTER = '.[] | [.tag_name, .draft, .prerelease] | @tsv'

/**
 * Every name a GitHub token is read from — by `gh`, and by ozc. What is published with is in one
 * of them, and is `gh`'s alone: no other program this tool starts finds any of them in its
 * environment. A build runs code of every package it installs; none of it gets to publish.
 */
export const ENV_GITHUB_TOKENS = [...ENV_TOKENS, ...ENV_ENTERPRISE_TOKENS] as const

// --- command line -------------------------------------------------------------------------------

/**
 * The flags. Without `--publish` a run is a dry one: everything is built and packed, and nothing
 * is written to GitHub.
 */
export const FLAGS = {
  publish: '--publish',
  plugin: '--plugin',
} as const

// --- failures -----------------------------------------------------------------------------------

/**
 * The tool's failure tags.
 *
 *   - `input`     — the command line does not say what to do
 *   - `version`   — a plugin's version is no version to release: not semver, a pre-release, or
 *                   lower than what is released already; or its package says no version at all
 *   - `token`     — publishing was asked for, and the environment holds no token to do it with
 *   - `tree`      — publishing was asked for, and the tree is not a commit and nothing else
 *   - `github`    — the repository could not be asked what is released, or refused a write
 *   - `task`      — a build failed
 *   - `artifact`  — what a build left is not the plugin the project says it is
 *   - `plugins`   — more than one plugin failed: each failure is a cause
 */
export const ReleaseErrors = createTags(
  'release',
  'input',
  'version',
  'token',
  'tree',
  'github',
  'task',
  'artifact',
  'plugins',
)
