import { attempt, call } from 'std:effect'
import type { Operation } from 'std:effect'
import { IO } from 'std:io'
import { fail, isFailure } from 'std:result'

import { z } from 'zod'

import {
  IP,
  IP_ENV,
  IgnoreDpiErrors,
  LOOPBACK,
  RESOLVECTL,
  RESOLVECTL_ENV,
  RESOLVED_DIR,
  RESOLVED_DIR_ENV,
  RESOLVED_FILE,
  RESOLVED_SCOPE,
  SUDO,
  SUDO_ENV,
  SYSTEMCTL,
  SYSTEMCTL_ENV,
  UNIT_DIR,
  UNIT_DIR_ENV,
  UNIT_FILE,
} from '../const'
import type { IgnoreDpiDef } from '../types'

import type { Agent, Host } from './system'
import { execTool, runTool, toolOf } from './tools'

/**
 * The machine around the service on Linux, through systemd. The DNS is taken with ONE drop-in of
 * systemd-resolved — every name (`Domains=~.`) to 127.0.0.1 — not each link's servers, which the
 * network manager writes again whenever a link comes up: a routing domain of `~.` outranks every
 * link that is only the default route, so the router's servers (its IPv6 `fe80::1` too) are no
 * longer asked, while a VPN's own names (Tailscale's `~ts.net`) still go to it. The drop-in is
 * under `/run`, so a reboot forgets it; nothing is saved to give back — giving it back is removing
 * it. The ISP's resolver is what the link the default route leaves by was given, the drop-in never
 * changes it. A system unit keeps the service running from boot, as root: the ports below 1024 and
 * systemd-resolved are root's. A command that is not root asks `sudo` (the password on the
 * terminal) for what it changes; `run` itself binds the ports, so it has to be root. The tools are
 * `systemctl`, `resolvectl`, `ip` and `sudo`, each through a seam; the parsers and the unit are
 * pure.
 */

/** Whether this process is root: then nothing goes through `sudo`. */
function* isRoot(): Operation<boolean> {
  return (yield* IO.actions.platform()).uid === 0
}

/** Run `args` as root — directly when this is root, else through `sudo` — `stdin` written to it. */
function* asRoot(args: readonly string[], stdin?: string): Operation<string> {
  const [tool = '', ...rest] = args

  if (yield* isRoot()) {
    return yield* execTool(tool, rest, { shown: rest.join(' '), stdin })
  }

  return yield* execTool(yield* toolOf(SUDO_ENV, SUDO), args, { shown: args.join(' '), stdin })
}

function* systemctl(): Operation<string> {
  return yield* toolOf(SYSTEMCTL_ENV, SYSTEMCTL)
}

/** `/run/systemd/resolved.conf.d/99-ozaco-ignoredpi.conf`. */
function* dropInFile(): Operation<string> {
  return yield* IO.actions.join(yield* toolOf(RESOLVED_DIR_ENV, RESOLVED_DIR), RESOLVED_FILE)
}

/** `/etc/systemd/system/com.ozaco.ignoredpi.service`. */
function* unitFile(): Operation<string> {
  return yield* IO.actions.join(yield* toolOf(UNIT_DIR_ENV, UNIT_DIR), UNIT_FILE)
}

/** Write `text` to `file` as root (its directory made first). */
function* writeAsRoot(file: string, text: string): Operation<void> {
  yield* asRoot(['mkdir', '-p', yield* IO.actions.dirname(file)])
  yield* asRoot(['tee', file], text)
}

/**
 * systemd-resolved reads its drop-ins again (restarted where it cannot reload), its cache emptied.
 * `wait: false` queues the job and returns: the unit is ordered after systemd-resolved, so while
 * it stops — the service giving the DNS back on SIGTERM — a job of resolved waits for that stop to
 * end, and a `systemctl` waiting for the job holds the stop until systemd kills it.
 */
function* reloadResolved(options: { wait: boolean }): Operation<void> {
  yield* asRoot([
    yield* systemctl(),
    ...(options.wait ? [] : ['--no-block']),
    'reload-or-restart',
    'systemd-resolved.service',
  ])
  // what the ISP said before would be answered from it for a while
  yield* attempt(asRoot([yield* toolOf(RESOLVECTL_ENV, RESOLVECTL), 'flush-caches']))
}

