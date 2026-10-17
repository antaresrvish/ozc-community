import { defineAction } from 'cli:command'
import { Terminal } from 'cli:core'
import { attempt, ensure, spawn, sleep, suspend } from 'std:effect'
import type { Operation } from 'std:effect'
import { IO } from 'std:io'
import { isFailure } from 'std:result'

import { STATE_INTERVAL_MS } from '../const'
import { placeInput, runInput } from '../internal/schemas'
import { SYSTEM_PORTS, resolverOf, serve } from '../internal/service'
import { loadSettings } from '../internal/settings'
import { isAlive, readState, removeState, writeState } from '../internal/state'
import { dhcpResolver, expectMacos, giveDnsBack, takeDns } from '../internal/system'
import type { IgnoreDpiDef } from '../types'

/** A line of the service's log, stamped. */
function* log(line: string): Operation<void> {
  yield* Terminal.actions.write(`${new Date().toISOString()} ${line}\n`)
}

/**
 * `ozc ignoredpi run` — the service itself, in the foreground: what the LaunchAgent `up` writes
 * starts. It takes its ports first (DNS 53, HTTP 80, HTTPS 443 — on the wildcard address, the only
 * one macOS lets a user bind them on, answering this machine alone), then points every network
 * service's DNS at itself; on the way out (Ctrl-C, `down`) it gives each its DNS back. A run that
 * crashed left what to give back in the state file, and the next one takes it from there.
 *
 * `--trial` leaves the machine's DNS alone and `--dns`/`--https`/`--http` move it off the system's
 * ports: `dig @127.0.0.1 -p 5353 discord.com`, then
 * `curl --connect-to ::127.0.0.1:8443 https://discord.com`.
 */
export const RunAction = defineAction(
  {
    inherits: placeInput,
    description:
      'Run the service in the foreground: ignoredpi run [--trial] [--dns n] [--https n] [--http n]',
    input: runInput,
    examples: [
      { run: 'ignoredpi run', note: 'what the LaunchAgent runs: takes DNS, 80 and 443' },
      {
        run: 'ignoredpi run --trial --dns 5353 --https 8443 --http 8080',
        note: 'a trial on ports of its own, the machine’s DNS untouched',
      },
    ],
  },
  function* (ctx) {
    const settings = yield* loadSettings(ctx.cwd)
    const ports = {
      dns: ctx.dns ?? SYSTEM_PORTS.dns,
      http: ctx.http ?? SYSTEM_PORTS.http,
      https: ctx.https ?? SYSTEM_PORTS.https,
    }
    const system = !ctx.trial

    if (system) {
      yield* expectMacos('pointing the machine’s DNS at the service')
    }

    const previous = yield* readState()

    // the ISP's resolver: the config's, else what DHCP handed out — never the DNS set by hand,
    // which is this service once it runs
    const { os } = yield* IO.actions.platform()
    const isp = settings.isp ?? (os === 'darwin' ? yield* dhcpResolver() : undefined)
    const resolver = resolverOf(settings, isp)
    const forwarder = yield* serve({ settings, resolver, ports, log })
    const sinkholes = yield* resolver.learn()

    yield* log(
      `ignoredpi up: dns :${ports.dns}, https :${ports.https}, http :${ports.http}; isp ${isp ?? 'none'}; sinkholes ${sinkholes.join(', ')}; split ${settings.split ?? 'record'}`,
    )

    const savedDns: IgnoreDpiDef.SavedDns = {}
    const startedAt = new Date().toISOString()
    const stateNow = (): IgnoreDpiDef.State => ({
      pid: process.pid,
      startedAt,
      updatedAt: new Date().toISOString(),
      savedDns,
      isp,
      sinkholes: resolver.sinkholes(),
      counters: {
        queries: resolver.counters.queries,
        redirected: resolver.counters.redirected,
        connections: forwarder.stats.connections,
        failures: forwarder.stats.failures,
      },
      recent: forwarder.stats.recent,
    })

    if (system) {
      // a run that died left the DNS pointing here; what it saved is the truth, not what is set now
      const crashed =
        previous !== undefined && !(yield* isAlive(previous.pid)) ? previous.savedDns : undefined

      yield* ensure(function* () {
        const restored = yield* attempt(giveDnsBack(savedDns))

        yield* attempt(removeState())
        yield* attempt(
          log(
            isFailure(restored)
              ? `✗ could not give the DNS back: ${restored.message}`
              : `ignoredpi down: DNS given back to ${restored.value.join(', ') || 'no service'}`,
          ),
        )
      })

      // on disk before each service is changed: a crash at any point still knows what to give back
      yield* takeDns(crashed, savedDns, () => writeState(stateNow()))
      yield* log(`DNS of ${Object.keys(savedDns).join(', ') || 'no service'} now points here`)

      yield* spawn(function* () {
        for (;;) {
          yield* attempt(writeState(stateNow()))
          yield* sleep(STATE_INTERVAL_MS)
        }
      })
    }

    yield* suspend()
  },
)
