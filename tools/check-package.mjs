/**
 * Distribution-readiness check for this plugin package.
 *
 * Verifies the manifest invariants the profile installer and the client module
 * table actually read, so a packaging mistake surfaces here instead of as a
 * refused install or a plugin that silently never loads:
 *
 *   - package.json parses and carries the fields `DshPackageManifest` declares
 *   - `dsh.bundle.patch` exists and parses (the install reconciler validates it)
 *   - that patch names THIS package, which is what the Loader imports
 *   - the client artifact registers under THIS package name, which is the key
 *     the browser module table looks up
 *   - `private` is absent, since it blocks npm publication
 *
 * Usage: node tools/check-package.mjs
 */

import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const problems = []
const notes = []

const read = name => readFileSync(join(root, name), 'utf8')

// ------------------------------------------------------------------ manifest

let manifest
try {
  manifest = JSON.parse(read('package.json'))
} catch (error) {
  console.log(`package.json does not parse: ${String(error)}`)
  process.exit(1)
}

const { name, version, description, license, type } = manifest
if (typeof name !== 'string' || name.length === 0) problems.push('name is required')
if (typeof version !== 'string' || version.length === 0) problems.push('version is required')
if (description === undefined) notes.push('no description (shown in the Plugins list)')
if (license === undefined) notes.push('no license field')
if (type !== 'module') problems.push('type must be "module"')
if (manifest.private === true) {
  problems.push('private: true blocks npm publication — remove it to distribute')
}

// ------------------------------------------------------------------- dsh.dsh

const dsh = manifest.dsh
if (dsh === undefined) {
  problems.push('dsh is required — without it the package is not a plugin')
} else {
  if (dsh.manifestVersion === undefined) notes.push('dsh.manifestVersion is absent (currently 1)')
  else if (dsh.manifestVersion !== 1) problems.push(`dsh.manifestVersion must be 1, got ${String(dsh.manifestVersion)}`)

  const patch = dsh.bundle?.patch
  if (typeof patch !== 'string') {
    problems.push('dsh.bundle.patch is required — a package without it is refused as "no bundle"')
  } else if (!existsSync(join(root, patch))) {
    problems.push(`dsh.bundle.patch points at a missing file: ${patch}`)
  } else {
    const text = read(patch.replace(/^\.\//, ''))
    // The installer parses this file before adding the bundle to the profile.
    // A crude structural check is enough to catch the mistakes that matter:
    // a lost list marker, a stray tab, or a name that does not match.
    if (!/^-\s/m.test(text)) problems.push(`${patch} does not contain a top-level list entry`)
    if (/^\t/m.test(text)) problems.push(`${patch} contains a tab, which YAML forbids for indentation`)
    if (!text.includes(`name: '${name}'`) && !text.includes(`name: "${name}"`)) {
      problems.push(`${patch} must name this package (${name}) — the Loader imports that module`)
    }
  }

  const client = dsh.client
  if (client === undefined) {
    notes.push('dsh.client is absent — no browser half')
  } else {
    if (client.platform !== 'web') notes.push(`dsh.client.platform is ${String(client.platform)}, not "web"`)
    if (!existsSync(join(root, 'client.js'))) problems.push('dsh.client is declared but client.js is missing')
    else {
      const client_js = read('client.js')
      const id = /__ModuleLoader__\.load\(\{[\s\S]*?\bid:\s*'([^']+)'/.exec(client_js)
      if (id === null) problems.push("client.js does not call window.__ModuleLoader__.load({ id, factory })")
      else if (id[1] !== name) {
        problems.push(`client.js registers as ${JSON.stringify(id[1])} but the package is ${JSON.stringify(name)}`)
      }
    }
  }
}

// ------------------------------------------------------------------- engines

if (manifest.engines?.dsh === undefined) {
  notes.push('engines.dsh is absent — DSH compatibility stays undeclared')
}

// -------------------------------------------------------------------- report

// The panel reports the Host's version so "which build am I running" is
// answerable, which only works while the constant and the manifest agree.
const hostSource = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
const declared = /export const PLUGIN_VERSION = '([^']+)'/.exec(hostSource)?.[1]
if (declared === undefined) problems.push('index.js does not declare PLUGIN_VERSION')
else if (declared !== version) {
  problems.push(`PLUGIN_VERSION (${declared}) does not match package.json (${String(version)})`)
}

console.log(`package : ${String(name)}@${String(version)}`)
console.log(`patch   : ${String(dsh?.bundle?.patch ?? '(none)')}`)
console.log(`client  : ${String(dsh?.client?.platform ?? '(none)')}`)
console.log(`engines : dsh ${String(manifest.engines?.dsh ?? '(undeclared)')}, node ${String(manifest.engines?.node ?? '(undeclared)')}`)
console.log(`files   : ${Array.isArray(manifest.files) ? manifest.files.join(', ') : '(all)'}`)
console.log('')

if (notes.length > 0) {
  console.log('notes:')
  for (const note of notes) console.log(`  - ${note}`)
  console.log('')
}

if (problems.length === 0) {
  console.log('package is distribution-ready')
} else {
  console.log(`${problems.length} problem(s):`)
  for (const problem of problems) console.log(`  ! ${problem}`)
  process.exitCode = 1
}