/** Remove the drop-in (a crashed run's too) when it is there; whether it was. */
function* removeDropIn(): Operation<boolean> {
  const file = yield* dropInFile()

  if (!(yield* IO.actions.exists(file))) {
    return false
  }

  yield* asRoot(['rm', '-f', file])
  yield* reloadResolved({ wait: false })

  return true
}

/**
 * Point every name at the service: what is taken is kept BEFORE it is taken (a crash halfway
 * leaves it to give back), and a crashed run's drop-in is written over, not doubled. There is
 * nothing to save — the drop-in is given back by removing it — so a crashed run's record changes
 * nothing.
 */
function* takeDns(
  _previous: IgnoreDpiDef.SavedDns | undefined,
  saved: IgnoreDpiDef.SavedDns,
  keep: () => Operation<void>,
): Operation<void> {
  // without systemd-resolved there is nothing the drop-in would change
  yield* look()
  saved[RESOLVED_SCOPE] = []
  yield* keep()
  yield* writeAsRoot(yield* dropInFile(), DROP_IN)
  yield* reloadResolved({ wait: true })
}

/** Give back what a run took: its drop-in removed. */
function* giveDnsBack(saved: IgnoreDpiDef.SavedDns): Operation<string[]> {
  if (Object.keys(saved).length === 0) {
    return []
  }

  yield* removeDropIn()

  return [RESOLVED_SCOPE]
}

/** A drop-in of this service left with no run to remove it (the state file gone too). */
function* sweepDns(): Operation<string[]> {
  return (yield* removeDropIn()) ? [RESOLVED_SCOPE] : []
}

function* ispResolver(): Operation<string | undefined> {
  const looked = yield* attempt(look())

  return isFailure(looked) ? undefined : ispOf(looked.value)
}

function* dnsLines(): Operation<string[]> {
  return dnsLinesOf(yield* look(), yield* IO.actions.exists(yield* dropInFile()))
}

/**
 * Root changes systemd-resolved and the unit: a command that is not root asks `sudo` once, here
 * (the password on the terminal), for what follows. One that binds the ports itself has to BE
 * root.
 */
function* expectPrivileges(what: string, options?: { ports?: boolean }): Operation<void> {
  if (yield* isRoot()) {
    return
  }

  if (options?.ports === true) {
    return yield* fail(
      IgnoreDpiErrors.Privilege,
      `${what} binds ports 53, 80 and 443, which Linux leaves to root: \`ozc ignoredpi up\` runs it as a systemd service, or run it as root in the foreground — \`sudo OZC_HOME="$HOME" "$(command -v ozc)" ignoredpi run\``,
    )
  }

  const asked = yield* attempt(execTool(yield* toolOf(SUDO_ENV, SUDO), ['-v'], { shown: '-v' }))

  if (isFailure(asked)) {
    return yield* fail(
      IgnoreDpiErrors.Privilege,
      `${what} changes systemd-resolved and the system's services, which Linux leaves to root, and sudo did not let it (${asked.message}): run it from a terminal where sudo can ask for the password, or as root`,
    )
  }
}

/** One of systemd's words in a unit, double-quoted: `\`, `"` and the specifier `%` escaped. */
const wordOf = (text: string): string =>
  `"${text
    .replaceAll('\\', String.raw`\\`)
    .replaceAll('"', String.raw`\"`)
    .replaceAll('%', '%%')}"`

/** A word of `ExecStart=`: as above, and `$` — systemd's own expansion — doubled. */
const execWordOf = (text: string): string => wordOf(text).replaceAll('$', '$$$$')

/** A route as `ip -j route show default` prints it. */
const RoutesSchema = z.array(z.object({ dev: z.string(), metric: z.number().optional() }))

