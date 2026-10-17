import { createTags } from 'std:shared'

/**
 * Failure tags for the `ignoredpi` plugin (`ozc:ignoredpi.*`):
 *   - `config`   — the `[ignoredpi]` config in `ozaco.toml` is invalid
 *   - `platform` — the machine is not one the service can be kept on (macOS only, for now)
 *   - `system`   — a system tool (`networksetup`, `launchctl`) refused what was asked of it
 *   - `listen`   — a port the service needs is taken, or may not be bound
 *   - `service`  — the service is not installed, or not running
 *   - `resolve`  — a name could not be resolved by any upstream
 */
export const IgnoreDpiErrors = createTags(
  'ozc:ignoredpi',
  'config',
  'platform',
  'system',
  'listen',
  'service',
  'resolve',
)

/**
 * The ports the service takes: the DNS every app asks, and the two a browser or an app connects to
 * when the DNS answered a blocked name with this machine. Without root macOS lets a process bind
 * them on the wildcard address only, so that is where they are bound — and anything that does not
 * come from this machine is dropped there, unless `lan = true` (`internal/peers.ts`).
 */
export const DNS_PORT = 53
export const HTTP_PORT = 80
export const HTTPS_PORT = 443
export const WILDCARD = '0.0.0.0'

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

/** How long `up` waits for the service to take the DNS, and `down` for it to give it back. */
export const SETTLE_TRIES = 50
export const SETTLE_INTERVAL_MS = 200

/** How often the running service writes what it did to its state file, in milliseconds. */
export const STATE_INTERVAL_MS = 5000

/** How many recently forwarded names the state keeps (`status` lists them). */
export const RECENT_NAMES = 20

/** The launchd label of the service, and the file names under `~/.ozaco/ignoredpi/`. */
export const LABEL = 'com.ozaco.ignoredpi'
export const STATE_DIR = 'ignoredpi'
export const STATE_FILE = 'state.json'
export const LOG_FILE = 'ignoredpi.log'

/** Seams the suites (and a curious user) point at stand-ins: the system tools the service drives. */
export const LAUNCHCTL_ENV = 'IGNOREDPI_LAUNCHCTL'
export const LAUNCHCTL = '/bin/launchctl'
export const NETWORKSETUP_ENV = 'IGNOREDPI_NETWORKSETUP'
export const NETWORKSETUP = '/usr/sbin/networksetup'
export const IPCONFIG_ENV = 'IGNOREDPI_IPCONFIG'
export const IPCONFIG = '/usr/sbin/ipconfig'
export const DSCACHEUTIL_ENV = 'IGNOREDPI_DSCACHEUTIL'
export const DSCACHEUTIL = '/usr/bin/dscacheutil'

/** What `networksetup` writes in place of a service's DNS servers when it has none set by hand. */
export const NO_DNS_SERVERS = "There aren't any DNS Servers set"
