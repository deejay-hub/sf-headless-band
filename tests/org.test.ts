import { expect, test } from 'claude-code/testing'

import { daysUntil, resolveOrg } from '../hooks/org'

const HOME = '/home/me'
const NOW = Date.parse('2026-10-06T12:00:00Z')

const files = (entries: Record<string, unknown>) => async (path: string) =>
  path in entries ? JSON.stringify(entries[path]) : undefined

const auth = (username: string, fields: Record<string, unknown>) => ({
  [`${HOME}/.sfdx/${username}.json`]: { username, ...fields },
})

test('outside a Salesforce project the global default org applies, as for a DX server; with none set there is no org', async () => {
  const read = files({ [`${HOME}/.sf/config.json`]: { 'target-org': 'dev' } })
  expect(await resolveOrg(read, '/work/plain', HOME, NOW)).toMatchObject({ name: 'dev', type: 'unknown' })
  expect(await resolveOrg(files({}), '/work/plain', HOME, NOW)).toBe(null)
})

test('a scratch org in a parent project, by alias, with days to expiry', async () => {
  const read = files({
    '/work/app/sfdx-project.json': {},
    '/work/app/.sf/config.json': { 'target-org': 'scratchy' },
    [`${HOME}/.sfdx/alias.json`]: { orgs: { scratchy: 'test-1@example.com' } },
    ...auth('test-1@example.com', { isScratch: true, expirationDate: '2026-10-13' }),
  })
  expect(await resolveOrg(read, '/work/app/force-app/main', HOME, NOW)).toEqual({
    name: 'scratchy',
    username: 'test-1@example.com',
    type: 'scratch',
    daysLeft: 7,
  })
})

test('the global target org applies when the project sets none', async () => {
  const read = files({
    '/work/app/sfdx-project.json': {},
    [`${HOME}/.sf/config.json`]: { 'target-org': 'me@prod.com' },
    ...auth('me@prod.com', { isScratch: false, isSandbox: false }),
  })
  expect(await resolveOrg(read, '/work/app', HOME, NOW)).toMatchObject({ name: 'me@prod.com', type: 'production' })
})

test('the instance URL tells sandbox and scratch apart when the flags are absent', async () => {
  const read = files({
    '/p/sfdx-project.json': {},
    '/p/.sf/config.json': { 'target-org': 'u@sb.com' },
    ...auth('u@sb.com', { instanceUrl: 'https://acme--uat.sandbox.my.salesforce.com' }),
  })
  expect(await resolveOrg(read, '/p', HOME, NOW)).toMatchObject({ type: 'sandbox', daysLeft: undefined })
})

test('an org with no auth file is unknown', async () => {
  const read = files({ '/p/sfdx-project.json': {}, '/p/.sf/config.json': { 'target-org': 'gone' } })
  expect(await resolveOrg(read, '/p', HOME, NOW)).toMatchObject({ name: 'gone', type: 'unknown' })
})

test('days until expiry', () => {
  expect(daysUntil('2026-10-07', NOW)).toBe(1)
  expect(daysUntil('2026-10-01', NOW)).toBe(0)
})
