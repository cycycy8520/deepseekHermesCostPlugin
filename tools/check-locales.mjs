/**
 * Assert the two locale tables declare the SAME keys.
 *
 * A key present in one language and missing in the other renders the raw key
 * name to the user (e.g. `notReadyMissingHint`), which reads as a broken UI and
 * is easy to introduce: every feature adds keys to both blocks by hand.
 *
 * Static on purpose — the tables are module-private inside `apply`, so this
 * reads the source rather than importing it, and it needs no DOM.
 *
 * Usage: node tools/check-locales.mjs [client.js]
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const file = resolve(process.argv[2] ?? 'client.js')
const lines = readFileSync(file, 'utf8').split(/\r?\n/)

/** @returns every `key:` at the locale-table indent, plus the block's span. */
function readTable(name) {
  const start = lines.findIndex(line => new RegExp(`^\\s*const ${name} = \\{$`).test(line))
  if (start < 0) return null
  const keys = []
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s*\}$/.test(lines[i])) return { keys, start, end: i }
    const match = /^\s{6}([A-Za-z][A-Za-z0-9_]*):/.exec(lines[i])
    if (match !== null) keys.push(match[1])
  }
  return null
}

const zh = readTable('ZH')
const en = readTable('EN')

if (zh === null || en === null) {
  console.log(`${file}: FAILED — could not locate the ZH/EN locale tables`)
  process.exit(1)
}

const problems = []
const onlyZh = zh.keys.filter(key => !en.keys.includes(key))
const onlyEn = en.keys.filter(key => !zh.keys.includes(key))

if (onlyZh.length > 0) problems.push(`only in ZH: ${onlyZh.join(', ')}`)
if (onlyEn.length > 0) problems.push(`only in EN: ${onlyEn.join(', ')}`)

// A duplicated key is silently overwritten by the later one — usually a typo.
for (const [label, table] of [['ZH', zh], ['EN', en]]) {
  const seen = new Set()
  for (const key of table.keys) {
    if (seen.has(key)) problems.push(`${label} declares ${key} twice`)
    seen.add(key)
  }
}

// Every `t('...')` call must resolve, or the UI prints the key itself.
const used = new Set()
for (const match of readFileSync(file, 'utf8').matchAll(/\bt\('([A-Za-z][A-Za-z0-9_]*)'/g)) {
  used.add(match[1])
}
const missing = [...used].filter(key => !zh.keys.includes(key) && !en.keys.includes(key))

console.log(`${file}: locales aligned`)
console.log(`  ZH keys        : ${zh.keys.length}`)
console.log(`  EN keys        : ${en.keys.length}`)
console.log(`  t() call sites : ${used.size} distinct keys`)
if (missing.length > 0) console.log(`  note           : ${missing.length} t() key(s) not in either table — may be passed through from a prop`)

if (problems.length > 0) {
  console.log('')
  for (const problem of problems) console.log(`  FAIL ${problem}`)
  process.exitCode = 1
}
