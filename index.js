/**
 * Host half of the cost meter.
 *
 * It owns exactly one thing: the durable document holding the user's
 * effective-dated price table and the machine-written spend ledger, written to
 * a file this package owns (`$DSH_HOME/dsh-cost-meter/state.json`) and served
 * over three routes under `/api/cost`. No billing arithmetic happens here — the
 * Client half computes every figure — so this half exists only because the
 * browser cannot write a durable file and `localStorage` dies with the cache.
 *
 * THE STORE IS DELIBERATELY OUTSIDE THE HARNESS SETTINGS API. The settings
 * namespace seam was replaced between harness generations (`ctx.settings
 * .register(ns, schema)` before, entry-scoped `Config` schemas plus
 * `configEditor` after), while a plugin-owned file and a plugin-owned route
 * have survived both. Keeping the document here also keeps a machine-written
 * ledger out of a hand-edited, hot-reloaded configuration document.
 *
 * PRICES ARE EFFECTIVE-DATED because a model name is not a price: through
 * 2026-09-10 `deepseek-v4-flash` was the separately-priced V4-Flash-0731, and
 * only afterwards did the retired name start routing to V4.1-Flash. Resolving
 * a rate without a date would silently misprice one of those two eras. All
 * rates are CNY per 1,000,000 tokens at the PEAK tier; `discount` halves them
 * off-peak. A row carrying `tokenPlan` instead describes a prepaid
 * subscription, whose usage is counted in Credits and never in money.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 2026 放假安排, 国办发明电〔2025〕7号. Beijing calendar dates. */
const DEFAULT_HOLIDAYS = [
  '2026-01-01', '2026-01-02', '2026-01-03',
  '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19',
  '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
  '2026-04-04', '2026-04-05', '2026-04-06',
  '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
  '2026-06-19', '2026-06-20', '2026-06-21',
  '2026-09-25', '2026-09-26', '2026-09-27',
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04',
  '2026-10-05', '2026-10-06', '2026-10-07',
]

/** DeepSeek peak windows are Beijing Mon-Fri 09:00-12:00 and 14:00-18:00. */
const deepSeekDiscount = () => ({
  offPeakRatio: 0.5,
  peakHours: [[9, 12], [14, 18]],
  weekdaysOnly: true,
})

/** V4 GA took effect 16:00 UTC 2026-08-16; V4.1-Flash 04:00 UTC 2026-09-10. */
const DEFAULT_MODELS = [
  {
    match: 'deepseek-v4-pro',
    currency: 'CNY',
    from: '2026-08-16T16:00:00Z',
    to: null,
    rates: { cacheHit: 0.3, cacheMiss: 9, cacheWrite: 0, output: 27 },
    discount: deepSeekDiscount(),
  },
  {
    match: 'deepseek-v4-flash',
    currency: 'CNY',
    from: '2026-08-16T16:00:00Z',
    to: '2026-09-10T04:00:00Z',
    rates: { cacheHit: 0.1, cacheMiss: 3, cacheWrite: 0, output: 9 },
    discount: deepSeekDiscount(),
  },
  {
    match: 'deepseek-v4-flash',
    currency: 'CNY',
    from: '2026-09-10T04:00:00Z',
    to: null,
    rates: { cacheHit: 0.04, cacheMiss: 2, cacheWrite: 0, output: 8 },
    discount: deepSeekDiscount(),
  },
  {
    match: 'deepseek-flash',
    currency: 'CNY',
    from: '2026-09-10T04:00:00Z',
    to: null,
    rates: { cacheHit: 0.04, cacheMiss: 2, cacheWrite: 0, output: 8 },
    discount: deepSeekDiscount(),
  },
  {
    // MiMo pay-as-you-go: no time-of-day tiers at all.
    match: 'xiaomi/mimo-v2.5-pro',
    currency: 'CNY',
    from: null,
    to: null,
    rates: { cacheHit: 0.025, cacheMiss: 3, cacheWrite: 0, output: 6 },
  },
  {
    match: 'xiaomi/mimo-v2.5',
    currency: 'CNY',
    from: null,
    to: null,
    rates: { cacheHit: 0.02, cacheMiss: 1, cacheWrite: 0, output: 2 },
  },
  {
    // Token Plan is a SUBSCRIPTION: quota is deducted in Credits and running
    // out suspends service instead of spilling to balance, so no money figure
    // is meaningful. Credits per 1M tokens, as published.
    match: 'xiaomi-token-plan-cn/*',
    currency: 'CREDITS',
    from: null,
    to: null,
    rates: { cacheHit: 2.5, cacheMiss: 300, cacheWrite: 0, output: 600 },
    tokenPlan: true,
  },
]

