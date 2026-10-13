/**
 * A stand-in for `gh`: it records every call, and plays the repository as far as the release tool
 * asks it — in the words the real one answers with:
 *
 *   api repos/<repo>/releases?per_page=100 --paginate --jq <filter>   a line per release: tag, draft, pre-release
 *   release create <tag> <files…> --repo <repo> --title … --notes …   takes the release, and keeps its assets
 *
 * It runs no `jq`: a filter it was not written for is refused, so the tool cannot drift from what
 * was tried against the real `gh`.
 *
 * What it holds, and what it was asked, is one JSON file (`STANDIN_GH`): a test writes the state
 * it wants there, and reads back what happened. `refuse` names a call it turns down the way
 * GitHub turns down a token that may not do it.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

/** The stand-in's whole world. */
interface State {
  /** The tags that are released, as `<repo> <tag>`, in the order they were. */
  readonly releases: string[]
  /** Of those, the ones marked a pre-release. */
  readonly prereleases: string[]
  /** Releases nobody published: `<repo> <tag>`. */
  readonly drafts: string[]
  /** Every release created here, as it was given: its assets are the copies kept of them. */
  readonly created: {
    repo: string
    tag: string
    title: string
    notes: string
    files: string[]
  }[]
  /** Every call, in order: its arguments. */
  readonly calls: { args: string[] }[]
  /** The calls to turn down: `asked` (what is released), `create`. */
  readonly refuse: string[]
}

const LISTED = '.[] | [.tag_name, .draft, .prerelease] | @tsv'
const REFUSED = 'gh: Resource not accessible by personal access token (HTTP 403)'

const file = process.env['STANDIN_GH'] ?? ''
const args = process.argv.slice(2)
const state = JSON.parse(readFileSync(file, 'utf8')) as State

/** The argument after a flag. */
const after = (flag: string): string => args[args.indexOf(flag) + 1] ?? ''

const answer = (stdout: string): number => {
  process.stdout.write(`${stdout}\n`)

  return 0
}

const refuse = (said: string): number => {
  process.stderr.write(`${said}\n`)

  return 1
}

/** Every release of a repository, newest first, as the filter prints one. */
const listed = (repo: string): number => {
  const lines = [
    ...state.drafts
      .filter(key => key.startsWith(`${repo} `))
      .map(key => `${key.slice(repo.length + 1)}\ttrue\tfalse`),
    ...state.releases
      .filter(key => key.startsWith(`${repo} `))
      .toReversed()
      .map(key => `${key.slice(repo.length + 1)}\tfalse\t${state.prereleases.includes(key)}`),
  ]

  process.stdout.write(lines.map(line => `${line}\n`).join(''))

  return 0
}

const api = (): number => {
  const path = args.find(arg => arg.startsWith('repos/')) ?? ''
  const all = /^repos\/(.+)\/releases\?per_page=100$/u.exec(path)

  if (all === null) {
    return refuse(`gh: the stand-in knows no ${path}`)
  }

  if (!args.includes('--paginate') || after('--jq') !== LISTED) {
    return refuse(`gh: the stand-in lists releases one way, and not as ${args.join(' ')}`)
  }

  return state.refuse.includes('asked')
    ? refuse('gh: Bad credentials (HTTP 401)')
    : listed(all[1] ?? '')
}

const create = (): number => {
  const repo = after('--repo')
  const tag = args[2] ?? ''
  const key = `${repo} ${tag}`
  const files = args.slice(3, args.indexOf('--repo'))

  if (state.refuse.includes('create')) {
    return refuse(REFUSED)
  }

  if (state.releases.includes(key)) {
    return refuse('gh: a release with the same tag name already exists (HTTP 422)')
  }

  const missing = files.find(path => !existsSync(path))

  if (missing !== undefined) {
    return refuse(`gh: open ${missing}: no such file or directory`)
  }

  // a copy of its own: the directory a release was created from is the next run's to clear
  const kept: string[] = []

  for (const path of files) {
    const copy = join(dirname(file), 'assets', tag, basename(path))

    mkdirSync(dirname(copy), { recursive: true })
    copyFileSync(path, copy)
    kept.push(copy)
  }

  state.releases.push(key)
  state.created.push({ repo, tag, title: after('--title'), notes: after('--notes'), files: kept })

  return answer(`https://github.com/${repo}/releases/tag/${tag}`)
}

state.calls.push({ args })

const code =
  args[0] === 'api'
    ? api()
    : args[0] === 'release' && args[1] === 'create'
      ? create()
      : refuse(`gh: the stand-in knows no "${args.slice(0, 2).join(' ')}"`)

writeFileSync(file, JSON.stringify(state, null, 2))
process.exitCode = code
