import { expect, test } from 'claude-code/testing'

import { resolveMcp } from '../hooks/mcp'

const HOME = '/home/me'
const NOW = Date.parse('2026-10-06T12:00:00Z')
const PROD = 'https://api.salesforce.com/platform/mcp/v1/platform/sobject-all'
const SANDBOX = 'https://api.salesforce.com/platform/mcp/v1/sandbox/platform/metadata-experts'

const files = (entries: Record<string, unknown>) => async (path: string) =>
  path in entries ? JSON.stringify(entries[path]) : undefined

const hostedOf = async (read: (path: string) => Promise<string | undefined>, cwd: string, configDir?: string) =>
  (await resolveMcp(read, cwd, HOME, NOW, configDir)).hosted

const KEY = '3MVG9-consumer-key'
const hosted = (url: string, clientId = KEY) => ({ type: 'http', url, oauth: { clientId, callbackPort: 38000 } })

test('with no hosted servers configured there are none', async () => {
  const read = files({
    [`${HOME}/.claude.json`]: { mcpServers: { docs: { type: 'stdio', command: 'docker' } } },
  })
  expect(await hostedOf(read, '/work/app')).toEqual([])
})

test('a local-scope server in a parent project: its URL kind kept, no type claimed until a call shows the org', async () => {
  const read = files({
    [`${HOME}/.claude.json`]: {
      projects: { '/work/app': { mcpServers: { 'sobject-all': hosted(PROD), 'metadata-experts': hosted(SANDBOX) } } },
    },
  })
  expect(await hostedOf(read, '/work/app/force-app')).toEqual([
    { server: 'metadata-experts', type: 'unknown', clientId: KEY, urlType: 'sandbox', domainKey: `app:${KEY}|sandbox`, isConnected: false },
    { server: 'sobject-all', type: 'unknown', clientId: KEY, urlType: 'production', domainKey: `app:${KEY}|production`, isConnected: false },
  ])
})

test('user and project scopes count, the nearer scope winning by name', async () => {
  const read = files({
    [`${HOME}/.claude.json`]: { mcpServers: { sf: hosted(PROD) } },
    '/work/app/.mcp.json': { mcpServers: { sf: hosted(SANDBOX) } },
  })
  expect(await hostedOf(read, '/work/app')).toEqual([{ server: 'sf', type: 'unknown', clientId: KEY, urlType: 'sandbox', domainKey: `app:${KEY}|sandbox`, isConnected: false }])
})

test('an mcp-remote bridge is read from its args', async () => {
  const read = files({
    '/p/.mcp.json': {
      mcpServers: {
        bridge: {
          command: 'npx',
          args: ['-y', 'mcp-remote@0.1.18', SANDBOX, '8080', '--static-oauth-client-info', '{"client_id":"3MVG9-other","client_secret":""}'],
        },
        bare: { command: 'npx', args: ['-y', 'mcp-remote@0.1.18', PROD] },
      },
    },
  })
  expect(await hostedOf(read, '/p')).toEqual([
    { server: 'bare', type: 'unknown', urlType: 'production', domainKey: 'server:bare|sobject-all|production', isConnected: false },
    { server: 'bridge', type: 'unknown', clientId: '3MVG9-other', urlType: 'sandbox', domainKey: 'app:3MVG9-other|sandbox', isConnected: false },
  ])
})

test('disabled servers are left out', async () => {
  const read = files({
    [`${HOME}/.claude.json`]: {
      mcpServers: { a: hosted(PROD) },
      projects: { '/p': { disabledMcpServers: ['a'], disabledMcpjsonServers: ['b'] } },
    },
    '/p/.mcp.json': { mcpServers: { b: hosted(PROD) } },
  })
  expect(await hostedOf(read, '/p')).toEqual([])
})

test('CLAUDE_CONFIG_DIR moves .claude.json', async () => {
  const read = files({ '/cfg/.claude.json': { mcpServers: { sf: hosted(PROD) } } })
  expect(await hostedOf(read, '/p', '/cfg')).toEqual([{ server: 'sf', type: 'unknown', clientId: KEY, urlType: 'production', domainKey: `app:${KEY}|production`, isConnected: false }])
})

const dxServer = (orgs: string) => ({ command: 'npx', args: ['-y', '@salesforce/mcp', '--orgs', orgs, '--toolsets', 'all'] })

test('a DX MCP Server resolves DEFAULT_TARGET_ORG and named aliases through the CLI', async () => {
  const read = files({
    '/work/app/sfdx-project.json': {},
    '/work/app/.sf/config.json': { 'target-org': 'my-scratch' },
    [`${HOME}/.sfdx/alias.json`]: { orgs: { 'my-scratch': 'test-1@example.com', uat: 'me@acme.com.uat' } },
    [`${HOME}/.sfdx/test-1@example.com.json`]: { isScratch: true, expirationDate: '2026-10-08' },
    [`${HOME}/.sfdx/me@acme.com.uat.json`]: { isSandbox: true },
    '/work/app/.mcp.json': { mcpServers: { 'salesforce-dx': dxServer('DEFAULT_TARGET_ORG,uat') } },
  })
  const { dx, hosted } = await resolveMcp(read, '/work/app', HOME, NOW)
  expect(hosted).toEqual([])
  expect(dx).toEqual([
    {
      server: 'salesforce-dx',
      allOrgs: false,
      type: 'sandbox',
      isConnected: false,
      orgs: [
        { name: 'my-scratch', username: 'test-1@example.com', type: 'scratch', daysLeft: 2 },
        { name: 'uat', username: 'me@acme.com.uat', type: 'sandbox', daysLeft: undefined },
      ],
    },
  ])
})

test('ALLOW_ALL_ORGS, the Dev Hub, an --orgs= flag and an unset default', async () => {
  const read = files({
    [`${HOME}/.sf/config.json`]: { 'target-dev-hub': 'hub' },
    [`${HOME}/.sfdx/alias.json`]: { orgs: { hub: 'me@acme.com' } },
    [`${HOME}/.sfdx/me@acme.com.json`]: { isDevHub: true },
    [`${HOME}/.claude.json`]: {
      mcpServers: {
        dx: { command: 'npx', args: ['@salesforce/mcp@latest', '--orgs=DEFAULT_TARGET_DEV_HUB,ALLOW_ALL_ORGS'] },
        none: dxServer('DEFAULT_TARGET_ORG'),
      },
    },
  })
  expect((await resolveMcp(read, '/p', HOME, NOW)).dx).toEqual([
    { server: 'dx', allOrgs: true, type: 'production', isConnected: false, orgs: [{ name: 'hub', username: 'me@acme.com', type: 'production', daysLeft: undefined }] },
    { server: 'none', allOrgs: false, type: 'unknown', isConnected: false, orgs: [] },
  ])
})
