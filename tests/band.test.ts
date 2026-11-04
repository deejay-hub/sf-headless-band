import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

const HOME = '/home/me'
const PROJECT = '/work/app'

// What Claude Code passes to a ui.render hook for the band, apart from the surface
const BAND = {
  plugin: 'sf-headless-band',
  component: 'AbovePrompt',
  viewport: { columns: 100, rows: 30 },
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 95,
    scroll: { offset: 0, bodyRows: 9 },
    view: {},
  },
} as const

const SURFACES = ['terminal', 'desktop'] as const

// A scratch org that expires 2 days after the mock clock's start
const FILES: Record<string, unknown> = {
  [`${PROJECT}/sfdx-project.json`]: {},
  [`${PROJECT}/.sf/config.json`]: { 'target-org': 'my-scratch' },
  [`${HOME}/.sfdx/alias.json`]: { orgs: { 'my-scratch': 'test-1@example.com' } },
  [`${HOME}/.sfdx/test-1@example.com.json`]: {
    isScratch: true,
    expirationDate: '2026-10-08',
    instanceUrl: 'https://speedy-1-dev-ed.scratch.my.salesforce.com',
  },
}

// The band starts off; most tests begin with it switched on in an earlier session
const stubSession = (on: Parameters<TestBody>[1], cwd: string, files = FILES, env: Record<string, string> = {}, store: Record<string, unknown> = { hidden: false }) => {
  const clock = mock.clock(on, { now: Date.parse('2026-10-06T12:00:00Z') })
  mock.env(on, { HOME, ...env })
  mock.store(on, store)
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.cwd', () => ({ value: cwd }))
  on('fs.read', ($, e) =>
    e.path in files ? { value: JSON.stringify(files[e.path]) } : { deny: 'ENOENT' },
  )
  on('session.start', () => ({ cwd }))
  // Stands for what other mods draw in the shared band
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['another mod'] }))
  return clock
}

test('in a Salesforce project the band shows the org, its type and expiry', async ($, on) => {
  stubSession(on, `${PROJECT}/force-app`)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: `${PROJECT}/force-app` })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: 'my-scratch' })).toBeDefined()
    // Named by its alias and its My Domain, as a hosted server is; the username is the pane's
    expect(await ui.find({ type: 'Text', text: ' › speedy-1-dev-ed' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /test-1@example\.com/ })).toBeUndefined()
    // No dot: the org type is a pill on the right, as in sf-headless-config
    expect(await ui.find({ type: 'Text', text: /●/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: ' scratch ' })).toMatchObject({ props: { backgroundColor: 'success', color: 'inverseText' } })
    expect(await ui.find({ type: 'Text', text: /expires in 2 days/ })).toBeDefined()
    // Other mods' band content is kept
    expect(await ui.find({ type: 'Text', text: 'another mod' })).toBeDefined()
    await ui.unmount()
  }
})

test('outside a Salesforce project the band is left to others', async ($, on) => {
  stubSession(on, '/work/plain')
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work/plain' })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: /my-scratch/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'another mod' })).toBeDefined()
    await ui.unmount()
  }
})

test('the org comes back after /clear, at the next refresh', async ($, on) => {
  const clock = stubSession(on, PROJECT)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: PROJECT })
  // /clear resets $.state; the 15-second refresh reads the org again
  await clock.advance(15_000)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'my-scratch' })).toBeDefined()
})

test('a production pill is solid red and holds still', async ($, on) => {
  const prod = {
    [`${PROJECT}/sfdx-project.json`]: {},
    [`${PROJECT}/.sf/config.json`]: { 'target-org': 'me@acme.com' },
    [`${HOME}/.sfdx/me@acme.com.json`]: { isScratch: false, isSandbox: false },
  }
  const clock = stubSession(on, PROJECT, prod)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: PROJECT })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const pillColor = async () => (await ui.find({ type: 'Text', text: ' production ' }))?.props?.backgroundColor
  // No alias, so the username is not repeated in brackets
  expect(await ui.find({ type: 'Text', text: /\(me@acme.com\)/ })).toBeUndefined()
  expect(await pillColor()).toBe('error')
  await clock.advance(600)
  expect(await pillColor()).toBe('error')
  await ui.unmount()
})

