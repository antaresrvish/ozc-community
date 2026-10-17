import { homeDir, ozacoDir } from 'sdk:core'

import { attempt, call } from 'std:effect'
import type { Operation } from 'std:effect'
import { IO } from 'std:io'
import { fail, isFailure } from 'std:result'

import { realpath } from 'node:fs/promises'

import {
  DSCACHEUTIL,
  DSCACHEUTIL_ENV,
  IPCONFIG,
  IPCONFIG_ENV,
  IgnoreDpiErrors,
  LABEL,
  LAUNCHCTL,
  LAUNCHCTL_ENV,
  LOG_FILE,
  LOOPBACK,
  NETWORKSETUP,
  NETWORKSETUP_ENV,
  NO_DNS_SERVERS,
  STATE_DIR,
  STATE_FILE,
} from '../const'
import type { IgnoreDpiDef } from '../types'

/**
 * The machine around the service — macOS for now: the network services whose DNS it takes and
 * gives back (`networksetup`), what DHCP named as the ISP's resolver (`ipconfig`), and the
 * LaunchAgent that keeps it running (`launchctl`). The parsers and the plist are pure; the rest
 * runs the tools, each through a seam the suites point at a stand-in.
 */

/** XML text, escaped. */
const escaped = (text: string): string =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

/** A tool's path: the seam's value when set, else the system's own. */
function* toolOf(env: string, fallback: string): Operation<string> {
  const value = yield* IO.actions.env(data => ({ tool: data[env] }), ['tool'])

  return value.tool ?? fallback
}

/** Run a tool, its stdout as text; a non-zero exit is a `system` failure carrying its stderr. */
function* runTool(env: string, fallback: string, args: readonly string[]): Operation<string> {
  const tool = yield* toolOf(env, fallback)
  const ran = yield* IO.actions.exec(tool, args)
  const stdout = new TextDecoder().decode(ran.stdout)

  if (!ran.success) {
    const said = `${new TextDecoder().decode(ran.stderr)}${stdout}`.trim()

    return yield* fail(
      IgnoreDpiErrors.System,
      `${tool} ${args.join(' ')} failed${said === '' ? '' : `: ${said}`}`,
    )
  }

  return stdout
}

/** The launchd domain of the user. */
function* domainOf(): Operation<string> {
  return `gui/${(yield* IO.actions.platform()).uid ?? 0}`
}

/** A network service as `networksetup -listnetworkserviceorder` lists it. */
export interface NetworkService {
  name: string
  device: string
  enabled: boolean
}

/** The services of a `-listnetworkserviceorder` listing, in order. */
export const servicesOf = (listing: string): NetworkService[] => {
  const services: NetworkService[] = []
  const lines = listing.split('\n')

  for (const [index, line] of lines.entries()) {
    const title = /^\((\d+|\*)\)\s+(.+)$/u.exec(line.trim())
    const port = /Device:\s*([^)]*)\)/u.exec(lines[index + 1] ?? '')

    if (title?.[1] !== undefined && title[2] !== undefined) {
      services.push({
        name: title[2].trim(),
        device: port?.[1]?.trim() ?? '',
        enabled: title[1] !== '*',
      })
    }
  }

  return services
}

/** The DNS servers a `-getdnsservers` answer names (none: DHCP's are in use). */
export const dnsServersOf = (answer: string): string[] =>
  answer.includes(NO_DNS_SERVERS)
    ? []
    : answer
        .split('\n')
        .map(line => line.trim())
        .filter(line => line !== '')

/**
 * The LaunchAgent: `ozc ignoredpi run` from home, started at login and again whenever it stops,
 * its output in the log file.
 */
