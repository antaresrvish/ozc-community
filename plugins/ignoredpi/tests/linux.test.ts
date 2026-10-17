/**
 * Linux as the service sees it: what `resolvectl` and `ip` list, the ISP's resolver found in it,
 * the unit — pure — and the DNS taken and given back through stand-ins of the suite's own
 * (`IGNOREDPI_SUDO`, `IGNOREDPI_SYSTEMCTL`, `IGNOREDPI_RESOLVECTL`, `IGNOREDPI_IP`, the drop-in and
 * unit directories in a temp dir). The stand-ins are shell scripts: on Windows the suite is skipped.
 */
import { run } from 'std:effect'
import { isFailure } from 'std:result'

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BunIO } from 'std:io/impl/bun'

import {
  DROP_IN,
  addressOf,
  dnsLinesOf,
  ispOf,
  linksOf,
  linuxHost,
  routesOf,
  unitOf,
} from '../src/internal/linux'
import type { Look } from '../src/internal/linux'
import type { IgnoreDpiDef } from '../src/types'

/** What `resolvectl` printed on a machine with Wi-Fi, a cable unplugged and Tailscale. */
const DNS = [
  'Global:',
  'Link 2 (enp8s0):',
  'Link 3 (wlp5s0): 192.168.1.1 fe80::1',
  'Link 4 (tailscale0): 100.100.100.100 fd7a:115c:a1e0::53',
  '',
].join('\n')
const DOMAINS = [
  'Global:',
  'Link 2 (enp8s0):',
  'Link 3 (wlp5s0): local',
  'Link 4 (tailscale0): tail7cf643.ts.net ~0.e.1.a.c.5.1.1.a.7.d.f.ip6.arpa',
  '        ~100.100.in-addr.arpa ~101.100.in-addr.arpa',
  '        ~ts.net',
  '',
].join('\n')
const DEFAULTS = [
  'Link 2 (enp8s0): no',
  'Link 3 (wlp5s0): yes',
  'Link 4 (tailscale0): no',
  '',
].join('\n')

const LOOKED: Look = {
  servers: linksOf(DNS),
  domains: linksOf(DOMAINS),
  defaults: ['wlp5s0'],
  routes: ['wlp5s0'],
}

const dir = mkdtempSync(join(tmpdir(), 'ignoredpi-linux-'))
const calls = join(dir, 'calls')
const seams = {
  IGNOREDPI_SUDO: join(dir, 'sudo'),
  IGNOREDPI_SYSTEMCTL: join(dir, 'systemctl'),
  IGNOREDPI_RESOLVECTL: join(dir, 'resolvectl'),
  IGNOREDPI_IP: join(dir, 'ip'),
  IGNOREDPI_RESOLVED_DIR: join(dir, 'run', 'resolved.conf.d'),
  IGNOREDPI_UNIT_DIR: join(dir, 'etc', 'system'),
} as const
const dropIn = join(seams.IGNOREDPI_RESOLVED_DIR, '99-ozaco-ignoredpi.conf')

/** What the stand-ins were asked, a line each, since the last look. */
const calledOf = (): string[] => {
  const lines = existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : []

  rmSync(calls, { force: true })

  return lines.filter(line => line !== '')
}

/** A stand-in that writes what it was asked to the calls, then `body`. */
const standIn = (file: string, name: string, body: string[]): void => {
  writeFileSync(
    file,
    ['#!/bin/sh', `echo "${name} $*" >> ${JSON.stringify(calls)}`, ...body, ''].join('\n'),
  )
  chmodSync(file, 0o755)
}

beforeAll(() => {
  // sudo runs what it is given, as the suite: the directories are the suite's own
  standIn(seams.IGNOREDPI_SUDO, 'sudo', ['[ "$1" = -v ] && exit 0', 'exec "$@"'])
  standIn(seams.IGNOREDPI_SYSTEMCTL, 'systemctl', ['[ "$1" = is-active ] && exit 3', 'exit 0'])
  writeFileSync(join(dir, 'dns'), DNS)
  writeFileSync(join(dir, 'domain'), DOMAINS)
  writeFileSync(join(dir, 'default-route'), DEFAULTS)
  standIn(seams.IGNOREDPI_RESOLVECTL, 'resolvectl', [
    `[ -f ${JSON.stringify(dir)}/"$1" ] && cat ${JSON.stringify(dir)}/"$1"`,
    'exit 0',
  ])
  standIn(seams.IGNOREDPI_IP, 'ip', [
    `echo '[{"dst":"default","gateway":"192.168.1.1","dev":"wlp5s0","metric":600}]'`,
  ])
  Object.assign(process.env, seams)
})