test('hosted MCP servers show outside a Salesforce project, with no type until a call shows their org', async ($, on) => {
  const oauth = { clientId: '3MVG9-consumer-key', callbackPort: 38000 }
  const files = {
    [`${HOME}/.claude.json`]: {
      projects: {
        '/work/plain': {
          mcpServers: {
            'sobject-all': { type: 'http', url: 'https://api.salesforce.com/platform/mcp/v1/platform/sobject-all', oauth },
            'metadata-experts': {
              type: 'http',
              url: 'https://api.salesforce.com/platform/mcp/v1/sandbox/platform/metadata-experts',
              oauth,
            },
          },
        },
      },
    },
  }
  const clock = stubSession(on, '/work/plain', files)
  on('tool.call', () => ({ result: 'x', text: 'ok' }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work/plain' })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: 'sobject-all' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'metadata-experts' })).toBeDefined()
    // No take on the type from the URL: no pill, and no dangling separator
    expect(await ui.find({ type: 'Text', text: ' production ' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: ' sandbox ' })).toBeUndefined()
    expect(await ui.find({ type: 'Box', text: /^sf › mcp › ✗ sobject-all$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'sf › cli › ' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'another mod' })).toBeDefined()
    await ui.unmount()
  }

  // Once a call shows the org is production: a solid red pill that holds still
  await $.tool.call({ tool: 'mcp__sobject-all__soqlQuery', url: 'https://acme.my.salesforce.com/services/data' } as never)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const pillColor = async () => (await ui.find({ type: 'Text', text: ' production ' }))?.props?.backgroundColor
  expect(await pillColor()).toBe('error')
  await clock.advance(600)
  expect(await pillColor()).toBe('error')
})

test('hosted MCP servers share a line only when they share a consumer key', async ($, on) => {
  const url = (server: string) => `https://api.salesforce.com/platform/mcp/v1/platform/${server}`
  const files = {
    [`${PROJECT}/.mcp.json`]: {
      mcpServers: {
        'acme-sobjects': { type: 'http', url: url('sobject-all'), oauth: { clientId: 'acme-key' } },
        'acme-metadata': { type: 'http', url: url('metadata-experts'), oauth: { clientId: 'acme-key' } },
        'globex-sobjects': { type: 'http', url: url('sobject-all'), oauth: { clientId: 'globex-key' } },
      },
    },
  }
  stubSession(on, PROJECT, files)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: PROJECT })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  // One line per org: both acme servers on one, globex on its own
  expect(await ui.find({ type: 'Box', text: /^sf › mcp › ✗ acme-metadata, ✗ acme-sobjects$/ })).toBeDefined()
  expect(await ui.find({ type: 'Box', text: /^sf › mcp › ✗ globex-sobjects$/ })).toBeDefined()
})

test('a CLI org and a hosted MCP server show side by side', async ($, on) => {
  const files = {
    ...FILES,
    [`${PROJECT}/.mcp.json`]: {
      mcpServers: { sf: { type: 'http', url: 'https://api.salesforce.com/platform/mcp/v1/sandbox/platform/sobject-all' } },
    },
  }
  stubSession(on, PROJECT, files)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: PROJECT })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'my-scratch' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'sf' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'sf › mcp › ' })).toBeDefined()
})

test('a DX MCP Server line lists the aliases it allows, with their types', async ($, on) => {
  const files = {
    ...FILES,
    [`${HOME}/.sfdx/alias.json`]: { orgs: { 'my-scratch': 'test-1@example.com', uat: 'me@acme.com.uat' } },
    [`${HOME}/.sfdx/me@acme.com.uat.json`]: { isSandbox: true },
    [`${PROJECT}/.mcp.json`]: {
      mcpServers: { 'salesforce-dx': { command: 'npx', args: ['-y', '@salesforce/mcp', '--orgs', 'DEFAULT_TARGET_ORG,uat'] } },
    },
  }
  stubSession(on, PROJECT, files)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: PROJECT })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: 'sf › cli › ' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'my-scratch, uat' })).toBeDefined()
    // A pill per org it reaches
    expect(await ui.find({ type: 'Box', text: /^sf › mcp › ✗ salesforce-dx › my-scratch, uat › speedy-1-dev-ed ›  scratch  sandbox $/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: ' sandbox ' })).toMatchObject({ props: { backgroundColor: 'warning' } })
    await ui.unmount()
  }
})

test('a DX MCP Server with ALLOW_ALL_ORGS gets a red all-orgs pill', async ($, on) => {
  const files = {
    [`${HOME}/.claude.json`]: {
      mcpServers: { dx: { command: 'npx', args: ['-y', '@salesforce/mcp', '--orgs', 'ALLOW_ALL_ORGS'] } },
    },
  }
  const clock = stubSession(on, '/work/plain', files)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work/plain' })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'every org the CLI knows' })).toBeDefined()
  const pillColor = async () => (await ui.find({ type: 'Text', text: ' all orgs ' }))?.props?.backgroundColor
  expect(await pillColor()).toBe('error')
  await clock.advance(600)
  expect(await pillColor()).toBe('error')
})

