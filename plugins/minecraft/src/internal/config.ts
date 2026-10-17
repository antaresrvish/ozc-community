import { CONFIG_FILES, DATA_PATH } from '../const'
import type { MinecraftDef } from '../types'

/** The `server.properties` keys the spec's own fields stand for. */
const FIELD_PROPERTIES = {
  motd: 'motd',
  difficulty: 'difficulty',
  maxPlayers: 'max-players',
  onlineMode: 'online-mode',
} as const

/** Whether a value is a table of more, and not a leaf. */
const isTree = (value: MinecraftDef.ConfigValue): value is MinecraftDef.ConfigTree =>
  typeof value === 'object' && !Array.isArray(value)

/** A JsonPath segment: bracket notation throughout, so a key with a dash or a dot is one key. */
const segment = (key: string): string =>
  `['${key.replaceAll('\\', String.raw`\\`).replaceAll("'", String.raw`\'`)}']`

/**
 * The operations that put a tree into a file: one `$put` per leaf, under the path of the table it
 * is in. Tables the file does not have yet are not made: a put into a missing one fails at start,
 * which is the image's way of saying the key is not the file's.
 */
const opsOf = (tree: MinecraftDef.ConfigTree, path = '$'): PatchOp[] =>
  Object.entries(tree).flatMap(([key, value]) =>
    isTree(value) ? opsOf(value, `${path}${segment(key)}`) : [{ $put: { path, key, value } }],
  )

/**
 * The files the spec configures, each with its path under `/data`: the named tables first, in
 * their order, then `files` — a file named twice gets one patch of all its tables.
 */
const filesOf = (spec: MinecraftDef.ServerSpec): [string, MinecraftDef.ConfigTree][] => {
  const named: [string, MinecraftDef.ConfigTree | undefined][] = [
    [CONFIG_FILES.paper, spec.paper],
    [CONFIG_FILES.paperWorld, spec.paperWorld],
    [CONFIG_FILES.bukkit, spec.bukkit],
    [CONFIG_FILES.spigot, spec.spigot],
  ]
  const merged = new Map<string, MinecraftDef.ConfigTree>()

  for (const [file, tree] of [...named, ...Object.entries(spec.files ?? {})]) {
    if (tree !== undefined) {
      merged.set(file, { ...merged.get(file), ...tree })
    }
  }

  return [...merged]
}

/** One operation of a patch: a key put into the object at `path` — new or not — with `value`. */
export interface PatchOp {
  readonly $put: {
    readonly path: string
    readonly key: string
    readonly value: MinecraftDef.ConfigValue
  }
}

/** One file's patch, as `mc-image-helper patch` reads it. */
export interface Patch {
  readonly file: string
  readonly ops: readonly PatchOp[]
}

/** The patch set: every file the spec configures, in one document. */
export interface PatchSet {
  readonly patches: readonly Patch[]
}

/**
 * The `server.properties` entries the spec sets, as the image takes them (`CUSTOM_SERVER_PROPERTIES`:
 * one `key=value` a line); `undefined` when it sets none.
 */
export const propertiesOf = (spec: MinecraftDef.ServerSpec): string | undefined => {
  const entries = Object.entries(spec.properties ?? {})

  return entries.length === 0
    ? undefined
    : entries.map(([key, value]) => `${key}=${String(value)}`).join('\n')
}

/**
 * Whether a field of the spec is overruled by the `properties` table naming the same key: the
 * table is the file as the user wrote it, so the field's variable is left out.
 */
export const overruled = (
  spec: MinecraftDef.ServerSpec,
  field: keyof typeof FIELD_PROPERTIES,
): boolean => Object.hasOwn(spec.properties ?? {}, FIELD_PROPERTIES[field])

/** The patch set of a spec: every configured file with its operations; `undefined` for none. */
export const patchSetOf = (spec: MinecraftDef.ServerSpec): PatchSet | undefined => {
  const patches = filesOf(spec).flatMap(([file, tree]) => {
    const ops = opsOf(tree)

    return ops.length === 0 ? [] : [{ file: `${DATA_PATH}/${file}`, ops }]
  })

  return patches.length === 0 ? undefined : { patches }
}

/** The patch set as the file in the pod holds it. */
export const patchSetText = (set: PatchSet): string => `${JSON.stringify(set, null, 2)}\n`
