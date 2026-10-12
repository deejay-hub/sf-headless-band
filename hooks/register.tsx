import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { DxMcp, McpOrg, OrgInfo, OrgType } from '../types'
import { resolveMcp } from './mcp'
import { resolveOrg } from './org'
import { ORG_TYPE_COLOR, ORG_TYPE_LABEL, RISK, WATCH_MS, connectedServers, domainFits, domainName, myDomainOf, splitTool, watchedPaths, wireName } from './salesforce'
import type { SfDomain, SfEnv } from './salesforce'

const org = atom({ plugin: 'sf-headless-band', key: 'org' } as const, null)
const mcp = atom({ plugin: 'sf-headless-band', key: 'mcp' } as const, [] as McpOrg[])
const dx = atom({ plugin: 'sf-headless-band', key: 'dx' } as const, [] as DxMcp[])
const hidden = atom({ plugin: 'sf-headless-band', key: 'hidden' } as const, true)
const domains = atom({ plugin: 'sf-headless-band', key: 'domains' } as const, {} as Record<string, SfDomain>)

// Whether the band is switched off, kept across sessions; off until /sf-headless-band turns it on
const HIDDEN = 'hidden'
// The My Domains hosted servers' calls carried, as sf-headless-config keeps them
const DOMAINS = 'domains'

const REFRESH_MS = 15_000

// The watched files' times and sizes at the last read, and the timers refreshing the band
let stamp: string | undefined
let ticker: { cancel: () => void } | undefined
let watcher: { cancel: () => void } | undefined