const DEFAULTS = {
  currency: 'CNY',
  /** Ledger flush interval; the client debounces writes to this cadence. */
  flushMs: 4000,
  models: DEFAULT_MODELS,
  holidays: DEFAULT_HOLIDAYS,
  ledger: {},
}

const RATE_KEYS = ['cacheHit', 'cacheMiss', 'cacheWrite', 'output']
/** The four disjoint billing buckets, in the order the UI reads them. */
const STANDARD_BUCKETS = ['cacheRead', 'cacheMiss', 'cacheWrite', 'output']
const isNonNegative = value => typeof value === 'number' && Number.isFinite(value) && value >= 0

/** @returns an ISO instant for a date or datetime string, or undefined when unusable. */
function parseInstant(raw) {
  if (typeof raw !== 'string' || raw.trim().length === 0) return undefined
  const ms = Date.parse(raw)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined
}

/** @returns a rate set with every bucket present. */
function normalizeRates(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const rates = {}
  for (const key of RATE_KEYS) rates[key] = isNonNegative(source[key]) ? source[key] : 0
  return rates
}

/** @returns a model row, or undefined when it carries no usable `match`. */
function normalizeModel(raw) {
  if (raw === null || typeof raw !== 'object') return undefined
  const match = typeof raw.match === 'string' ? raw.match.trim() : ''
  if (match.length === 0) return undefined

  const model = {
    match,
    currency: typeof raw.currency === 'string' && raw.currency.length > 0 ? raw.currency : DEFAULTS.currency,
    from: parseInstant(raw.from) ?? null,
    to: parseInstant(raw.to) ?? null,
    rates: normalizeRates(raw.rates),
    tokenPlan: raw.tokenPlan === true,
  }

  const discount = raw.discount
  if (discount !== null && typeof discount === 'object') {
    const offPeakRatio = isNonNegative(discount.offPeakRatio) && discount.offPeakRatio <= 1
      ? discount.offPeakRatio
      : 0.5
    const peakHours = Array.isArray(discount.peakHours)
      ? discount.peakHours
        .filter(pair => Array.isArray(pair) && pair.length === 2
          && Number.isInteger(pair[0]) && Number.isInteger(pair[1])
          && pair[0] >= 0 && pair[1] <= 24 && pair[0] < pair[1])
        .map(pair => [pair[0], pair[1]])
      : []
    model.discount = { offPeakRatio, peakHours, weekdaysOnly: discount.weekdaysOnly !== false }
  }
  return model
}

/** Beijing calendar day keys, the same zone the peak/off-peak tariff uses. */
const DAY_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/
/** Retention cap on per-day rows kept per session; ~13 months of dense history. */
const DAY_RETENTION = 400

/**
 * @returns one day's slice of a session, or undefined when unusable.
 *
 * Per-bucket money rides along so a date-range filter can slice the cost
 * composition chart, not just the totals.
 */
function normalizeDay(raw) {
  if (raw === null || typeof raw !== 'object') return undefined
  const source = raw.byBucket !== null && typeof raw.byBucket === 'object' ? raw.byBucket : {}
  const byBucket = {}
  for (const key of STANDARD_BUCKETS) {
    byBucket[key] = isNonNegative(source[key]) ? source[key] : 0
  }
  return {
    tokens: isNonNegative(raw.tokens) ? raw.tokens : 0,
    cost: isNonNegative(raw.cost) ? raw.cost : 0,
    credits: isNonNegative(raw.credits) ? raw.credits : 0,
    byBucket,
  }
}

