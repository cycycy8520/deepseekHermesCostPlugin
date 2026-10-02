/**
 * Print the effective price table in the same YAML shape `settings.yaml` uses,
 * so the stored table and the shipped defaults can be compared line by line:
 *
 *   node tools/dump-models.mjs --defaults   # what the package ships
 *   node tools/dump-models.mjs              # what this machine stored
 *
 * Both sides come out in the identical shape on purpose — a structural diff is
 * the only way to prove "this machine's table IS the shipped default" without
 * eyeballing it.
 *
 * Usage: node tools/dump-models.mjs [--defaults | <settings.yaml>]
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const target = process.argv[2] ?? join(homedir(), '.dsh', 'settings.yaml')

/** Render rows exactly the way the settings serializer nests them. */
function renderModels(models) {
  const out = ['  models:']
  for (const model of models) {
    out.push(`    - match: ${model.match}`)
    out.push(`      currency: ${model.currency}`)
    out.push(`      from: ${model.from ?? 'null'}`)
    out.push(`      to: ${model.to ?? 'null'}`)
    out.push('      rates:')
    for (const key of ['cacheHit', 'cacheMiss', 'cacheWrite', 'output']) {
      out.push(`        ${key}: ${model.rates[key]}`)
    }
    if (model.discount !== undefined) {
      out.push('      discount:')
      out.push(`        offPeakRatio: ${model.discount.offPeakRatio}`)
      out.push('        peakHours:')
      for (const [from, to] of model.discount.peakHours) {
        out.push(`          - - ${from}`)
        out.push(`            - ${to}`)
      }
      out.push(`        weekdaysOnly: ${model.discount.weekdaysOnly}`)
    }
    out.push(`      tokenPlan: ${model.tokenPlan === true}`)
  }
  return out.join('\n')
}

if (target === '--defaults') {
  let captured
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    settings: {
      register: (namespace, schema) => {
        captured = schema
        return () => {}
      },
    },
    inject: () => () => {},
    effect: () => () => {},
    get: () => undefined,
  }
  const mod = await import(pathToFileURL(resolve('index.js')).href)
  mod.apply(ctx)
  if (typeof captured !== 'function') {
    console.log('(index.js registered no schema)')
    process.exit(1)
  }
  // Resolve with an empty section: exactly what a machine that never edited
  // the table sees. This is the guarantee under test, not a reimplementation.
  console.log(renderModels(captured({}).models))
  process.exit(0)
}

const text = readFileSync(target, 'utf8')
const lines = text.split(/\r?\n/)

// locate top-level `dsh-cost:`
let start = -1
for (let i = 0; i < lines.length; i++) {
  if (/^dsh-cost:\s*$/.test(lines[i])) { start = i; break }
}
if (start < 0) { console.log('(no dsh-cost: section)'); process.exit(0) }

// locate `  models:` inside it, stop at the next key — either a top-level one
// or a sibling at the same 2-space indent. The block's own content is indented
// 4+ spaces, so `^ {2}\S` cannot match it.
let from = -1
let to = lines.length
for (let i = start + 1; i < lines.length; i++) {
  if (/^\S/.test(lines[i])) { to = i; break }
  if (from < 0) {
    if (/^ {2}models:/.test(lines[i])) from = i
    continue
  }
  if (/^ {2}\S/.test(lines[i])) { to = i; break }
}
if (from < 0) { console.log('(no dsh-cost.models)'); process.exit(0) }

console.log(lines.slice(from, to).join('\n').replace(/\s+$/, ''))
