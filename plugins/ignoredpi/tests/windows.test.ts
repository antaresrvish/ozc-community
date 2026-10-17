/**
 * Windows as the service sees it: what PowerShell reports of the adapters and the NRPT, the ISP's
 * resolver found in it, whether a terminal is elevated, and the scheduled task — pure. On Windows
 * the report is also read from the machine itself (read only: nothing is changed).
 */
import { run } from 'std:effect'
import { isFailure } from 'std:result'

import { describe, expect, it } from 'bun:test'

import { BunIO } from 'std:io/impl/bun'

import { listenOn } from '../src/internal/service'
import { isAlive } from '../src/internal/state'
import { hostOf } from '../src/internal/system'
import {
  commandLineOf,
  dnsLinesOf,
  encodedOf,
  isElevatedOf,
  ispOf,
  look,
  lookOf,
  quotedOf,
  taskOf,
  utf16Of,
} from '../src/internal/windows'

/** What the look script printed on a machine with Wi-Fi, Tailscale and the service's rule. */
const PRINTED = {
  adapters: [
    { name: 'Tailscale', index: 30, dhcp: '', manual: '', metric: null },
    { name: 'Ethernet', index: 5, dhcp: '10.0.0.1', manual: '9.9.9.9,149.112.112.112', metric: 60 },
    { name: 'Wi-Fi', index: 9, dhcp: '192.168.1.1 192.168.1.2', manual: '', metric: 30 },
  ],
  rules: [
    {
      name: '{6F3DBA2B-DF7D-410D-8611-FA38E973731A}',
      namespace: ['.ts.net'],
      servers: ['100.100.100.100'],
      comment: '',
    },
    { name: '{A1}', namespace: ['.'], servers: ['127.0.0.1'], comment: 'ozaco ignoredpi' },
  ],
}

/** A script back from `-EncodedCommand`. */
const decodedOf = (encoded: string): string => {
  const binary = atob(encoded)
  let text = ''

  for (let index = 0; index < binary.length; index += 2) {
    text += String.fromCodePoint(
      (binary.codePointAt(index) ?? 0) | ((binary.codePointAt(index + 1) ?? 0) << 8),
    )
  }

  return text
}

describe('the machine, on Windows', () => {
  it('is one the service can be kept on, and bound on 127.0.0.1 unless the network is asked for', () => {
    expect(hostOf('win32')?.name).toBe('Windows')
    expect(hostOf('darwin')?.name).toBe('macOS')
    expect(hostOf('linux')).toBeUndefined()
    expect(listenOn('win32', false)).toBe('127.0.0.1')
    expect(listenOn('win32', true)).toBe('0.0.0.0')
    expect(listenOn('darwin', false)).toBe('0.0.0.0')
  })

  it('takes a process that is there but not its own to signal for alive — the elevated service, asked from a terminal that is not', async () => {
    const asked = await run(function* () {
      yield* BunIO.use()

      // the System process on Windows, init or launchd elsewhere: never this user's to signal;
      // and a pid above any the kernels hand out
      return [yield* isAlive(process.platform === 'win32' ? 4 : 1), yield* isAlive(2 ** 22 + 4)]
    })

    expect(isFailure(asked) ? undefined : asked.value).toEqual([true, false])
  })

  it('reads the adapters and the NRPT from what PowerShell printed', () => {
    const looked = lookOf(PRINTED)

    expect(looked?.adapters[1]).toEqual({
      name: 'Ethernet',
      index: 5,
      dhcp: ['10.0.0.1'],
      manual: ['9.9.9.9', '149.112.112.112'],
      metric: 60,
    })
    expect(looked?.adapters[0]?.metric).toBeUndefined()
    expect(looked?.rules.map(rule => rule.ours)).toEqual([false, true])
    expect(lookOf({ adapters: 'none' })).toBeUndefined()
  })

  it('finds the ISP’s resolver in what DHCP gave the adapter the default route leaves by', () => {
    const looked = lookOf(PRINTED)

    expect(ispOf(looked?.adapters ?? [])).toBe('192.168.1.1')
    expect(ispOf([])).toBeUndefined()
    expect(
      ispOf([
        { name: 'VPN', index: 1, dhcp: ['fe80::1', '10.8.0.1'], manual: [], metric: undefined },
      ]),
    ).toBe('10.8.0.1')
  })

  it('says where names go: a rule for every name first, then each adapter', () => {
    const looked = lookOf(PRINTED)

    expect(looked === undefined ? [] : dnsLinesOf(looked)).toEqual([
      'every name → 127.0.0.1 (NRPT)',
      'Tailscale → none',
      'Ethernet → 9.9.9.9, 149.112.112.112',
      "Wi-Fi → DHCP's (192.168.1.1, 192.168.1.2)",
    ])
  })

  it('tells an elevated terminal by its mandatory label', () => {
    expect(
      isElevatedOf(String.raw`"Mandatory Label\High Mandatory Level","Label","S-1-16-12288",""`),
    ).toBe(true)
    expect(
      isElevatedOf(String.raw`"Mandatory Label\Medium Mandatory Level","Label","S-1-16-8192",""`),
    ).toBe(false)
  })

  it('hands PowerShell its script encoded, its errors as text, its literals quoted', () => {
    const script = decodedOf(encodedOf("Write-Output 'ağ'"))

    expect(script).toContain("$ErrorActionPreference = 'Stop'")
    expect(script).toContain("try {\nWrite-Output 'ağ'\n} catch {")
    expect(script).toContain('[Console]::Error.WriteLine($_.Exception.Message)')
    expect(quotedOf("it's")).toBe("'it''s'")
    expect(quotedOf('it’s')).toBe("'it’’s'")
  })

  it('keeps the service with a scheduled task that loops over `ozc ignoredpi run` from home', () => {
    const options = {
      user: String.raw`DESKTOP\someone`,
      program: String.raw`C:\Users\some one\.local\bin\ozc.exe`,
      home: String.raw`C:\Users\some one`,
      log: String.raw`C:\Users\some one\.ozaco\ignoredpi\ignoredpi.log`,
    }
    const task = taskOf(options)

    expect(commandLineOf(options)).toBe(
      String.raw`/d /s /c "set "USERPROFILE=C:\Users\some one" & for /l %i in (0,0,1) do ("C:\Users\some one\.local\bin\ozc.exe" ignoredpi run >>"C:\Users\some one\.ozaco\ignoredpi\ignoredpi.log" 2>&1 & ping -n 11 127.0.0.1 >nul)"`,
    )
    expect(task).toContain('<LogonType>S4U</LogonType>')
    expect(task).toContain('<RunLevel>HighestAvailable</RunLevel>')
    expect(task).toContain('<BootTrigger><Enabled>true</Enabled></BootTrigger>')
    expect(task).toContain('<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>')
    expect(task).toContain('<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>')
    expect(task).toContain('2&gt;&amp;1 &amp; ping')
    expect(task).toContain(String.raw`<WorkingDirectory>C:\Users\some one</WorkingDirectory>`)

    const bytes = utf16Of('<T/>')

    expect([...bytes]).toEqual([0xff, 0xfe, 0x3c, 0, 0x54, 0, 0x2f, 0, 0x3e, 0])
  })

  it.skipIf(process.platform !== 'win32')(
    'reads this machine’s adapters and NRPT through PowerShell',
    async () => {
      const looked = await run(function* () {
        yield* BunIO.use()

        return yield* look()
      })

      expect(isFailure(looked)).toBe(false)
      expect(Array.isArray(isFailure(looked) ? undefined : looked.value.adapters)).toBe(true)
    },
    30_000,
  )
})
