import { homeDir } from 'sdk:core'

import { attempt, sleep } from 'std:effect'
import type { Operation } from 'std:effect'
import { IO } from 'std:io'
import { isFailure } from 'std:result'

import {
  DSCACHEUTIL,
  DSCACHEUTIL_ENV,
  IPCONFIG,
  IPCONFIG_ENV,
  LABEL,
  LAUNCHCTL,
  LAUNCHCTL_ENV,
  LOOPBACK,
  NETWORKSETUP,
  NETWORKSETUP_ENV,
  NO_DNS_SERVERS,
  SETTLE_INTERVAL_MS,
  SETTLE_TRIES,
} from '../const'
import type { IgnoreDpiDef } from '../types'

import type { Host } from './system'
import { escaped, runTool } from './tools'

/**
 * The machine around the service on macOS: the network services whose DNS it takes and gives
 * back (`networksetup`), what DHCP named as the ISP's resolver (`ipconfig`), and the LaunchAgent
 * that keeps it running (`launchctl`). The parsers and the plist are pure; the rest runs the
 * tools, each through a seam the suites point at a stand-in.
 */

/** The launchd domain of the user. */
function* domainOf(): Operation<string> {
  return `gui/${(yield* IO.actions.platform()).uid ?? 0}`
}

/** A service still pointing at this machine with nothing saved for it goes back to DHCP's. */
function* sweepDns(): Operation<string[]> {
  const given: string[] = []

  for (const service of yield* networkServices()) {
    if ((yield* dnsOf(service.name)).includes(LOOPBACK)) {
      yield* setDns(service.name, [])
      given.push(`${service.name} (to DHCP's)`)
    }
  }

  return given
}

/** Each service's DNS as `status` prints it. */
function* dnsLines(): Operation<string[]> {
  const lines: string[] = []

  for (const service of yield* networkServices()) {
    const servers = yield* dnsOf(service.name)

    lines.push(`${service.name} → ${servers.length === 0 ? "DHCP's" : servers.join(', ')}`)
  }

  return lines
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

/** macOS: every network service's DNS, and a LaunchAgent. */
export const macosHost: Host = {
  name: 'macOS',
  *expectPrivileges() {},
  ispResolver: dhcpResolver,
  takeDns,
  giveDnsBack,
  sweepDns,
  dnsLines,
  agent: {
    installedAs: 'loaded (starts at login)',
    where: plistFile,
    *state() {
      const { loaded } = yield* agentState()

      return { installed: loaded, active: loaded }
    },
    *install(options) {
      const plist = yield* plistFile()

      yield* IO.actions.ensureDir(yield* IO.actions.dirname(plist))
      yield* IO.actions.write(
        plist,
        plistOf({
          ...options,
          path: [
            yield* IO.actions.dirname(options.program),
            '/usr/bin',
            '/bin',
            '/usr/sbin',
            '/sbin',
          ].join(':'),
        }),
      )

      if ((yield* agentState()).loaded) {
        yield* attempt(stopAgent())

        for (let tries = 0; tries < SETTLE_TRIES && (yield* agentState()).loaded; tries++) {
          yield* sleep(SETTLE_INTERVAL_MS)
        }
      }

      yield* bootAgent(plist)
    },
    stop: stopAgent,
    *remove() {
      yield* IO.actions.rm(yield* plistFile(), { force: true })
    },
  },
}
