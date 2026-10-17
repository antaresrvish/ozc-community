import { attempt, call, sleep } from 'std:effect'
import type { Operation } from 'std:effect'
import { IO } from 'std:io'
import { fail, isFailure } from 'std:result'

import { z } from 'zod'

import {
  ELEVATED_LABELS,
  IgnoreDpiErrors,
  LABEL,
  LOOPBACK,
  NRPT_COMMENT,
  NRPT_SCOPE,
  POWERSHELL,
  POWERSHELL_ENV,
  RESTART_DELAY_S,
  SCHTASKS,
  SCHTASKS_ENV,
  SETTLE_INTERVAL_MS,
  SETTLE_TRIES,
  TASK_FILE,
  WHOAMI,
  WHOAMI_ENV,
} from '../const'
import type { IgnoreDpiDef } from '../types'

import { isAlive, readState, stateDir } from './state'
import type { Agent, Host } from './system'
import { escaped, execTool, runTool, toolOf } from './tools'

/**
 * The machine around the service on Windows. The DNS is taken with ONE rule of the name
 * resolution policy (NRPT): every name (`.`) to 127.0.0.1 — whatever the adapter, its IPv6 DNS
 * included (the router's `fe80::1` would go around a server set per adapter), and an adapter that
 * comes up later. Nothing is saved to give back: giving it back is removing the rule, found by its
 * comment even after a crash. The ISP's resolver is what DHCP gave the adapter the default route
 * leaves by (the registry's `DhcpNameServer`, never the DNS set by hand), and a scheduled task
 * keeps the service running — from boot, as the user, elevated (`S4U`: no window, no password
 * stored). The NRPT and the task are an administrator's to change: `up`, `down` and `run` need an
 * elevated terminal, `status` does not. The tools are PowerShell (its cmdlets answer alike in
 * every language, as JSON), `schtasks` and `whoami`, each through a seam; the parsers and the task
 * are pure.
 */

/** A path under Windows' own `System32`. */
function* system32(...segments: readonly string[]): Operation<string> {
  const env = yield* IO.actions.env(
    data => ({ root: data.SystemRoot ?? data.SYSTEMROOT }),
    ['root'],
  )

  return yield* IO.actions.join(env.root ?? String.raw`C:\Windows`, 'System32', ...segments)
}

/** Text as UTF-16 code units (a character beyond the first plane as its two surrogates). */
const unitsOf = (text: string): number[] => {
  const units: number[] = []

  for (const char of text) {
    const point = char.codePointAt(0) ?? 0

    if (point > 0xff_ff) {
      units.push(0xd8_00 + ((point - 0x1_00_00) >> 10), 0xdc_00 + ((point - 0x1_00_00) & 0x3_ff))
    } else {
      units.push(point)
    }
  }

  return units
}

/** What every script starts with: errors stop it, and its output is UTF-8 (an adapter's name need not be ASCII). */
const PRELUDE = [
  "$ErrorActionPreference = 'Stop'",
  "$ProgressPreference = 'SilentlyContinue'",
  '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
].join('\n')

/** Run a script; `what` names it in a failure (the encoded script would say nothing). */
function* powershell(what: string, script: string): Operation<string> {
  const tool = yield* toolOf(POWERSHELL_ENV, yield* system32(...POWERSHELL))
  const args = [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-EncodedCommand',
    encodedOf(script),
  ]

  return yield* execTool(tool, args, `(${what})`)
}

function* schtasks(...args: string[]): Operation<string> {
  return yield* runTool(SCHTASKS_ENV, yield* system32(SCHTASKS), args)
}

function* whoami(...args: string[]): Operation<string> {
  return yield* runTool(WHOAMI_ENV, yield* system32(WHOAMI), args)
}

/**
 * The adapters that are up — each with its DNS from the registry (`DhcpNameServer`, `NameServer`)
 * and the metric of its default route — and the NRPT's rules, as one JSON document.
 */
const LOOK = String.raw`
$interfaces = 'HKLM:\SYSTEM\CurrentControlSet\Services\Tcpip\Parameters\Interfaces'
$routes = @(Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue)
$metrics = @{}
foreach ($interface in @(Get-NetIPInterface -AddressFamily IPv4 -ErrorAction SilentlyContinue)) {
  $metrics[[int]$interface.ifIndex] = [int]$interface.InterfaceMetric
}
$adapters = @(Get-NetAdapter | Where-Object Status -eq 'Up' | ForEach-Object {
  $dns = Get-ItemProperty -Path "$interfaces\$($_.InterfaceGuid)" -ErrorAction SilentlyContinue
  $route = @($routes | Where-Object ifIndex -eq $_.ifIndex | Sort-Object RouteMetric)[0]
  [pscustomobject]@{
    name = [string]$_.Name
    index = [int]$_.ifIndex
    dhcp = [string]$dns.DhcpNameServer
    manual = [string]$dns.NameServer
    metric = if ($route) { [int]$route.RouteMetric + [int]$metrics[[int]$_.ifIndex] } else { $null }
  }
})
$rules = @(Get-DnsClientNrptRule | ForEach-Object {
  [pscustomobject]@{
    name = [string]$_.Name
    namespace = @($_.Namespace | ForEach-Object { [string]$_ })
    servers = @($_.NameServers | ForEach-Object { [string]$_ })
    comment = [string]$_.Comment
  }
})
ConvertTo-Json -Compress -Depth 4 -InputObject ([pscustomobject]@{ adapters = $adapters; rules = $rules })
`