/** The unit `com.ozaco.ignoredpi.service`. */
const linuxAgent: Agent = {
  installedAs: 'a systemd service (starts at boot)',
  where: unitFile,
  *state() {
    const installed = yield* IO.actions.exists(yield* unitFile())
    const active = yield* attempt(runTool(SYSTEMCTL_ENV, SYSTEMCTL, ['is-active', UNIT_FILE]))

    return { installed, active: installed && !isFailure(active) }
  },
  *install(options) {
    const program = yield* IO.actions.dirname(options.program)

    yield* writeAsRoot(
      yield* unitFile(),
      unitOf({
        ...options,
        path: [program, '/usr/local/sbin', '/usr/local/bin', '/usr/sbin', '/usr/bin'].join(':'),
      }),
    )
    yield* asRoot([yield* systemctl(), 'daemon-reload'])
    yield* asRoot([yield* systemctl(), 'enable', UNIT_FILE])
    // a running one is stopped first, then started with what was written
    yield* asRoot([yield* systemctl(), 'restart', UNIT_FILE])
  },
  /** systemd stops it with SIGTERM: it gives the DNS back on the way out. */
  *stop() {
    yield* asRoot([yield* systemctl(), 'stop', UNIT_FILE])
  },
  *remove() {
    const file = yield* unitFile()

    if (!(yield* IO.actions.exists(file))) {
      return
    }

    yield* attempt(asRoot([yield* systemctl(), 'disable', UNIT_FILE]))
    yield* asRoot(['rm', '-f', file])
    yield* asRoot([yield* systemctl(), 'daemon-reload'])
  },
}

/**
 * The drop-in: every name to the service. DNSSEC and DNS over TLS are off for it — the service
 * speaks plain DNS on 127.0.0.1, and answers a blocked name with this machine, unsigned.
 */
export const DROP_IN = [
  '# ozc ignoredpi: every name to the service on 127.0.0.1 — removed when it stops',
  '[Resolve]',
  `DNS=${LOOPBACK}`,
  'Domains=~.',
  'DNSSEC=no',
  'DNSOverTLS=no',
  '',
].join('\n')

/**
 * The unit: `ozc ignoredpi run` as root from boot, again 10 s after it stops, its output appended
 * to the log. It runs through `/bin/sh` — on Fedora SELinux lets systemd execute no file under a
 * home directory, a shell it starts may — which opens the log as well, for the same reason;
 * `OZC_HOME` is the user's, whose `~/.ozaco` holds the plugin, the config and the state.
 */
export const unitOf = (options: {
  program: string
  home: string
  log: string
  path: string
}): string =>
  [
    '[Unit]',
    'Description=ozc ignoredpi run: the sites blocked in Turkey opened for every app',
    'Wants=network-online.target',
    'After=network-online.target systemd-resolved.service',
    '',
    '[Service]',
    'Type=simple',
    `Environment=${wordOf(`OZC_HOME=${options.home}`)} ${wordOf(`PATH=${options.path}`)}`,
    `ExecStart=/bin/sh -c ${execWordOf('exec "$0" ignoredpi run >>"$1" 2>&1')} ${execWordOf(options.program)} ${execWordOf(options.log)}`,
    'Restart=always',
    'RestartSec=10',
    'TimeoutStopSec=20',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    '',
  ].join('\n')

/** A link (or `Global`) as `resolvectl dns|domain|default-route` lists it, with what it has. */
export interface Link {
  name: string
  /** The link's index; `undefined` for `Global`. */
  index: number | undefined
  values: string[]
}

/** What a `resolvectl dns|domain|default-route` listing names — its wrapped lines joined back. */
export const linksOf = (listing: string): Link[] => {
  const links: Link[] = []
  const words = (text: string): string[] => text.split(/\s+/u).filter(word => word !== '')

  for (const line of listing.split('\n')) {
    const head = /^(?:Global|Link (\d+) \(([^)]*)\)):(.*)$/u.exec(line)

    if (head !== null) {
      links.push({
        name: head[2] ?? 'Global',
        index: head[1] === undefined ? undefined : Number(head[1]),
        values: words(head[3] ?? ''),
      })
    } else if (/^\s/u.test(line)) {
      links.at(-1)?.values.push(...words(line))
    }
  }

  return links
}

/** The machine's names as systemd-resolved routes them, and where its default routes leave by. */
export interface Look {
  /** Each link's servers, `Global` first. */
  servers: Link[]
  /** Each link's domains (`~` before one only routes). */
  domains: Link[]
  /** The links that are a default route of the DNS. */
  defaults: string[]
  /** The devices the default routes leave by, the preferred first. */
  routes: string[]
}