/** The watched files' modification times and sizes, as one string to compare. */
async function stampOf($: EngineInterface): Promise<string> {
  const paths = watchedPaths(await $.session.cwd(), (await $.env.get('HOME')) ?? '', await $.env.get('CLAUDE_CONFIG_DIR'))
  const parts = await Promise.all(paths.map(p => $.fs.stat(p).then(s => `${s.mtimeMs}:${s.size}`, () => '-')))
  return parts.join('|')
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

async function refresh($: EngineInterface) {
  // Before reading: a change made during the read shows at the next compare
  stamp = await stampOf($)
  // From the store each time: /clear resets the atom to hidden
  const isHidden = (await $.store.get(HIDDEN).catch(() => undefined)) !== false
  if ((await read($, hidden)) !== isHidden) await update($, hidden, () => isHidden)
  const cwd = await $.session.cwd()
  const home = (await $.env.get('HOME')) ?? ''
  const env: SfEnv = {
    SF_TARGET_ORG: await $.env.get('SF_TARGET_ORG'),
    SFDX_DEFAULTUSERNAME: await $.env.get('SFDX_DEFAULTUSERNAME'),
    SF_TARGET_DEV_HUB: await $.env.get('SF_TARGET_DEV_HUB'),
    SFDX_DEFAULTDEVHUBUSERNAME: await $.env.get('SFDX_DEFAULTDEVHUBUSERNAME'),
  }
  const usage = await $.session.usage({ breakdown: 'summary' }).catch(() => undefined)
  const connected = connectedServers(usage?.context.breakdown?.mcpTools)
  const readFile = (path: string) =>
    $.fs.read(path).then(
      text => (typeof text === 'string' ? text : undefined),
      () => undefined,
    )
  const next = await resolveOrg(readFile, cwd, home, await $.clock.now(), env)
  if (!same(await read($, org), next)) {
    await update($, org, () => next)
  }
  const servers = await resolveMcp(readFile, cwd, home, await $.clock.now(), await $.env.get('CLAUDE_CONFIG_DIR'), { env, connected, domains: await read($, domains) })
  if (!same(await read($, mcp), servers.hosted)) {
    await update($, mcp, () => servers.hosted)
  }
  if (!same(await read($, dx), servers.dx)) {
    await update($, dx, () => servers.dx)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await refresh($)
    const reached = await $.store.get(DOMAINS).catch(() => undefined)
    if (reached && typeof reached === 'object') await update($, domains, seen => ({ ...(reached as Record<string, SfDomain>), ...seen }))
    // Servers connecting, which changes no file
    ticker?.cancel()
    ticker = $.clock.every(REFRESH_MS, () => refresh($))
    // `sf config set target-org`, an alias or an MCP server changed in another
    // session or a terminal, as sf-headless-config watches
    watcher?.cancel()
    watcher = $.clock.every(WATCH_MS, () => {
      void (async () => {
        if ((await stampOf($)) !== stamp) await refresh($)
      })()
    })
    // Last, so the band draws even where commands can't be added
    await $.command.register({
      name: 'sf-headless-band',
      description: 'Show or hide the Salesforce band above the prompt (on, off, or toggle)',
      argumentHint: '[on|off]',
    })
    return started
  })

  // A hosted server's org, from the My Domain its calls carry, as sf-headless-config watches
  on('tool.call', { tool: /^mcp__/ }, async ($, e, next) => {
    const ran = await next(e)
    const parts = splitTool(e.tool)
    if (parts === undefined) return ran
    try {
      const entry = (await read($, mcp)).find(m => wireName(m.server) === parts.server)
      const { tool: _tool, tool_use_id: _id, ...args } = e as Record<string, unknown>
      const seen = entry === undefined ? undefined : (myDomainOf(JSON.stringify(args)) ?? myDomainOf(ran.text ?? ''))
      // Kept only where it fits the URL: never a sandbox's domain for a production URL's server
      const found = seen && entry && domainFits(entry.urlType, seen) ? seen : undefined
      const known = found && (await read($, domains))[entry!.domainKey]
      if (found && entry && (known?.host !== found.host || known?.type !== found.type)) {
        await update($, domains, all => ({ ...all, [entry.domainKey]: found }))
        const kept = await $.store.get(DOMAINS)
        await $.store.set(DOMAINS, { ...(kept && typeof kept === 'object' ? kept : {}), [entry.domainKey]: found })
        await refresh($)
      }
    } catch {
      // Watching never stands in a call's way
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'sf-headless-band' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const isHidden = arg === 'on' || arg === 'show' ? false : arg === 'off' || arg === 'hide' ? true : !(await read($, hidden))
    await update($, hidden, () => isHidden)
    await $.store.set(HIDDEN, isHidden)
    return {
      text: isHidden
        ? 'Salesforce band hidden. /sf-headless-band brings it back.'
        : 'Salesforce band shown above the prompt. /sf-headless-band hides it.',
    }
  })

  // /clear, /resume and /branch reset $.state without a new session.start
  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    const result = await next(e)
    await refresh($)
    return result
  })

  on('classic.CwdChanged', async ($, e, next) => {
    const result = await next(e)
    await refresh($)
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    await refresh($)
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const info = await read($, org)
    const hosted = await read($, mcp)
    const dxServers = await read($, dx)
    if (e.props.hasSurvey || (await read($, hidden)) || (info === null && hosted.length === 0 && dxServers.length === 0)) {
      return next(e)
    }

    const { Box, Text } = $.ui.resolve(e)
    const lines = []

    // The org type as sf-headless-config draws it: its label on a solid pill
    const pill = (type: OrgType, label: string = ORG_TYPE_LABEL[type], key: string = label) => (
      <Text key={key} backgroundColor={ORG_TYPE_COLOR[type]} color="inverseText">
        {` ${label} `}
      </Text>
    )
    // One line: what it is, then › and its org type pills
    const row = (key: string, left: RenderChildren, pills: RenderChildren[]) => (
      <Box key={key} flexDirection="row">
        <Box flexDirection="row" flexShrink={1}>
          {left}
        </Box>
        {pills.length === 0 ? null : <Text dimColor> › </Text>}
        {pills.length === 0 ? null : (
          <Box flexDirection="row" gap={1} flexShrink={0}>
            {pills}
          </Box>
        )}
      </Box>
    )

    if (info !== null) {
      const expiry =
        info.daysLeft === undefined
          ? null
          : info.daysLeft === 0
            ? 'expires today'
            : `expires in ${info.daysLeft} day${info.daysLeft === 1 ? '' : 's'}`
      const isExpiring = info.daysLeft !== undefined && info.daysLeft <= 3

      // sf › cli › alias › my-domain › expires in N days › [ type ]
      lines.push(
        row(
          'sf',
          <Box flexDirection="row">
            <Text dimColor>sf › cli › </Text>
            <Text bold>{info.name}</Text>
            {info.host ? <Text dimColor> › {domainName(info.host)}</Text> : null}
            {expiry === null ? null : <Text dimColor> › </Text>}
            {expiry === null ? null : isExpiring ? <Text color="error">{expiry}</Text> : <Text dimColor>{expiry}</Text>}
          </Box>,
          [pill(info.type)],
        ),
      )
    }

    // ✓ or ✗: whether the session has the server's tools
    const connection = (isConnected: boolean) =>
      isConnected ? <Text color="success">✓ </Text> : <Text color="error">✗ </Text>

    // sf › mcp › ✓ server › alias, alias › my-domain, my-domain › [ type ] [ type ], one line per DX MCP Server in use
    for (const server of dxServers) {
      const names = server.orgs.map(o => o.name).join(', ')
      const domains = server.orgs.flatMap(o => (o.host ? [domainName(o.host)] : [])).join(', ')
      const pills = server.orgs.map(o => pill(o.type, ORG_TYPE_LABEL[o.type], o.username))
      if (server.allOrgs) pills.push(pill('production', 'all orgs'))
      lines.push(
        row(
          `dx-${server.server}`,
          <Box flexDirection="row">
            <Text dimColor>sf › mcp › </Text>
            {connection(server.isConnected)}
            <Text>{server.server}</Text>
            <Text dimColor> › </Text>
            {names === '' ? null : <Text bold>{names}</Text>}
            {domains === '' ? null : <Text dimColor> › {domains}</Text>}
            {names === '' && !server.allOrgs ? <Text dimColor>no org set</Text> : null}
            {names === '' && server.allOrgs ? <Text bold>every org the CLI knows</Text> : null}
          </Box>,
          pills,
        ),
      )
    }

    // sf › mcp › ✓ server, ✗ server › my-domain › [ type ], one line per org: servers of one type
    // sharing a consumer key reach the same org; a server with no key stands alone
    const groups = new Map<string, McpOrg[]>()
    for (const m of [...hosted].sort((a, b) => RISK.indexOf(a.type) - RISK.indexOf(b.type))) {
      // By the URL's kind, not the type: servers whose org isn't known yet still group by their app
      const key = `${m.urlType}|${m.clientId ?? `server:${m.server}`}`
      groups.set(key, [...(groups.get(key) ?? []), m])
    }
    for (const [key, group] of groups) {
      lines.push(
        row(
          `mcp-${key}`,
          <Box flexDirection="row">
            <Text dimColor>sf › mcp › </Text>
            {group.map((m, i) => (
              <Box key={m.server} flexDirection="row">
                {i === 0 ? null : <Text dimColor>, </Text>}
                {connection(m.isConnected)}
                <Text bold>{m.server}</Text>
              </Box>
            ))}
            {group[0]!.host ? <Text dimColor> › {domainName(group[0]!.host)}</Text> : null}
          </Box>,
          // No take on the type until a call has shown the org
          group[0]!.host ? [pill(group[0]!.type)] : [],
        ),
      )
    }

    const line = lines.length === 1 ? lines[0]! : <Box flexDirection="column">{lines}</Box>

    // The band is shared: keep what the mods after this one draw there
    const theirs = await next(e)
    return theirs ? (
      <Box flexDirection="column">
        {line}
        {theirs}
      </Box>
    ) : (
      line
    )
  })
}
