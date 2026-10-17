import { homeDir } from 'sdk:core'

import { defineAction } from 'cli:command'
import { Terminal } from 'cli:core'
import { sleep } from 'std:effect'
import type { Operation } from 'std:effect'
import { IO } from 'std:io'
import { fail } from 'std:result'

import { IgnoreDpiErrors, LOOPBACK, SETTLE_INTERVAL_MS, START_TRIES } from '../const'
import { placeInput } from '../internal/schemas'
import { loadSettings } from '../internal/settings'
import { isAlive, logFile, readState, stateDir, tailOf } from '../internal/state'
import { expectHost, ozcProgram } from '../internal/system'
import type { IgnoreDpiDef } from '../types'

/** The running service's state, once a live process wrote it — `undefined` if none did in time. */
function* settled(before: number | undefined): Operation<IgnoreDpiDef.State | undefined> {
  for (let tries = 0; tries < START_TRIES; tries++) {
    const state = yield* readState()

    if (state !== undefined && state.pid !== before && (yield* isAlive(state.pid))) {
      return state
    }

    yield* sleep(SETTLE_INTERVAL_MS)
  }

  return undefined
}

/**
 * `ozc ignoredpi up` — keep the service running on this machine: write what starts it — on macOS
 * a LaunchAgent (`~/Library/LaunchAgents/com.ozaco.ignoredpi.plist`, `ozc ignoredpi run` at every
 * login and again whenever it stops), on Windows a scheduled task (`com.ozaco.ignoredpi`, from
 * boot, run again whenever it stops; an administrator's terminal registers it) — and start it.
 * Once it runs, the machine's DNS points at it: every app — a browser, the Discord app, a game
 * launcher — reaches blocked names through it with no proxy setting of its own. Run again after
 * changing `[ignoredpi]`: the service restarts.
 */
export const UpAction = defineAction(
  {
    inherits: placeInput,
    description:
      'Start the service and keep it running (LaunchAgent, scheduled task): ignoredpi up',
  },
  function* (ctx) {
    const host = yield* expectHost('ignoredpi up')

    yield* host.expectPrivileges('ignoredpi up')
    // a config that does not hold fails here, not in a log line the agent restarts every 10 s
    yield* loadSettings(ctx.cwd)

    const home = yield* homeDir()
    const log = yield* logFile()
    const program = yield* ozcProgram()
    const before = (yield* readState())?.pid

    yield* IO.actions.ensureDir(yield* stateDir())

    if ((yield* host.agent.state()).active) {
      yield* Terminal.actions.write('→ restarting ignoredpi\n')
    }

    yield* host.agent.install({ program, home, log })

    const state = yield* settled(before)

    if (state === undefined) {
      const said = yield* tailOf(log, 15)

      return yield* fail(
        IgnoreDpiErrors.Service,
        `ignoredpi did not come up (its log, ${log}):\n${said === '' ? '(empty)' : said}`,
      )
    }

    const services = Object.keys(state.savedDns)

    yield* Terminal.actions.write(
      [
        `✓ ignoredpi is up (pid ${state.pid}) — DNS of ${services.join(', ') || 'no service'} → ${LOOPBACK}`,
        `  blocked names are told by ${state.isp ?? 'the lists alone (no ISP resolver found)'}; sinkholes ${state.sinkholes.join(', ')}`,
        '  `ozc ignoredpi status` shows what it does, `ozc ignoredpi down` gives the DNS back',
        '',
      ].join('\n'),
    )
  },
)
