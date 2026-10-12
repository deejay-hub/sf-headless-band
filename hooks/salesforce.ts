// The Salesforce rules sf-headless-config and sf-headless-band share: which MCP servers are
// in use, which orgs they reach, and each org's type. The same file in both mods,
// so the pane and the band always agree; scripts/check-shared.sh holds them equal.

/** Reads a file's text, or undefined when it is missing or unreadable. */
export type ReadFile = (path: string) => Promise<string | undefined>

/** A DX server's org is any of the four; a hosted server's only production or sandbox, from its URL. */
export type SfOrgType = 'production' | 'developer' | 'sandbox' | 'scratch' | 'unknown'

/** Where Claude Code keeps a server: `~/.claude.json` (user, local) or a `.mcp.json` (project). */
export type SfScope = 'local' | 'project' | 'user'

const DAY_MS = 24 * 60 * 60 * 1000

// https://api.salesforce.com/platform/mcp/<version>/[sandbox/]platform/<server>
const HOSTED_URL = /https:\/\/api\.salesforce\.com\/platform\/mcp\/([^/\s"]+)\/(sandbox\/)?platform\/([^/\s"?#]+)/
// The DX MCP server's npm package, alone, versioned, or in a path or a command line
const DX_PACKAGE = /(^|[/\s])@salesforce\/mcp(@[\w.-]+)?$/
// A Developer Edition's My Domain: <name>-dev-ed.develop.my.salesforce.com, or <name>-dev-ed.my… before enhanced domains
const DEVELOPER_URL = /-dev-ed\.|\.develop\.my\.salesforce\.com/

/** Riskiest first. An org the CLI can't describe is last: the DX server can't reach it either. */
export const RISK: SfOrgType[] = ['production', 'developer', 'sandbox', 'scratch', 'unknown']

/** Theme keys, so the colors follow the light or dark theme. */
export const ORG_TYPE_COLOR: Record<SfOrgType, string> = {
  production: 'error',
  developer: 'suggestion',
  sandbox: 'warning',
  scratch: 'success',
  unknown: 'inactive',
}

export const ORG_TYPE_LABEL: Record<SfOrgType, string> = {
  production: 'production',
  developer: 'developer edition',
  sandbox: 'sandbox',
  scratch: 'scratch',
  unknown: 'unknown',
}

/** The riskiest of the types, or unknown for none. */
export const riskiest = (types: readonly SfOrgType[]): SfOrgType => RISK.find(t => types.includes(t)) ?? 'unknown'

export const readJson = async (read: ReadFile, path: string): Promise<any> => {
  const text = await read(path)
  if (text === undefined) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** `cwd` and every folder above it, nearest first. */
export const ancestors = (cwd: string): string[] => {
  const dirs: string[] = []
  for (let dir = cwd.replace(/\/+$/, '') || '/'; ; ) {
    dirs.push(dir)
    if (dir === '/') return dirs
    const cut = dir.lastIndexOf('/')
    dir = cut <= 0 ? '/' : dir.slice(0, cut)
  }
}

export const fileIn = (dir: string, name: string) => `${dir === '/' ? '' : dir}/${name}`

/** The last six characters of a consumer key, enough to tell two apart. */
export const keyTail = (key: string) => (key.length <= 8 ? key : `…${key.slice(-6)}`)

/** A URL's host, lowercased: `https://Acme.my.salesforce.com/x` is `acme.my.salesforce.com`. */
export const hostOf = (url: string): string | undefined => /^https?:\/\/([^/?#]+)/i.exec(url.trim())?.[1]?.toLowerCase()

/** A My Domain's own name, its first label: what the band calls the org (`acme--uat`). */
export const domainName = (host: string) => host.split('.')[0]!

/** A server name as tool wire names spell it: anything but letters, digits, `_` and `-` becomes `_`. */
export const wireName = (server: string) => server.replace(/[^a-zA-Z0-9_-]/g, '_')

// ── Orgs, through the Salesforce CLI's files ────────────────────────────────

/** An org's type from its CLI auth file: the scratch and sandbox flags, then its domain. */
export const authType = (auth: any): SfOrgType => {
  if (auth === undefined) return 'unknown'
  const url: string = auth.instanceUrl ?? ''
  if (auth.isScratch === true || url.includes('.scratch.')) return 'scratch'
  if (auth.isSandbox === true || url.includes('.sandbox.')) return 'sandbox'
  if (DEVELOPER_URL.test(url)) return 'developer'
  return 'production'
}

/** Days from `now` until the end of `expirationDate` (YYYY-MM-DD, UTC); 0 on its last day. */
export const daysUntil = (expirationDate: string, now: number): number | undefined => {
  const at = Date.parse(`${expirationDate}T00:00:00Z`)
  if (Number.isNaN(at)) return undefined
  return Math.max(0, Math.ceil((at - now) / DAY_MS))
}

/** The Salesforce CLI's variables that set the default orgs, the legacy names second. */
export type SfEnv = {
  SF_TARGET_ORG?: string
  SFDX_DEFAULTUSERNAME?: string
  SF_TARGET_DEV_HUB?: string
  SFDX_DEFAULTDEVHUBUSERNAME?: string
}

/** The nearest folder at or above `cwd` holding an sfdx-project.json. */
export const findProject = async (read: ReadFile, cwd: string): Promise<string | undefined> => {
  for (const dir of ancestors(cwd)) {
    if ((await read(fileIn(dir, 'sfdx-project.json'))) !== undefined) return dir
  }
  return undefined
}

/** The CLI's aliases and default orgs for a folder. */
export type SfDefaults = {
  aliases: Record<string, string>
  /** The project's root, when the folder is in one. */
  project?: string
  org?: string
  hub?: string
}

/**
 * The aliases and default orgs as the CLI resolves them: an environment variable
 * over the project's config (at its sfdx-project.json root only) over the global
 * config; sf over sfdx.
 */
export const sfDefaults = async (read: ReadFile, cwd: string, home: string, env: SfEnv = {}): Promise<SfDefaults> => {
  const aliases = (await readJson(read, `${home}/.sfdx/alias.json`))?.orgs ?? {}
  const project = await findProject(read, cwd)
  const defaults: SfDefaults = { aliases, ...(project === undefined ? {} : { project }) }
  const layers = [
    `${home}/.sfdx/sfdx-config.json`,
    `${home}/.sf/config.json`,
    ...(project === undefined ? [] : [fileIn(project, '.sfdx/sfdx-config.json'), fileIn(project, '.sf/config.json')]),
  ]
  for (const path of layers) {
    const json = await readJson(read, path)
    if (!json) continue
    const org = json['target-org'] ?? json.defaultusername
    const hub = json['target-dev-hub'] ?? json.defaultdevhubusername
    if (typeof org === 'string' && org !== '') defaults.org = org
    if (typeof hub === 'string' && hub !== '') defaults.hub = hub
  }
  const org = env.SF_TARGET_ORG || env.SFDX_DEFAULTUSERNAME
  const hub = env.SF_TARGET_DEV_HUB || env.SFDX_DEFAULTDEVHUBUSERNAME
  if (org) defaults.org = org
  if (hub) defaults.hub = hub
  return defaults
}

/** One org, as written and as the CLI knows it. */
export type SfOrg = {
  /** As written: an alias, a username, or `DEFAULT_TARGET_ORG` and its kin. */
  target: string
  /** The alias or username it stands for, `DEFAULT_TARGET_ORG` resolved; absent when no default is set. */
  name?: string
  username?: string
  type: SfOrgType
  /** Its My Domain host, from the CLI's auth file (`acme--uat.sandbox.my.salesforce.com`). */
  host?: string
  /** Days until a scratch org expires. */
  daysLeft?: number
}

/** An org by alias, username or `DEFAULT_TARGET_ORG`/`DEFAULT_TARGET_DEV_HUB`: who it is and its type. */
export const resolveSfOrg = async (read: ReadFile, home: string, defaults: SfDefaults, target: string, now: number): Promise<SfOrg> => {
  if (target === 'ALLOW_ALL_ORGS') return { target, type: 'unknown' }
  const name = target === 'DEFAULT_TARGET_ORG' ? defaults.org : target === 'DEFAULT_TARGET_DEV_HUB' ? defaults.hub : target
  if (name === undefined) return { target, type: 'unknown' }
  const username = typeof defaults.aliases[name] === 'string' ? defaults.aliases[name]! : name
  const auth = await readJson(read, `${home}/.sfdx/${username}.json`)
  const type = authType(auth)
  const daysLeft = type === 'scratch' && typeof auth?.expirationDate === 'string' ? daysUntil(auth.expirationDate, now) : undefined
  const host = typeof auth?.instanceUrl === 'string' ? hostOf(auth.instanceUrl) : undefined
  return { target, name, username, type, ...(host ? { host } : {}), ...(daysLeft === undefined ? {} : { daysLeft }) }
}

// ── Servers, from Claude Code's config ──────────────────────────────────────

const argsOf = (config: any): string[] =>
  Array.isArray(config?.args) ? config.args.filter((a: unknown): a is string => typeof a === 'string') : []

/** mcp-remote's `--static-oauth-client-info` JSON, parsed. */
export const staticClientInfo = (config: any): any => {
  const args = argsOf(config)
  const at = args.indexOf('--static-oauth-client-info')
  if (at < 0 || args[at + 1] === undefined) return undefined
  try {
    return JSON.parse(args[at + 1]!)
  } catch {
    return undefined
  }
}

/** A Salesforce Hosted MCP server, from its URL: an `http` server's own, or an mcp-remote bridge's in its args. */
export type SfHosted = {
  /** The URL's server segment (`sobject-all`). */
  server: string
  /** The URL's API version (`v1`). */
  version: string
  transport: 'http' | 'mcp-remote'
  /** A `/sandbox/` URL signs in through test.salesforce.com and serves sandbox and scratch orgs. */
  type: 'production' | 'sandbox'
  /** The External Client App's consumer key; servers sharing one and a type reach the same org. */
  clientId?: string
  callbackPort?: number
}

export const hostedOf = (config: any): SfHosted | undefined => {
  const args = argsOf(config)
  const url = typeof config?.url === 'string' ? config.url : undefined
  const at = url !== undefined && HOSTED_URL.test(url) ? url : args.find(a => HOSTED_URL.test(a))
  if (at === undefined) return undefined
  const [, version, sandbox, server] = HOSTED_URL.exec(at)!
  const isBridge = at !== url
  const clientId = isBridge ? staticClientInfo(config)?.client_id : config?.oauth?.clientId
  const port = isBridge ? Number(args[args.indexOf(at) + 1]) : config?.oauth?.callbackPort
  return {
    server: server!,
    version: version!,
    transport: isBridge ? 'mcp-remote' : 'http',
    type: sandbox === undefined ? 'production' : 'sandbox',
    ...(typeof clientId === 'string' && clientId !== '' ? { clientId } : {}),
    ...(Number.isInteger(port) && port > 0 ? { callbackPort: port } : {}),
  }
}

// ── A hosted server's org, from the My Domain its calls carry ─────────────────

// https://<name>[--<sandbox>].[sandbox.|scratch.|develop.|trailblaze.]my.salesforce.com
const MY_DOMAIN = /https:\/\/([a-z0-9][a-z0-9-]*)\.((?:sandbox|scratch|develop|trailblaze)\.)?my\.salesforce\.com/i

/** The org a hosted server reached, by the My Domain in a call's input or result. */
export type SfDomain = { host: string; type: SfOrgType }

/** The first My Domain in some text, typed by its form: scratch, sandbox, developer edition (a Trailhead Playground too), else production. */
export const myDomainOf = (text: string): SfDomain | undefined => {
  const match = MY_DOMAIN.exec(text)
  if (!match) return undefined
  const kind = match[2]?.toLowerCase()
  const type: SfOrgType =
    kind === 'scratch.' ? 'scratch' : kind === 'sandbox.' ? 'sandbox' : kind === 'develop.' || kind === 'trailblaze.' || /-dev-ed$/i.test(match[1]!) ? 'developer' : 'production'
  return { host: match[0].slice('https://'.length).toLowerCase(), type }
}

/**
 * What a hosted server's org is remembered by: its consumer key and URL kind, which
 * every server signed in through that app shares; the server itself when it has no key.
 */
export const domainKey = (name: string, hosted: SfHosted): string =>
  hosted.clientId === undefined ? `server:${name}|${hosted.server}|${hosted.type}` : `app:${hosted.clientId}|${hosted.type}`

/**
 * A hosted server's type: unknown until a call carries its org's My Domain, and that
 * fits the URL; no guess from the URL alone. A production URL serves production and
 * developer edition orgs; a sandbox URL, sandbox and scratch orgs.
 */
export const hostedType = (hosted: SfHosted, domain?: SfDomain): SfOrgType =>
  domain !== undefined && domainFits(hosted.type, domain) ? domain.type : 'unknown'

/** Whether a My Domain's org can be one a URL of that kind serves. */
export const domainFits = (urlType: SfHosted['type'], domain: SfDomain): boolean =>
  (urlType === 'production' ? ['production', 'developer'] : ['sandbox', 'scratch']).includes(domain.type)

/** `mcp__<server>__<tool>` split at the first `__` after the prefix: the server as wire names spell it. */
export const splitTool = (name: string): { server: string; tool: string } | undefined => {
  if (!name.startsWith('mcp__')) return undefined
  const rest = name.slice(5)
  const cut = rest.indexOf('__')
  return cut <= 0 ? undefined : { server: rest.slice(0, cut), tool: rest.slice(cut + 2) }
}

/** The value of `--flag value` or `--flag=value`. */
const flagValue = (args: string[], flag: string): string | undefined => {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag) return args[i + 1]
    if (args[i]!.startsWith(`${flag}=`)) return args[i]!.slice(flag.length + 1)
  }
  return undefined
}

const list = (value: string | undefined) =>
  (value ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)

/** The Salesforce DX MCP server's flags: the orgs it may reach and the tools it loads. */
export type SfDxFlags = { orgs: string[]; toolsets: string[]; tools: string[]; allowNonGa: boolean }

/** The DX MCP server's flags, or undefined when the config runs something else. */
export const dxOf = (config: any): SfDxFlags | undefined => {
  const args = argsOf(config)
  const command = typeof config?.command === 'string' ? config.command : ''
  if (!DX_PACKAGE.test(command) && !args.some(a => DX_PACKAGE.test(a))) return undefined
  return {
    orgs: list(flagValue(args, '--orgs')),
    toolsets: list(flagValue(args, '--toolsets')),
    tools: list(flagValue(args, '--tools')),
    allowNonGa: args.includes('--allow-non-ga-tools'),
  }
}

/** What a DX server can reach, as one type: ALLOW_ALL_ORGS is every org, production included. */
export const dxType = (flags: SfDxFlags, orgs: readonly SfOrg[]): SfOrgType =>
  flags.orgs.includes('ALLOW_ALL_ORGS') ? 'production' : riskiest(orgs.map(o => o.type))

/** One server as configured in one scope. */
export type SfConfigured = {
  name: string
  scope: SfScope
  /** The file it is written in. */
  file: string
  /** The folder `claude mcp` runs in to reach it: the project folder for local and project scope. */
  cwd: string
  config: Record<string, unknown>
  /** False when a nearer scope configures the same name. */
  isActive: boolean
  /** In force, but switched off for this project with /mcp. */
  isDisabled: boolean
}

/** Claude Code's MCP config for a folder: every scope's servers, nearest first. */
export type SfClaudeMcp = {
  claudeFile: string
  /** The `~/.claude.json` project the folder belongs to, the one local scope is written under. */
  projectDir?: string
  /** Each `.mcp.json` at or above the folder, nearest first. */
  mcpJsonFiles: string[]
  /** The scopes as read, nearest first, each with every server it names. */
  layers: { scope: SfScope; file: string; cwd: string; servers: Record<string, unknown> }[]
  servers: SfConfigured[]
  /** `~/.claude.json`'s projects, for local scope elsewhere. */
  projects: Record<string, any>
}

/**
 * Every server configured for `cwd`, in every scope, with the one Claude Code uses
 * for each name marked active: local over project (the nearest .mcp.json first)
 * over user. A server is in use when it is active and not disabled.
 */
export const readClaudeMcp = async (read: ReadFile, cwd: string, home: string, configDir?: string): Promise<SfClaudeMcp> => {
  const claudeFile = `${configDir || home}/.claude.json`
  const claude = (await readJson(read, claudeFile)) ?? {}
  const dirs = ancestors(cwd)
  const projectDir = dirs.find(dir => claude.projects?.[dir] !== undefined)
  const local = projectDir === undefined ? {} : claude.projects[projectDir]

  const layers: SfClaudeMcp['layers'] = []
  if (local.mcpServers) layers.push({ scope: 'local', file: claudeFile, cwd: projectDir!, servers: local.mcpServers })
  const mcpJsonFiles: string[] = []
  for (const dir of dirs) {
    const file = fileIn(dir, '.mcp.json')
    const json = await readJson(read, file)
    if (json === undefined) continue
    mcpJsonFiles.push(file)
    if (json.mcpServers) layers.push({ scope: 'project', file, cwd: dir, servers: json.mcpServers })
  }
  if (claude.mcpServers) layers.push({ scope: 'user', file: claudeFile, cwd, servers: claude.mcpServers })

  const disabled = new Set<string>([
    ...(Array.isArray(local.disabledMcpServers) ? local.disabledMcpServers : []),
    ...(Array.isArray(local.disabledMcpjsonServers) ? local.disabledMcpjsonServers : []),
  ])
  const seen = new Set<string>()
  const servers: SfConfigured[] = []
  for (const layer of layers) {
    for (const [name, config] of Object.entries(layer.servers)) {
      const isActive = !seen.has(name)
      seen.add(name)
      servers.push({
        name,
        scope: layer.scope,
        file: layer.file,
        cwd: layer.cwd,
        config: (config ?? {}) as Record<string, unknown>,
        isActive,
        isDisabled: isActive && disabled.has(name),
      })
    }
  }
  return {
    claudeFile,
    ...(projectDir === undefined ? {} : { projectDir }),
    mcpJsonFiles,
    layers,
    servers,
    projects: claude.projects ?? {},
  }
}

/** The servers this session's MCP tools come from, by /mcp name: a server in the set is connected. */
export const connectedServers = (mcpTools: readonly { serverName: string }[] | undefined): Set<string> =>
  new Set((mcpTools ?? []).map(t => t.serverName))

/**
 * Every file the servers and orgs are read from, for `cwd`: Claude Code's config,
 * each folder's .mcp.json, and the CLI's config and aliases. One changed by another
 * session or a terminal is the cue to read again.
 */
export const watchedPaths = (cwd: string, home: string, configDir?: string): string[] => [
  `${configDir || home}/.claude.json`,
  `${home}/.sf/config.json`,
  `${home}/.sfdx/sfdx-config.json`,
  `${home}/.sfdx/alias.json`,
  ...ancestors(cwd).flatMap(dir => [
    fileIn(dir, '.mcp.json'),
    fileIn(dir, 'sfdx-project.json'),
    fileIn(dir, '.sf/config.json'),
    fileIn(dir, '.sfdx/sfdx-config.json'),
  ]),
]

/** How often the watched files are compared: a stat each, nothing read unless one changed. */
export const WATCH_MS = 3000
