import { defineCommand } from 'cli:command'
import { Config } from 'std:config'
import { FetchClient } from 'std:fetch'

import { TomlCodec } from 'std:codec/impl/toml'

import { CheckAction } from './commands/check'
import { DownAction } from './commands/down'
import { LogsAction } from './commands/logs'
import { RunAction } from './commands/run'
import { StatusAction } from './commands/status'
import { UpAction } from './commands/up'
import { placeInput, placeShort } from './internal/schemas'

/**
 * `ozc ignoredpi …` — open the sites blocked in Turkey for every app on this machine, with no
 * proxy setting anywhere. The service is the machine's DNS: a name is resolved over DNS-over-HTTPS
 * (by address, so the DPI sees no name), and a blocked one — on the lists (Discord's, and
 * `[ignoredpi].domains`), or one the ISP's resolver answers with its block page — is answered
 * with this machine. A connection to it arrives at the service's forwarder (443, 80), which reads
 * the name the client meant from its TLS hello (or HTTP Host), connects to the real address, and
 * sends that hello cut in two TLS records, the cut inside the name: the DPI reads one record at a
 * time and never sees the name whole. The TLS itself is never opened — the app talks to the real
 * server, certificate and all. `up` keeps it running — a LaunchAgent on macOS, a scheduled task
 * on Windows — and `down` gives the DNS back (`internal/system.ts`); elsewhere `run --trial` runs
 * it.
 */
export const command = defineCommand({
  name: 'ignoredpi',
  description: 'Open the sites blocked in Turkey for every app (a local DNS + TLS forwarder)',
  actions: {
    up: UpAction,
    down: DownAction,
    status: StatusAction,
    check: CheckAction,
    logs: LogsAction,
    run: RunAction,
  },
  input: placeInput,
  short: placeShort,
  examples: [
    { run: 'ignoredpi up', note: 'start it, keep it running, point the DNS at it' },
    { run: 'ignoredpi status', note: 'whose DNS it holds, what it sent through' },
    { run: 'ignoredpi check discord.com', note: 'why a name opens or not' },
    { run: 'ignoredpi logs -f', note: 'follow what it does' },
    { run: 'ignoredpi down', note: 'stop it and give the DNS back' },
  ],
  *setup() {
    // the host resolves this bundle's std to its own: re-installing the same impl is idempotent
    yield* TomlCodec.use()
    yield* Config.use()
    yield* FetchClient.use()
  },
})
