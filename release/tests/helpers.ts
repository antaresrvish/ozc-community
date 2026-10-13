// oxlint-disable import/exports-last
/**
 * What the release suite shares: a workspace of a test's own — a repository at one commit, with a
 * plugin called `kit` and what its build would have left — and stand-ins for the two programs the
 * tool must never run for real in a test: `moon`, which only notes what it was asked to run, and
 * `gh`, which plays the repository (`gh.ts`). The tool itself runs as it is, with an environment
 * of the test's making.
 *
 * Nothing here builds anything, and nothing reaches GitHub.
 */
import { MANIFEST_PREFIX, releaseTag } from 'sdk:core'

import type { Operation } from 'std:effect'
import { run } from 'std:effect'
import { IO } from 'std:io'
import type { Result } from 'std:result'

import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { JsonCodec } from 'std:codec/impl/json'
import { BunIO } from 'std:io/impl/bun'

import {
  ASSETS_DIR_NAME,
  COMMIT_DIGITS,
  ENV_GH,
  ENV_MOON,
  OUTPUT_DIR,
  PLUGIN_FILE,
  PLUGINS_DIR,
} from '../src/const'
import { release } from '../src/internal/release'
import type { Release } from '../src/types'

/** What `gh.ts` holds and was asked: see there. */
export interface GhState {
  releases: string[]
  prereleases: string[]
  drafts: string[]
  created: { repo: string; tag: string; title: string; notes: string; files: string[] }[]
  calls: { args: string[] }[]
  refuse: string[]
}

/** One `moon run`, as the stand-in noted it. */
export interface MoonCall {
  readonly targets: readonly string[]
  /** Whether its environment said it runs on a CI machine. */
  readonly ci: boolean
  /** Whether its environment held a GitHub token, under any of the names one is read from. */
  readonly token: boolean
}

export interface Workspace {
  /** The repository the plugins are under. */
  readonly root: string
  /** The environment the tool sees, and nothing of the real one: a test adds what it wants. */
  readonly env: Record<string, string | undefined>
  /** Every line the tool said. */
  readonly said: string[]
  path(...segments: string[]): string
  /** Where a run of a plugin — the kit, unless another is named — leaves its assets. */
  assets(plugin?: Release.Plugin): string
  /** Run tool code in here, for how it ended. */
  run<T>(operation: () => Operation<T>): Promise<Result<T>>
  /** Run the release of the plugins — the workspace's, unless some are named. */
  release(
    options?: { readonly publish?: boolean },
    plugins?: readonly Release.Plugin[],
  ): Promise<Result<Release.Outcome[]>>
  /** Commit whatever a test changed in the workspace: a release is published from a commit. */
  commit(): void
  /** The commit the workspace is at, as a release's page names it. */
  head(): string
  /** The repository, as it is now. */
  gh(): GhState
  /** Change what the repository holds, or what it turns down. */
  setGh(change: Partial<GhState>): void
  /** Every `moon run` so far, in order. */
  moon(): MoonCall[]
  /** Make every `moon run` that names this target fail. */
  failMoon(target: string): void
  dispose(): void
}

/** The version the kit carries, unless a test says otherwise. */
export const VERSION = '1.2.3'

/** The fixture's plugin: one directory under `plugins/`, one name, one version. */
export const KIT: Release.Plugin = { dir: 'kit', name: 'kit', version: VERSION }

/** Another: a plugin whose directory is not its name. */
export const TOOL: Release.Plugin = { dir: 'tool-plugin', name: 'tool', version: '0.1.0' }

const GH_ENTRY = join(import.meta.dir, 'gh.ts')

export const sha256 = (value: string | Uint8Array): string =>
  createHash('sha256').update(value).digest('hex')

/** A fresh directory, by its real path: on macOS the temp directory is behind a symlink. */
export const tempDir = (): string =>
  realpathSync(mkdtempSync(join(tmpdir(), 'ozc-community-release-test-')))

const put = (path: string, content: string, mode = 0o644): void => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  chmodSync(path, mode)
}

/** Write an executable shell script. */
export const script = (path: string, body: string): string => {
  put(path, `#!/bin/sh\n${body}\n`, 0o755)

  return path
}

/** A packed ozc plugin: its banner, and a body the banner's hash is of. */
export const pluginOf = (name: string, version: string): string => {
  const body = `module.exports = { name: ${JSON.stringify(name)} }\n`

  return `${MANIFEST_PREFIX}${JSON.stringify({ name, version, commands: [name], sdk: '^0.1.1', sha256: sha256(body) })}\n${body}`
}

/** What a plugin's build leaves, as a path under a workspace. */
export const builtFile = (plugin: Release.Plugin): string =>
  join(PLUGINS_DIR, plugin.dir, PLUGIN_FILE)

/**
 * A plugin's project in a workspace: its package, and what its build would have left — the
 * plugin itself, unless `built` says another text, or `false` for a build that left nothing.
 */
