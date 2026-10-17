import { attempt, call } from 'std:effect'
import type { Operation } from 'std:effect'
import { IO } from 'std:io'
import { fail, isFailure } from 'std:result'

import { realpath } from 'node:fs/promises'
import { delimiter } from 'node:path'

import { IgnoreDpiErrors } from '../const'
import type { IgnoreDpiDef } from '../types'

import { macosHost } from './macos'
import { windowsHost } from './windows'

/**
 * The machine around the service: how its DNS is pointed at the service and given back, where the
 * ISP's resolver is found, and what keeps the service running — `macos.ts` (every network
 * service's DNS, a LaunchAgent) and `windows.ts` (an NRPT rule for every name, a scheduled task).
 * The commands ask the host of the machine they run on; elsewhere there is none, and only
 * `run --trial` runs.
 */

/** What keeps the service running: started with the machine (or the login), stopped, removed. */
export interface Agent {
  /** What `status` says of it once it is installed. */
  installedAs: string
  /** Where it is kept, as a message names it. */
  where: () => Operation<string>
  /** Installed: it starts with the machine. Active: it holds the service running now. */
  state: () => Operation<{ installed: boolean; active: boolean }>
  /** Write it and start it — a running one is stopped first. */
  install: (options: { program: string; home: string; log: string }) => Operation<void>
  /** Stop it, the service with it; it stays installed. */
  stop: () => Operation<void>
  /** Remove it: it no longer starts. */
  remove: () => Operation<void>
}

export interface Host {
  /** The machine as a message names it. */
  name: string
  /** Fail, saying what to do, unless this process may change the machine's DNS. */
  expectPrivileges: (what: string) => Operation<void>
  /** The resolver DHCP handed out — the ISP's — never the DNS set by hand (this service). */
  ispResolver: () => Operation<string | undefined>
  /**
   * Point the machine's DNS at the service, writing into `saved` what each place had — and
   * `keep`ing it — BEFORE it is changed. `previous` (a crashed run's saved state) wins over what
   * is set now, which would be this service.
   */
  takeDns: (
    previous: IgnoreDpiDef.SavedDns | undefined,
    saved: IgnoreDpiDef.SavedDns,
    keep: () => Operation<void>,
  ) => Operation<void>
  /** Give back what `saved` holds; the places given back. */
  giveDnsBack: (saved: IgnoreDpiDef.SavedDns) => Operation<string[]>
  /** Give back what still points at the service with nothing saved for it; the places given back. */
  sweepDns: () => Operation<string[]>
  /** Where the machine's names go now, a line each, as `status` prints them. */
  dnsLines: () => Operation<string[]>
  agent: Agent
}

/** The host of a machine (`process.platform`), `undefined` where the service cannot be kept yet. */
export const hostOf = (os: string): Host | undefined =>
  os === 'darwin' ? macosHost : os === 'win32' ? windowsHost : undefined

/** The host of this machine, and a `platform` failure where there is none. */
export function* expectHost(what: string): Operation<Host> {
  const { os } = yield* IO.actions.platform()
  const host = hostOf(os)

  if (host === undefined) {
    return yield* fail(
      IgnoreDpiErrors.Platform,
      `${what} is macOS and Windows only for now (this is ${os}): \`ozc ignoredpi run --trial\` runs the service without touching the machine's DNS`,
    )
  }

  return host
}

/**
 * The `ozc` the agent runs: the link on PATH that leads to this very executable (it survives an
 * upgrade, the versioned file behind it does not), else the executable itself. `IGNOREDPI_OZC`
 * names another.
 */
export function* ozcProgram(): Operation<string> {
  const env = yield* IO.actions.env(
    data => ({ ozc: data.IGNOREDPI_OZC, path: data.PATH ?? data.Path }),
    ['ozc', 'path'],
  )

  if (env.ozc !== undefined) {
    return env.ozc
  }

  const { os } = yield* IO.actions.platform()
  const names = os === 'win32' ? ['ozc.exe', 'ozc'] : ['ozc']
  const executable = process.execPath
  const real = yield* attempt(call(() => realpath(executable)))
  const target = isFailure(real) ? executable : real.value

  for (const dir of (env.path ?? '').split(delimiter).filter(entry => entry !== '')) {
    for (const name of names) {
      const candidate = yield* IO.actions.join(dir, name)
      const resolved = yield* attempt(call(() => realpath(candidate)))

      if (!isFailure(resolved) && resolved.value === target) {
        return candidate
      }
    }
  }

  return executable
}
