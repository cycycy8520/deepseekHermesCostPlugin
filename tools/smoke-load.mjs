/**
 * Load-time smoke test for the Client half.
 *
 * Executes the real module in Node with a stub module loader and a minimal
 * `react` (no rendering: `createElement` returns null, no hook is ever called,
 * no DOM exists). It proves exactly two things:
 *
 *   1. the module INITIALIZES — no top-level reference error
 *   2. `apply(ctx)` runs against a plausible context and registers its slots
 *
 * That first point is the one that took the whole UI down. A top-level `const`
 * reading a `const` declared later in the file throws a TDZ ReferenceError at
 * import time, so the plugin never loads and the panel it owns goes blank.
 * `node --check` cannot see it (the file is valid syntax) and neither can a
 * "is this name bound anywhere" audit (it IS bound — just not yet).
 *
 * It does NOT render, and proves nothing about appearance.
 *
 * Usage: node tools/smoke-load.mjs <client.js>
 */

import { readFileSync } from 'node:fs'

const file = process.argv[2]
const source = readFileSync(file, 'utf8')

/** Minimal React stand-in: enough for `class X extends React.Component` to parse. */
const stubReact = {
  Component: class Component {
    constructor(props) {
      this.props = props
    }
  },
  createElement: () => null,
  Fragment: Symbol('Fragment'),
}

const stubRequire = id => {
  if (id === 'react') return stubReact
  if (id === 'react-dom') return { createPortal: () => null }
  throw new Error(`unexpected require(${JSON.stringify(id)})`)
}

let spec
const fakeWindow = {
  __ModuleLoader__: {
    load: captured => {
      spec = captured
    },
  },
  matchMedia: () => ({ matches: true }),
  innerWidth: 1440,
  innerHeight: 900,
}

const fail = message => {
  console.log(`${file}: FAILED — ${message}`)
  process.exitCode = 1
}

// ------------------------------------------------------------------ 1. load

try {
  // eslint-disable-next-line no-new-func -- the module is a browser script, not ESM.
  new Function('window', `${source}\n`)(fakeWindow)
} catch (error) {
  fail(`module evaluation threw: ${error?.constructor?.name ?? 'Error'}: ${error?.message ?? error}`)
  process.exit()
}

if (spec === undefined) {
  fail('module did not call window.__ModuleLoader__.load()')
  process.exit()
}
if (spec.id === undefined || typeof spec.factory !== 'function') {
  fail('loader spec is missing an id or a factory')
  process.exit()
}

let exported
try {
  exported = spec.factory(stubRequire)
} catch (error) {
  fail(`factory threw: ${error?.constructor?.name ?? 'Error'}: ${error?.message ?? error}`)
  process.exit()
}

// ------------------------------------------------------------- 2. apply(ctx)

const registered = []
const disposers = []
const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  locale: { register: () => () => {}, bind: () => key => key },
  slots: {
    inject: (_key, callback) => {
      callback()
      return () => {}
    },
    register: (options, Component) => {
      registered.push({ id: options.id, name: options.name, order: options.order, Component })
      return () => {}
    },
  },
  sessions: { list: { subscribe: () => () => {}, getSnapshot: () => ({ ids: [], byId: {} }) } },
  remote: { settings: { describe: async () => ({ namespaces: [] }), update: async () => ({}) } },
  effect: callback => {
    const result = callback()
    const dispose = typeof result === 'function' ? result : () => {}
    disposers.push(dispose)
    return () => {}
  },
  inject: (_deps, callback) => {
    callback(ctx)
    return () => {}
  },
  get: () => undefined,
}

try {
  const inject = exported.inject ?? []
  exported.apply(ctx)
  console.log(`${file}: loads clean`)
  console.log(`  spec id     : ${spec.id}`)
  console.log(`  inject      : ${Array.isArray(inject) ? inject.join(', ') : '(none)'}`)
  for (const entry of registered) {
    console.log(`  registers   : ${entry.name} [id=${entry.id}, order=${entry.order}]`)
  }
  if (registered.length === 0) {
    console.log('  registers   : (none)')
    process.exitCode = 1
  }
} catch (error) {
  fail(`apply threw: ${error?.constructor?.name ?? 'Error'}: ${error?.message ?? error}`)
}

// The Client half arms a retry timer while its Host route is unreachable — the
// ordinary case under this stub, which serves no HTTP at all. Disposing the
// plugin's effects is what stops that timer, so this harness exits on its own
// instead of hanging on a pending one.
for (const dispose of disposers) {
  try {
    dispose()
  } catch (error) {
    fail(`effect disposer threw: ${error?.message ?? error}`)
  }
}
