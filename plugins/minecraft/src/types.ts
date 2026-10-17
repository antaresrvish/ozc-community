/**
 * Local types for the `minecraft` plugin. `MinecraftDef.ServerSpec` is the friendly
 * `[minecraft.<name>]` shape (hand-written source of truth; the zod schema in `internal/schemas.ts`
 * validates into it); it renders to Kubernetes objects in `internal/manifests.ts`.
 */
export namespace MinecraftDef {
  /** A value a configuration file holds: a scalar, a list of scalars, or a table of more. */
  export type ConfigValue = string | number | boolean | (string | number | boolean)[] | ConfigTree

  /** A configuration file's content, as far as the spec sets it: nested as the file is. */
  export interface ConfigTree {
    [key: string]: ConfigValue
  }

  /** How a server is reached from outside the cluster. */
  export type Expose = 'none' | 'nodeport' | 'loadbalancer'

  /** The difficulty, as the server's own property spells it. */
  export type Difficulty = 'peaceful' | 'easy' | 'normal' | 'hard'

  /** One `[minecraft.<name>]` server: ONE pod, ONE world, on the cluster `-p` names. */
  export interface ServerSpec {
    /** The image (default `itzg/minecraft-server`) and its tag (default `latest`). */
    image?: string | undefined
    tag?: string | undefined
    /** The server type the image installs: `PAPER` (default), `VANILLA`, `FABRIC`, `FORGE`, … */
    type?: string | undefined
    /** The Minecraft version (default `LATEST`). */
    version?: string | undefined
    /** The Java heap (`2G` by default); also the pod's memory request. */
    memory?: string | undefined
    /** Pod resources beyond the heap: a cpu request, and the limits. */
    cpu?: string | undefined
    cpuLimit?: string | undefined
    memoryLimit?: string | undefined
    /** The namespace the objects go to (the kubeconfig's default when unset). */
    namespace?: string | undefined
    /** The port players connect to on the Service (default 25565). */
    port?: number | undefined
    /** `loadbalancer` (default — on k3s the node's own address), `nodeport`, or `none` (in-cluster only). */
    expose?: Expose | undefined
    /** A fixed NodePort when `expose = "nodeport"` (else the cluster picks one). */
    nodePort?: number | undefined
    /** The world's volume: its size (default `10Gi`) and storage class. */
    storage?: string | undefined
    storageClass?: string | undefined
    /** Server properties the image sets from its environment. */
    motd?: string | undefined
    difficulty?: Difficulty | undefined
    maxPlayers?: number | undefined
    onlineMode?: boolean | undefined
    /** Operators, and — when given — the whitelist (which is turned on by naming anyone). */
    ops?: string[] | undefined
    whitelist?: string[] | undefined
    /** The server's time zone (`UTC` by default). */
    timezone?: string | undefined
    /**
     * The name players connect by. Nothing in the cluster binds it: `status` says the DNS records
     * it needs — an A record to the address, and an SRV record when the port is not the game's own.
     */
    domain?: string | undefined
    /**
     * What the image installs at start, beside the server: Modrinth projects by slug (`sodium`,
     * `fabric-api:0.102.0+1.21.1`), mods and plugins by jar URL, Spigot resources by id, a modpack
     * archive by URL. Each is the image's own variable, as is.
     */
    modrinth?: string[] | undefined
    /** Whether Modrinth dependencies come along: `none` (the image's default), `required`, `optional`. */
    modrinthDependencies?: 'none' | 'required' | 'optional' | undefined
    mods?: string[] | undefined
    plugins?: string[] | undefined
    spiget?: number[] | undefined
    modpack?: string | undefined
    /** Drop from the server what the lists above no longer name (`REMOVE_OLD_MODS`). */
    removeOldMods?: boolean | undefined
    /**
     * How `backup` snapshots the world unless the line says otherwise: `snapshot` (in-cluster, the
     * default) or `s3` (pushed to the external backup target through the `longhorn-backup` class).
     */
    backup?: 'snapshot' | 's3' | undefined
    /**
     * `server.properties`, any key as the file spells it (`view-distance`, `pvp`, `level-seed`):
     * what the fields above also set (`motd`, `difficulty`, `max-players`, `online-mode`) is this
     * table's when it names the key.
     */
    properties?: Record<string, string | number | boolean> | undefined
    /**
     * The server's own configuration files, nested as each file is: `paper` is
     * `config/paper-global.yml`, `paperWorld` `config/paper-world-defaults.yml`, `bukkit`
     * `bukkit.yml`, `spigot` `spigot.yml` — and `files` any other YAML, JSON, TOML or properties
     * file under `/data`, by its path (`plugins/Essentials/config.yml`). Every leaf is put into the
     * file at start, over what the file has; the rest of the file is left as it is.
     */
    paper?: ConfigTree | undefined
    paperWorld?: ConfigTree | undefined
    bukkit?: ConfigTree | undefined
    spigot?: ConfigTree | undefined
    files?: Record<string, ConfigTree> | undefined
    /** Extra JVM arguments (`JVM_OPTS`), and Aikar's flags (`USE_AIKAR_FLAGS`). */
    jvmOpts?: string[] | undefined
    aikarFlags?: boolean | undefined
    /** Any other variable the image reads, as is — laid over what the fields above set. */
    env?: Record<string, string | number | boolean> | undefined
  }

  /** A server to act on: its name and its spec. */
  export interface ServerTarget {
    name: string
    spec: ServerSpec
  }
}
