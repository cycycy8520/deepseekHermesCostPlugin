/**
 * Wall-time fold: unit checks, and a real-log report.
 *
 * The panel's 模型用时 / 工具用时 come from DSH's `sessionStats` projection when the
 * host carries it, and otherwise from the fold this plugin records in its own
 * ledger (`foldTiming` in `../index.js`). A fold that is wrong is worse than a
 * missing figure, because nothing looks broken — so it is checked two ways here:
 *
 *   1. Synthetic logs with known spans, including the cases the algorithm is
 *      defined by: a cancelled step assembles no message and must contribute no
 *      model time, and a tool result with no matching call must contribute
 *      nothing at all.
 *   2. `--root <sessions dir>`: fold every persisted session log on this machine
 *      and print the totals per session, to compare against what the panel and
 *      the `sessionStats` projection report for the same sessions.
 *
 * Usage: node tools/check-timing-fold.mjs [--root ~/.dsh/sessions]
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { foldTiming } from '../index.js'

const FRAME_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
/** Progressive decode windows; a frame larger than the window simply never matches. */
const WINDOWS = [1 << 16, 1 << 18, 1 << 20, 1 << 22, 1 << 24]

let passed = 0
let failed = 0
const check = (label, ok, detail) => {
  if (ok) {
    passed += 1
    console.log(`PASS  ${label}${detail === undefined ? '' : `  (${detail})`}`)
  } else {
    failed += 1
    console.log(`FAIL  ${label}${detail === undefined ? '' : `  (${detail})`}`)
  }
}

/* --------------------------------------------------------------- the algorithm */

const message = (time, turn, step) => ({ type: 'assistant/message', time, data: { turn, step } })
const start = (time, turn, step) => ({ type: 'step/start', time, data: { turn, step } })
const end = (time, turn, step) => ({ type: 'step/end', time, data: { turn, step } })
const call = (time, callId) => ({ type: 'tool/call', time, data: { callId } })
const result = (time, callId) => ({ type: 'tool/result', time, data: { message: { source: { callId } } } })

const timeline = [
  start(1000, 0, 0),
  message(4000, 0, 0), // 3000 ms of model time
  end(4000, 0, 0),
  call(5000, 'a'),
  result(9000, 'a'), // 4000 ms of tool time
  start(10000, 0, 1),
  end(12000, 0, 1), // cancelled step: no message, so no model time
  result(13000, 'z'), // no matching call: ignored
  message(14000, 7, 7), // wrong turn/step for the (closed) step: ignored
  start(20000, 1, 0),
  message(21000, 1, 0), // 1000 ms
  end(21000, 1, 0),
]
const folded = foldTiming(timeline)
check('model time is step/start to assistant/message', folded.llmMs === 4000, `llmMs=${folded.llmMs}`)
check('tool time is tool/call to tool/result by callId', folded.toolMs === 4000, `toolMs=${folded.toolMs}`)
check('a cancelled step contributes no model time', folded.llmMs === 4000, 'included in the total above')
check('an unmatched tool result contributes nothing', folded.toolMs === 4000, 'included in the total above')
check('turns and steps are counted from step/end', folded.turns === 2 && folded.steps === 3,
  `turns=${folded.turns} steps=${folded.steps}`)

const openStep = foldTiming([start(1000, 0, 0), end(5000, 0, 0)])
check('a step with no message adds no time', openStep.llmMs === 0 && openStep.steps === 1,
  `llmMs=${openStep.llmMs} steps=${openStep.steps}`)

const NaNGuard = foldTiming([
  { type: 'step/start', data: { turn: 0, step: 0 } },
  { type: 'assistant/message', data: { turn: 0, step: 0 } },
  { type: 'tool/call', data: { callId: 'a' } },
  { type: 'tool/result', data: { message: { source: { callId: 'a' } } } },
])
check('events without a timestamp cannot produce NaN',
  NaNGuard.llmMs === 0 && NaNGuard.toolMs === 0 && Number.isFinite(NaNGuard.llmMs + NaNGuard.toolMs),
  `llmMs=${NaNGuard.llmMs} toolMs=${NaNGuard.toolMs}`)

const empty = foldTiming([])
check('an empty log folds to zero', empty.llmMs === 0 && empty.toolMs === 0 && empty.steps === 0)

/* ------------------------------------------------------------- the real logs */

/**
 * Decode every zstd frame in one persisted log, in log order.
 *
 * Frames are appended independently (one per flush), so a single
 * `zstdDecompressSync` yields only the header; starts are found by magic and a
 * candidate that fails to decode is skipped.
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

const args = {}
for (let i = 2; i < process.argv.length; i += 2) {
  if (process.argv[i]?.startsWith('--')) args[process.argv[i].slice(2)] = process.argv[i + 1]
}
const root = args.root ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh', 'sessions')

/** Every session directory under the store, one level below a workspace key. */
function sessionDirs(dir, depth = 0) {
  const out = []
  let entries = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const full = join(dir, entry.name)
    if (depth >= 1) out.push(full)
    else out.push(...sessionDirs(full, depth + 1))
  }
  return out
}

const rows = []
for (const dir of sessionDirs(root)) {
  const files = readdirSync(dir).filter(name => name.startsWith('session') && name.endsWith('.zstd'))
  if (files.length === 0) continue
  const events = []
  for (const name of files) {
    const text = decodeLog(readFileSync(join(dir, name)))
    for (const line of text.split('\n')) {
      if (line.length === 0) continue
      try {
        events.push(JSON.parse(line))
      } catch {
        // A partial trailing frame is normal for the last flush.
      }
    }
  }
  const timing = foldTiming(events)
  rows.push({ id: dir.split(/[\\/]/).pop(), bytes: files.reduce((sum, name) => sum + statSync(join(dir, name)).size, 0), ...timing })
}

if (rows.length === 0) {
  console.log(`\n(no session logs under ${root})`)
} else {
  rows.sort((a, b) => (b.llmMs + b.toolMs) - (a.llmMs + a.toolMs))
  const totalLlm = rows.reduce((sum, row) => sum + row.llmMs, 0)
  const totalTool = rows.reduce((sum, row) => sum + row.toolMs, 0)
  const hours = ms => `${(ms / 3600000).toFixed(2)}h`
  console.log(`\n${'session'.padEnd(40)}${'model'.padStart(10)}${'tool'.padStart(10)}${'steps'.padStart(8)}`)
  for (const row of rows.slice(0, 12)) {
    console.log(`${String(row.id).padEnd(40)}${hours(row.llmMs).padStart(10)}${hours(row.toolMs).padStart(10)}${String(row.steps).padStart(8)}`)
  }
  console.log(`${'—'.padEnd(40)}${'—'.padStart(10)}${'—'.padStart(10)}${'—'.padStart(8)}`)
  console.log(`${`${rows.length} sessions`.padEnd(40)}${hours(totalLlm).padStart(10)}${hours(totalTool).padStart(10)}`)
  console.log(`total: model ${hours(totalLlm)} · tool ${hours(totalTool)}`)
}

console.log(`\n${passed}/${passed + failed} checks passed`)
process.exit(failed === 0 ? 0 : 1)
