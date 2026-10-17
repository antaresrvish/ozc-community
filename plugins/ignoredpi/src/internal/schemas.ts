import { z } from 'zod'

import type { IgnoreDpiDef } from '../types'

import { isAddress, normalizeName } from './names'

/** A name as DNS spells it, `*.` allowed in front (it means the same as without). */
const DomainSchema = z
  .string()
  .regex(
    /^(?:\*\.)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+\.?$/iu,
    'expected a domain, e.g. "example.com"',
  )
  .transform(normalizeName)

/** An address the service may reach without asking any DNS: an IPv4 or IPv6 literal. */
const AddressSchema = z.string().refine(isAddress, 'expected an IP address, e.g. "192.168.1.1"')

/**
 * A DNS-over-HTTPS endpoint, by address: the service is the system's DNS, so it cannot ask that
 * for its own upstream's name — and a request to an address carries no name for the DPI to read.
 */
const UpstreamSchema = z
  .url({ protocol: /^https$/u })
  .refine(
    url => isAddress(new URL(url).hostname.replaceAll(/^\[|\]$/gu, '')),
    'expected a DoH endpoint by address, e.g. "https://1.1.1.1/dns-query"',
  )

/** The `[ignoredpi]` table. Every field is optional: the service runs with none of them. */
export const SettingsSchema: z.ZodType<IgnoreDpiDef.Settings> = z.object({
  domains: z.array(DomainSchema).optional(),
  direct: z.array(DomainSchema).optional(),
  upstreams: z.array(UpstreamSchema).min(1).optional(),
  isp: AddressSchema.optional(),
  sinkholes: z.array(AddressSchema).optional(),
  split: z.enum(['record', 'segment', 'both']).optional(),
  lan: z.boolean().optional(),
})

/** What every command takes: `-C`, the directory `ozaco.toml` is discovered from (home by default). */
export const placeInput = z.object({
  cwd: z
    .string()
    .optional()
    .describe(
      'directory ozaco.toml is discovered from (default: home — the service is the machine’s)',
    ),
})

export const placeShort = { cwd: 'C' }

/**
 * `run`: the service in the foreground, as the LaunchAgent starts it. `--trial` leaves the
 * machine's DNS alone, and `--dns`/`--https`/`--http` move it off the system's ports — a try of
 * the service beside whatever runs, or the suites.
 */
export const runInput = z.object({
  trial: z.boolean().default(false).describe('leave the machine’s DNS alone'),
  dns: z.coerce.number().int().min(1).max(65_535).optional().describe('DNS port (53)'),
  https: z.coerce.number().int().min(1).max(65_535).optional().describe('HTTPS port (443)'),
  http: z.coerce.number().int().min(1).max(65_535).optional().describe('HTTP port (80)'),
})

/** `check`: the names to look at. */
export const checkInput = z.object({
  names: z.array(z.string().min(1)).min(1).describe('names to check, e.g. discord.com'),
})

/** `logs`: followed or not, the last lines or all of them. */
export const logsInput = z.object({
  follow: z.boolean().default(false).describe('stream live until Ctrl-C'),
  tail: z.coerce.number().int().positive().optional().describe('only the last n lines'),
})

export const logsShort = { follow: 'f' }