/** @returns a bounded, day-keyed map; unparseable keys are dropped. */
function normalizeByDay(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out = {}
  for (const [day, value] of Object.entries(raw)) {
    if (!DAY_KEY_PATTERN.test(day)) continue
    const normalized = normalizeDay(value)
    if (normalized !== undefined) out[day] = normalized
  }
  const keys = Object.keys(out)
  if (keys.length <= DAY_RETENTION) return out
  const kept = {}
  for (const day of keys.sort().slice(-DAY_RETENTION)) kept[day] = out[day]
  return kept
}

/** @returns one ledger row normalized to JSON-safe numbers. */
function normalizeLedgerRow(raw) {
  if (raw === null || typeof raw !== 'object') return undefined
  const buckets = source => {
    const value = source !== null && typeof source === 'object' ? source : {}
    const out = {}
    for (const key of STANDARD_BUCKETS) {
      out[key] = isNonNegative(value[key]) ? value[key] : 0
    }
    return out
  }
  return {
    baseline: buckets(raw.baseline),
    byBucket: buckets(raw.byBucket),
    charged: buckets(raw.charged),
    byDay: normalizeByDay(raw.byDay),
    cost: isNonNegative(raw.cost) ? raw.cost : 0,
    credits: isNonNegative(raw.credits) ? raw.credits : 0,
    unpriced: isNonNegative(raw.unpriced) ? raw.unpriced : 0,
    // Wall times, as this plugin's own log fold measured them. Absent means "not
    // measured yet", which is not the same as zero, so `undefined` is preserved.
    llmMs: isNonNegative(raw.llmMs) ? raw.llmMs : undefined,
    toolMs: isNonNegative(raw.toolMs) ? raw.toolMs : undefined,
    model: typeof raw.model === 'string' ? raw.model : '',
    updatedAt: isNonNegative(raw.updatedAt) ? raw.updatedAt : 0,
  }
}

function normalizeLedger(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const ledger = {}
  for (const [sessionId, row] of Object.entries(raw)) {
    const normalized = normalizeLedgerRow(row)
    if (normalized !== undefined) ledger[sessionId] = normalized
  }
  return ledger
}

/**
 * The built-in price table, run through the SAME normalizer as user rows.
 *
 * Shipping the table as the fallback is what makes a fresh install usable with
 * no editing at all. But returning `DEFAULT_MODELS` raw would give stored rows
 * and default rows two different shapes: a default row missing `cacheWrite`
 * would stay `undefined` and price as `NaN` instead of 0, and its instants
 * would skip ISO canonicalisation. Normalizing once, lazily (so it runs after
 * `DEFAULTS` is initialized) keeps the two paths identical.
 *
 * Deliberately NOT frozen: the resolved configuration travels to the Client on
 * every state read, and a frozen array reaching an in-place write would throw —
 * far worse than the mutation freezing would prevent.
 * @returns {Array<object>} normalized price rows.
 */
let defaultModelsCache
function defaultModels() {
  if (defaultModelsCache === undefined) {
    defaultModelsCache = DEFAULT_MODELS
      .map(normalizeModel)
      .filter(model => model !== undefined)
  }
  return defaultModelsCache
}

/**
 * Resolve the effective configuration from whatever the document holds.
 *
 * Every field is defaulted here, so an absent or hand-edited document still
 * resolves, and stored rows are normalized by the same code that normalizes the
 * built-in table — a stored row missing `cacheWrite` must not price as `NaN`.
 * @param raw - the document's `config` object, or anything else.
 * @returns `{ currency, flushMs, models, holidays }`.
 */
