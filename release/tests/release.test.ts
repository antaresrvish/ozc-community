/**
 * A release, start to end, in a workspace of the test's own: what is decided by the version, what
 * a dry run leaves and what it does not write, what publishing writes — and where a run stops
 * when something is not as it has to be.
 *
 * Moon is a stand-in that notes what it was asked to run; `gh` is one that plays the repository.
 * What IS real is everything between them: the copy, the manifest, the checks on the built file.
 */
import { parseReleaseManifest, releaseTag } from 'sdk:core'

import type { Result } from 'std:result'
import { isFailure, unwrap } from 'std:result'

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

import { FLAGS, REPO, ReleaseErrors } from '../src/const'
import { askedBy } from '../src/internal/input'
import { pluginsOf } from '../src/plugins'
import type { Release } from '../src/types'

import type { Workspace } from './helpers'
import { builtFile, KIT, pluginOf, project, sha256, TOOL, VERSION, workspace } from './helpers'

const TAG = releaseTag(KIT.name, VERSION)
const TOKEN = 'ghp_a-token-that-is-never-printed'

let box: Workspace

beforeEach(() => {
  box = workspace()
})

afterEach(() => {
  box.dispose()
})

/** What a failed run says: its tag and its message. */
const failed = (outcome: Result<unknown>): { error: unknown; message: string } => {
  if (!isFailure(outcome)) {
    throw new Error('the run did not fail')
  }

  return { error: outcome.error, message: outcome.message }
}

describe('a run', () => {
  it('does nothing for a version that is out, whatever the tag that started it', async () => {
    box.setGh({ releases: [`${REPO} ${TAG}`] })

    expect(unwrap(await box.release())).toEqual([
      { status: 'released', plugin: 'kit', version: VERSION, tag: TAG },
    ])
    expect(box.moon()).toEqual([])
    expect(box.gh().created).toEqual([])
    expect(box.said).toEqual([`kit ${VERSION} is released already (${TAG}) — nothing to do`])
  })

  it('builds through Moon, packs the plugin with its manifest, and stops short of publishing', async () => {
    const [outcome] = unwrap(await box.release())
    const dir = box.assets()
    const plugin = readFileSync(box.path(builtFile(KIT)), 'utf8')

    // the build, started without a token and off a machine that says CI
    expect(box.moon()).toEqual([{ targets: ['kit:build'], ci: false, token: false }])

    // the assets: the plugin under the name the release carries it by, and `ozc.json`
    expect(readdirSync(dir).toSorted()).toEqual([`kit-${VERSION}.plugin.js`, 'ozc.json'])
    expect(readFileSync(join(dir, `kit-${VERSION}.plugin.js`), 'utf8')).toBe(plugin)

    const manifest = unwrap(
      await box.run(() => parseReleaseManifest(readFileSync(join(dir, 'ozc.json'), 'utf8'))),
    )

    expect(manifest).toEqual({
      schema: 1,
      name: 'kit',
      version: VERSION,
      artifacts: [
        {
          kind: 'plugin',
          name: 'kit',
          platform: 'any',
          file: `kit-${VERSION}.plugin.js`,
          sha256: sha256(plugin),
          size: Buffer.byteLength(plugin),
        },
      ],
    })

    // the outcome names them, and nothing was written
    expect(outcome?.status).toBe('assembled')
    expect(outcome?.status === 'assembled' && outcome.assets.map(asset => asset.file)).toEqual([
      `kit-${VERSION}.plugin.js`,
      'ozc.json',
    ])
    expect(box.gh().created).toEqual([])
    expect(box.said.at(-1)).toBe(
      `  a dry run: ${TAG} ("kit ${VERSION}") on ${REPO}, with the 2 assets above, is not published — ${FLAGS.publish} does`,
    )
  })

  it('publishes the release with its two assets, titled and noted, from the commit it was built at', async () => {
    box.env['GH_TOKEN'] = TOKEN

    const [outcome] = unwrap(await box.release({ publish: true }))
    const [created] = box.gh().created

    expect(outcome?.status).toBe('published')
    expect(created?.repo).toBe(REPO)
    expect(created?.tag).toBe(TAG)
    expect(created?.title).toBe(`kit ${VERSION}`)
    expect(created?.files.map(file => basename(file))).toEqual([
      `kit-${VERSION}.plugin.js`,
      'ozc.json',
    ])
    expect(created?.notes).toBe(
      [
        `kit ${VERSION}, a community plugin for ozc.`,
        '',
        'ozc installs it, and the same line brings its newest:',
        '',
        '    ozc install kit',
        '',
        `Built from commit ${box.head()}.`,
        '',
      ].join('\n'),
    )
    // what is published is what was packed: the copy gh kept is the file in the assets directory
    expect(readFileSync(created?.files[0] ?? '', 'utf8')).toBe(
      readFileSync(join(box.assets(), `kit-${VERSION}.plugin.js`), 'utf8'),
    )
    expect(box.said.at(-1)).toBe(`  published ${TAG} ("kit ${VERSION}") on ${REPO}`)
  })

  it('refuses to publish without a token, or from a tree that is not a commit — before anything is built', async () => {
    expect(failed(await box.release({ publish: true }))).toEqual({
      error: ReleaseErrors.Token,
      message: expect.stringContaining('GH_TOKEN or GITHUB_TOKEN'),
    })

    box.env['GH_TOKEN'] = TOKEN
    writeFileSync(box.path('plugins', 'kit', 'notes.txt'), 'work in progress\n')

    expect(failed(await box.release({ publish: true }))).toEqual({
      error: ReleaseErrors.Tree,
      message: expect.stringContaining('plugins/kit/notes.txt'),
    })
    expect(box.moon()).toEqual([])
    expect(box.gh().created).toEqual([])

    // committed, it is a commit again
    box.commit()
    expect(unwrap(await box.release({ publish: true }))[0]?.status).toBe('published')
  })

  it('refuses a version below the newest that is out, and a pre-release; a draft or a pre-release that is out counts for nothing', async () => {
    box.setGh({ releases: [`${REPO} kit-v2.0.0`] })
    expect(failed(await box.release())).toEqual({
      error: ReleaseErrors.Version,
      message: `kit is at ${VERSION}, and 2.0.0 is released already: a release is published forward`,
    })

    const early: Release.Plugin = { ...KIT, version: '1.3.0-rc.1' }

    project(box.root, early)
    box.setGh({ releases: [] })
    expect(failed(await box.release({}, [early]))).toEqual({
      error: ReleaseErrors.Version,
      message: expect.stringContaining('a pre-release'),
    })

    project(box.root, KIT)
    box.setGh({
      releases: [`${REPO} kit-v9.0.0`],
      prereleases: [`${REPO} kit-v9.0.0`],
      drafts: [`${REPO} kit-v8.0.0`],
    })
    expect(unwrap(await box.release())[0]?.status).toBe('assembled')
    expect(box.moon()).toEqual([{ targets: ['kit:build'], ci: false, token: false }])
  })

  it('refuses a build that failed, left nothing, or left a file that is not the plugin the project says it is', async () => {
    box.failMoon('kit:build')
    expect(failed(await box.release()).error).toBe(ReleaseErrors.Task)
    expect(existsSync(box.assets())).toBe(false)

    const cases: [string | false, string][] = [
      [false, `kit: its build left no ${builtFile(KIT)}`],
      ['module.exports = {}\n', 'does not begin with an ozc manifest banner'],
      [pluginOf('kit', '9.9.9'), 'says it is kit@9.9.9, and the project is kit@1.2.3'],
      [
        `${pluginOf('kit', VERSION)}// tampered\n`,
        "the sha256 its banner carries is not its body's",
      ],
    ]

    box.failMoon('')

    for (const [built, said] of cases) {
      project(box.root, KIT, { built })

      // oxlint-disable-next-line no-await-in-loop -- one case after another, on the same workspace
      const outcome = failed(await box.release())

      expect(outcome.error, said).toBe(ReleaseErrors.Artifact)
      expect(outcome.message, said).toContain(said)
    }

    expect(box.gh().created).toEqual([])
  })

  it('goes on past a plugin that fails, and fails at its end with every failure', async () => {
    const both = workspace([KIT, TOOL])

    try {
      both.failMoon('tool-plugin:build')

      const one = await both.release()

      // the kit went through; the one failure is the run's
      expect(failed(one).error).toBe(ReleaseErrors.Task)
      expect(existsSync(both.assets())).toBe(true)
      expect(both.said).toContain(`kit ${VERSION} is due: ${TAG}`)
      expect(both.said.some(line => line.startsWith('tool 0.1.0 failed: '))).toBe(true)

      project(both.root, KIT, { built: false })

      const two = failed(await both.release())

      expect(two.error).toBe(ReleaseErrors.Plugins)
      expect(two.message).toBe('2 plugins failed')
    } finally {
      both.dispose()
    }
  })
})

