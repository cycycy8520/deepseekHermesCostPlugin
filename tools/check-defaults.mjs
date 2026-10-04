/**
 * Prove the plugin needs NO price-table setup on a fresh machine.
 *
 * The claim under test: with no state document at all — no user layer, no hand
 * editing — the Host still resolves a complete, effective-dated price table, so
 * the Client prices every request.
 *
 * It imports the real `index.js` and mounts it against a stub context, then
 * checks both halves of the contract that replaced the settings namespace:
 *
 *   1. `apply()` registers the three `/api/cost` routes the Client calls
 *   2. an absent, empty, or junk document still resolves the canonical table
 *
 * Usage: node tools/check-defaults.mjs [index.js]
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const indexPath = resolve(process.argv[2] ?? 'index.js')
const problems = []
const fail = message => problems.push(message)

// ----------------------------------------------------------------- 1. mount

// The document is plugin-owned, so the check drives it through a scratch
// harness home rather than a settings namespace.
const scratchHome = mkdtempSync(join(tmpdir(), 'dsh-cost-defaults-'))
process.env.DSH_HOME = scratchHome

const routes = new Map()
const scoped = {
  connection: {
    fetch: {
      register: async route => {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
  },
  sessionQuery: { readSession: async () => ({ events: [] }) },
  effect: run => run(),
  logger: { info() {}, warn() {}, error() {} },
}
const ctx = {
  logger: scoped.logger,
  inject: (dependencies, callback) => callback(scoped),
}

let mod
try {
  mod = await import(pathToFileURL(indexPath).href)
} catch (error) {
  console.log(`${indexPath}: FAILED — import threw: ${error?.message ?? error}`)
  process.exit(1)
}

try {
  mod.apply(ctx)
} catch (error) {
  console.log(`${indexPath}: FAILED — apply threw: ${error?.message ?? error}`)
  process.exit(1)
}

for (const path of ['/api/cost/state', '/api/cost/config', '/api/cost/backfill']) {
  if (!routes.has(path)) fail(`apply() registered no ${path} route`)
}
if (typeof mod.resolveConfig !== 'function') {
  console.log(`${indexPath}: FAILED — the Host half exports no resolveConfig()`)
  process.exit(1)
}

// ---------------------------------------------------- 2. resolve with nothing

/** Fresh install: no document, so the resolver sees nothing. */
const fresh = mod.resolveConfig(undefined)

// A hand-edited or half-written document must not lose the built-in table.
const empty = mod.resolveConfig({ models: [], holidays: [] })
const junk = mod.resolveConfig({ models: [{ match: '   ' }, null, 7], holidays: 'nope' })

// ------------------------------------------------------------------- budgets
//
// A limit drives a warning, so an unusable one must be dropped rather than
// repaired into a different number: a budget nobody set, that nonetheless warns,
// is worse than no budget at all.
const budgets = mod.resolveConfig({
  budgets: {
    '': { amount: 100, period: 'month' },
    w1: { amount: 50, period: 'day' },
    negative: { amount: -5, period: 'month' },
    zero: { amount: 0 },
    nonsense: { amount: 10, period: 'fortnight' },
    notAnObject: 7,
  },
}).budgets
const budgetKeys = Object.keys(budgets).sort().join(',')
if (budgetKeys !== ',nonsense,w1') {
  console.log(`${indexPath}: FAILED — budget normalization kept ${budgetKeys || '(nothing)'}`)
  process.exit(1)
}
if (budgets.nonsense.period !== 'month') {
  console.log(`${indexPath}: FAILED — an unknown period must fall back to month, got ${budgets.nonsense.period}`)
  process.exit(1)
}
if (budgets[''].amount !== 100 || budgets.w1.period !== 'day') {
  console.log(`${indexPath}: FAILED — a valid budget was altered`)
  process.exit(1)
}
if (mod.resolveConfig(null).budgets === undefined) {
  console.log(`${indexPath}: FAILED — resolveConfig must always expose a budgets table`)
  process.exit(1)
}

