/**
 * Session model inventory.
 *
 * Walks every persisted session log, folds the same usage samples the backfill
 * engine will fold, and reports which provider/model routes were actually
 * billed, when, and with how many tokens. This answers the two questions the
 * price table cannot be written without:
 *
 *   1. Which models need a price entry at all?
 *   2. Which of them span a DeepSeek price change, so the entry needs an
 *      effective-dated history rather than one rate set?
 *
 * Persisted logs are an append-ordered sequence of INDEPENDENT zstd frames —
 * one per flush — not one stream. A single `zstdDecompressSync` therefore
 * yields only the first frame (the header), so frames are located by magic and
 * decoded individually. `--verify <sessionId>` prints one session's totals for
 * comparison against the `tokenUsage` projection already in settings.yaml,
 * which is how this parser is checked rather than trusted.
 *
 * Route attribution mirrors the client's delta engine: an assistant message
 * carries its own source, and any other billed attempt inherits the route of
 * the latest `request/context` or `request/header`.
 *
 * Usage: node tools/scan-sessions.mjs [--json out.json] [--root dir] [--verify id]
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { isTokenPlan, priceUsage } from './pricing.mjs'

const FRAME_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
/** Progressive decode windows; a frame larger than the file simply never matches. */
const WINDOWS = [1 << 16, 1 << 18, 1 << 20, 1 << 22, 1 << 24]
const BUCKETS = ['cacheMiss', 'cacheRead', 'cacheWrite', 'output']

/** Parse `--flag value` pairs. */
function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue
    out[argv[i].slice(2)] = argv[i + 1]
    i += 1
  }
  return out
}

/**
 * Decode every zstd frame in one persisted log.
 *
 * Frame starts are found by scanning for the frame magic; a candidate that is
 * not a real frame start fails to decode and is skipped. Frames are appended in
 * order, so offset order is log order.
 * @param buffer - the whole compressed log.
 * @returns the concatenated decoded text.
 */
function decodeLog(buffer) {
  const parts = []
  let at = buffer.indexOf(FRAME_MAGIC, 0)
  while (at !== -1) {
    for (const window of WINDOWS) {
      const end = Math.min(buffer.length, at + window)
      try {
        parts.push(zstdDecompressSync(buffer.subarray(at, end)))
        break
      } catch {
        // Either not a frame start, or the frame is larger than this window.
      }
      if (end === buffer.length) break
    }
    at = buffer.indexOf(FRAME_MAGIC, at + 4)
  }
  return Buffer.concat(parts).toString('utf8')
}

/** Collect every persisted log below `dir`. */
function walk(dir, out = []) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) walk(path, out)
    else if (entry.name.endsWith('.jsonl.zstd')) out.push(path)
  }
  return out
}

/** The last `usage` chunk of a stream, matching lastAssistantStreamChunk. */
function streamUsage(stream) {
  if (!Array.isArray(stream)) return undefined
  for (let i = stream.length - 1; i >= 0; i -= 1) {
    const record = stream[i]
    if (record?.type === 'chunk' && record.chunk?.type === 'usage') return record.chunk.usage
  }
  return undefined
}

const bucketsOf = usage => ({
  cacheMiss: usage.inputTokens ?? 0,
  cacheRead: usage.cacheReadTokens ?? 0,
  cacheWrite: usage.cacheWriteTokens ?? 0,
  output: usage.outputTokens ?? 0,
})

const zero = () => ({ cacheMiss: 0, cacheRead: 0, cacheWrite: 0, output: 0 })
const totalOf = tokens => BUCKETS.reduce((sum, bucket) => sum + tokens[bucket], 0)
const monthOf = ms => new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 7)

/** Money and Token Plan Credits, each accumulated at its request's own instant. */
function newPriced() {
  return { cost: 0, credits: 0, unpriced: 0, peak: 0, offPeak: 0, byRoute: new Map(), byMonth: new Map() }
}