afterAll(() => {
  for (const seam of Object.keys(seams)) {
    Reflect.deleteProperty(process.env, seam)
  }

  rmSync(dir, { recursive: true, force: true })
})

describe('the machine, on Linux', () => {
  it('reads what resolvectl lists, its wrapped lines joined back', () => {
    expect(LOOKED.servers).toEqual([
      { name: 'Global', index: undefined, values: [] },
      { name: 'enp8s0', index: 2, values: [] },
      { name: 'wlp5s0', index: 3, values: ['192.168.1.1', 'fe80::1'] },
      { name: 'tailscale0', index: 4, values: ['100.100.100.100', 'fd7a:115c:a1e0::53'] },
    ])
    expect(LOOKED.domains.at(-1)?.values).toEqual([
      'tail7cf643.ts.net',
      '~0.e.1.a.c.5.1.1.a.7.d.f.ip6.arpa',
      '~100.100.in-addr.arpa',
      '~101.100.in-addr.arpa',
      '~ts.net',
    ])
  })

  it('names a server bare, and the default routes the lowest metric first', () => {
    expect(addressOf('1.1.1.1#cloudflare-dns.com')).toBe('1.1.1.1')
    expect(addressOf('192.168.1.1:53')).toBe('192.168.1.1')
    expect(addressOf('fe80::1%3')).toBe('fe80::1')
    expect(addressOf('[2606:4700::1111]:853')).toBe('2606:4700::1111')
    expect(
      routesOf([
        { dst: 'default', dev: 'wlp5s0', metric: 600 },
        { dst: 'default', dev: 'enp8s0', metric: 100 },
      ]),
    ).toEqual(['enp8s0', 'wlp5s0'])
    expect(routesOf({ not: 'routes' })).toEqual([])
  })

  it('finds the ISP’s resolver on the link the default route leaves by', () => {
    expect(ispOf(LOOKED)).toBe('192.168.1.1')
    // with no route known, a link that is a default route of the DNS
    expect(ispOf({ ...LOOKED, routes: [] })).toBe('192.168.1.1')
    // a VPN's own servers are not the ISP's, nor the service's
    expect(ispOf({ ...LOOKED, routes: ['tailscale0'], defaults: [] })).toBe('100.100.100.100')
    expect(
      ispOf({ ...LOOKED, servers: linksOf('Link 3 (wlp5s0): 127.0.0.1 fe80::1\n') }),
    ).toBeUndefined()
  })

  it('says where names go: every name to the service first, then each link', () => {
    const taken: Look = {
      ...LOOKED,
      servers: linksOf(DNS.replace('Global:', 'Global: 127.0.0.1')),
      domains: linksOf(DOMAINS.replace('Global:', 'Global: ~.')),
    }

    expect(dnsLinesOf(taken, true)).toEqual([
      'every name → 127.0.0.1 (systemd-resolved)',
      'wlp5s0 → 192.168.1.1, fe80::1',
      'tailscale0 → 100.100.100.100, fd7a:115c:a1e0::53 (its own names)',
    ])
    expect(dnsLinesOf(LOOKED, false)[0]).toBe('wlp5s0 → 192.168.1.1, fe80::1')
  })

  it('keeps the service with a unit that runs `ozc ignoredpi run` as root through a shell', () => {
    const unit = unitOf({
      program: '/home/some one/.ozaco/bin/ozc',
      home: '/home/some one',
      log: '/home/some one/.ozaco/ignoredpi/ignoredpi.log',
      path: '/home/some one/.ozaco/bin:/usr/bin',
    })

    expect(unit).toContain(
      String.raw`ExecStart=/bin/sh -c "exec \"$$0\" ignoredpi run >>\"$$1\" 2>&1" "/home/some one/.ozaco/bin/ozc" "/home/some one/.ozaco/ignoredpi/ignoredpi.log"`,
    )
    expect(unit).toContain(
      'Environment="OZC_HOME=/home/some one" "PATH=/home/some one/.ozaco/bin:/usr/bin"',
    )
    expect(unit).toContain('Restart=always')
    expect(unit).toContain('WantedBy=multi-user.target')
    expect(unit).not.toContain('User=')
    expect(unitOf({ program: '/p%n', home: '/h', log: '/l', path: '/b' })).toContain('"/p%%n"')
  })
})