test('a scratch pill holds still', async ($, on) => {
  const clock = stubSession(on, PROJECT)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: PROJECT })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await clock.advance(600)
  expect(await ui.find({ type: 'Text', text: ' scratch ' })).toMatchObject({ props: { backgroundColor: 'success' } })
})

test('the band and sf-headless-config agree: connected servers, developer edition and SF_TARGET_ORG', async ($, on) => {
  const files = {
    [`${PROJECT}/sfdx-project.json`]: {},
    [`${PROJECT}/.sf/config.json`]: { 'target-org': 'my-scratch' },
    [`${HOME}/.sfdx/alias.json`]: { orgs: { 'my-scratch': 'test-1@example.com', dev: 'me@acme-dev.com' } },
    [`${HOME}/.sfdx/test-1@example.com.json`]: { isScratch: true, expirationDate: '2026-10-08' },
    [`${HOME}/.sfdx/me@acme-dev.com.json`]: { instanceUrl: 'https://acme-dev-ed.develop.my.salesforce.com' },
    [`${HOME}/.claude.json`]: {
      mcpServers: {
        'salesforce-dx': { command: 'npx', args: ['-y', '@salesforce/mcp', '--orgs', 'DEFAULT_TARGET_ORG'] },
        'sobject-all': { type: 'http', url: 'https://api.salesforce.com/platform/mcp/v1/platform/sobject-all' },
      },
      // Disabled for the project: not in use, so not in the band
      projects: { [PROJECT]: { disabledMcpServers: ['sobject-all'] } },
    },
  }
  stubSession(on, PROJECT, files, { SF_TARGET_ORG: 'dev' })
  on('session.usage', () => ({
    value: { context: { window: 200_000, breakdown: { mcpTools: [{ name: 'mcp__salesforce-dx__list_all_orgs', serverName: 'salesforce-dx', tokens: 100, isLoaded: true }] } } },
  }) as never)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: PROJECT })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    // SF_TARGET_ORG wins over the project's target-org, as the CLI has it
    expect(await ui.find({ type: 'Box', text: /^sf › cli › dev › acme-dev-ed ›  developer edition $/ })).toBeDefined()
    expect(await ui.find({ type: 'Box', text: /^sf › mcp › ✓ salesforce-dx › dev › acme-dev-ed ›  developer edition $/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: ' developer edition ' })).toMatchObject({ props: { backgroundColor: 'suggestion' } })
    expect(await ui.find({ type: 'Text', text: 'sobject-all' })).toBeUndefined()
    await ui.unmount()
  }
})

test('a default org changed in another session shows within a few seconds, as in sf-headless-config', async ($, on) => {
  const files: Record<string, unknown> = { ...FILES, [`${HOME}/.sfdx/me@acme.com.json`]: { instanceUrl: 'https://acme.my.salesforce.com' } }
  const mtimes: Record<string, number> = {}
  const clock = stubSession(on, PROJECT, files)
  on('fs.stat', ($, e) =>
    e.path in files
      ? { value: { kind: 'file', size: JSON.stringify(files[e.path]).length, mtimeMs: mtimes[e.path] ?? 1, isLink: false } }
      : { deny: 'ENOENT' },
  )
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: PROJECT })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'my-scratch' })).toBeDefined()

  // `sf config set target-org me@acme.com` in another terminal
  files[`${PROJECT}/.sf/config.json`] = { 'target-org': 'me@acme.com' }
  mtimes[`${PROJECT}/.sf/config.json`] = 2
  await clock.advance(3000)

  expect(await ui.find({ type: 'Text', text: 'me@acme.com' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: ' production ' })).toBeDefined()
  await ui.unmount()
})

test('each band line draws as one row: nothing in it stacks', async ($, on) => {
  const files = {
    ...FILES,
    [`${PROJECT}/.mcp.json`]: {
      mcpServers: {
        'salesforce-dx': { command: 'npx', args: ['-y', '@salesforce/mcp', '--orgs', 'DEFAULT_TARGET_ORG'] },
        a: { type: 'http', url: 'https://api.salesforce.com/platform/mcp/v1/platform/sobject-all', oauth: { clientId: 'k' } },
        b: { type: 'http', url: 'https://api.salesforce.com/platform/mcp/v1/platform/sobject-reads', oauth: { clientId: 'k' } },
      },
    },
  }
  stubSession(on, PROJECT, files)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: PROJECT })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    // The lines: the column of the band's own Box; in each, every Box lays its children in a row
    const lines = (await ui.findAll({ type: 'Box' })).filter(b => /^(sf|dx-|mcp-)/.test(b.key ?? ''))
    expect(lines.map(l => l.key)).toEqual(['sf', 'dx-salesforce-dx', 'mcp-production|k'])
    const stacked = (node: any): boolean =>
      node?.type === 'Fragment' ||
      (node?.type === 'Box' && node.props?.flexDirection !== undefined && node.props.flexDirection !== 'row') ||
      (Array.isArray(node?.children) && node.children.some(stacked))
    for (const line of lines) {
      expect(line.props.flexDirection).toBe('row')
      expect(line.children.some(stacked)).toBe(false)
    }
    await ui.unmount()
  }
})