/**
 * Fold one decoded log.
 * @returns per-route and per-month aggregates plus the session's own totals.
 */
function foldLog(text, sessionId, into) {
  let route = { provider: '(unattributed)', model: '(unattributed)' }
  const sessionTotals = zero()
  let requests = 0

  for (const line of text.split('\n')) {
    if (line.length === 0) continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    into.events += 1

    if (event.type === 'request/context') {
      if (typeof event.data?.model === 'string') {
        route = { provider: event.data.provider ?? route.provider, model: event.data.model }
      }
      continue
    }
    if (event.type === 'request/header') {
      const config = event.data?.header?.config
      if (typeof config?.model === 'string') {
        route = { provider: config.provider ?? route.provider, model: config.model }
      }
      continue
    }
    if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') continue

    const usage = event.data?.usage ?? streamUsage(event.data?.stream)
    if (usage === undefined) continue

    const source = event.data?.message?.source
    const provider = typeof source?.provider === 'string' && source.provider.length > 0
      ? source.provider
      : route.provider
    const model = typeof source?.model === 'string' && source.model.length > 0
      ? source.model
      : route.model
    const buckets = bucketsOf(usage)
    const key = `${provider}/${model}`
    const time = Number.isFinite(event.time) ? event.time : Date.now()
    requests += 1

    // Price this sample at its own instant, which is the whole point of
    // reading the log rather than watching the counter move.
    const priced = priceUsage(provider, model, buckets, time)
    const monthLabel = monthOf(time)
    let routeCost = into.priced.byRoute.get(key)
    if (routeCost === undefined) {
      routeCost = { key, cost: 0, credits: 0, unpriced: 0, tokens: zero(), peak: 0, offPeak: 0 }
      into.priced.byRoute.set(key, routeCost)
    }
    let monthCost = into.priced.byMonth.get(`${key}\0${monthLabel}`)
    if (monthCost === undefined) {
      monthCost = { key, month: monthLabel, cost: 0, credits: 0 }
      into.priced.byMonth.set(`${key}\0${monthLabel}`, monthCost)
    }
    for (const bucket of BUCKETS) {
      routeCost.tokens[bucket] += buckets[bucket]
    }
    if (isTokenPlan(provider)) {
      into.priced.credits += priced.credits
      routeCost.credits += priced.credits
      monthCost.credits += priced.credits
    } else if (priced.priced) {
      into.priced.cost += priced.cost
      routeCost.cost += priced.cost
      monthCost.cost += priced.cost
      if (priced.peak) {
        into.priced.peak += priced.cost
        routeCost.peak += priced.cost
      } else {
        into.priced.offPeak += priced.cost
        routeCost.offPeak += priced.cost
      }
    } else {
      const missed = totalOf(buckets)
      into.priced.unpriced += missed
      routeCost.unpriced += missed
      if (routeCost.unpricedFirst === undefined) routeCost.unpricedFirst = time
      routeCost.unpricedLast = time
    }

    for (const bucket of BUCKETS) sessionTotals[bucket] += buckets[bucket]

    let row = into.byModel.get(key)
    if (row === undefined) {
      row = { key, provider, model, sessions: new Set(), requests: 0, tokens: zero(), first: Infinity, last: -Infinity }
      into.byModel.set(key, row)
    }
    row.sessions.add(sessionId)
    row.requests += 1
    for (const bucket of BUCKETS) row.tokens[bucket] += buckets[bucket]
    row.first = Math.min(row.first, time)
    row.last = Math.max(row.last, time)

    const monthKey = `${key}\0${monthOf(time)}`
    let month = into.byMonth.get(monthKey)
    if (month === undefined) {
      month = { key, provider, model, month: monthOf(time), tokens: zero(), requests: 0 }
      into.byMonth.set(monthKey, month)
    }
    month.requests += 1
    for (const bucket of BUCKETS) month.tokens[bucket] += buckets[bucket]
  }

  return { totals: sessionTotals, requests }
}