describe.skipIf(process.platform === 'win32')("the machine's DNS, on Linux", () => {
  it('is taken with a drop-in of systemd-resolved — kept before it is written — and given back', async () => {
    const saved: IgnoreDpiDef.SavedDns = {}
    const kept: IgnoreDpiDef.SavedDns[] = []
    const asRoot = process.getuid?.() !== 0

    calledOf()

    const taken = await run(function* () {
      yield* BunIO.use()
      yield* linuxHost.takeDns(undefined, saved, function* () {
        kept.push({ ...saved })
        // on disk before the drop-in is
        expect(existsSync(dropIn)).toBe(false)
      })
    })

    expect(isFailure(taken)).toBe(false)
    expect(saved).toEqual({ 'every name (systemd-resolved)': [] })
    expect(kept).toEqual([{ 'every name (systemd-resolved)': [] }])
    expect(readFileSync(dropIn, 'utf8')).toBe(DROP_IN)
    expect(DROP_IN).toContain('DNS=127.0.0.1\nDomains=~.\n')
    const called = calledOf()

    // written and reloaded as root: through sudo, unless the suite is root itself
    expect(called).toContain('systemctl reload-or-restart systemd-resolved.service')
    expect(called.includes(`sudo tee ${dropIn}`)).toBe(asRoot)

    const given = await run(function* () {
      yield* BunIO.use()

      return [yield* linuxHost.giveDnsBack(saved), yield* linuxHost.sweepDns()]
    })

    expect(isFailure(given) ? undefined : given.value).toEqual([
      ['every name (systemd-resolved)'],
      [],
    ])
    expect(existsSync(dropIn)).toBe(false)
    // given back without waiting for resolved's job: inside the unit's own stop it would wait for
    // that stop to end
    expect(calledOf()).toContain('systemctl --no-block reload-or-restart systemd-resolved.service')
  })

  it('sweeps a drop-in a crashed run left, and says where names go', async () => {
    writeFileSync(dropIn, DROP_IN)

    const swept = await run(function* () {
      yield* BunIO.use()

      return [
        yield* linuxHost.dnsLines(),
        yield* linuxHost.sweepDns(),
        yield* linuxHost.ispResolver(),
      ]
    })

    expect(isFailure(swept) ? undefined : swept.value).toEqual([
      [
        'wlp5s0 → 192.168.1.1, fe80::1',
        'tailscale0 → 100.100.100.100, fd7a:115c:a1e0::53 (its own names)',
      ],
      ['every name (systemd-resolved)'],
      '192.168.1.1',
    ])
    expect(existsSync(dropIn)).toBe(false)
  })

  it('installs the unit, enables and starts it, and removes it', async () => {
    const unit = join(seams.IGNOREDPI_UNIT_DIR, 'com.ozaco.ignoredpi.service')
    const options = { program: '/opt/ozc/bin/ozc', home: '/home/x', log: '/home/x/log' }

    calledOf()

    const installed = await run(function* () {
      yield* BunIO.use()
      yield* linuxHost.agent.install(options)

      return yield* linuxHost.agent.state()
    })

    expect(isFailure(installed) ? undefined : installed.value).toEqual({
      installed: true,
      active: false,
    })
    expect(readFileSync(unit, 'utf8')).toContain('"PATH=/opt/ozc/bin:/usr/local/sbin')

    const systemctl = calledOf()
      .filter(line => line.startsWith('systemctl '))
      .map(line => line.replace('systemctl ', ''))

    expect(systemctl).toEqual([
      'daemon-reload',
      'enable com.ozaco.ignoredpi.service',
      'restart com.ozaco.ignoredpi.service',
      'is-active com.ozaco.ignoredpi.service',
    ])

    const removed = await run(function* () {
      yield* BunIO.use()
      yield* linuxHost.agent.remove()

      return yield* linuxHost.agent.state()
    })

    expect(isFailure(removed) ? undefined : removed.value).toEqual({
      installed: false,
      active: false,
    })
    expect(existsSync(unit)).toBe(false)
  })
})
