import type { DxMcp, McpOrg, OrgInfo } from '../types'
import { toOrgInfo } from './org'
import type { ReadFile } from './org'
import { domainFits, domainKey, dxOf, dxType, hostedOf, hostedType, readClaudeMcp, resolveSfOrg, sfDefaults } from './salesforce'
import type { SfDomain, SfEnv } from './salesforce'

export type McpOptions = {
  /** The CLI's default-org variables from the session's environment. */
  env?: SfEnv
  /** The servers this session has tools from, by /mcp name. */
  connected?: ReadonlySet<string>
  /** The My Domains hosted servers' calls have carried, by domain key. */
  domains?: Record<string, SfDomain>
}

/**
 * The Salesforce MCP servers in use for `cwd`, as sf-headless-config reads them: the copy
 * of each name Claude Code uses (local over project over user), not disabled.
 * Hosted servers are typed by URL; DX MCP Servers by the orgs their `--orgs` allows,
 * resolved through the CLI's files.
 */
export const resolveMcp = async (
  read: ReadFile,
  cwd: string,
  home: string,
  now: number,
  configDir?: string,
  options: McpOptions = {},
): Promise<{ hosted: McpOrg[]; dx: DxMcp[] }> => {
  const hosted: McpOrg[] = []
  const dx: DxMcp[] = []
  const mcp = await readClaudeMcp(read, cwd, home, configDir)
  const defaults = await sfDefaults(read, cwd, home, options.env)
  const inUse = mcp.servers.filter(s => s.isActive && !s.isDisabled).sort((a, b) => a.name.localeCompare(b.name))

  for (const { name: server, config } of inUse) {
    const isConnected = options.connected?.has(server) ?? false
    const site = hostedOf(config)
    if (site !== undefined) {
      const key = domainKey(server, site)
      const domain = options.domains?.[key]
      hosted.push({
        server,
        type: hostedType(site, domain),
        urlType: site.type,
        domainKey: key,
        ...(domain && domainFits(site.type, domain) ? { host: domain.host } : {}),
        ...(site.clientId === undefined ? {} : { clientId: site.clientId }),
        isConnected,
      })
      continue
    }
    const flags = dxOf(config)
    if (flags === undefined) continue

    const all = await Promise.all(flags.orgs.map(target => resolveSfOrg(read, home, defaults, target, now)))
    // The band names each org once; one with no default set reaches nothing
    const orgs: OrgInfo[] = []
    for (const org of all.map(toOrgInfo)) {
      if (org !== undefined && !orgs.some(o => o.username === org.username)) orgs.push(org)
    }
    dx.push({ server, orgs, allOrgs: flags.orgs.includes('ALLOW_ALL_ORGS'), type: dxType(flags, all), isConnected })
  }
  return { hosted, dx }
}