export const plistOf = (options: {
  program: string
  home: string
  log: string
  path: string
}): string =>
  [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key><string>${LABEL}</string>`,
    '  <key>ProgramArguments</key>',
    `  <array><string>${escaped(options.program)}</string><string>ignoredpi</string><string>run</string></array>`,
    `  <key>WorkingDirectory</key><string>${escaped(options.home)}</string>`,
    '  <key>EnvironmentVariables</key>',
    `  <dict><key>PATH</key><string>${escaped(options.path)}</string></dict>`,
    '  <key>RunAtLoad</key><true/>',
    '  <key>KeepAlive</key><true/>',
    '  <key>ThrottleInterval</key><integer>10</integer>',
    `  <key>StandardOutPath</key><string>${escaped(options.log)}</string>`,
    `  <key>StandardErrorPath</key><string>${escaped(options.log)}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n')

/** Whether the service can be kept on this machine (macOS), and a `platform` failure if not. */
export function* expectMacos(what: string): Operation<void> {
  const { os } = yield* IO.actions.platform()

  if (os !== 'darwin') {
    return yield* fail(
      IgnoreDpiErrors.Platform,
      `${what} is macOS only for now (this is ${os}): \`ozc ignoredpi run --trial\` runs the service without touching the machine's DNS`,
    )
  }
}

/** The enabled network services that sit on a device (Wi-Fi, Ethernet; not a VPN's). */
export function* networkServices(): Operation<NetworkService[]> {
  const listing = yield* runTool(NETWORKSETUP_ENV, NETWORKSETUP, ['-listnetworkserviceorder'])

  return servicesOf(listing).filter(service => service.enabled && service.device !== '')
}

/** A service's DNS servers set by hand ([] → none, DHCP's in use). */
export function* dnsOf(service: string): Operation<string[]> {
  return dnsServersOf(yield* runTool(NETWORKSETUP_ENV, NETWORKSETUP, ['-getdnsservers', service]))
}

/** Set a service's DNS servers ([] → none, back to DHCP's). */
export function* setDns(service: string, servers: readonly string[]): Operation<void> {
  yield* runTool(NETWORKSETUP_ENV, NETWORKSETUP, [
    '-setdnsservers',
    service,
    ...(servers.length === 0 ? ['Empty'] : servers),
  ])
}

/**
 * Point every service's DNS at the service, writing into `saved` what each had — and `keep`ing it
 * — BEFORE it is changed: a failure or a crash halfway leaves exactly the services to give back.
 * `previous` (a crashed run's saved state) wins over what is set now, which would be this service.
 */
export function* takeDns(
  previous: IgnoreDpiDef.SavedDns | undefined,
  saved: IgnoreDpiDef.SavedDns,
  keep: () => Operation<void>,
): Operation<void> {
  for (const service of yield* networkServices()) {
    const current = (yield* dnsOf(service.name)).filter(server => server !== LOOPBACK)

    saved[service.name] = previous?.[service.name] ?? current
    yield* keep()
    yield* setDns(service.name, [LOOPBACK])
  }

  // the resolver cache would answer from what the ISP said before for a while
  yield* attempt(runTool(DSCACHEUTIL_ENV, DSCACHEUTIL, ['-flushcache']))
}

/** Give every service back the DNS it had; a service that is gone is passed over. */
export function* giveDnsBack(saved: IgnoreDpiDef.SavedDns): Operation<string[]> {
  const restored: string[] = []

  for (const [service, servers] of Object.entries(saved)) {
    if (!isFailure(yield* attempt(setDns(service, servers)))) {
      restored.push(service)
    }
  }

  yield* attempt(runTool(DSCACHEUTIL_ENV, DSCACHEUTIL, ['-flushcache']))

  return restored
}

/** The resolver DHCP gave the first service that has one: the ISP's (the router, usually). */
export function* dhcpResolver(): Operation<string | undefined> {
  for (const service of yield* networkServices()) {
    const answer = yield* attempt(
      runTool(IPCONFIG_ENV, IPCONFIG, ['getoption', service.device, 'domain_name_server']),
    )
    const server = isFailure(answer) ? undefined : answer.value.trim().split(/\s+/u)[0]

    if (server !== undefined && /^\d{1,3}(?:\.\d{1,3}){3}$/u.test(server)) {
      return server
    }
  }

  return undefined
}

/** `~/.ozaco/ignoredpi/` and the files in it. */
export function* stateDir(): Operation<string> {
  return yield* IO.actions.join(yield* ozacoDir(), STATE_DIR)
}

export function* stateFile(): Operation<string> {
  return yield* IO.actions.join(yield* stateDir(), STATE_FILE)
}

export function* logFile(): Operation<string> {
  return yield* IO.actions.join(yield* stateDir(), LOG_FILE)
}

/** `~/Library/LaunchAgents/com.ozaco.ignoredpi.plist`. */
export function* plistFile(): Operation<string> {
  return yield* IO.actions.join(yield* homeDir(), 'Library', 'LaunchAgents', `${LABEL}.plist`)
}

export function* launchctl(...args: string[]): Operation<string> {
  return yield* runTool(LAUNCHCTL_ENV, LAUNCHCTL, args)
}

/** Whether launchd has the service loaded, and its pid when it runs. */
export function* agentState(): Operation<{ loaded: boolean; pid: number | undefined }> {
  const printed = yield* attempt(launchctl('print', `${yield* domainOf()}/${LABEL}`))

  if (isFailure(printed)) {
    return { loaded: false, pid: undefined }
  }

  const pid = /^\s*pid\s*=\s*(\d+)/mu.exec(printed.value)?.[1]

  return { loaded: true, pid: pid === undefined ? undefined : Number(pid) }
}

/** Load the agent (it starts at once: `RunAtLoad`). */
export function* bootAgent(plist: string): Operation<void> {
  yield* launchctl('bootstrap', yield* domainOf(), plist)
}

/** Unload the agent: launchd stops it (SIGTERM — it gives the DNS back on the way out). */
export function* stopAgent(): Operation<void> {
  yield* launchctl('bootout', `${yield* domainOf()}/${LABEL}`)
}

/**
 * The `ozc` the agent runs: the link on PATH that leads to this very executable (it survives an
 * upgrade, the versioned file behind it does not), else the executable itself. `IGNOREDPI_OZC`
 * names another.
 */
export function* ozcProgram(): Operation<string> {
  const env = yield* IO.actions.env(
    data => ({ ozc: data.IGNOREDPI_OZC, path: data.PATH }),
    ['ozc', 'path'],
  )

  if (env.ozc !== undefined) {
    return env.ozc
  }

  const executable = process.execPath
  const real = yield* attempt(call(() => realpath(executable)))
  const target = isFailure(real) ? executable : real.value

  for (const dir of (env.path ?? '').split(':').filter(entry => entry !== '')) {
    const candidate = yield* IO.actions.join(dir, 'ozc')
    const resolved = yield* attempt(call(() => realpath(candidate)))

    if (!isFailure(resolved) && resolved.value === target) {
      return candidate
    }
  }

  return executable
}