export function resolveConfig(raw) {
  const value = raw !== null && typeof raw === 'object' ? raw : {}
  const models = Array.isArray(value.models)
    ? value.models.map(normalizeModel).filter(model => model !== undefined)
    : []
  const fallback = defaultModels()
  const holidays = Array.isArray(value.holidays)
    ? value.holidays.filter(day => typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day))
    : []
  return {
    currency: typeof value.currency === 'string' && value.currency.length > 0
      ? value.currency
      : DEFAULTS.currency,
    flushMs: isNonNegative(value.flushMs) && value.flushMs >= 500 ? value.flushMs : DEFAULTS.flushMs,
    models: models.length > 0 ? models : fallback,
    holidays: holidays.length > 0 ? holidays : DEFAULTS.holidays,
  }
}

/**
 * Version of the on-disk document, and of the wire envelope the routes answer
 * with. Bump it when the shape changes and migrate in {@link adoptDocument}.
 */
export const SCHEMA_TAG = 'dsh-cost-state/v1'

/**
 * This build's version, reported to the panel so 'which code is loaded' is
 * answerable without reading files. Kept equal to package.json by
 * 	ools/check-package.mjs, because a version that drifts is worse than none.
 */
export const PLUGIN_VERSION = '1.3.0'

/** Harness home, without asking the framework for it (env first, then `~/.dsh`). */
function harnessHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return fromEnv
  return join(homedir(), '.dsh')
}

/** Absolute path of the document this half owns. */
export function stateFilePath() {
  return join(harnessHome(), 'dsh-cost-meter', 'state.json')
}

/**
 * Absolute pathname the Client requests, INCLUDING the `/api` mount.
 *
 * The service doc says "absolute path below /api", but the registry keys routes
 * by the raw `url.pathname` and `assertFetchRoute` rejects anything not starting
 * with `/api/` — so the mount prefix is part of the value, not implied by it.
 * Registering `/cost/state` instead throws, and a swallowed promise turns
 * that into a silent 404 at request time.
 */
const STATE_PATH = '/api/cost/state'

/** Absolute pathname the Client posts an edited price table to. */
const CONFIG_PATH = '/api/cost/config'

/** Absolute pathname the Client streams a history re-pricing run through. */
const BACKFILL_PATH = '/api/cost/backfill'

/** One JSON response, never cached: every read of a live ledger is fresh. */
function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/** Whitelist the configuration keys a Client may write, so a stray field cannot land. */
function pickConfig(raw) {
  const out = {}
  for (const key of ['currency', 'flushMs', 'models', 'holidays']) {
    if (Object.prototype.hasOwnProperty.call(raw, key)) out[key] = raw[key]
  }
  return out
}

/**
 * The document this half owns: lazily read, kept in memory, persisted one write
 * at a time through a promise chain so two flushes cannot interleave a rename.
 *
 * A document this package cannot parse is NOT fatal and NOT destructive: the
 * meter starts from the built-in table, logs once, and the next write replaces
 * the file. Losing a corrupt ledger beats refusing to show the panel at all.
 * @param ctx - the plugin's Cordis context, for logging only.
 * @returns `{ read, commit }` over the document.
 */
