# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repository is

The community plugins of ozc — `ozaco/ozc-community`. Every directory under `plugins/` whose
`package.json` carries an `ozc` field is one plugin, called what `ozc.name` calls it, built into
ONE file (`dist/plugin.js`) by `@ozaco/ozc-devkit`'s `pack()` and released by itself, in THIS
repository, as the GitHub release `<name>-v<version>` (assets `<name>-<version>.plugin.js` and
`ozc.json`). `ozc install <name>` asks `ozaco/apps` first — ozc's own release, and ozaOS's — and
this repository second (`DEFAULT_SOURCES` in the sdk's `packages/sdk/src/loader/const.ts` of
`ozaco/internal`), unless `~/.ozaco/sources.json` or `OZC_SOURCE` says otherwise.

What is NOT here: ozc itself, its sdk and devkit, its own seven plugins (app, cert, config,
ingress-nginx, kube, secret, storage) and ozaOS — those live in `ozaco/internal` and are released
to `ozaco/apps`. This repository consumes the PUBLISHED `@ozaco/*` packages from npm (the
`ozaco` catalog of `package.json`), never a sibling checkout.

## Commands

**All workflows must go through Moon** — never invoke Bun/OXC directly except for debugging.

```bash
bun install                           # Install dependencies (Bun pinned via Moon / .prototools)
moon run :check -f                    # Full lint + format check (oxlint + oxfmt); without -f a stale cached pass
moon run :apply -f                    # Auto-fix formatting and lint (incl. the blank-line rule)
moon run :apply-unsafe                # Auto-fix with dangerous rewrites (oxlint --fix-dangerous)
moon run :clean                       # Reset build artifacts (dist, .ozaco)
moon run <plugin>:build               # plugins/<plugin>/dist/plugin.js (tsdown + pack())
moon run <plugin>:types               # tsc --noEmit of that plugin
moon run <plugin>:test                # its suite, when it has one
moon run community:types community:test   # the release tool's tsc and suite (stand-ins for gh and moon)
moon run community:release            # dry run: every plugin whose version is not out is built and packed; nothing is written to GitHub
moon run community:release -- --publish        # publish; needs GH_TOKEN and a clean tree — the pipeline's job, not a habit
moon run community:release -- --plugin <name>  # only that plugin
```

Pre-commit hook runs `moon run :check`.

## A plugin

`plugins/<name>/` — `package.json` (`"ozc": { "name": "<name>", "commands": ["<name>"] }`, the
`version` the release carries, devDependencies by catalog: `@ozaco/cli`, `@ozaco/devkit`,
`@ozaco/ozc-devkit`, `@ozaco/ozc-sdk`, `@ozaco/std`, `tsdown`, `unrun`, `zod`), `moon.yml`
(`build`: `bun x tsdown --config-loader unrun`, outputs `dist/plugin.js`; `types`; `test`),
`tsdown.config.ts` (`export default pack()`), `tsconfig.json` (extends `../../tsconfig.base.json`,
`types: ["node", "bun", "@ozaco/devkit", "@ozaco/ozc-devkit"]`, no declaration emit) and
`src/index.ts`, which exports what `defineCommand` returns — `export const command = …`, or
`export const commands = [...]` for several.

- Imports go through the devkit aliases — `std:effect`, `cli:command`, `sdk:core`, `sdk:k8s`,
  `db:core`, `server:core` — never `@ozaco/…` (lint: `no-restricted-imports`). The host serves
  its own instances of std, cli, the sdk and zod: `pack()` leaves them external and records the
  version each was built against in the banner; the host refuses a plugin built against a NEWER
  version than it carries (`^built` has to take the host's). So the catalog pins what the
  RELEASED ozc carries — `zod` exactly — and a plugin is built against those, not against
  whatever npm has newest.
- Errors are `Result`s with the module's tag bundle (`createTags`), never a bare throw or a
  `new Error`; telemetry through `Trace.actions.*`; the std conventions of `ozaco/ozaco`'s
  CLAUDE.md hold here.
- Layout as everywhere in the ozaco repositories: `src/index.ts`, `src/commands/`,
  `src/internal/<group>/`, `src/const.ts`, `src/types.ts`; tests in `tests/`.
- Tests and smokes isolate themselves (`OZC_DIR` in a temp dir, own ports). Never point one at
  `~/.ozaco`.

## Release

`release/` (root Moon project `community`) releases each plugin at its own version as one GitHub
release in this repository — the tag is `<name>-v<version>`, the assets `<name>-<version>.plugin.js`
and `ozc.json` (the manifest `ozc install` reads; schema in the sdk's `core/release.ts`).

- What is released is decided by VERSION, not by the tag that triggered the run: a version that is
  out → nothing to do; a pre-release or a version below the newest released → refused; otherwise
  built through Moon (`<plugin>:build`), the built file held to its banner (name, version, the
  body's sha256), packed into `.ozaco/release/<tag>/assets/`, published in publish mode.
- `.github/workflows/release.yml`, on every tag and on dispatch: one Linux job runs
  `bun release/src/main.ts --publish` with the run's own `GITHUB_TOKEN` (`contents: write` — the
  releases are this repository's). To cut a release: bump the plugin's version, commit, push any tag.
- A plugin runs wherever ozc does (`platform: any`): one build, one machine, no gathering.
- Tests never run a real `gh` or `moon`: seams `OZACO_RELEASE_GH`, `OZACO_RELEASE_MOON`
  (`release/tests/gh.ts`, the stand-in `moon` the suite writes).

## Code Style

OXC is canonical (oxlint + oxfmt): 2 spaces, width 100, single quotes, trailing commas `all`, no
semicolons. Import order: `sdk:*` → `std:*`/`cli:*`/… → node builtins → external → relatives.
Blank lines between statements are enforced (`@stylistic/padding-line-between-statements` on
`plugins/*/src`, `release/`): a blank line before a `return`/`throw`, around a block, after a run of
declarations — `moon run :apply -f` fixes. `const` arrows for exports; generator actions are
`function*` declarations; `import type` for type-only imports; tsconfig strictness is not relaxed.