if (fresh === null || typeof fresh !== 'object') {
  console.log(`${indexPath}: FAILED — schema({}) returned ${String(fresh)}`)
  process.exit(1)
}

// ------------------------------------------------------------ 3. the table

/** The maintainer's approved table, in CNY per 1M tokens (PEAK rates). */
const EXPECTED = [
  { match: 'deepseek-v4-pro', from: '2026-08-16T16:00:00.000Z', to: null, rates: [0.3, 9, 0, 27], plan: false },
  { match: 'deepseek-v4-flash', from: '2026-08-16T16:00:00.000Z', to: '2026-09-10T04:00:00.000Z', rates: [0.1, 3, 0, 9], plan: false },
  { match: 'deepseek-v4-flash', from: '2026-09-10T04:00:00.000Z', to: null, rates: [0.04, 2, 0, 8], plan: false },
  { match: 'deepseek-flash', from: '2026-09-10T04:00:00.000Z', to: null, rates: [0.04, 2, 0, 8], plan: false },
  { match: 'xiaomi/mimo-v2.5-pro', from: null, to: null, rates: [0.025, 3, 0, 6], plan: false },
  { match: 'xiaomi/mimo-v2.5', from: null, to: null, rates: [0.02, 1, 0, 2], plan: false },
  { match: 'xiaomi-token-plan-cn/*', from: null, to: null, rates: [2.5, 300, 0, 600], plan: true },
]

const tuple = row => [
  row.match,
  row.from ?? null,
  row.to ?? null,
  row.rates.cacheHit,
  row.rates.cacheMiss,
  row.rates.cacheWrite,
  row.rates.output,
  row.tokenPlan === true,
].join('|')

const actual = fresh.models.map(tuple)
const expected = EXPECTED.map(row => [
  row.match, row.from, row.to, ...row.rates, row.plan,
].join('|'))

if (actual.length !== expected.length) {
  fail(`fresh resolve has ${actual.length} price rows, expected ${expected.length}`)
}
for (let i = 0; i < Math.max(actual.length, expected.length); i += 1) {
  if (actual[i] !== expected[i]) {
    fail(`price row ${i}:\n      got      ${actual[i] ?? '(missing)'}\n      expected ${expected[i] ?? '(missing)'}`)
  }
}

// An empty or junk section must fall back to the same table.
for (const [label, value] of [['{ models: [] }', empty], ['junk rows', junk]]) {
  const got = value.models.map(tuple)
  if (got.join('\n') !== expected.join('\n')) {
    fail(`${label} did not fall back to the built-in table (${got.length} rows)`)
  }
}

// The tariff depends on the off-peak calendar, so it must ship too.
const holidayCount = Array.isArray(fresh.holidays) ? fresh.holidays.length : 0
if (holidayCount === 0) fail('fresh resolve has no holiday calendar')

for (const [index, row] of fresh.models.entries()) {
  const expectedDiscount = EXPECTED[index]?.plan === true || EXPECTED[index]?.match.startsWith('xiaomi/')
  if (expectedDiscount) {
    if (row.discount !== undefined) fail(`row ${index} (${row.match}) should carry no off-peak discount`)
  } else if (row.discount?.offPeakRatio !== 0.5 || row.discount?.weekdaysOnly !== true) {
    fail(`row ${index} (${row.match}) lost its off-peak discount`)
  }
}

// The route the Client actually calls must serve that same table, and a fresh
// document must start at revision 0 so the Client's first write is never a
// stale-revision conflict.
const stateRoute = routes.get('/api/cost/state')
if (stateRoute !== undefined) {
  const response = await stateRoute.fetch(new Request('http://127.0.0.1/api/cost/state', { method: 'GET' }))
  const payload = await response.json().catch(() => null)
  if (response.status !== 200 || payload?.ok !== true) {
    fail(`GET /api/cost/state answered ${response.status}`)
  } else {
    const served = payload.config.models.map(tuple)
    if (served.join('\n') !== expected.join('\n')) {
      fail('the state route did not serve the built-in table')
    }
    if (payload.revision !== 0) fail(`a fresh document should be revision 0, got ${payload.revision}`)
    if (payload.ledger === null || typeof payload.ledger !== 'object') fail('the state route served no ledger object')
  }
}