function createStore(ctx) {
  let state = null
  let queue = Promise.resolve()
  let warned = false

  const log = (level, message) => {
    const logger = ctx.logger
    if (logger === null || logger === undefined) return
    const write = typeof logger[level] === 'function' ? logger[level].bind(logger) : undefined
    if (write !== undefined) write(message)
  }

  /** Accept either a previous or a foreign document shape without throwing. */
  const adoptDocument = raw => {
    const value = raw !== null && typeof raw === 'object' ? raw : {}
    return {
      version: 1,
      revision: isNonNegative(value.revision) ? value.revision : 0,
      config: resolveConfig(value.config),
      ledger: normalizeLedger(value.ledger),
    }
  }

  async function load() {
    if (state !== null) return state
    const path = stateFilePath()
    try {
      state = adoptDocument(JSON.parse(await readFile(path, 'utf8')))
      log('info', `dsh-cost: state loaded from ${path} (${Object.keys(state.ledger).length} rows)`)
    } catch (error) {
      if (error?.code !== 'ENOENT' && !warned) {
        warned = true
        log('warn', `dsh-cost: state document unusable, starting from the built-in table: ${String(error)}`)
      }
      state = adoptDocument(null)
    }
    return state
  }

  function persist() {
    const snapshot = state
    queue = queue.then(async () => {
      const path = stateFilePath()
      await mkdir(dirname(path), { recursive: true })
      const temp = `${path}.${process.pid}.${Date.now()}.tmp`
      await writeFile(temp, `${JSON.stringify({
        version: 1,
        revision: snapshot.revision,
        config: snapshot.config,
        ledger: snapshot.ledger,
      })}\n`, 'utf8')
      await rename(temp, path)
    }, error => log('error', `dsh-cost: state write failed: ${String(error)}`))
    return queue
  }

  return {
    read: load,
    /**
     * Merge one Client patch into the document and persist it.
     * @param body - `{ revision?, ledger? }` and/or `{ revision?, config? }`.
     * @returns `{ ok: true, revision, config }`, or a conflict envelope.
     */
    async commit(body) {
      const document = await load()
      const patch = body !== null && typeof body === 'object' ? body : {}
      const expected = patch.revision
      if (Number.isFinite(expected) && expected !== document.revision) {
        return { ok: false, error: 'revision', revision: document.revision }
      }
      let changed = false
      if (patch.ledger !== null && typeof patch.ledger === 'object') {
        for (const [sessionId, row] of Object.entries(patch.ledger)) {
          const normalized = normalizeLedgerRow(row)
          if (normalized === undefined) continue
          document.ledger[sessionId] = normalized
          changed = true
        }
      }
      if (patch.config !== null && typeof patch.config === 'object') {
        document.config = resolveConfig({ ...document.config, ...pickConfig(patch.config) })
        changed = true
      }
      if (!changed) return { ok: true, revision: document.revision, config: document.config }
      document.revision += 1
      await persist()
      return { ok: true, revision: document.revision, config: document.config }
    },
  }
}

/** The last `usage` chunk of a stream, matching the harness's own reader. */
function usageOf(event) {
  if (event.type === 'assistant/message' && event.data?.usage !== undefined) return event.data.usage
  const stream = event.data?.stream
  if (!Array.isArray(stream)) return undefined
  for (let i = stream.length - 1; i >= 0; i -= 1) {
    const record = stream[i]
    if (record?.type === 'chunk' && record.chunk?.type === 'usage') return record.chunk.usage
  }
  return undefined
}

/**
 * Fold one durable log into per-request usage samples.
 *
 * Each sample keeps its own `time`, because a request's price depends on when
 * it ran and nothing here may average that away. Attribution mirrors the live
 * Client engine: an assistant message carries its own source, and any other
 * billed attempt inherits the route of the latest `request/context` or
 * `request/header`.
 *
 * Replacement semantics mirror the `tokenUsage` projection exactly. An attempt
 * reported twice at the same (turn, step) supersedes itself rather than double
 * counting, while `llm/retry-started` closes the slot so a retried attempt ADDS
 * — a retry is a second billed request.
 * @param events - one session's complete raw log.
 * @returns `{t, p, m, b}` samples in log order, `b` being the four buckets.
 */
