/**
 * The asset of a release — the plugin as its build left it, under the name a release carries it
 * by — and the manifest beside it, `ozc.json`: what `ozc install` reads. Its shape is the sdk's,
 * the one contract between this tool and ozc, and what is written here is held to the sdk's own
 * check before it goes anywhere: a manifest ozc would refuse is refused where it is made.
 */
import type { ReleaseArtifact, ReleaseManifest } from 'sdk:core'
import {
  parseManifest,
  PLATFORM_ANY,
  RELEASE_MANIFEST_FILE,
  RELEASE_MANIFEST_SCHEMA,
  releaseManifestSchema,
} from 'sdk:core'

import type { Operation } from 'std:effect'
import { IO } from 'std:io'
import { fail } from 'std:result'

import { ASSETS_DIR_NAME, OUTPUT_DIR, PLUGIN_FILE, PLUGINS_DIR, ReleaseErrors } from '../const'
import type { Release } from '../types'

const encoder = new TextEncoder()

/** A file of the assets directory, measured: its size, and its sha256. */
function* assetOf(dir: string, file: string): Operation<Release.Asset> {
  const path = yield* IO.actions.join(dir, file)
  const bytes = yield* IO.actions.read(path)

  return {
    file,
    path,
    size: bytes.length,
    sha256: yield* IO.actions.hash('SHA-256', bytes, { encoding: 'hex' }),
  }
}

/**
 * The plugin a build left, held to what it says of itself before it goes anywhere: it begins with
 * the banner ozc reads, the banner names the plugin and the version the project carries, and the
 * sha256 in it is the body's — the integrity ozc checks before it loads a plugin, checked where
 * the file is made. Answers the file's path.
 */
function* builtPlugin(root: string, plugin: Release.Plugin): Operation<string> {
  const project = `${PLUGINS_DIR}/${plugin.dir}`
  const file = yield* IO.actions.join(root, project, PLUGIN_FILE)

  if (!(yield* IO.actions.exists(file))) {
    return yield* fail(
      ReleaseErrors.Artifact,
      `${plugin.name}: its build left no ${project}/${PLUGIN_FILE}`,
    )
  }

  const text = yield* IO.actions.readText(file)
  const newline = text.indexOf('\n')
  const manifest = newline === -1 ? undefined : yield* parseManifest(text.slice(0, newline))

  if (manifest === undefined) {
    return yield* fail(
      ReleaseErrors.Artifact,
      `${project}/${PLUGIN_FILE} does not begin with an ozc manifest banner: it was not packed by pack()`,
    )
  }

  if (manifest.name !== plugin.name || manifest.version !== plugin.version) {
    return yield* fail(
      ReleaseErrors.Artifact,
      `${project}/${PLUGIN_FILE} says it is ${manifest.name}@${manifest.version}, and the project is ${plugin.name}@${plugin.version}: build it again`,
    )
  }

  const digest = yield* IO.actions.hash('SHA-256', encoder.encode(text.slice(newline + 1)), {
    encoding: 'hex',
  })

  if (digest !== manifest.sha256) {
    return yield* fail(
      ReleaseErrors.Artifact,
      `${project}/${PLUGIN_FILE}: the sha256 its banner carries is not its body's — ozc would refuse it`,
    )
  }

  return file
}

/** A plugin's file in a release: `<name>-<version>.plugin.js` — it runs wherever ozc does. */
export const assetFile = ({ name, version }: Release.Plugin): string =>
  `${name}-${version}.plugin.js`

/** Where a run of one tag leaves everything: `<root>/.ozaco/release/<tag>`. */
export function* outputDir(root: string, tag: string): Operation<string> {
  return yield* IO.actions.join(root, ...OUTPUT_DIR, tag)
}

/** The assets of a tag: exactly the files its release carries. */
export function* assetsDir(root: string, tag: string): Operation<string> {
  return yield* IO.actions.join(yield* outputDir(root, tag), ASSETS_DIR_NAME)
}

/**
 * Everything a release is made of, in a directory of the tag's own: the plugin under the name the
 * release carries it by, and `ozc.json` listing it. Whatever an earlier run of this tag left is
 * gone first: an asset of then is not an asset of now.
 */
export function* assemble(
  root: string,
  plugin: Release.Plugin,
  tag: string,
): Operation<Release.Assembled> {
  const built = yield* builtPlugin(root, plugin)
  const out = yield* outputDir(root, tag)
  const dir = yield* assetsDir(root, tag)
  const file = assetFile(plugin)

  yield* IO.actions.rm(out, { recursive: true, force: true })
  yield* IO.actions.ensureDir(dir)
  yield* IO.actions.copy(built, yield* IO.actions.join(dir, file))

  const asset = yield* assetOf(dir, file)
  const artifact: ReleaseArtifact = {
    kind: 'plugin',
    name: plugin.name,
    platform: PLATFORM_ANY,
    file,
    sha256: asset.sha256,
    size: asset.size,
  }
  const manifest: ReleaseManifest = {
    schema: RELEASE_MANIFEST_SCHEMA,
    name: plugin.name,
    version: plugin.version,
    artifacts: [artifact],
  }
  const checked = releaseManifestSchema.safeParse(manifest)

  if (!checked.success) {
    const [issue] = checked.error.issues

    return yield* fail(
      ReleaseErrors.Artifact,
      `${RELEASE_MANIFEST_FILE} would not be read by ozc: ${issue === undefined ? 'invalid' : `${issue.path.join('.')} ${issue.message}`}`,
    )
  }

  yield* IO.actions.write(
    yield* IO.actions.join(dir, RELEASE_MANIFEST_FILE),
    `${JSON.stringify(manifest, null, 2)}\n`,
  )

  return { dir, assets: [asset, yield* assetOf(dir, RELEASE_MANIFEST_FILE)] }
}
