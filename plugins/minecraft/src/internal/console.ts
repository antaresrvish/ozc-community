import { K8s } from 'sdk:k8s'
import type { K8sDef } from 'sdk:k8s'

import type { Operation } from 'std:effect'

import { CONSOLE_COMMAND, CONSOLE_TIMEOUT_MS, CONTAINER } from '../const'
import type { MinecraftDef } from '../types'

import { podOf } from './manifests'

/**
 * A command at a server's console, through the image's own `rcon-cli` inside the pod: nothing is
 * reached over the network but the apiserver, and no password leaves the pod. What the server
 * answered, and whether it did, is the caller's to read.
 */
export function* consoleOf(
  target: MinecraftDef.ServerTarget,
  words: readonly string[],
): Operation<K8sDef.ExecResult> {
  return yield* K8s.actions.exec(podOf(target.name), {
    command: [CONSOLE_COMMAND, ...words],
    namespace: target.spec.namespace,
    container: CONTAINER,
    timeoutMs: CONSOLE_TIMEOUT_MS,
  })
}
