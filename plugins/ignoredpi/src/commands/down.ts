import { defineAction } from 'cli:command'
import { Terminal } from 'cli:core'
import { attempt, call, sleep } from 'std:effect'
import { IO } from 'std:io'
import { isFailure } from 'std:result'

import { LOOPBACK, SETTLE_INTERVAL_MS, SETTLE_TRIES } from '../const'
import { placeInput } from '../internal/schemas'
import { isAlive, readState, removeState } from '../internal/state'
import {
  agentState,
  dnsOf,
  expectMacos,
  giveDnsBack,
  networkServices,
  plistFile,
  setDns,
  stopAgent,
} from '../internal/system'

/**
 * `ozc ignoredpi down` — stop the service and give every network service its DNS back. The
 * service gives it back itself on the way out; whatever it could not (a crash, a kill) is given
 * back here from its state file — and a service still pointing at this machine with nothing
 * saved for it goes back to what DHCP hands out. The LaunchAgent is removed: it no longer starts
 * at login (`up` puts it back).
 */
export const DownAction = defineAction(
  {
    inherits: placeInput,
    description: 'Stop the service and give the DNS back: ignoredpi down',
  },
  function* () {
    yield* expectMacos('ignoredpi down')

    const before = yield* readState()

    if ((yield* agentState()).loaded) {
      yield* stopAgent()
    }

    // a foreground `ignoredpi run` holds the DNS as well: it is asked to stop the same way
    const running = yield* readState()

    if (running !== undefined && (yield* isAlive(running.pid))) {
      yield* attempt(call(() => process.kill(running.pid, 'SIGTERM')))
    }

    for (let tries = 0; tries < SETTLE_TRIES; tries++) {
      const state = yield* readState()

      if (state === undefined || !(yield* isAlive(state.pid))) {
        break
      }

      yield* sleep(SETTLE_INTERVAL_MS)
    }

    const left = yield* readState()
    // what the service gave back itself, on its way out
    const given = left === undefined ? Object.keys(before?.savedDns ?? {}) : []

    if (left !== undefined) {
      given.push(...(yield* giveDnsBack(left.savedDns)))
      yield* removeState()
    }

    for (const service of yield* networkServices()) {
      if ((yield* dnsOf(service.name)).includes(LOOPBACK)) {
        yield* setDns(service.name, [])
        given.push(`${service.name} (to DHCP's)`)
      }
    }

    const plist = yield* plistFile()
    const removed = yield* attempt(IO.actions.rm(plist, { force: true }))

    yield* Terminal.actions.write(
      [
        `✓ ignoredpi is down${given.length === 0 ? '' : ` — DNS given back to ${given.join(', ')}`}`,
        isFailure(removed) ? `  (could not remove ${plist}: ${removed.message})` : '',
      ]
        .filter(line => line !== '')
        .join('\n')
        .concat('\n'),
    )
  },
)
