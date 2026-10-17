import { createTags } from 'std:shared'

/**
 * Failure tags for the `ignoredpi` plugin (`ozc:ignoredpi.*`):
 *   - `config`   — the `[ignoredpi]` config in `ozaco.toml` is invalid
 *   - `platform`  — the machine is not one the service can be kept on (macOS, Windows, Linux with
 *                   systemd-resolved)
 *   - `privilege` — the command changes what only an administrator may (Windows: the NRPT, the task;
 *                   Linux: systemd-resolved, the unit, the ports below 1024)
 *   - `system`    — a system tool (`networksetup`, `launchctl`, `powershell`, `schtasks`,
 *                   `systemctl`, `resolvectl`) refused what was asked of it
 *   - `listen`    — a port the service needs is taken, or may not be bound
 *   - `service`   — the service is not installed, or not running
 *   - `resolve`   — a name could not be resolved by any upstream
 */
export const IgnoreDpiErrors = createTags(
  'ozc:ignoredpi',
  'config',
  'platform',
  'privilege',
  'system',
  'listen',
  'service',
  'resolve',
)

/**
 * The ports the service takes: the DNS every app asks, and the two a browser or an app connects to
 * when the DNS answered a blocked name with this machine. Without root macOS lets a process bind
 * them on the wildcard address only, so that is where they are bound there — and anything that
 * does not come from this machine is dropped, unless `lan = true` (`admitsOf`). Elsewhere they are
 * bound on {@link LOOPBACK} unless `lan = true`: Windows asks no firewall question for that.
 */
export const DNS_PORT = 53
export const HTTP_PORT = 80
export const HTTPS_PORT = 443
export const WILDCARD = '0.0.0.0'

/**
 * The other ports a TLS client reaches a name answered with this machine on, each forwarded to the
 * same port of the real server: Cloudflare's HTTPS ports, which Discord's voice servers are reached
 * on — its RTC socket is `wss://c-mxp02-….discord.media:2083`, and with nothing on 127.0.0.1:2083
 * a voice channel never connects. One that is taken already is passed over.
 */
export const TLS_PORTS = [2053, 2083, 2087, 2096, 8443] as const

/** The address a blocked name is answered with, for this machine's own apps. */
export const LOOPBACK = '127.0.0.1'

/**
 * Where names are really resolved: DNS over HTTPS, reached by address. A request to an address
 * carries no server name for the DPI to read, and the service never asks the system DNS — which
 * is itself — for its own upstream. Plain DNS to these is what the DPI reads and drops.
 */
export const DEFAULT_UPSTREAMS = [
  'https://1.1.1.1/dns-query',
  'https://8.8.8.8/dns-query',
  'https://1.0.0.1/dns-query',
] as const

/**
 * Names that always go through the forwarder, with every name under them: the ones whose DNS is
 * not always poisoned at the ISP but whose server name the DPI resets anyway. Discord is the
 * reason the plugin exists — its desktop app does not use the system proxy, so a proxy never
 * reached it.
 */
export const BUILTIN_DOMAINS = [
  'discord.com',
  'discord.gg',
  'discord.media',
  'discord.co',
  'discord.dev',
  'discord.gift',
  'discord.new',
  'discordapp.com',
  'discordapp.net',
  'discordstatus.com',
  'dis.gd',
] as const

/**
 * The addresses an ISP's resolver answers a blocked name with — the BTK's block page on Türk
 * Telekom. Other ISPs' pages are learned at start from {@link CANARIES}, or named in `sinkholes`.
 */
export const BUILTIN_SINKHOLES = ['195.175.254.2', '2a01:358:4014:a00::3'] as const

/**
 * Names that are blocked everywhere in Turkey, asked of the ISP's resolver at start: an address it
 * gives for two of them that the upstream never gives for either is the block page — a sinkhole —
 * whatever the ISP.
 */
export const CANARIES = ['discord.com', 'wattpad.com', 'roblox.com'] as const

/** How many canaries have to point at one address before it counts as a sinkhole. */
export const CANARY_QUORUM = 2

/** How long one upstream (DoH) and the ISP's resolver may take to answer, in milliseconds. */
export const UPSTREAM_TIMEOUT_MS = 3000
export const ISP_TIMEOUT_MS = 1500

/** How long a verdict on a name holds, in milliseconds: blocked, direct, or the ISP not answering. */
export const BLOCKED_HOLD_MS = 60 * 60 * 1000
export const DIRECT_HOLD_MS = 10 * 60 * 1000
export const UNSURE_HOLD_MS = 60 * 1000

/** The TTL a blocked name is answered with, and the floor and ceiling of what is cached. */
export const REDIRECT_TTL = 60
export const NEGATIVE_TTL = 60
export const MAX_CACHE_TTL = 300
export const MAX_CACHE_ENTRIES = 10_000

/** How long a client has to send its first bytes (the TLS hello, the HTTP head), and the upstream to accept. */
export const HELLO_TIMEOUT_MS = 10_000
export const CONNECT_TIMEOUT_MS = 10_000