const LookSchema = z.object({
  adapters: z.array(
    z.object({
      name: z.string(),
      index: z.number(),
      dhcp: z.string(),
      manual: z.string(),
      metric: z.number().nullable(),
    }),
  ),
  rules: z.array(
    z.object({
      name: z.string(),
      namespace: z.array(z.string()),
      servers: z.array(z.string()),
      comment: z.string(),
    }),
  ),
})

/** The servers of a registry list: `DhcpNameServer` is spaced, `NameServer` comma'd. */
const serversOf = (text: string): string[] => text.split(/[\s,]+/u).filter(server => server !== '')

/** Remove every rule this service added (a crashed run's too), and the cache of what they said. */
function* removeRules(): Operation<number> {
  const removed = yield* powershell(
    'removing the NRPT rule',
    [
      `$rules = @(Get-DnsClientNrptRule | Where-Object Comment -eq ${quotedOf(NRPT_COMMENT)})`,
      'foreach ($rule in $rules) { Remove-DnsClientNrptRule -Name $rule.Name -Force }',
      'Clear-DnsClientCache',
      '$rules.Count',
    ].join('\n'),
  )

  return Number(removed.trim()) || 0
}

/**
 * Point every name at the service: what is taken is kept BEFORE it is taken (a crash halfway
 * leaves it to give back), and a rule of a crashed run is replaced, not doubled. There is nothing
 * to save — the rule is given back by removing it — so a crashed run's record changes nothing.
 */
function* takeDns(
  _previous: IgnoreDpiDef.SavedDns | undefined,
  saved: IgnoreDpiDef.SavedDns,
  keep: () => Operation<void>,
): Operation<void> {
  saved[NRPT_SCOPE] = []
  yield* keep()
  yield* powershell(
    'adding the NRPT rule',
    [
      `$ours = ${quotedOf(NRPT_COMMENT)}`,
      'Get-DnsClientNrptRule | Where-Object Comment -eq $ours | ForEach-Object { Remove-DnsClientNrptRule -Name $_.Name -Force }',
      `Add-DnsClientNrptRule -Namespace '.' -NameServers ${quotedOf(LOOPBACK)} -Comment $ours -DisplayName $ours`,
      // the cache would answer from what the ISP said before for a while
      'Clear-DnsClientCache',
    ].join('\n'),
  )
}

/** Give back what a run took: its rule removed. */
function* giveDnsBack(saved: IgnoreDpiDef.SavedDns): Operation<string[]> {
  if (Object.keys(saved).length === 0) {
    return []
  }

  yield* removeRules()

  return [NRPT_SCOPE]
}

/** A rule of this service left with no run to remove it (the state file gone too). */
function* sweepDns(): Operation<string[]> {
  return (yield* removeRules()) > 0 ? [NRPT_SCOPE] : []
}

function* ispResolver(): Operation<string | undefined> {
  const looked = yield* attempt(look())

  return isFailure(looked) ? undefined : ispOf(looked.value.adapters)
}

function* dnsLines(): Operation<string[]> {
  return dnsLinesOf(yield* look())
}

/** The NRPT and the task are an administrator's: fail with what to do when this is not one. */
function* expectPrivileges(what: string): Operation<void> {
  if (!isElevatedOf(yield* whoami('/groups', '/fo', 'csv', '/nh'))) {
    return yield* fail(
      IgnoreDpiErrors.Privilege,
      `${what} changes the machine's DNS, which Windows leaves to an administrator: run it from a terminal opened as administrator (or \`sudo ozc …\` where Windows' sudo is on)`,
    )
  }
}

/** `~/.ozaco/ignoredpi/task.xml`: the task as it was registered. */
function* taskFile(): Operation<string> {
  return yield* IO.actions.join(yield* stateDir(), TASK_FILE)
}

