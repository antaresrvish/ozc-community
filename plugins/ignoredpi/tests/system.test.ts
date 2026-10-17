/**
 * The machine's DNS taken and given back, through a `networksetup` of the suite's own (the
 * `IGNOREDPI_NETWORKSETUP` seam): two services, one with servers set by hand, one on DHCP's.
 */
import { run } from 'std:effect'
import { isFailure } from 'std:result'

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BunIO } from 'std:io/impl/bun'

import { giveDnsBack, takeDns } from '../src/internal/system'
import type { IgnoreDpiDef } from '../src/types'

const dir = mkdtempSync(join(tmpdir(), 'ignoredpi-system-'))
const seams = ['IGNOREDPI_NETWORKSETUP', 'IGNOREDPI_DSCACHEUTIL'] as const

/** The DNS a service of the stand-in has now: its file's lines, none when it has no file. */
const dnsOf = (service: string): string[] => {
  const file = join(dir, `${service}.dns`)

  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n') : []
}

beforeAll(() => {
  writeFileSync(
    join(dir, 'networksetup'),
    [
      '#!/bin/sh',
      `D=${JSON.stringify(dir)}`,
      'case "$1" in',
      String.raw`  -listnetworkserviceorder) printf 'An asterisk (*) denotes that a network service is disabled.\n(1) Ethernet\n(Hardware Port: Ethernet, Device: en7)\n\n(2) Wi-Fi\n(Hardware Port: Wi-Fi, Device: en0)\n\n(*) Old\n(Hardware Port: Old, Device: en9)\n\n(4) VPN\n(Hardware Port: vpn, Device: )\n' ;;`,
      '  -getdnsservers) if [ -f "$D/$2.dns" ]; then cat "$D/$2.dns"; else echo "There aren\'t any DNS Servers set on $2."; fi ;;',
      String.raw`  -setdnsservers) S="$2"; shift 2; if [ "$1" = Empty ]; then rm -f "$D/$S.dns"; else printf "%s\n" "$@" > "$D/$S.dns"; fi ;;`,
      'esac',
      '',
    ].join('\n'),
  )
  writeFileSync(join(dir, 'dscacheutil'), '#!/bin/sh\n')
  chmodSync(join(dir, 'networksetup'), 0o755)
  chmodSync(join(dir, 'dscacheutil'), 0o755)
  writeFileSync(join(dir, 'Ethernet.dns'), '9.9.9.9\n149.112.112.112\n')
  process.env.IGNOREDPI_NETWORKSETUP = join(dir, 'networksetup')
  process.env.IGNOREDPI_DSCACHEUTIL = join(dir, 'dscacheutil')
})

afterAll(() => {
  for (const seam of seams) {
    Reflect.deleteProperty(process.env, seam)
  }

  rmSync(dir, { recursive: true, force: true })
})

describe("the machine's DNS", () => {
  it('is taken by every service on a device — what each had saved before it is changed — and given back', async () => {
    const saved: IgnoreDpiDef.SavedDns = {}
    const kept: IgnoreDpiDef.SavedDns[] = []
    const taken = await run(function* () {
      yield* BunIO.use()
      yield* takeDns(undefined, saved, function* () {
        kept.push({ ...saved })
      })
    })

    expect(isFailure(taken)).toBe(false)
    expect(saved).toEqual({ Ethernet: ['9.9.9.9', '149.112.112.112'], 'Wi-Fi': [] })
    // on disk before each change: the first keep already names Ethernet's servers
    expect(kept[0]).toEqual({ Ethernet: ['9.9.9.9', '149.112.112.112'] })
    expect(dnsOf('Ethernet')).toEqual(['127.0.0.1'])
    expect(dnsOf('Wi-Fi')).toEqual(['127.0.0.1'])
    expect(dnsOf('Old')).toEqual([])

    const given = await run(function* () {
      yield* BunIO.use()

      return yield* giveDnsBack(saved)
    })

    expect(isFailure(given) ? undefined : given.value).toEqual(['Ethernet', 'Wi-Fi'])
    expect(dnsOf('Ethernet')).toEqual(['9.9.9.9', '149.112.112.112'])
    expect(dnsOf('Wi-Fi')).toEqual([])
  })

  it("is not saved as the service's own after a crash: the dead run's record wins", async () => {
    writeFileSync(join(dir, 'Wi-Fi.dns'), '127.0.0.1\n')

    const saved: IgnoreDpiDef.SavedDns = {}

    await run(function* () {
      yield* BunIO.use()
      yield* takeDns({ 'Wi-Fi': ['1.1.1.1'] }, saved, function* () {})
    })

    expect(saved).toEqual({ Ethernet: ['9.9.9.9', '149.112.112.112'], 'Wi-Fi': ['1.1.1.1'] })
  })
})