/** The largest TLS hello or HTTP head the forwarder reads before it gives up on a connection. */
export const MAX_HELLO_BYTES = 16_384 + 5
export const MAX_HEAD_BYTES = 16_384

/** The pause between two TCP segments when the hello is also cut on the wire (`split = "both"`). */
export const SEGMENT_GAP_MS = 5

/** How long `down` waits for the service to give the DNS back (and an agent to stop), in tries. */
export const SETTLE_TRIES = 50
export const SETTLE_INTERVAL_MS = 200

/**
 * How long `up` waits for the service to take the DNS, in tries: on Windows a start asks
 * PowerShell twice (the ISP's resolver, the NRPT), seconds each when it starts cold.
 */
export const START_TRIES = 150

/** How often the running service writes what it did to its state file, in milliseconds. */
export const STATE_INTERVAL_MS = 5000

/** How many recently forwarded names the state keeps (`status` lists them). */
export const RECENT_NAMES = 20

/**
 * The launchd label of the service (the scheduled task's name on Windows, the systemd unit's on
 * Linux), and the file names under
 * `~/.ozaco/ignoredpi/` — `task.xml` is the task as it was registered.
 */
export const LABEL = 'com.ozaco.ignoredpi'
export const STATE_DIR = 'ignoredpi'
export const STATE_FILE = 'state.json'
export const LOG_FILE = 'ignoredpi.log'
export const TASK_FILE = 'task.xml'

/**
 * Windows: the comment the service's NRPT rule is found by, and what the state saves for it (the
 * rule is given back by removing it: there is nothing else to save).
 */
export const NRPT_COMMENT = 'ozaco ignoredpi'
export const NRPT_SCOPE = 'every adapter (NRPT)'

/** Windows: the pause between two runs of the service when one ends, in seconds. */
export const RESTART_DELAY_S = 10

/** Windows: the SIDs of the mandatory labels an elevated process runs at (High, System). */
export const ELEVATED_LABELS = ['S-1-16-12288', 'S-1-16-16384'] as const

/**
 * Linux: the unit that keeps the service (`com.ozaco.ignoredpi.service`, where systemd keeps a
 * system's own units), and systemd-resolved's drop-in that points every name at it — under `/run`:
 * a reboot forgets it, a crashed run's with it. What the state saves for it: nothing (the drop-in
 * is given back by removing it).
 */
export const UNIT_FILE = `${LABEL}.service`
export const UNIT_DIR = '/etc/systemd/system'
export const UNIT_DIR_ENV = 'IGNOREDPI_UNIT_DIR'
export const RESOLVED_DIR = '/run/systemd/resolved.conf.d'
export const RESOLVED_DIR_ENV = 'IGNOREDPI_RESOLVED_DIR'
export const RESOLVED_FILE = '99-ozaco-ignoredpi.conf'
export const RESOLVED_SCOPE = 'every name (systemd-resolved)'

/** Seams the suites (and a curious user) point at stand-ins: the system tools the service drives. */
export const LAUNCHCTL_ENV = 'IGNOREDPI_LAUNCHCTL'
export const LAUNCHCTL = '/bin/launchctl'
export const NETWORKSETUP_ENV = 'IGNOREDPI_NETWORKSETUP'
export const NETWORKSETUP = '/usr/sbin/networksetup'
export const IPCONFIG_ENV = 'IGNOREDPI_IPCONFIG'
export const IPCONFIG = '/usr/sbin/ipconfig'
export const DSCACHEUTIL_ENV = 'IGNOREDPI_DSCACHEUTIL'
export const DSCACHEUTIL = '/usr/bin/dscacheutil'
/** Windows' own tools: paths under `%SystemRoot%\System32`. */
export const POWERSHELL_ENV = 'IGNOREDPI_POWERSHELL'
export const POWERSHELL = ['WindowsPowerShell', 'v1.0', 'powershell.exe'] as const
export const SCHTASKS_ENV = 'IGNOREDPI_SCHTASKS'
export const SCHTASKS = 'schtasks.exe'
export const WHOAMI_ENV = 'IGNOREDPI_WHOAMI'
export const WHOAMI = 'whoami.exe'
/** Linux's: by name, found on PATH (sudo's own `secure_path` under sudo). */
export const SUDO_ENV = 'IGNOREDPI_SUDO'
export const SUDO = 'sudo'
export const SYSTEMCTL_ENV = 'IGNOREDPI_SYSTEMCTL'
export const SYSTEMCTL = 'systemctl'
export const RESOLVECTL_ENV = 'IGNOREDPI_RESOLVECTL'
export const RESOLVECTL = 'resolvectl'
export const IP_ENV = 'IGNOREDPI_IP'
export const IP = 'ip'

/** What `networksetup` writes in place of a service's DNS servers when it has none set by hand. */
export const NO_DNS_SERVERS = "There aren't any DNS Servers set"