/** The scheduled task `com.ozaco.ignoredpi`. */
const windowsAgent: Agent = {
  installedAs: 'a scheduled task (starts at boot)',
  *where() {
    return `the scheduled task ${LABEL}`
  },
  *state() {
    // a task an administrator registered may not be read from a terminal that is not one: the
    // file it was registered from says it is there as well
    const queried = yield* attempt(schtasks('/Query', '/TN', LABEL))
    const installed = !isFailure(queried) || (yield* IO.actions.exists(yield* taskFile()))
    const running = yield* readState()

    return {
      installed,
      active: installed && running !== undefined && (yield* isAlive(running.pid)),
    }
  },
  *install(options) {
    const file = yield* taskFile()
    const user = (yield* whoami()).trim()

    yield* IO.actions.ensureDir(yield* IO.actions.dirname(file))
    yield* IO.actions.write(file, utf16Of(taskOf({ ...options, user })))
    yield* windowsAgent.stop()
    yield* schtasks('/Create', '/TN', LABEL, '/XML', file, '/F')
    yield* schtasks('/Run', '/TN', LABEL)
  },
  /**
   * End the task — which ends the loop around the service, not always the service — then the
   * service itself: Windows has no SIGTERM for it, so it gives nothing back on the way out, and
   * whoever stops it gives the DNS back (`down`; the next run, after `up`).
   */
  *stop() {
    yield* attempt(schtasks('/End', '/TN', LABEL))

    const running = yield* readState()

    if (running !== undefined && (yield* isAlive(running.pid))) {
      yield* attempt(call(() => process.kill(running.pid)))

      for (let tries = 0; tries < SETTLE_TRIES && (yield* isAlive(running.pid)); tries++) {
        yield* sleep(SETTLE_INTERVAL_MS)
      }
    }
  },
  *remove() {
    if (!isFailure(yield* attempt(schtasks('/Query', '/TN', LABEL)))) {
      yield* schtasks('/Delete', '/TN', LABEL, '/F')
    }

    yield* IO.actions.rm(yield* taskFile(), { force: true })
  },
}

/**
 * A script as `-EncodedCommand` takes it — UTF-16LE in base64, nothing on the command line to
 * quote — its error written as a line of text rather than PowerShell's CLIXML.
 */
export const encodedOf = (script: string): string => {
  const text = [
    PRELUDE,
    'try {',
    script,
    '} catch {',
    '  [Console]::Error.WriteLine($_.Exception.Message)',
    '  exit 1',
    '}',
  ].join('\n')

  return btoa(
    unitsOf(text)
      .map(unit => String.fromCodePoint(unit & 0xff, unit >> 8))
      .join(''),
  )
}

/** A PowerShell literal: single-quoted (its typographic quotes too), nothing in it expanded. */
export const quotedOf = (text: string): string => `'${text.replaceAll(/['‘’‚‛]/gu, '$&$&')}'`

/** An adapter that is up, as the look script reports it. */
export interface Adapter {
  name: string
  index: number
  /** What DHCP handed out, and what is set by hand (none: DHCP's are in use). */
  dhcp: string[]
  manual: string[]
  /** The metric of its default route (route + interface), `undefined` when it has none. */
  metric: number | undefined
}

/** A rule of the name resolution policy; `ours` when this service added it. */
export interface NrptRule {
  name: string
  namespace: string[]
  servers: string[]
  ours: boolean
}

export interface Look {
  adapters: Adapter[]
  rules: NrptRule[]
}

/** What the look script printed, parsed; `undefined` when it is not what it prints. */
export const lookOf = (data: unknown): Look | undefined => {
  const parsed = LookSchema.safeParse(data)

  if (!parsed.success) {
    return undefined
  }

  return {
    adapters: parsed.data.adapters.map(adapter => ({
      name: adapter.name,
      index: adapter.index,
      dhcp: serversOf(adapter.dhcp),
      manual: serversOf(adapter.manual),
      metric: adapter.metric ?? undefined,
    })),
    rules: parsed.data.rules.map(rule => ({
      name: rule.name,
      namespace: rule.namespace,
      servers: rule.servers,
      ours: rule.comment === NRPT_COMMENT,
    })),
  }
}

/** The resolver DHCP gave the adapter the default route leaves by: the ISP's (the router, usually). */
export const ispOf = (adapters: readonly Adapter[]): string | undefined => {
  const last = Number.MAX_SAFE_INTEGER
  const ordered = adapters.toSorted((a, b) => (a.metric ?? last) - (b.metric ?? last))

  for (const adapter of ordered) {
    const server = adapter.dhcp.find(entry => /^\d{1,3}(?:\.\d{1,3}){3}$/u.test(entry))

    if (server !== undefined) {
      return server
    }
  }

  return undefined
}

