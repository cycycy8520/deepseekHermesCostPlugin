import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

// Execute the registered factory: syntax checks alone miss initialization errors.
for (const mode of ['dark', 'light', 'without-match-media']) {
  let registration
  const window = {
    __ModuleLoader__: { load(value) { registration = value } },
  }
  if (mode !== 'without-match-media') {
    window.matchMedia = () => ({ matches: mode === 'dark' })
  }
  vm.runInNewContext(source, { window }, { filename: 'client.js' })
  // Must equal the npm package name: the browser module table keys by it.
  assert.equal(registration.id, 'dsh-cost-meter')
  const plugin = registration.factory(id => {
    if (id === 'react') return { createElement() {}, Component: class {} }
    throw new Error(`unavailable optional module: ${id}`)
  })
  assert.equal(typeof plugin.apply, 'function')
  assert.ok(plugin.inject.includes('slots'))
  console.log(`PASS client factory: ${mode}`)
}
