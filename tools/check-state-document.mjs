/**
 * Behaviour of the Host-owned state document, without booting the harness.
 *
 * The document replaced the settings namespace, so this is where the storage
 * contract is pinned: a fresh read resolves the built-in table, a ledger patch
 * merges and bumps the revision, a stale revision is refused instead of
 * clobbering a concurrent writer, a config edit keeps the price table, and the
 * file actually lands under `DSH_HOME`.
 *
 * Usage: node tools/check-state-document.mjs [index.js]
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// The document is plugin-owned, so the whole check runs against a scratch home.
const scratch = mkdtempSync(join(tmpdir(), 'dsh-cost-state-'))
process.env.DSH_HOME = scratch

const module = await import(pathToFileURL(resolve(process.argv[2] ?? 'index.js')).href)

const routes = new Map()
const effects = []
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
  effect: (run, label) => { effects.push(label); const dispose = run(); return dispose },
  logger: { info: () => {}, warn: () => {}, error: (...a) => console.error('host error:', ...a) },
}
// `ctx.inject(deps, cb)` is called once per mount; run each callback eagerly.
const ctx = {
  logger: scoped.logger,
  inject: (deps, callback) => callback(scoped),
}

module.apply(ctx)

const checks = []
const check = (label, condition, detail = '') => {
  checks.push({ label, ok: condition === true, detail })
  console.log(`${condition === true ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : `  (${detail})`}`)
}

const call = async (path, method, body) => {
  const route = routes.get(path)
  if (route === undefined) throw new Error(`route ${path} is not registered`)
  const request = new Request(`http://127.0.0.1/api${path.slice(4)}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const response = await route.fetch(request)
  return { status: response.status, body: await response.json() }
}

check('state route registered', routes.has('/api/cost/state'))
check('config route registered', routes.has('/api/cost/config'))
check('backfill route registered', routes.has('/api/cost/backfill'))
check('effects registered', effects.length === 3, effects.join(' | '))
check('balance route registered', routes.has('/api/cost/balance'))

let state = await call('/api/cost/state', 'GET')
check('fresh document answers ok', state.body.ok === true && state.status === 200)
check('fresh revision is 0', state.body.revision === 0, `revision=${state.body.revision}`)
check('built-in price table present', Array.isArray(state.body.config.models) && state.body.config.models.length >= 5,
  `models=${state.body.config.models?.length}`)
check('built-in holidays present', state.body.config.holidays.length > 20, `holidays=${state.body.config.holidays.length}`)
check('ledger starts empty', Object.keys(state.body.ledger).length === 0)

const writes = await call('/api/cost/state', 'POST', {
  revision: 0,
  ledger: { 'session-a': { cost: 1.5, charged: { cacheRead: 10, output: 20 }, model: 'deepseek-flash' } },
})
check('ledger write accepted', writes.body.ok === true, JSON.stringify(writes.body))
check('revision advanced to 1', writes.body.revision === 1)

state = await call('/api/cost/state', 'GET')
check('ledger row persisted in memory', state.body.ledger['session-a']?.cost === 1.5)
check('ledger row normalized', state.body.ledger['session-a']?.byBucket?.cacheMiss === 0)

const conflict = await call('/api/cost/state', 'POST', { revision: 0, ledger: { 'session-b': { cost: 9 } } })
check('stale revision refused', conflict.body.ok === false && conflict.status === 409, JSON.stringify(conflict.body))
check('conflict reports current revision', conflict.body.revision === 1)

const config = await call('/api/cost/config', 'POST', { revision: 1, config: { currency: 'USD', flushMs: 3000 } })
check('config write accepted', config.body.ok === true, JSON.stringify(config.body))
check('config revision advanced', config.body.revision === 2)
check('untouched model table kept', config.body.config.models.length >= 5)
check('currency applied', config.body.config.currency === 'USD')
check('stray keys ignored', config.body.config.ledger === undefined)

await new Promise(resolve => setTimeout(resolve, 250))
const onDisk = JSON.parse(readFileSync(module.stateFilePath(), 'utf8'))
check('document written to disk', onDisk.revision === 2 && onDisk.config.currency === 'USD')
check('disk document is versioned', onDisk.version === 1)
check('disk ledger intact', onDisk.ledger['session-a']?.cost === 1.5)
console.log(`state file: ${module.stateFilePath()}`)

const failed = checks.filter(entry => !entry.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
rmSync(scratch, { recursive: true, force: true })
if (failed.length > 0) process.exit(1)