test('the band starts off until /sf-headless-band turns it on', async ($, on) => {
  stubSession(on, PROJECT, FILES, {}, {})
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: PROJECT })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'my-scratch' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'another mod' })).toBeDefined()

  expect((await $.command.run({ command: 'sf-headless-band', args: '' } as never) as { text: string }).text).toMatch(/shown/)
  expect(await ui.find({ type: 'Text', text: 'my-scratch' })).toBeDefined()
  await ui.unmount()
})

test('/sf-headless-band hides and shows the band, and the choice is kept', async ($, on) => {
  stubSession(on, PROJECT)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: PROJECT })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'my-scratch' })).toBeDefined()

  expect((await $.command.run({ command: 'sf-headless-band', args: '' } as never) as { text: string }).text).toMatch(/hidden/)
  expect(await ui.find({ type: 'Text', text: 'my-scratch' })).toBeUndefined()
  // Other mods' band content stays
  expect(await ui.find({ type: 'Text', text: 'another mod' })).toBeDefined()

  // A new session keeps it hidden
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: PROJECT })
  expect(await ui.find({ type: 'Text', text: 'my-scratch' })).toBeUndefined()

  expect((await $.command.run({ command: 'sf-headless-band', args: 'on' } as never) as { text: string }).text).toMatch(/shown/)
  expect(await ui.find({ type: 'Text', text: 'my-scratch' })).toBeDefined()
  await ui.unmount()
})

test("a hosted server's calls carry its My Domain: the band names the org and its exact type, as the pane does", async ($, on) => {
  const files = {
    [`${HOME}/.claude.json`]: {
      mcpServers: { 'sf-headless-toolkit': { type: 'http', url: 'https://api.salesforce.com/platform/mcp/v1/platform/headless-360', oauth: { clientId: 'k' } } },
    },
  }
  stubSession(on, '/work/plain', files)
  let answer = 'ok'
  on('tool.call', () => ({ result: 'x', text: answer }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work/plain' })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  // Before any call: no type claimed
  expect(await ui.find({ type: 'Box', text: /^sf › mcp › ✗ sf-headless-toolkit$/ })).toBeDefined()

  // The URL a dispatch is given names the org
  await $.tool.call({ tool: 'mcp__sf-headless-toolkit__dispatch_readonly', url: 'https://headless-360-0826.my.salesforce.com/services/data/v66.0/tooling/query' } as never)
  expect(await ui.find({ type: 'Box', text: /^sf › mcp › ✗ sf-headless-toolkit › headless-360-0826 ›  production $/ })).toBeDefined()

  // A developer edition's result makes the type exact
  answer = '{"url":"https://acme-dev-ed.develop.my.salesforce.com/services/data"}'
  await $.tool.call({ tool: 'mcp__sf-headless-toolkit__dispatch_readonly' } as never)
  expect(await ui.find({ type: 'Box', text: /^sf › mcp › ✗ sf-headless-toolkit › acme-dev-ed ›  developer edition $/ })).toBeDefined()
  await ui.unmount()
})

test('outside a Salesforce project the global default org still shows, as a DX server resolves it', async ($, on) => {
  const files = {
    [`${HOME}/.sf/config.json`]: { 'target-org': 'uat-testing' },
    [`${HOME}/.sfdx/alias.json`]: { orgs: { 'uat-testing': 'demo@coworker-df26.com.dev' } },
    [`${HOME}/.sfdx/demo@coworker-df26.com.dev.json`]: { isSandbox: true, instanceUrl: 'https://coworker-df26--dev.sandbox.my.salesforce.com' },
    [`${HOME}/.claude.json`]: {
      mcpServers: { 'salesforce-dx': { command: 'npx', args: ['-y', '@salesforce/mcp', '--orgs', 'DEFAULT_TARGET_ORG'] } },
    },
  }
  stubSession(on, '/work/plain', files)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work/plain' })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Box', text: /^sf › cli › uat-testing › coworker-df26--dev ›  sandbox $/ })).toBeDefined()
  expect(await ui.find({ type: 'Box', text: /^sf › mcp › ✗ salesforce-dx › uat-testing › coworker-df26--dev ›  sandbox $/ })).toBeDefined()
  await ui.unmount()
})
