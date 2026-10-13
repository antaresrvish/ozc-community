/**
 * The programs the tool runs. Two of them — `gh` and `moon` — stand behind a variable that names
 * another program in their place: that is how a test runs a recording stand-in, and never the real
 * thing. `git` is found on the `PATH`.
 *
 * One of them talks to GitHub, and it alone is started with the token that publishes: everything
 * else — Moon and all it builds, `git` — is started without.
 */
import type { Operation } from 'std:effect'
import type { IODef } from 'std:io'
import { IO } from 'std:io'
import { fail } from 'std:result'

import { ENV_GITHUB_TOKENS } from '../const'

const decoder = new TextDecoder()

/** A command line: a program and its arguments. */
type CommandLine = readonly [string, ...string[]]

/**
 * What is laid over the environment of every program that is not `gh`: each name a GitHub token is
 * read from, taken out. A child gets this tool's environment otherwise, so what is not taken out
 * here is handed on.
 */
export const TOKENLESS: Readonly<Record<string, undefined>> = Object.fromEntries(
  ENV_GITHUB_TOKENS.map(name => [name, undefined]),
)

/** The program a variable names; `fallback` while it names none. */
export function* programOf(variable: string, fallback: string): Operation<string> {
  const env = yield* IO.actions.env(data => ({ program: data[variable] }), ['program'])
  const program = env.program?.trim() ?? ''

  return program === '' ? fallback : program
}

export const textOf = (bytes: Uint8Array): string => decoder.decode(bytes)

/** What a program said on its way out, for a failure's message. */
export const saidBy = (result: IODef.ExecResult): string => {
  const text = `${textOf(result.stderr)}${textOf(result.stdout)}`.trim()

  return text === '' ? (result.signal ?? `exit code ${result.code}`) : text
}

/**
 * Run a command line that is not `gh` to its end and answer what it printed on stdout alone: for a
 * program whose answer is read line by line, and whose stderr is for a person. Anything but a
 * clean exit is a failure under `tag`, in the program's own words. No token is handed on.
 */
export function* answered(
  tag: string,
  [program, ...args]: CommandLine,
  options?: IODef.ExecOptions,
): Operation<string> {
  const result = yield* IO.actions.exec(program, args, {
    ...options,
    env: { ...TOKENLESS, ...options?.env },
  })

  if (!result.success) {
    return yield* fail(tag, `${program} ${args.join(' ')}\n${saidBy(result)}`)
  }

  return textOf(result.stdout)
}