function foldSamples(events) {
  const samples = []
  let route = { provider: '', model: '' }
  /** Index of the sample the current (turn, step) slot holds, or -1. */
  let pending = -1

  for (const event of events) {
    const type = event.type
    if (type === 'request/context') {
      if (typeof event.data?.model === 'string') {
        route = { provider: event.data.provider ?? route.provider, model: event.data.model }
      }
      continue
    }
    if (type === 'request/header') {
      const config = event.data?.header?.config
      if (typeof config?.model === 'string') {
        route = { provider: config.provider ?? route.provider, model: config.model }
      }
      continue
    }
    if (type === 'llm/retry-started') {
      if (pending >= 0) {
        const at = samples[pending]
        if (at.turn === event.data?.turn && at.step === event.data?.step) pending = -1
      }
      continue
    }
    if (type !== 'assistant/message' && type !== 'assistant/attempt') continue

    const usage = usageOf(event)
    if (usage === undefined) continue
    const source = event.data?.message?.source
    const provider = typeof source?.provider === 'string' && source.provider.length > 0
      ? source.provider
      : route.provider
    const model = typeof source?.model === 'string' && source.model.length > 0
      ? source.model
      : route.model
    const buckets = [
      usage.inputTokens ?? 0,
      usage.cacheReadTokens ?? 0,
      usage.cacheWriteTokens ?? 0,
      usage.outputTokens ?? 0,
    ]
    const turn = event.data?.turn
    const step = event.data?.step
    const time = Number.isFinite(event.time) ? event.time : 0
    const previous = pending >= 0 ? samples[pending] : undefined

    if (previous !== undefined && previous.turn === turn && previous.step === step) {
      if (previous.b[0] === buckets[0] && previous.b[1] === buckets[1]
        && previous.b[2] === buckets[2] && previous.b[3] === buckets[3]) continue
      samples[pending] = { t: time, p: provider, m: model, turn, step, b: buckets }
      continue
    }
    samples.push({ t: time, p: provider, m: model, turn, step, b: buckets })
    pending = samples.length - 1
  }

  // `turn`/`step` exist only to resolve replacement; the Client prices the rest.
  return samples.map(sample => ({ t: sample.t, p: sample.p, m: sample.m, b: sample.b }))
}

/**
 * Fold a session log into the wall times this panel reports.
 *
 * The same algorithm as DSH's own `sessionStats` projection
 * (`@deepseek-ai/dsh-session-stats`), for the two figures the panel renders:
 *
 *   - model time: `step/start` → `assistant/message`, per step
 *   - tool time:  `tool/call` → `tool/result`, paired by `callId`
 *
 * That projection is the host's own answer and the panel prefers it. This fold
 * exists because the projection is not always carried for every session in the
 * session-list snapshot: while it is missing, a session that ran for an hour
 * contributes nothing, and the panel's totals collapse with no visible reason
 * (they fell from 47h to 1h on one machine with every other figure correct).
 * Recording the fold in the ledger makes these figures a property of the stored
 * record instead of a property of whichever projections happen to be loaded.
 *
 * @param events - one session's events, in log order.
 * @returns `{ llmMs, toolMs, turns, steps }`; times are 0 when the log has none.
 */
export function foldTiming(events) {
  let llmMs = 0
  let toolMs = 0
  let turns = 0
  let steps = 0
  let lastTurn = null
  let openStep = null
  const pendingCalls = new Map()
  for (const event of Array.isArray(events) ? events : []) {
    const type = event?.type
    const at = Number.isFinite(event?.time) ? event.time : undefined
    if (type === 'step/start') {
      if (at !== undefined) {
        openStep = { turn: event.data?.turn, step: event.data?.step, startTime: at }
      }
      continue
    }
    if (type === 'assistant/message') {
      if (openStep === null || at === undefined) continue
      if (openStep.turn !== event.data?.turn || openStep.step !== event.data?.step) continue
      llmMs += Math.max(0, at - openStep.startTime)
      openStep = null
      continue
    }
    if (type === 'tool/call') {
      const callId = event.data?.callId
      if (typeof callId === 'string' && at !== undefined) pendingCalls.set(callId, at)
      continue
    }
    if (type === 'tool/result') {
      const callId = event.data?.message?.source?.callId
      if (typeof callId !== 'string' || at === undefined) continue
      const dispatched = pendingCalls.get(callId)
      if (dispatched === undefined) continue
      toolMs += Math.max(0, at - dispatched)
      pendingCalls.delete(callId)
      continue
    }
    if (type === 'step/end') {
      if (lastTurn !== event.data?.turn) turns += 1
      steps += 1
      lastTurn = event.data?.turn
      openStep = null
      continue
    }
    if (type === 'turn/end') pendingCalls.clear()
  }
  return { llmMs, toolMs, turns, steps }
}

