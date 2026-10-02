/**
 * Prove the plugin needs NO price-table setup on a fresh machine.
 *
 * The claim under test: with no `dsh-cost:` section at all — no user layer, no
 * hand editing — the Host still resolves a complete, effective-dated price
 * table, so `adoptConfig(view.value)` on the Client prices every request.
 *
 * It imports the real `index.js`, captures the schema the Host registers, and
 * resolves it against an empty input. It then asserts the canonical table the
 * maintainer approved, so a later edit cannot silently drift away from it.
 *
 * Usage: node tools/check-defaults.mjs [index.js]
 */

import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const indexPath = resolve(process.argv[2] ?? 'index.js')
const problems = []
const fail = message => problems.push(message)

// ----------------------------------------------------------------- 1. mount

let captured
const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  settings: {
    register: (namespace, schema, options) => {
      captured = { namespace, schema, options }
      return () => {}
    },
  },
  inject: () => () => {},
  effect: () => () => {},
  get: () => undefined,
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

if (captured === undefined) {
  console.log(`${indexPath}: FAILED — apply() registered no settings namespace`)
  process.exit(1)
}
if (typeof captured.schema !== 'function') {
  console.log(`${indexPath}: FAILED — registered schema is not callable`)
  process.exit(1)
}

// ---------------------------------------------------- 2. resolve with nothing

/** Fresh install: the namespace is absent, so the Host resolves `{}`. */
const fresh = captured.schema({})

// A hand-edited or half-written section must not lose the built-in table.
const empty = captured.schema({ models: [], holidays: [] })
const junk = captured.schema({ models: [{ match: '   ' }, null, 7], holidays: 'nope' })

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

const described = typeof captured.schema.toJSON === 'function' ? captured.schema.toJSON() : null
if (described === null || typeof described !== 'object') {
  fail('schema.toJSON() did not return a descriptor')
}

// ---------------------------------------------------------------- 4. report

console.log(`${indexPath}: defaults are self-sufficient`)
console.log(`  namespace   : ${captured.namespace} (${mod.SCHEMA_TAG ?? 'no tag'})`)
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

if (problems.length > 0) {
  console.log('')
  for (const problem of problems) console.log(`  FAIL ${problem}`)
  process.exitCode = 1
}
