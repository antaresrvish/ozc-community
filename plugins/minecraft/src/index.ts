import { accessInput, accessShort } from 'sdk:core'
import { K8s, KUBECONFIG_NAMESPACE } from 'sdk:k8s'
import { Profile } from 'sdk:profile'

import { defineCommand } from 'cli:command'
import { DefaultTable } from 'cli:table'
import { Config } from 'std:config'

import { TomlCodec } from 'std:codec/impl/toml'
import { YamlCodec } from 'std:codec/impl/yaml'

import { BackupAction } from './commands/backup'
import { BackupsAction } from './commands/backups'
import { ConsoleAction } from './commands/console'
import { DownAction } from './commands/down'
import { LogsAction } from './commands/logs'
import { PreviewAction } from './commands/preview'
import { PruneAction } from './commands/prune'
import { RestoreAction } from './commands/restore'
import { StatusAction } from './commands/status'
import { UpAction } from './commands/up'

/**
 * `ozc minecraft …` — Minecraft servers on the cluster. Each `[minecraft.<name>]` in `ozaco.toml`
 * is one server: `itzg/minecraft-server` as a StatefulSet of one, its world on a claim of its own,
 * reached through a Service — on k3s a LoadBalancer one, which ServiceLB puts on the node's own
 * address (`internal/manifests.ts`). The target cluster is `[kube].profile` / `-p`, reached via
 * `sdk:k8s`. The console is the image's `rcon-cli`, run inside the pod. Mods and plugins are the
 * spec's lists, installed by the image at start; a backup is a Longhorn `VolumeSnapshot` of the
 * world, the world held still meanwhile; a `domain` is the player's name for it — `status` says
 * the DNS records it needs. Several servers are several tables, each on a port of its own.
 */
export const command = defineCommand({
  name: 'minecraft',
  description: 'Run Minecraft servers on the cluster ([minecraft.*] → StatefulSet/Service/PVC)',
  actions: {
    up: UpAction,
    down: DownAction,
    status: StatusAction,
    logs: LogsAction,
    console: ConsoleAction,
    preview: PreviewAction,
    backup: BackupAction,
    backups: BackupsAction,
    restore: RestoreAction,
    prune: PruneAction,
  },
  input: accessInput,
  short: accessShort,
  examples: [
    { run: 'minecraft up', note: 'deploy every [minecraft.*]' },
    { run: 'minecraft up survival', note: 'deploy just survival' },
    { run: 'minecraft status', note: 'every server: ready, address, players' },
    { run: 'minecraft logs survival -f', note: 'follow its log' },
    { run: 'minecraft console survival list', note: 'who is online' },
    { run: 'minecraft preview survival', note: 'the objects, no cluster needed' },
    { run: 'minecraft down survival', note: 'remove it (keeps the world)' },
    { run: 'minecraft down survival --volumes', note: 'remove it, world included' },
    { run: 'minecraft backup survival', note: 'snapshot its world (Longhorn)' },
    { run: 'minecraft backup survival --s3', note: 'push the backup to the backup target' },
    { run: 'minecraft backups survival', note: 'its backups' },
    {
      run: 'minecraft restore survival',
      note: 'the world as the newest backup had it (down first)',
    },
    { run: 'minecraft prune survival --from data-survival-0-2026-…', note: 'delete one backup' },
  ],
  *setup() {
    // `ozaco.toml` is TOML. The host resolves this bundle's std to its own, so this is the host's
    // `TomlCodec`: re-installing the same impl is idempotent.
    yield* TomlCodec.use()
    yield* YamlCodec.use()
    yield* DefaultTable.use()
    yield* Config.use()
    yield* Profile.use({ namespace: KUBECONFIG_NAMESPACE })
    yield* K8s.use()
  },
})