/**
 * Register the document routes, then the backfill route.
 *
 * `connection` is read through a scoped inject because it activates
 * asynchronously — `ctx.get('connection')` is still `undefined` while this half
 * applies, so a synchronous read would silently register nothing. The two
 * dependency sets stay separate on purpose: a composition without
 * `sessionQuery` still gets durable state, and loses only history re-pricing.
 * @param ctx - the plugin's Cordis context.
 */
export function apply(ctx) {
  const store = createStore(ctx)

  const mount = (dependencies, label, routes) => {
    ctx.inject(dependencies, scoped => {
      scoped.effect(() => {
        let disposed = false
        const removers = []
        const settle = disposer => {
          if (disposed) void disposer()
          else removers.push(disposer)
        }

        for (const route of routes(scoped)) {
          void scoped.connection.fetch.register(route).then(settle, error => {
            // Never swallow this: a failed registration only surfaces much later
            // as an opaque 404 on the Client's request.
            scoped.logger?.error?.(
              `dsh-cost: route ${route.path} failed to register: ${String(error)}`,
            )
          })
        }

        return () => {
          disposed = true
          for (const remove of removers) void remove()
        }
      }, label)
    })
  }

  mount(['connection'], 'dsh-cost: state routes', () => [
    {
      path: STATE_PATH,
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      /**
       * `GET` answers the whole document; `POST` merges one patch into it.
       * @param request - `{ revision?, ledger? }` on `POST`.
       * @returns the document, or a revision-conflict envelope with status 409.
       */
      fetch: async request => {
        if (request.method === 'GET') {
          const document = await store.read()
          return json({
            ok: true,
            version: 1,
            pluginVersion: PLUGIN_VERSION,
            revision: document.revision,
            config: document.config,
            ledger: document.ledger,
          })
        }
        let body = null
        try {
          body = await request.json()
        } catch {
          body = null
        }
        const result = await store.commit(body)
        return json(result, result.ok === true ? 200 : 409)
      },
    },
    {
      path: CONFIG_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      /**
       * Replace the price-table fields the Cost settings page edited.
       * @param request - `{ revision?, config }`.
       * @returns `{ ok, revision, config }`, or a revision-conflict envelope.
       */
      fetch: async request => {
        let body = null
        try {
          body = await request.json()
        } catch {
          body = null
        }
        const result = await store.commit({ revision: body?.revision, config: body?.config })
        return json(result, result.ok === true ? 200 : 409)
      },
    },
  ])

  // The backfill route additionally needs a session-query backend.
  mount(['connection', 'sessionQuery'], 'dsh-cost: backfill route', scoped => [
    {
      path: BACKFILL_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      /**
       * Stream one NDJSON line per finished session, so a full-corpus run shows
       * progress instead of holding a silent minute-long request open.
       * @param request - `{ sessions: string[] }`.
       * @returns an `application/x-ndjson` stream of start/session/error/done frames.
       */
      fetch: async request => {
        let body = {}
        try {
          body = await request.json()
        } catch {
          body = {}
        }
        const requested = Array.isArray(body?.sessions) ? body.sessions : []
        const sessions = [...new Set(requested.filter(id => typeof id === 'string' && id.length > 0))]
        const encoder = new TextEncoder()

        const stream = new ReadableStream({
          async start(controller) {
            const send = frame => controller.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`))
            send({ type: 'start', total: sessions.length })
            let done = 0
            for (const sessionId of sessions) {
              try {
                const snapshot = await scoped.sessionQuery.readSession(sessionId)
                send({ type: 'session', sessionId, samples: foldSamples(snapshot.events), timing: foldTiming(snapshot.events) })
              } catch (error) {
                send({ type: 'error', sessionId, reason: String(error).slice(0, 200) })
              }
              done += 1
              if (done % 5 === 0) send({ type: 'progress', done, total: sessions.length })
            }
            send({ type: 'done', done, total: sessions.length })
            controller.close()
          },
        })

        return new Response(stream, {
          headers: { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' },
        })
      },
    },
  ])
}