export const project = (
  root: string,
  plugin: Release.Plugin,
  options: { readonly built?: string | false } = {},
): void => {
  put(
    join(root, PLUGINS_DIR, plugin.dir, 'package.json'),
    `${JSON.stringify(
      {
        name: `@ozaco/ozc-plugin-${plugin.name}`,
        version: plugin.version,
        private: true,
        ozc: { name: plugin.name, commands: [plugin.name] },
      },
      null,
      2,
    )}\n`,
  )

  if (options.built === false) {
    rmSync(join(root, builtFile(plugin)), { force: true })
  } else {
    put(join(root, builtFile(plugin)), options.built ?? pluginOf(plugin.name, plugin.version))
  }
}

/** What a build leaves that is not source, and what the stand-ins keep: git looks past both. */
const IGNORED = ['.ozaco', '.programs', 'dist']

/**
 * What `git` is told before anything else: no upkeep of the repository by itself. A commit
 * otherwise leaves a process behind that goes on working in `.git` after `git` has returned —
 * while the test is already changing what is there.
 */
const GIT_QUIET = ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0'] as const

/**
 * `git` in a workspace, with nothing of the developer's own configuration — no hooks, no signing —
 * and an author that is the fixture's.
 */
const git = (root: string, args: readonly string[]): string => {
  const ran = Bun.spawnSync(['git', ...GIT_QUIET, ...args], {
    cwd: root,
    env: {
      PATH: process.env['PATH'] ?? '',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_AUTHOR_NAME: 'fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.com',
      GIT_COMMITTER_NAME: 'fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.com',
    },
  })

  if (ran.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')}\n${ran.stderr.toString()}`)
  }

  return ran.stdout.toString()
}

/**
 * A workspace for one test: the plugins' projects — the kit alone, unless others are named —
 * built, nothing released, and a `moon` and a `gh` that are the stand-ins.
 */
export const workspace = (plugins: readonly Release.Plugin[] = [KIT]): Workspace => {
  const root = tempDir()
  const programs = join(root, '.programs')
  const ghFile = join(programs, 'gh.json')
  const moonRecord = join(programs, 'moon.calls')
  const moonFails = join(programs, 'moon.fails')
  const said: string[] = []

  const ghEmpty: GhState = {
    releases: [],
    prereleases: [],
    drafts: [],
    created: [],
    calls: [],
    refuse: [],
  }

  for (const plugin of plugins) {
    project(root, plugin)
  }

  put(ghFile, JSON.stringify(ghEmpty))
  put(join(root, '.gitignore'), `${IGNORED.join('\n')}\n`)
  git(root, ['init', '--quiet', '--initial-branch', 'main'])
  git(root, ['add', '--all'])
  git(root, ['commit', '--quiet', '--message', 'fixture'])

  const box: Workspace = {
    root,
    env: {
      [ENV_GH]: script(
        join(programs, 'gh'),
        `STANDIN_GH='${ghFile}' exec '${process.execPath}' '${GH_ENTRY}' "$@"`,
      ),
      // one line a call: what it was asked to run, what its environment says of CI, whether it
      // holds a token. A target named in `moon.fails` fails the run
      [ENV_MOON]: script(
        join(programs, 'moon'),
        [
          `echo "$* | CI=\${CI:-} | TOKEN=\${GH_TOKEN:+set}\${GITHUB_TOKEN:+set}\${GH_ENTERPRISE_TOKEN:+set}\${GITHUB_ENTERPRISE_TOKEN:+set}" >> '${moonRecord}'`,
          `[ -f '${moonFails}' ] || exit 0`,
          `case " $* " in *" $(cat '${moonFails}') "*) exit 1 ;; esac`,
        ].join('\n'),
      ),
    },
    said,
    path: (...segments) => join(root, ...segments),
    assets: (plugin = KIT) =>
      join(root, ...OUTPUT_DIR, releaseTag(plugin.name, plugin.version), ASSETS_DIR_NAME),
    run: async operation =>
      await run(function* () {
        yield* BunIO.use()
        yield* JsonCodec.use()
        yield* IO.around({
          *env([mapper]) {
            return mapper(box.env) as never
          },
        })

        return yield* operation()
      }),
    release: (options = {}, which = plugins) =>
      box.run(() =>
        release(which, {
          root,
          publish: options.publish ?? false,
          *report(line) {
            said.push(line)
          },
        }),
      ),
    commit: () => {
      git(root, ['add', '--all'])
      git(root, ['commit', '--quiet', '--allow-empty', '--message', 'change'])
    },
    head: () => git(root, ['rev-parse', `--short=${COMMIT_DIGITS}`, 'HEAD']).trim(),
    gh: () => JSON.parse(readFileSync(ghFile, 'utf8')) as GhState,
    setGh: change => put(ghFile, JSON.stringify({ ...box.gh(), ...change })),
    moon: () =>
      existsSync(moonRecord)
        ? readFileSync(moonRecord, 'utf8')
            .split('\n')
            .filter(line => line !== '')
            .map(line => {
              const [ran = '', ci = '', token = ''] = line.split(' | ')

              return {
                targets: ran.split(' ').slice(1),
                ci: ci !== 'CI=',
                token: token !== 'TOKEN=',
              }
            })
        : [],
    failMoon: target => put(moonFails, target),
    dispose: () => rmSync(root, { recursive: true, force: true }),
  }

  return box
}