/** A server as `resolvectl` names it, bare: no `%link`, no `#name` (DNS over TLS), no port. */
export const addressOf = (server: string): string => {
  const bare = server.split('#')[0]?.split('%')[0] ?? ''
  const v4 = /^(\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?$/u.exec(bare)
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/u.exec(bare)

  return v4?.[1] ?? bracketed?.[1] ?? bare
}

/** The devices of `ip -j route show default`, the lowest metric first; none when it is not that. */
export const routesOf = (data: unknown): string[] => {
  const parsed = RoutesSchema.safeParse(data)

  return parsed.success
    ? parsed.data.toSorted((a, b) => (a.metric ?? 0) - (b.metric ?? 0)).map(route => route.dev)
    : []
}

/**
 * The resolver the link the default route leaves by was given: the ISP's (the router, usually) —
 * an IPv4 server, never this machine's own.
 */
export const ispOf = (looked: Look): string | undefined => {
  const order = [...looked.routes, ...looked.defaults]

  for (const name of order) {
    const link = looked.servers.find(entry => entry.index !== undefined && entry.name === name)
    const server = link?.values
      .map(addressOf)
      .find(entry => /^\d{1,3}(?:\.\d{1,3}){3}$/u.test(entry) && !entry.startsWith('127.'))

    if (server !== undefined) {
      return server
    }
  }

  return undefined
}

/**
 * Where names go, as `status` prints it: systemd-resolved's own servers first (`ours`: the
 * service's drop-in is in place), then each link that has servers — one that is not a default
 * route is asked its own names only.
 */
export const dnsLinesOf = (looked: Look, ours: boolean): string[] => {
  const lines: string[] = []
  const global = looked.servers.find(link => link.index === undefined)
  const routesAll = looked.domains.find(link => link.index === undefined)?.values.includes('~.')

  if (global !== undefined && global.values.length > 0) {
    lines.push(
      `${routesAll === true ? 'every name' : 'global'} → ${global.values.join(', ')} (systemd-resolved${ours ? '' : ", not ignoredpi's"})`,
    )
  }

  for (const link of looked.servers) {
    if (link.index !== undefined && link.values.length > 0) {
      lines.push(
        `${link.name} → ${link.values.join(', ')}${looked.defaults.includes(link.name) ? '' : ' (its own names)'}`,
      )
    }
  }

  return lines
}

/** What the machine looks like now: systemd-resolved's links, and the default routes. */
export function* look(): Operation<Look> {
  const resolvectl = yield* toolOf(RESOLVECTL_ENV, RESOLVECTL)
  const servers = yield* attempt(execTool(resolvectl, ['dns'], { shown: 'dns' }))

  if (isFailure(servers)) {
    return yield* fail(
      IgnoreDpiErrors.Platform,
      `systemd-resolved does not answer here (${servers.message}): on Linux ignoredpi points the machine's DNS through it — \`ozc ignoredpi run --trial\` runs the service without`,
    )
  }

  const domains = yield* execTool(resolvectl, ['domain'], { shown: 'domain' })
  const defaults = yield* execTool(resolvectl, ['default-route'], { shown: 'default-route' })
  const routed = yield* attempt(runTool(IP_ENV, IP, ['-j', 'route', 'show', 'default']))
  const routes = isFailure(routed)
    ? undefined
    : yield* attempt(call(() => JSON.parse(routed.value) as unknown))

  return {
    servers: linksOf(servers.value),
    domains: linksOf(domains),
    defaults: linksOf(defaults)
      .filter(link => link.index !== undefined && link.values[0] === 'yes')
      .map(link => link.name),
    routes: routes === undefined || isFailure(routes) ? [] : routesOf(routes.value),
  }
}

/** Linux: one drop-in of systemd-resolved for every name, and a system unit. */
export const linuxHost: Host = {
  name: 'Linux',
  expectPrivileges,
  ispResolver,
  takeDns,
  giveDnsBack,
  sweepDns,
  dnsLines,
  agent: linuxAgent,
}
