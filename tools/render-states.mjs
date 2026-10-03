/**
 * Render the registered surfaces in BOTH readiness states and assert what the
 * user actually sees.
 *
 * This exists because the not-ready state used to be silent: the composer pill
 * returned `null` (nothing at all) and the three panels returned a bare `…`.
 * A plugin whose Host half never loaded — the ordinary "installed but not
 * restarted" case — therefore looked identical to one that was still booting,
 * and the only sentence naming the fix sat behind a guard that state could not
 * pass. The regression this guards is "fails without saying why".
 *
 * It builds the real module with REAL react, resolves the real locale strings
 * from the source, and server-renders every slot registration.
 *
 * React is resolved from DSH_REACT_DIR or a `node_modules/react` found by
 * walking up from the working directory. When react is genuinely unavailable
 * the run is SKIPPED (exit 0) rather than failed, so this stays portable.
 *
 * Usage: node tools/render-states.mjs [client.js]
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'

const file = resolve(process.argv[2] ?? 'client.js')
const source = readFileSync(file, 'utf8')

// ------------------------------------------------------------------ react

/** @returns a `require` rooted where react lives, or null when it is absent. */
function findReact() {
  const candidates = []
  if (process.env.DSH_REACT_DIR) candidates.push(process.env.DSH_REACT_DIR)
  let dir = process.cwd()
  for (let i = 0; i < 6; i += 1) {
    candidates.push(join(dir, 'node_modules'))
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
  for (const base of candidates) {
    try {
      const req = createRequire(join(base, 'noop.js'))
      const react = req('react')
      const domServer = req('react-dom/server')
      const dom = req('react-dom')
      if (react !== undefined && domServer !== undefined) return { req, react, domServer, dom }
    } catch {
      // try the next candidate
    }
  }
  return null
}

const found = findReact()
if (found === null) {
  console.log(`${file}: SKIPPED — react/react-dom not resolvable (set DSH_REACT_DIR to enable)`)
  process.exit(0)
}
const { react: React, domServer, dom: ReactDOM } = found

// ---------------------------------------------------------------- locales

/** Pull the real zh/en strings out of the source, so assertions see user text. */
function readLocale(table) {
  const lines = source.split(/\r?\n/)
  const start = lines.findIndex(line => new RegExp(`^\\s*const ${table} = \\{$`).test(line))
  const strings = new Map()
  if (start < 0) return strings
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s*\}$/.test(lines[i])) break
    const match = /^\s{6}([A-Za-z][A-Za-z0-9_]*):\s*(['"])((?:[^'"\\]|\\.)*)\2/.exec(lines[i])
    if (match !== null) strings.set(match[1], match[3])
  }
  return strings
}

const ZH = readLocale('ZH')
const EN = readLocale('EN')

// ------------------------------------------------------------- the module

const problems = []
const note = message => problems.push(message)

/**
 * Build the module against a stub context and return its slot registrations.
 * @param describe - what `ctx.remote.settings.describe()` resolves to.
 */
async function mount(describe) {
  const spec = {}
  const fakeWindow = {
    __ModuleLoader__: { load: captured => { spec.value = captured } },
    matchMedia: () => ({ matches: false }),
    innerWidth: 1440,
    innerHeight: 900,
  }
  // eslint-disable-next-line no-new-func -- a browser script, not ESM.
  new Function('window', `${source}\n`)(fakeWindow)
  const exported = spec.value.factory(id => {
    if (id === 'react') return React
    if (id === 'react-dom') return ReactDOM
    throw new Error(`unexpected require(${JSON.stringify(id)})`)
  })

  const registered = []
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    locale: {
      register: () => () => {},
      // Real strings: assertions must see what a user sees, not key names.
      bind: () => (key, params) => {
        const raw = ZH.get(key) ?? EN.get(key) ?? key
        if (params === undefined) return raw
        return raw.replace(/\{(\w+)\}/g, (whole, name) =>
          (params[name] === undefined ? whole : String(params[name])))
      },
    },
    slots: {
      inject: (_key, callback) => { callback(); return () => {} },
      register: (options, Component) => {
        registered.push({ options, Component })
        return () => {}
      },
    },
    sessions: { list: { subscribe: () => () => {}, getSnapshot: () => ({ ids: [], byId: {} }) } },
    remote: { settings: { describe, update: async () => ({}) } },
    effect: callback => { const r = callback(); return typeof r === 'function' ? r : () => {} },
    inject: (_deps, callback) => { callback(ctx); return () => {} },
    get: () => undefined,
  }

  exported.apply(ctx)
  // `apply` kicks off `pull()` without awaiting it; let it settle so `readiness`
  // is the state the UI would actually paint.
  await new Promise(done => setTimeout(done, 30))
  return registered
}