// --------------------------------------------------------------------- main

const args = parseArgs(process.argv.slice(2))
const ROOT = args.root ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh', 'sessions')
const files = walk(ROOT).sort()

if (args.verify !== undefined) {
  const needle = args.verify
  const match = files.filter(file => file.includes(needle))
  if (match.length === 0) {
    console.log(`no log found for ${needle}`)
    process.exitCode = 1
  } else {
    for (const file of match) {
      const text = decodeLog(readFileSync(file))
      const local = { byModel: new Map(), byMonth: new Map(), events: 0, priced: newPriced() }
      const result = foldLog(text, needle, local)
      console.log(file)
      console.log(`  decoded   : ${text.length.toLocaleString('en-US')} chars, ${local.events.toLocaleString('en-US')} events`)
      console.log(`  requests  : ${result.requests}`)
      console.log(`  cacheMiss : ${result.totals.cacheMiss.toLocaleString('en-US')}`)
      console.log(`  cacheRead : ${result.totals.cacheRead.toLocaleString('en-US')}`)
      console.log(`  cacheWrite: ${result.totals.cacheWrite.toLocaleString('en-US')}`)
      console.log(`  output    : ${result.totals.output.toLocaleString('en-US')}`)
      console.log(`  total     : ${totalOf(result.totals).toLocaleString('en-US')}`)
      for (const row of local.byModel.values()) {
        console.log(`  route     : ${row.key} — ${row.requests} requests, ${totalOf(row.tokens).toLocaleString('en-US')} tok`)
      }
    }
  }
  process.exit()
}

const state = { byModel: new Map(), byMonth: new Map(), byVersion: new Map(), events: 0, priced: newPriced() }
const failures = []
const sessionTotals = new Map()

for (const file of files) {
  const sessionId = file.split(/[\\/]/).slice(-2)[0]
  const version = file.includes('.v3.') ? 'v3' : 'v2'
  state.byVersion.set(version, (state.byVersion.get(version) ?? 0) + 1)

  let text
  try {
    text = decodeLog(readFileSync(file))
  } catch (error) {
    failures.push({ file, reason: String(error) })
    continue
  }
  if (text.length === 0) {
    failures.push({ file, reason: 'no decodable frames' })
    continue
  }
  const result = foldLog(text, sessionId, state)
  sessionTotals.set(sessionId, result.totals)
}

// ------------------------------------------------------------------- report

const stamp = ms => (Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : '?')
const millions = value => (value / 1e6).toFixed(3)

console.log(`root      : ${ROOT}`)
console.log(`logs      : ${files.length}  (${[...state.byVersion].map(([v, n]) => `${v}:${n}`).join(', ')})`)
console.log(`events    : ${state.events.toLocaleString('en-US')}`)
console.log(`failures  : ${failures.length}`)
console.log()

console.log('=== routes actually billed (millions of tokens) ===')
const rows = [...state.byModel.values()].sort((a, b) => totalOf(b.tokens) - totalOf(a.tokens))
console.log('provider/model'.padEnd(38) + 'sess'.padStart(6) + 'reqs'.padStart(8)
  + 'miss'.padStart(10) + 'read'.padStart(12) + 'write'.padStart(8) + 'out'.padStart(10) + '  window')
for (const row of rows) {
  console.log(
    row.key.padEnd(38)
    + String(row.sessions.size).padStart(6)
    + String(row.requests).padStart(8)
    + millions(row.tokens.cacheMiss).padStart(10)
    + millions(row.tokens.cacheRead).padStart(12)
    + millions(row.tokens.cacheWrite).padStart(8)
    + millions(row.tokens.output).padStart(10)
    + `  ${stamp(row.first)} .. ${stamp(row.last)}`,
  )
}