const statePath = mod.stateFilePath()
if (!statePath.startsWith(scratchHome)) fail(`stateFilePath() escaped DSH_HOME: ${statePath}`)

// ---------------------------------------------------------------- 4. report

console.log(`${indexPath}: defaults are self-sufficient`)
console.log(`  document    : ${statePath} (${mod.SCHEMA_TAG ?? 'no tag'})`)
console.log(`  routes      : ${[...routes.keys()].join(', ')}`)
console.log(`  currency    : ${fresh.currency}`)
console.log(`  price rows  : ${fresh.models.length} (from an empty section)`)
console.log(`  holidays    : ${holidayCount} off-peak dates`)
for (const row of fresh.models) {
  const rates = `${row.rates.cacheHit}/${row.rates.cacheMiss}/${row.rates.cacheWrite}/${row.rates.output}`
  const span = row.from === null ? 'always' : `${row.from.slice(0, 10)} → ${(row.to ?? 'open').slice(0, 10)}`
  const unit = row.tokenPlan === true ? row.currency : `${row.currency}/1M`
  const off = row.discount === undefined ? '' : ` off-peak ×${row.discount.offPeakRatio}`
  console.log(`    ${row.match.padEnd(24)} ${rates.padEnd(22)} ${unit.padEnd(11)} ${span}${off}`)
}
console.log('  a fresh install needs no price-table editing')

/* ------------------------------------------------- project attribution (host) */

// The slug encoder is what lets a spawned child session be placed in its project: the
// session store names a workspace's directory with this encoding, and a wrong slug
// attributes nothing silently. These are the three real workspace paths from the
// machine that reported the bug, each checked against its real directory name.
if (mod.encodeWorkspaceSlug('E:\\SPMAN\\md') !== '--E-SPMAN-md--') {
  fail(`slug for a plain path: ${mod.encodeWorkspaceSlug('E:\\SPMAN\\md')}`)
}
if (mod.encodeWorkspaceSlug('E:\\DeepSeek\\小组插件') !== '--E-DeepSeek-~5C0F~7EC4~63D2~4EF6--'
  || mod.encodeWorkspaceSlug('E:\\脑力填填填') !== '--E-~8111~529B~586B~586B~586B--') {
  fail(`slug for a non-ASCII path: ${mod.encodeWorkspaceSlug('E:\\DeepSeek\\小组插件')}`)
}
// End to end, against a store shaped like the real one: a spawned child session is
// listed by NO workspace, so the directory it lives in is the only thing that can
// place it. This is the regression the plugin shipped once already.
const childId = 'child-session-under-a-workspace'
const slug = mod.encodeWorkspaceSlug('E:\\SPMAN\\md')
mkdirSync(join(scratchHome, 'sessions', slug, childId), { recursive: true })
mkdirSync(join(scratchHome, 'storages'), { recursive: true })
writeFileSync(join(scratchHome, 'storages', 'workspace.json'), JSON.stringify({
  tables: { workspaces: { 'uuid-md': { path: 'E:\\SPMAN\\md', title: 'md', sessionIds: [] } } },
}))
const attribution = mod.workspaceIdBySession()
if (!(attribution instanceof Map)) fail('workspaceIdBySession() did not return a map')
if (attribution.get(childId) !== 'uuid-md') {
  fail(`an unlisted child session was not attributed to its workspace: ${String(attribution.get(childId))}`)
}
console.log(`  project attribution places an unlisted child session (${attribution.size} stored session(s))`)
if (problems.length > 0) {
  console.log('')
  for (const problem of problems) console.log(`  FAIL ${problem}`)
  process.exitCode = 1
}
rmSync(scratchHome, { recursive: true, force: true })

