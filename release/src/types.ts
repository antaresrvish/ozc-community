import type { Operation } from 'std:effect'

export declare namespace Release {
  /** A plugin of this repository, as a release of its own. */
  interface Plugin {
    /** The directory under `plugins/`: its Moon project's id, so `<dir>:build` builds it. */
    readonly dir: string
    /** What `ozc install` is given, and the tag's prefix: its `package.json`'s `ozc.name`. */
    readonly name: string
    /** The version its `package.json` carries. */
    readonly version: string
  }

  interface Options {
    /** The repository the plugins are under. */
    readonly root: string
    /** Write to GitHub. Without it a run stops short of that, and says what it would have written. */
    readonly publish: boolean
    /** Said as the run goes: one line each. */
    report(line: string): Operation<void>
  }

  /** One file of a release, as it lies in the assets directory. */
  interface Asset {
    readonly file: string
    readonly path: string
    readonly size: number
    readonly sha256: string
  }

  /** A release that is ready: everything that would be, or was, written to GitHub. */
  interface Assembled {
    /** The directory holding the assets, and nothing else. */
    readonly dir: string
    readonly assets: readonly Asset[]
  }

  /**
   * How a plugin's run ended: `released` — its version is out already, nothing was built;
   * `assembled` — a dry run, everything but the write; `published`.
   */
  type Outcome =
    | {
        readonly status: 'released'
        readonly plugin: string
        readonly version: string
        readonly tag: string
      }
    | ({
        readonly status: 'assembled' | 'published'
        readonly plugin: string
        readonly version: string
        readonly tag: string
      } & Assembled)
}
