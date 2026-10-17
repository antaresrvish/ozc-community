import { defineAction } from 'cli:command'
import { Terminal } from 'cli:core'
import { attempt, call, sleep } from 'std:effect'
import { isFailure } from 'std:result'

import { SETTLE_INTERVAL_MS, SETTLE_TRIES } from '../const'
import { placeInput } from '../internal/schemas'
import { isAlive, readState, removeState } from '../internal/state'
import { expectHost } from '../internal/system'

/**
 * `ozc ignoredpi down` — stop the service and give the machine its DNS back. On macOS the service
 * gives it back itself on the way out; whatever it could not (a crash, a kill — on Windows, every
 * stop) is given back here from its state file — and what still points at this machine with
 * nothing saved for it goes back as well (a service to DHCP's; the NRPT rule, the drop-in of
 * systemd-resolved removed). The agent
 * is removed: it no longer starts at login or boot (`up` puts it back).
 */
export const DownAction = defineAction(
  {
    inherits: placeInput,
    description: 'Stop the service and give the DNS back: ignoredpi down',
  },
  function* () {
    const host = yield* expectHost('ignoredpi down')

    yield* host.expectPrivileges('ignoredpi down')

    const before = yield* readState()

    if ((yield* host.agent.state()).installed) {
      yield* host.agent.stop()
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
      given.push(...(yield* host.giveDnsBack(left.savedDns)))
      yield* removeState()
    }

    given.push(...(yield* host.sweepDns()))

    const where = yield* host.agent.where()
    const removed = yield* attempt(host.agent.remove())

    yield* Terminal.actions.write(
      [
        `✓ ignoredpi is down${given.length === 0 ? '' : ` — DNS given back to ${given.join(', ')}`}`,
        isFailure(removed) ? `  (could not remove ${where}: ${removed.message})` : '',
      ]
        .filter(line => line !== '')
        .join('\n')
        .concat('\n'),
    )
  },
)