describe('the plugins', () => {
  it('are read off plugins/: a directory whose package carries ozc, by directory name', async () => {
    project(box.root, TOOL)
    writeFileSync(box.path('plugins', 'README.txt'), 'not a plugin\n')
    project(box.root, { dir: 'library', name: 'library', version: '0.0.1' })
    writeFileSync(
      box.path('plugins', 'library', 'package.json'),
      JSON.stringify({ name: 'library', version: '0.0.1' }),
    )

    expect(unwrap(await box.run(() => pluginsOf(box.root)))).toEqual([KIT, TOOL])
  })

  it('are refused by name when the package says no version, or an ozc field without a name', async () => {
    writeFileSync(
      box.path('plugins', 'kit', 'package.json'),
      JSON.stringify({ name: 'kit', ozc: { name: 'kit' } }),
    )
    expect(failed(await box.run(() => pluginsOf(box.root)))).toEqual({
      error: ReleaseErrors.Version,
      message: 'plugins/kit/package.json carries no version',
    })

    writeFileSync(
      box.path('plugins', 'kit', 'package.json'),
      JSON.stringify({ name: 'kit', version: '1.0.0', ozc: {} }),
    )
    expect(failed(await box.run(() => pluginsOf(box.root))).message).toContain('ozc.name')
  })
})

describe('the command line', () => {
  it('names the plugins and the mode, and refuses what it does not know', async () => {
    const plugins = [KIT, TOOL]

    expect(unwrap(await box.run(() => askedBy([], plugins)))).toEqual({ publish: false, plugins })
    expect(
      unwrap(await box.run(() => askedBy([FLAGS.publish, FLAGS.plugin, 'tool'], plugins))),
    ).toEqual({ publish: true, plugins: [TOOL] })

    expect(failed(await box.run(() => askedBy(['--dry'], plugins)))).toEqual({
      error: ReleaseErrors.Input,
      message: expect.stringContaining('"--dry" is not understood'),
    })
    expect(failed(await box.run(() => askedBy([FLAGS.plugin, 'kube'], plugins))).message).toBe(
      'no plugin is called "kube" — there is kit, tool',
    )
    expect(failed(await box.run(() => askedBy([FLAGS.plugin, 'kube'], []))).message).toBe(
      'no plugin is called "kube" — nothing under plugins/ is one',
    )
  })
})
