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
  version than it carries (`^built` has to take the host's), and a plugin's `sdk: ^<built>` range
  has to take the host's sdk. So the catalog pins what the ozc being released carries — `zod`
  exactly — and a plugin is built against those, not against whatever npm has newest. As it
  stands: `@ozaco/ozc-sdk ^0.1.2` (published 2026-10-13), which the host ozc 0.2.3 carries; the
  released 0.2.2 (sdk 0.1.1) refuses a plugin built here until 0.2.3 is out.
- Errors are `Result`s with the module's tag bundle (`createTags`), never a bare throw or a
  `new Error`; telemetry through `Trace.actions.*`; the std conventions of `ozaco/ozaco`'s
  CLAUDE.md hold here.
- Layout as everywhere in the ozaco repositories: `src/index.ts`, `src/commands/`,
  `src/internal/<group>/`, `src/const.ts`, `src/types.ts`; tests in `tests/`.
- Tests and smokes isolate themselves (`OZC_DIR` in a temp dir, own ports). Never point one at
  `~/.ozaco`.

## The plugins

- `plugins/minecraft` — `ozc minecraft up|down|status|logs|console|preview|backup|backups|restore|prune`:
  Minecraft servers on the cluster `[kube].profile` / `-p` names (`sdk:k8s`, `sdk:profile`). Each
  `[minecraft.<name>]` is ONE server — several servers are several tables, each with a port of its
  own on the node (two on one port are refused before the cluster is asked) — rendered to a Service
  (LoadBalancer by default — on k3s ServiceLB puts it on the node's own address; `nodeport`,
  `none`) and a StatefulSet of one (`itzg/minecraft-server`, the world on the claim
  `data-<name>-0`, readiness by the image's `mc-health`, no liveness). `console` runs the image's
  `rcon-cli` inside the pod (`K8s.actions.exec`): no password leaves it. Mods and plugins are the
  spec's lists, the image's own variables as is (`modrinth` → `MODRINTH_PROJECTS`, `mods`,
  `plugins`, `spiget`, `modpack`, `removeOldMods`); resources are `memory` (the Java heap, also the
  pod's memory request as `<heap>i`), `cpu`, `cpuLimit`, `memoryLimit`. A `domain` binds nothing in
  the cluster: `status` prints the A record (and the SRV record `_minecraft._tcp.<domain>` on a port
  other than 25565) the name needs. `backup` is a Longhorn `VolumeSnapshot` of the claim, the world
  held still meanwhile (`save-all flush`, `save-off` … `save-on`); `--s3` / `backup = "s3"` push it
  through the `longhorn-backup` class; `restore` remakes the claim from a snapshot (the server has
  to be down — it holds the claim — then `up`). The WHOLE server configuration is the TOML's:
  `[minecraft.<n>.properties]` is `server.properties` key by key (`CUSTOM_SERVER_PROPERTIES`; a key
  a field also sets — `motd`, `difficulty`, `max-players`, `online-mode` — is the table's), and the
  server's own files are nested tables — `paper` (`config/paper-global.yml`), `paperWorld`
  (`config/paper-world-defaults.yml`), `bukkit`, `spigot`, and `files."<path>"` for any other
  YAML/JSON/TOML/properties file under `/data` — rendered to ONE patch set (`$put` per leaf, JsonPath
  in bracket notation; `internal/config.ts`) in the ConfigMap `<n>-config`, mounted at
  `/patches`, applied by the image's `mc-image-helper patch` at start (`PATCH_DEFINITIONS`); a
  changed set changes the pod-template annotation `ozc.dev/config-hash`, so `up` rolls the pod.
  A table the file does not have is NOT made (the put fails at start). `jvmOpts` → `JVM_OPTS`,
  `aikarFlags` → `USE_AIKAR_FLAGS`. The config is the ozaco TOML, discovered from
  `-C`/cwd up to home — `ozaco.toml`, or a fragment such as `.ozaco/minecraft.toml` beside
  `.ozaco/kube.toml`: the whole shape, with every field, is `plugins/minecraft/examples/minecraft.toml`
  (a test holds it to the schema).

  Not yet: the WebRTC side — the user's words: "ip üzerinden rtc portu açacak" — an agent beside
  the server reached over an RTC port on the node's address. Nothing of it is in the spec.

- `plugins/ignoredpi` — `ozc ignoredpi up|down|status|check|logs|run`: the sites blocked in Turkey
  opened for EVERY app on the machine, with no proxy setting anywhere (SpoofDPI is a proxy: the
  Discord app ignores it). The service is the machine's DNS: names are resolved over DoH by
  address (`https://1.1.1.1/dns-query` — no name for the DPI to read); a blocked name — on the
  lists (Discord's built in, `[ignoredpi].domains`) or one the ISP's resolver answers with its
  block page (the sinkholes: BTK's built in, others learned at start from canary names) — is
  answered with this machine, A only (no AAAA, no HTTPS record). Its forwarder on 443/80 reads the
  name from the TLS hello (HTTP `Host`), connects to the real address and sends the hello as TWO
  TLS records cut inside the name; the TLS is never opened. It also takes Cloudflare's other HTTPS
  ports (`TLS_PORTS`: 2053, 2083, 2087, 2096, 8443), each forwarded to the same port: Discord's
  voice RTC socket is `wss://c-<iata>NN-<hex>.discord.media:2083` — with nothing on 127.0.0.1:2083
  a voice channel never connects (seen in `%APPDATA%\discord\logs\renderer_js.log`). One already
  taken is logged and passed over; a trial with `--https` moved takes none. Measured on Türk Telekom (2026-10-17):
  TCP segmentation (SpoofDPI's way) is reset, the record split passes; for HTTP the header name
  `hoSt` passes where `Host`/`host` do not. macOS lets a user bind 53/80/443 on the wildcard
  only, so the service binds `0.0.0.0` and drops anything not from loopback (`lan = true` admits
  the private network). `up` writes the LaunchAgent `com.ozaco.ignoredpi` (`ozc ignoredpi run`
  from home); `run` takes the ports FIRST, then points every network service on a device at
  127.0.0.1 (`networksetup`), saving each one's DNS to `~/.ozaco/ignoredpi/state.json` before it
  is changed, and gives them back on SIGTERM; `down` (or the next start) gives back what a crashed
  run saved. The ISP resolver is DHCP's (`ipconfig getoption`), never the DNS set by hand. Config
  is read from home (`~/ozaco.toml` or `~/.ozaco/ignoredpi.toml`): the whole shape is
  `plugins/ignoredpi/examples/ignoredpi.toml`. `run --trial --dns n --https n --http n` runs it
  beside everything, the DNS untouched; `check <name>` shows ISP vs DoH, the verdict, and a hello
  sent whole and cut. Seams: `IGNOREDPI_NETWORKSETUP`, `IGNOREDPI_LAUNCHCTL`, `IGNOREDPI_IPCONFIG`,
  `IGNOREDPI_DSCACHEUTIL`, `IGNOREDPI_OZC`. A socket belongs to the scope it is opened in — never
  open one inside a `race` branch (the race's end closes it).

  The commands go through the host of the machine (`internal/system.ts`: `macos.ts`, `linux.ts`,
  `windows.ts`). On Windows the ports are bound on 127.0.0.1 (no firewall question; `lan = true`
  binds the wildcard), and the DNS is ONE NRPT rule — every name (`.`) to 127.0.0.1, comment
  `ozaco ignoredpi` — not each adapter's servers: an adapter's IPv6 DNS (the router's `fe80::1`)
  would go around those, the NRPT is asked first whatever the adapter. Giving it back is removing
  the rule (found by its comment, nothing saved). The ISP resolver is the registry's
  `DhcpNameServer` of the adapter the default route leaves by. `up` registers the scheduled task
  `com.ozaco.ignoredpi` from `~/.ozaco/ignoredpi/task.xml` (UTF-16): `S4U` (no window, no stored
  password), highest level, at boot and logon, no time limit, on battery too; it runs `cmd` looping
  `ozc ignoredpi run >> log`, 10 s apart (a task's own restart counts only a failed start). Windows
  has no SIGTERM: ending the task kills, so `down` gives the DNS back itself. The NRPT and the task
  need an administrator — `up`, `down` and `run` check `whoami /groups` for the High label (SIDs,
  no language) and say to open an elevated terminal; `status` and `check` need none (a pid that
  answers `EPERM` is alive). PowerShell is run with `-EncodedCommand` (UTF-16LE base64: no quoting)
  and prints JSON (its cmdlets answer alike in every language — never parse `netsh`/`schtasks`
  text). Seams: `IGNOREDPI_POWERSHELL`, `IGNOREDPI_SCHTASKS`, `IGNOREDPI_WHOAMI`. The macOS suite's
  stand-ins are shell scripts: it is skipped on Windows. `nslookup` asks the adapter's server
  directly and never shows the NRPT; `Resolve-DnsName` does.

  Run as administrator on Windows 11 on Türk Telekom (2026-10-17): `up` took the DNS
  (`Resolve-DnsName discord.com` → 127.0.0.1: the bare `.` rule catches every name), Discord and
  the blocked sites opened, voice channels connect once the RTC socket's 2083 is forwarded (the
  media, UDP to the address the socket names, passes the DPI untouched), and `down` left no task,
  rule or state behind.

  On Linux (`linux.ts`) the DNS is ONE drop-in of systemd-resolved,
  `/run/systemd/resolved.conf.d/99-ozaco-ignoredpi.conf`: `DNS=127.0.0.1`, `Domains=~.` (DNSSEC
  and DNS over TLS off for it) — not each link's servers, which NetworkManager writes again
  whenever a link comes up. A routing domain of `~.` outranks a link that is only the default
  route, so the router's servers (its `fe80::1` too) are not asked, while a VPN's own names
  (Tailscale's `~ts.net`) still go to it. Under `/run`, a reboot forgets it; giving it back is
  removing it (nothing saved), then `systemctl --no-block reload-or-restart systemd-resolved` —
  NEVER waiting there: the unit is `After=systemd-resolved.service`, so inside its own stop (the
  service giving the DNS back on SIGTERM) resolved's job waits for that stop, and a waiting
  `systemctl` held it until systemd SIGABRTed and SIGKILLed it (seen on Fedora 44). The ISP
  resolver is the first IPv4 server of the link the default route leaves by (`ip -j route show
  default`, `resolvectl dns|domain|default-route` — text, wrapped lines joined back; no `--json`:
  Ubuntu 24.04's resolvectl has none). `up` writes the system unit
  `/etc/systemd/system/com.ozaco.ignoredpi.service`: root (the ports below 1024 and resolved are
  root's), `OZC_HOME` the user's home (the plugin, config and state are the user's `~/.ozaco`),
  `Restart=always` 10 s apart, `ExecStart=/bin/sh -c 'exec "$0" ignoredpi run >>"$1" 2>&1'` — on
  Fedora SELinux lets systemd execute no file under a home, a shell it starts may (and it opens the
  log for the same reason). `up` and `down` run as the user and ask `sudo` (`sudo -v` once, the
  password on the terminal) for what they change; `run` binds the ports itself, so it has to BE
  root (`sudo OZC_HOME="$HOME" "$(command -v ozc)" ignoredpi run`); `status` and `check` need
  neither. Seams: `IGNOREDPI_SUDO`, `IGNOREDPI_SYSTEMCTL`, `IGNOREDPI_RESOLVECTL`, `IGNOREDPI_IP`,
  `IGNOREDPI_RESOLVED_DIR`, `IGNOREDPI_UNIT_DIR`. A trial on Linux takes `--dns 5354`, not 5353
  (avahi's mDNS holds it).

  Run on Fedora 44 (systemd 259, SELinux enforcing) on Türk Telekom (2026-10-17): `up` took the
  DNS (`resolvectl query discord.com` → 127.0.0.1, the router's servers left on the link, Tailscale's
  names to Tailscale), the unit came up through the shell under SELinux, Discord and the blocked
  sites opened. `lan = true` is not tried on Linux: the wildcard's 53 may collide with resolved's
  stub on 127.0.0.53.

  `run --trial` runs anywhere.

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
