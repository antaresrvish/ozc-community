/** The config, the names it lists, the machine's tools as they answer, and the LaunchAgent. */
import { isFailure } from 'std:result'
import { validateSync } from 'std:schema'

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { isInside, isLoopback, isPrivate, isUnder, normalizeName } from '../src/internal/names'
import { sinkholesOf } from '../src/internal/resolver'
import { SettingsSchema } from '../src/internal/schemas'
import { dnsServersOf, plistOf, servicesOf } from '../src/internal/system'

const LISTING = `An asterisk (*) denotes that a network service is disabled.
(1) USB 10/100 LAN
(Hardware Port: USB 10/100 LAN, Device: en7)

(*) Thunderbolt Bridge
(Hardware Port: Thunderbolt Bridge, Device: bridge0)

(4) Wi-Fi
(Hardware Port: Wi-Fi, Device: en0)

(5) Tailscale
(Hardware Port: io.tailscale.ipn.macsys, Device: )
`

describe('the [ignoredpi] table', () => {
  it('holds the example, every field of it', () => {
    const document = Bun.TOML.parse(
      readFileSync(join(import.meta.dir, '..', 'examples', 'ignoredpi.toml'), 'utf8'),
    ) as { ignoredpi?: Record<string, unknown> }
    const settings = SettingsSchema.safeParse(document.ignoredpi)

    expect(settings.success, JSON.stringify(settings.error?.issues)).toBe(true)
    expect(Object.keys(document.ignoredpi ?? {})).toEqual([
      'domains',
      'direct',
      'upstreams',
      'isp',
      'sinkholes',
      'split',
      'lan',
    ])
    expect(settings.data?.domains).toContain('wattpad.com')
  })

  it('takes names as DNS spells them, and upstreams only by address', () => {
    const settings = validateSync(SettingsSchema, { domains: ['*.Example.COM.'], direct: [] })

    expect(isFailure(settings) ? undefined : settings.value.domains).toEqual(['example.com'])
    expect(isFailure(validateSync(SettingsSchema, { domains: ['not a name'] }))).toBe(true)
    expect(
      isFailure(validateSync(SettingsSchema, { upstreams: ['https://dns.google/dns-query'] })),
    ).toBe(true)
    expect(
      isFailure(validateSync(SettingsSchema, { upstreams: ['http://1.1.1.1/dns-query'] })),
    ).toBe(true)
    expect(
      isFailure(
        validateSync(SettingsSchema, { upstreams: ['https://[2606:4700::1111]/dns-query'] }),
      ),
    ).toBe(false)
    expect(isFailure(validateSync(SettingsSchema, { split: 'sideways' }))).toBe(true)
  })
})

describe('names and peers', () => {
  it('match a list by the name or any name under it', () => {
    expect(isUnder('gateway.discord.gg', ['discord.gg'])).toBe(true)
    expect(isUnder('discord.gg', ['discord.gg'])).toBe(true)
    expect(isUnder('notdiscord.gg', ['discord.gg'])).toBe(false)
    expect(normalizeName(' .Discord.com. ')).toBe('discord.com')
  })

  it('are this machine, the private network, or neither', () => {
    expect(isLoopback('127.0.0.1')).toBe(true)
    expect(isLoopback('::ffff:127.0.0.1')).toBe(true)
    expect(isLoopback('::1')).toBe(true)
    expect(isLoopback('192.168.1.20')).toBe(false)
    expect(isPrivate('192.168.1.20')).toBe(true)
    expect(isPrivate('100.101.1.2')).toBe(true)
    expect(isPrivate('8.8.8.8')).toBe(false)
    expect(isInside('192.168.1.20', '192.168.1.0/24')).toBe(true)
    expect(isInside('192.168.2.20', '192.168.1.0/24')).toBe(false)
  })
})

describe('the ISP’s block page', () => {
  it('is the address two canaries get from the ISP that the upstream never gives', () => {
    expect(
      sinkholesOf([
        { isp: ['195.175.254.2'], upstream: ['162.159.138.232'] },
        { isp: ['195.175.254.2'], upstream: ['104.16.1.1'] },
        { isp: ['128.116.1.1'], upstream: ['128.116.2.2'] },
      ]),
    ).toEqual(['195.175.254.2'])
    // an ISP that answers truly has no block page to learn
    expect(
      sinkholesOf([
        { isp: ['162.159.138.232'], upstream: ['162.159.138.232'] },
        { isp: ['104.16.1.1'], upstream: ['104.16.1.1'] },
      ]),
    ).toEqual([])
  })
})

describe('the machine', () => {
  it('lists its network services with their devices, a disabled one marked', () => {
    expect(servicesOf(LISTING)).toEqual([
      { name: 'USB 10/100 LAN', device: 'en7', enabled: true },
      { name: 'Thunderbolt Bridge', device: 'bridge0', enabled: false },
      { name: 'Wi-Fi', device: 'en0', enabled: true },
      { name: 'Tailscale', device: '', enabled: true },
    ])
  })

  it('says a service has no DNS set by hand, or which', () => {
    expect(dnsServersOf("There aren't any DNS Servers set on Wi-Fi.\n")).toEqual([])
    expect(dnsServersOf('127.0.0.1\n1.1.1.1\n')).toEqual(['127.0.0.1', '1.1.1.1'])
  })

  it('keeps the service with a LaunchAgent that runs `ozc ignoredpi run` from home', () => {
    const plist = plistOf({
      program: '/opt/homebrew/bin/ozc',
      home: '/Users/someone',
      log: '/Users/someone/.ozaco/ignoredpi/ignoredpi.log',
      path: '/opt/homebrew/bin:/usr/bin:/bin',
    })

    expect(plist).toContain('<key>Label</key><string>com.ozaco.ignoredpi</string>')
    expect(plist).toContain(
      '<array><string>/opt/homebrew/bin/ozc</string><string>ignoredpi</string><string>run</string></array>',
    )
    expect(plist).toContain('<key>KeepAlive</key><true/>')
    expect(plist).toContain('<string>/Users/someone/.ozaco/ignoredpi/ignoredpi.log</string>')
  })
})
