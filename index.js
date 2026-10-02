/**
 * Host half of the cost meter.
 *
 * It owns exactly one thing: the `dsh-cost` settings namespace, which persists
 * the user's effective-dated price table and the machine-written spend ledger
 * to the harness settings document. No billing arithmetic happens here — the
 * Client half computes every figure — so this half exists only because the
 * browser cannot write a durable file and `localStorage` dies with the cache.
 *
 * The schema is a plain callable with a `toJSON`, which is the whole contract
 * `ctx.settings` asks of a namespace schema (`schema(value)` to resolve,
 * `schema.toJSON()` to describe). Hand-rolling it keeps this package at zero
 * dependencies, so the folder can be copied to another machine as-is.
 *
 * PRICES ARE EFFECTIVE-DATED because a model name is not a price: through
 * 2026-09-10 `deepseek-v4-flash` was the separately-priced V4-Flash-0731, and
 * only afterwards did the retired name start routing to V4.1-Flash. Resolving
 * a rate without a date would silently misprice one of those two eras. All
 * rates are CNY per 1,000,000 tokens at the PEAK tier; `discount` halves them
 * off-peak. A row carrying `tokenPlan` instead describes a prepaid
 * subscription, whose usage is counted in Credits and never in money.
 */

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
 * Deliberately NOT frozen: `settings.update` deep-merges through
 * `mergeLayers`, and a frozen array reaching an in-place write would throw on
 * the ledger flush path — far worse than the mutation it would prevent.
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
 * Build the namespace schema.
 *
 * `ctx.settings` calls the returned function to resolve a value and
 * `toJSON()` to describe it for configuration surfaces. Every field is
 * defaulted here, so an absent or hand-edited section still resolves.
 * @returns {((input: unknown) => object) & { toJSON(): object }} the schema.
 */
function createSchema() {
  const schema = input => {
    const value = input !== null && typeof input === 'object' ? input : {}
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
      ledger: normalizeLedger(value.ledger),
    }
  }
  // Deliberately minimal and static: this must never throw, because the same
  // call feeds the shipped Settings surfaces.
  schema.toJSON = () => ({
    type: 'object',
    properties: {
      currency: { type: 'string', description: 'Display currency label, e.g. CNY.' },
      flushMs: { type: 'number', description: 'Ledger flush interval in milliseconds.' },
      models: { type: 'array', description: 'Effective-dated price table. Edit from the Cost settings page.' },
      holidays: { type: 'array', description: 'Off-peak calendar dates, YYYY-MM-DD (Beijing).' },
      ledger: { type: 'object', description: 'Machine-written spend ledger. Do not hand-edit.' },
    },
  })
  return schema
}

/** Namespace owned by this plugin. */
export const NAMESPACE = 'dsh-cost'

/** Bumped whenever the namespace shape changes, so a reload is observable in the log. */
export const SCHEMA_TAG = 'effective-dated-prices/v2'

/**
 * Absolute pathname the Client requests, INCLUDING the `/api` mount.
 *
 * The service doc says "absolute path below /api", but the registry keys routes
 * by the raw `url.pathname` and `assertFetchRoute` rejects anything not starting
 * with `/api/` — so the mount prefix is part of the value, not implied by it.
 * Registering `/cost/backfill` instead throws, and a swallowed promise turns
 * that into a silent 404 at request time.
 */
const BACKFILL_PATH = '/api/cost/backfill'

export const inject = ['settings']

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
 * Register the settings namespace and the backfill route.
 * @param ctx - the plugin's Cordis context.
 */
export function apply(ctx) {
  try {
    ctx.settings.register(NAMESPACE, createSchema(), { applies: 'live' })
    ctx.logger?.info?.(`dsh-cost: settings namespace registered (${SCHEMA_TAG})`)
  } catch (error) {
    // A reload can re-run apply before the previous registration is disposed.
    // Losing the namespace is bad; losing the whole plugin would be worse.
    ctx.logger?.warn?.(`dsh-cost: settings namespace not registered: ${String(error)}`)
  }

  // The backfill route needs a Host transport and a session-query backend.
  // Registering through a scoped inject keeps the meter itself — the pill and
  // the settings page — working on a composition that provides neither.
  ctx.inject(['connection', 'sessionQuery'], scoped => {
    scoped.effect(() => {
      let disposed = false
      let remove
      const settle = disposer => {
        if (disposed) void disposer()
        else remove = disposer
      }

      void scoped.connection.fetch.register({
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
                send({ type: 'session', sessionId, samples: foldSamples(snapshot.events) })
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
    }).then(settle, error => {
      // Never swallow this: a failed registration only surfaces much later as
      // an opaque 404 on the Client's request.
      scoped.logger?.error?.(
        `dsh-cost: backfill route ${BACKFILL_PATH} failed to register: ${String(error)}`,
      )
    })

      return () => {
        disposed = true
        if (remove !== undefined) void remove()
      }
    }, 'dsh-cost: backfill route')
  })
}