/** Props the slot host would pass; the hook stubs answer the two selectors. */
const PROPS = {
  sessionId: 'session-under-test',
  useSessions: selector => selector({ byId: {}, items: [] }),
  useWorkspaces: selector => selector({ byId: {}, items: [] }),
}

/** @returns `{ label, html }` or `{ label, error }` for one surface. */
function render(entry) {
  const name = entry.options?.name ?? '?'
  const id = entry.options?.id ?? entry.options?.key ?? '?'
  const label = `${name}[${id}]`
  try {
    const html = domServer.renderToStaticMarkup(React.createElement(entry.Component, PROPS))
    return { label, html }
  } catch (error) {
    return { label, error: `${error?.constructor?.name ?? 'Error'}: ${error?.message ?? error}` }
  }
}

// ------------------------------------------------------- 1. the broken state

console.log(`${file}: readiness states render as intended`)

const broken = await mount(async () => ({ ok: true, value: { namespaces: [] } }))
if (broken.length === 0) note('the module registered no slots')

let sawRestartHint = 0
for (const entry of broken) {
  const result = render(entry)
  if (result.error !== undefined) {
    note(`${result.label} threw in the not-ready state: ${result.error}`)
    continue
  }
  // The hint may live in a `title` attribute (the compact pill keeps its label
  // short), so search the RAW markup, not the stripped text.
  const text = result.html.replace(/<[^>]*>/g, '')
  const hasHint = result.html.includes(ZH.get('notReadyMissingHint') ?? 'notReadyMissingHint')
  const hasTitle = result.html.includes(ZH.get('notReadyMissing'))
  const hasRestartWord = text.includes(ZH.get('notReadyShort'))
  // Silence means LITERALLY nothing, or the old bare ellipsis. A component that
  // renders icon markup with no text content (the sidebar entries) is not
  // silent — stripping tags just empties it.
  const isSilent = result.html.trim() === '' || text.trim() === '…'
  if (hasHint || hasTitle || hasRestartWord) sawRestartHint += 1
  if (isSilent) note(`${result.label} is SILENT in the not-ready state (renders ${JSON.stringify(text.trim())})`)
  console.log(`    ${result.label.padEnd(30)} ${String(result.html.length).padStart(5)}B  ${isSilent ? 'SILENT' : (hasHint || hasTitle || hasRestartWord ? 'states the fix' : 'renders')}`)
}

if (sawRestartHint === 0) {
  note('no surface told the user to restart the harness — the exact regression this guards')
}

// ------------------------------------------------------ 2. the healthy state

const healthy = await mount(async () => ({
  ok: true,
  value: {
    namespaces: [{
      ns: 'dsh-cost',
      revision: 1,
      value: { currency: 'CNY', flushMs: 4000, models: [], holidays: [], ledger: {} },
      user: { currency: 'CNY', models: [], holidays: [], ledger: {} },
    }],
  },
}))

let healthyOk = 0
for (const entry of healthy) {
  const result = render(entry)
  if (result.error !== undefined) {
    note(`${result.label} threw with a loaded namespace: ${result.error}`)
    continue
  }
  healthyOk += 1
  const text = result.html.replace(/<[^>]*>/g, '')
  if (text.includes(ZH.get('notReadyMissing'))) {
    note(`${result.label} still shows the not-ready notice after the namespace loaded`)
  }
}

console.log(`  not-ready surfaces : ${broken.length} rendered, ${sawRestartHint} show the restart hint`)
console.log(`  healthy surfaces   : ${healthyOk}/${healthy.length} rendered clean`)
console.log(`  zh strings resolved: ${ZH.size} (assertions use real user-facing text)`)

if (problems.length > 0) {
  console.log('')
  for (const problem of problems) console.log(`  FAIL ${problem}`)
  process.exitCode = 1
}