console.log()
console.log('=== month x route (millions of tokens; a price change lands here) ===')
const months = [...new Set([...state.byMonth.values()].map(row => row.month))].sort()
const cell = (key, month) => {
  const row = state.byMonth.get(`${key}\0${month}`)
  return row === undefined ? '·' : millions(totalOf(row.tokens))
}
console.log('month'.padEnd(9) + rows.map(row => row.key.slice(0, 20).padStart(23)).join(''))
for (const month of months) {
  console.log(month.padEnd(9) + rows.map(row => cell(row.key, month).padStart(23)).join(''))
}

console.log()
console.log('=== COST — every request priced at its own instant ===')
const routeRows = [...state.priced.byRoute.values()]
  .sort((a, b) => (b.cost - a.cost) || (b.credits - a.credits))
console.log('provider/model'.padEnd(38) + 'peak¥'.padStart(11) + 'off-peak¥'.padStart(11)
  + 'money¥'.padStart(11) + 'credits'.padStart(10) + '  unpriced tok (window)')
for (const row of routeRows) {
  console.log(
    row.key.padEnd(38)
    + (row.cost > 0 ? row.peak.toFixed(2) : '—').padStart(11)
    + (row.cost > 0 ? row.offPeak.toFixed(2) : '—').padStart(11)
    + (row.cost > 0 ? row.cost.toFixed(2) : '—').padStart(11)
    + (row.credits > 0 ? row.credits.toFixed(0) : '—').padStart(10)
    + (row.unpriced > 0
      ? `  ${row.unpriced.toLocaleString('en-US')} (${new Date(row.unpricedFirst).toISOString().slice(0, 16)} .. ${new Date(row.unpricedLast).toISOString().slice(0, 16)})`
      : ''),
  )
}
console.log('-'.repeat(83))
console.log(`TOTAL money   : ¥${state.priced.cost.toFixed(2)}`
  + `   (peak ¥${state.priced.peak.toFixed(2)} + off-peak ¥${state.priced.offPeak.toFixed(2)})`)
console.log(`TOTAL credits : ${state.priced.credits.toFixed(0)}`
  + '   (MiMo Token Plan — prepaid subscription quota, not money)')
if (state.priced.unpriced > 0) {
  console.log(`UNPRICED      : ${state.priced.unpriced.toLocaleString('en-US')} tok matched no price row`)
}

console.log()
console.log('=== money by month (cr = Token Plan credits) ===')
const priceMonths = [...new Set([...state.priced.byMonth.values()].map(row => row.month))].sort()
const priceRoutes = routeRows.map(row => row.key)
const moneyCell = (key, month) => {
  const row = state.priced.byMonth.get(`${key}\0${month}`)
  if (row === undefined) return '·'
  return row.cost > 0 ? row.cost.toFixed(2) : `${row.credits.toFixed(0)}cr`
}
console.log('month'.padEnd(8) + priceRoutes.map(key => key.slice(0, 20).padStart(22)).join(''))
for (const month of priceMonths) {
  console.log(month.padEnd(8) + priceRoutes.map(key => moneyCell(key, month).padStart(22)).join(''))
}

if (failures.length > 0) {
  console.log()
  console.log('=== failures ===')
  for (const failure of failures.slice(0, 10)) console.log(`  ${failure.file}: ${failure.reason}`)
}

if (args.json !== undefined) {
  writeFileSync(args.json, `${JSON.stringify({
    generatedAt: new Date().toISOString(),
    root: ROOT,
    logs: files.length,
    events: state.events,
    byVersion: Object.fromEntries(state.byVersion),
    routes: rows.map(row => ({
      key: row.key,
      provider: row.provider,
      model: row.model,
      sessions: row.sessions.size,
      requests: row.requests,
      tokens: row.tokens,
      first: Number.isFinite(row.first) ? new Date(row.first).toISOString() : null,
      last: Number.isFinite(row.last) ? new Date(row.last).toISOString() : null,
    })),
    byMonth: [...state.byMonth.values()],
    sessions: Object.fromEntries(sessionTotals),
    failures,
  }, null, 2)}\n`)
  console.log()
  console.log(`json report -> ${args.json}`)
}