/** Where names go, as `status` prints it: a rule for every name first (another's may win), then each adapter. */
export const dnsLinesOf = (looked: Look): string[] => [
  ...looked.rules
    .filter(rule => rule.namespace.includes('.'))
    .map(
      rule =>
        `every name → ${rule.servers.join(', ')} (NRPT${rule.ours ? '' : `, not ignoredpi's: ${rule.name}`})`,
    ),
  ...looked.adapters.map(
    adapter =>
      `${adapter.name} → ${
        adapter.manual.length > 0
          ? adapter.manual.join(', ')
          : adapter.dhcp.length > 0
            ? `DHCP's (${adapter.dhcp.join(', ')})`
            : 'none'
      }`,
  ),
]

/** Whether `whoami /groups /fo csv` names a label an elevated process runs at. */
export const isElevatedOf = (groups: string): boolean =>
  ELEVATED_LABELS.some(label => groups.includes(`"${label}"`))

/**
 * What the task runs, `cmd` looping over `ozc ignoredpi run`: its output appended to the log, a
 * pause between two runs (launchd's `KeepAlive` — a task's own restart counts only a start that
 * failed, not a run that ended). `USERPROFILE` is set for a run that starts before anyone logs on.
 */
export const commandLineOf = (options: { program: string; home: string; log: string }): string =>
  `/d /s /c "set "USERPROFILE=${options.home}" & for /l %i in (0,0,1) do ("${options.program}" ignoredpi run >>"${options.log}" 2>&1 & ping -n ${RESTART_DELAY_S + 1} 127.0.0.1 >nul)"`

/**
 * The scheduled task: the loop above from home, at boot and at the user's logon (the second is
 * ignored while the first runs), as the user — `S4U`: no window, no password stored — at the
 * highest level the user has, with no time limit and on battery as well.
 */
export const taskOf = (options: {
  user: string
  program: string
  home: string
  log: string
}): string =>
  [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    '  <RegistrationInfo>',
    '    <Description>ozc ignoredpi run: the sites blocked in Turkey opened for every app</Description>',
    '  </RegistrationInfo>',
    '  <Triggers>',
    '    <BootTrigger><Enabled>true</Enabled></BootTrigger>',
    `    <LogonTrigger><Enabled>true</Enabled><UserId>${escaped(options.user)}</UserId></LogonTrigger>`,
    '  </Triggers>',
    '  <Principals>',
    '    <Principal id="Author">',
    `      <UserId>${escaped(options.user)}</UserId>`,
    '      <LogonType>S4U</LogonType>',
    '      <RunLevel>HighestAvailable</RunLevel>',
    '    </Principal>',
    '  </Principals>',
    '  <Settings>',
    '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
    '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
    '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
    '    <AllowHardTerminate>true</AllowHardTerminate>',
    '    <StartWhenAvailable>true</StartWhenAvailable>',
    '    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>',
    '    <IdleSettings>',
    '      <StopOnIdleEnd>false</StopOnIdleEnd>',
    '      <RestartOnIdle>false</RestartOnIdle>',
    '    </IdleSettings>',
    '    <AllowStartOnDemand>true</AllowStartOnDemand>',
    '    <Enabled>true</Enabled>',
    '    <Hidden>false</Hidden>',
    '    <RunOnlyIfIdle>false</RunOnlyIfIdle>',
    '    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>',
    '    <Priority>4</Priority>',
    '  </Settings>',
    '  <Actions Context="Author">',
    '    <Exec>',
    String.raw`      <Command>%SystemRoot%\System32\cmd.exe</Command>`,
    `      <Arguments>${escaped(commandLineOf(options))}</Arguments>`,
    `      <WorkingDirectory>${escaped(options.home)}</WorkingDirectory>`,
    '    </Exec>',
    '  </Actions>',
    '</Task>',
    '',
  ].join('\r\n')

/** Text as `schtasks /XML` reads it: UTF-16LE, a byte order mark first. */
export const utf16Of = (text: string): Uint8Array =>
  Uint8Array.from([0xff, 0xfe, ...unitsOf(text).flatMap(unit => [unit & 0xff, unit >> 8])])

/** What the machine looks like now: the adapters and the NRPT. */
export function* look(): Operation<Look> {
  const printed = yield* powershell('the adapters and the NRPT', LOOK)
  const data = yield* attempt(call(() => JSON.parse(printed) as unknown))
  const looked = isFailure(data) ? undefined : lookOf(data.value)

  if (looked === undefined) {
    return yield* fail(IgnoreDpiErrors.System, `PowerShell answered what it should not: ${printed}`)
  }

  return looked
}

/** Windows: one NRPT rule for every name, and a scheduled task. */
export const windowsHost: Host = {
  name: 'Windows',
  expectPrivileges,
  ispResolver,
  takeDns,
  giveDnsBack,
  sweepDns,
  dnsLines,
  agent: windowsAgent,
}
