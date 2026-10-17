import { defineAction } from 'cli:command'
import { Terminal } from 'cli:core'
import { attempt } from 'std:effect'
import { IO } from 'std:io'
import { isFailure } from 'std:result'

import { ISP_TIMEOUT_MS } from '../const'
import { TYPE_A, addressesOf, queryOf } from '../internal/dns'
import { helloPiecesOf, serverNameOf } from '../internal/hello'
import { normalizeName } from '../internal/names'
import { describeProbe, helloFor, probe } from '../internal/probe'
import { askPlain } from '../internal/resolver'
import { checkInput, placeInput } from '../internal/schemas'
import { resolverOf } from '../internal/service'
import { loadSettings } from '../internal/settings'
import { readState } from '../internal/state'
import { dhcpResolver } from '../internal/system'

import { tabled } from './status'

/** The words a verdict's reason is printed with. */
const REASONS = {
  list: 'on the list',
  'direct-list': 'kept direct by [ignoredpi].direct',
  sinkhole: 'the ISP answers it with its block page',
  isp: 'the ISP answers it as it is',
  'no-isp': 'no ISP resolver to ask',
} as const

/**
 * `ozc ignoredpi check <names...>` — why a name opens or does not: what the ISP's resolver and the
 * upstream answer for it, what the service decides, and a TLS hello sent to its real address twice
 * — whole, then cut as the service cuts it. A name the DPI resets whole but lets through cut, that
 * the service leaves direct, belongs in `[ignoredpi].domains`. Needs no running service.
 */
export const CheckAction = defineAction(
  {
    inherits: placeInput,
    description:
      'Why a name opens or not — DNS, verdict, TLS whole and cut: ignoredpi check <names...>',
    args: ['names'],
    input: checkInput,
    examples: [
      { run: 'ignoredpi check discord.com', note: 'is it blocked, and does the cut pass' },
    ],
  },
  function* (ctx) {
    const settings = yield* loadSettings(ctx.cwd)
    const { os } = yield* IO.actions.platform()
    const isp =
      settings.isp ??
      (yield* readState())?.isp ??
      (os === 'darwin' ? yield* dhcpResolver() : undefined)
    const resolver = resolverOf(settings, isp)
    const split = settings.split ?? 'record'

    yield* resolver.learn()

    for (const name of ctx.names.map(normalizeName)) {
      const rows: string[][] = []
      const judged = yield* resolver.judge(name)
      const upstream = yield* attempt(resolver.addressesOf(name))
      const addresses = isFailure(upstream) ? [] : upstream.value

      if (isp !== undefined) {
        const said = yield* attempt(
          askPlain({ server: isp, timeoutMs: ISP_TIMEOUT_MS }, queryOf(name, TYPE_A, 0x0c_4e)),
        )
        const seen = isFailure(said) ? [] : addressesOf(said.value)
        const sinkholes = new Set(resolver.sinkholes())

        rows.push([
          `isp ${isp}`,
          isFailure(said)
            ? `no answer (${said.message})`
            : seen
                .map(address => (sinkholes.has(address) ? `${address} (block page)` : address))
                .join(', ') || 'no address',
        ])
      }

      rows.push([
        'upstream',
        isFailure(upstream)
          ? `no answer (${upstream.message})`
          : addresses.join(', ') || 'no address',
      ])

      const address = addresses[0]
      const hello = yield* attempt(helloFor(name))
      const sni = isFailure(hello) ? undefined : serverNameOf(hello.value)

      if (address !== undefined && !isFailure(hello) && sni !== undefined) {
        const whole = yield* probe(address, [hello.value])
        const cut = yield* probe(address, helloPiecesOf(hello.value, sni, split))

        rows.push(['TLS whole', describeProbe(whole)], [`TLS cut (${split})`, describeProbe(cut)])

        if (judged.verdict === 'direct' && whole.kind !== 'answered' && cut.kind === 'answered') {
          rows.push([
            '→',
            `add "${name}" to [ignoredpi].domains: the DPI resets it, the cut passes`,
          ])
        }
      }

      rows.push([
        'verdict',
        `${judged.verdict === 'blocked' ? 'sent through ignoredpi' : 'left direct'} — ${REASONS[judged.reason]}`,
      ])

      yield* Terminal.actions.write(
        `${name}\n${tabled(rows.map(([key, value]) => [`  ${key}`, value ?? '']))}\n`,
      )
    }
  },
)
