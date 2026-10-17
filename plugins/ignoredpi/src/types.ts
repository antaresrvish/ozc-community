/**
 * Local types for the `ignoredpi` plugin. `IgnoreDpiDef.Settings` is the `[ignoredpi]` shape
 * (hand-written source of truth; the zod schema in `internal/schemas.ts` validates into it).
 */
export namespace IgnoreDpiDef {
  /**
   * How the TLS hello is cut before it leaves for a blocked name:
   *   - `record`  — into two TLS records, the cut inside the server name, sent as one write: the
   *                 DPI on Türk Telekom reassembles TCP but not TLS records (the default)
   *   - `segment` — into two TCP segments at the same place, one TLS record (SpoofDPI's way)
   *   - `both`    — two records, and the second sent as a segment of its own
   */
  export type Split = 'record' | 'segment' | 'both'

  /** The `[ignoredpi]` table: every field optional — the service runs with none of them. */
  export interface Settings {
    /** Names sent through the forwarder beside the built-in ones (Discord's), each with its subdomains. */
    domains?: string[] | undefined
    /** Names never sent through it, whatever the lists or the ISP say (a bank, a game's login). */
    direct?: string[] | undefined
    /** DNS-over-HTTPS endpoints, by address (`https://1.1.1.1/dns-query`), tried in order. */
    upstreams?: string[] | undefined
    /** The ISP's resolver to tell blocked names by (default: what DHCP gave the machine). */
    isp?: string | undefined
    /** Addresses the ISP answers a blocked name with, beside the built-in and learned ones. */
    sinkholes?: string[] | undefined
    /** How the hello is cut (`record` by default). */
    split?: Split | undefined
    /** Answer other devices on the network too: set their DNS to this machine's address. */
    lan?: boolean | undefined
  }

  /** A verdict on a name: sent through the forwarder, or left to go directly. */
  export type Verdict = 'blocked' | 'direct'

  /** Why a name got its verdict. */
  export type Reason = 'list' | 'direct-list' | 'sinkhole' | 'isp' | 'no-isp'

  /**
   * What each place the service took the DNS of had before: on macOS each network service's
   * servers as `networksetup` had them; on Windows the NRPT, with nothing to save.
   */
  export type SavedDns = Record<string, string[]>

  /** What the running service writes to `~/.ozaco/ignoredpi/state.json` for `status` and `down`. */
  export interface State {
    pid: number
    startedAt: string
    updatedAt: string
    /** The DNS servers each network service had before (empty = none set by hand, DHCP's). */
    savedDns: SavedDns
    /** The ISP resolver blocked names are told by, and the sinkholes in use. */
    isp: string | undefined
    sinkholes: string[]
    counters: Counters
    /** The names most recently sent through the forwarder, newest first. */
    recent: string[]
  }

  export interface Counters {
    queries: number
    redirected: number
    connections: number
    failures: number
  }
}
