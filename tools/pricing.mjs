/**
 * Effective-dated price table and per-request pricing.
 *
 * This is the seed of the backfill engine: the same rate resolution and the
 * same tier test run offline here and inside the plugin later. Every rate is
 * CNY per 1,000,000 tokens at the PEAK tier; DeepSeek's off-peak tier is
 * exactly half. Prices are effective-dated because a model name is not a
 * price: `deepseek-v4-flash` was the separately-priced V4-Flash-0731 before
 * 2026-09-10 and only afterwards became a routing alias for V4.1-Flash.
 *
 * Sources: api-docs.deepseek.com quick_start/pricing and its archived
 * snapshots for the historical windows; Xiaomi MiMo official price tables.
 */

/** Peak windows in Beijing local time, Mon-Fri, excluding statutory holidays. */
const DEEPSEEK_DISCOUNT = {
  offPeakRatio: 0.5,
  peakHours: [[9, 12], [14, 18]],
  weekdaysOnly: true,
  /** 国办发明电〔2025〕7号 — only dates falling in a peak window matter. */
  holidays: [
    '2026-01-01', '2026-01-02', '2026-01-03',
    '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19',
    '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
    '2026-04-04', '2026-04-05', '2026-04-06',
    '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
    '2026-06-19', '2026-06-20', '2026-06-21',
    '2026-09-25', '2026-09-26', '2026-09-27',
    '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04',
    '2026-10-05', '2026-10-06', '2026-10-07',
  ],
}

/** V4 GA took effect 16:00 UTC 2026-08-16; V4.1-Flash 04:00 UTC 2026-09-10. */
const V4_GA = Date.parse('2026-08-16T16:00:00Z')
const V41 = Date.parse('2026-09-10T04:00:00Z')

/**
 * One effective-dated price row.
 * `from` is inclusive, `to` exclusive; null means unbounded. Rows are matched
 * by exact model id and, when several match, the latest `from` wins.
 */
export const PRICE_ROWS = [
  {
    provider: 'deepseek-official',
    model: 'deepseek-v4-pro',
    from: V4_GA,
    to: null,
    rates: { cacheHit: 0.3, cacheMiss: 9, cacheWrite: 0, output: 27 },
    discount: DEEPSEEK_DISCOUNT,
  },
  {
    // The real DeepSeek-V4-Flash-0731, priced in its own right.
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    from: V4_GA,
    to: V41,
    rates: { cacheHit: 0.1, cacheMiss: 3, cacheWrite: 0, output: 9 },
    discount: DEEPSEEK_DISCOUNT,
  },
  {
    // Same name, now a routing alias for V4.1-Flash at Flash rates.
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    from: V41,
    to: null,
    rates: { cacheHit: 0.04, cacheMiss: 2, cacheWrite: 0, output: 8 },
    discount: DEEPSEEK_DISCOUNT,
  },
  {
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    from: V41,
    to: null,
    rates: { cacheHit: 0.04, cacheMiss: 2, cacheWrite: 0, output: 8 },
    discount: DEEPSEEK_DISCOUNT,
  },
  {
    // MiMo pay-as-you-go has NO time-of-day tiers.
    provider: 'xiaomi',
    model: 'mimo-v2.5-pro',
    from: null,
    to: null,
    rates: { cacheHit: 0.025, cacheMiss: 3, cacheWrite: 0, output: 6 },
  },
  {
    provider: 'xiaomi',
    model: 'mimo-v2.5',
    from: null,
    to: null,
    rates: { cacheHit: 0.02, cacheMiss: 1, cacheWrite: 0, output: 2 },
  },
]

/**
 * Credits per 1M tokens on the MiMo Token Plan — a SUBSCRIPTION, not metered
 * money. Quota is deducted in Credits; running out suspends service rather
 * than spilling to balance, so a per-token money figure would be fiction.
 */
export const TOKEN_PLAN_CREDITS = {
  'mimo-v2.5-pro': { cacheHit: 2.5, cacheMiss: 300, output: 600 },
  'mimo-v2.5': { cacheHit: 2, cacheMiss: 100, output: 200 },
}

/** Providers whose usage is drawn from a prepaid subscription, not billed per token. */
export function isTokenPlan(provider) {
  return typeof provider === 'string' && provider.includes('token-plan')
}

const pad = value => String(value).padStart(2, '0')

/** Beijing calendar parts for one instant. */
function beijingParts(ms) {
  const d = new Date(ms + 8 * 3600 * 1000)
  return {
    date: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
    weekday: d.getUTCDay(),
    hour: d.getUTCHours() + d.getUTCMinutes() / 60,
  }
}

/** @returns whether the discounted tier applies to a request at `ms`. */
export function isOffPeak(ms, discount) {
  if (discount === undefined) return false
  const { date, weekday, hour } = beijingParts(ms)
  if (discount.weekdaysOnly !== false && (weekday === 0 || weekday === 6)) return true
  if (discount.holidays?.includes(date) === true) return true
  return !discount.peakHours.some(([from, to]) => hour >= from && hour < to)
}

/**
 * Resolve the price row in force for one route at one instant.
 * @returns the winning row, or undefined when the route was never priced.
 */
export function resolveRow(provider, model, ms) {
  let best
  for (const row of PRICE_ROWS) {
    if (row.model !== model) continue
    if (row.provider !== undefined && row.provider !== provider) continue
    const from = row.from ?? -Infinity
    const to = row.to ?? Infinity
    if (ms < from || ms >= to) continue
    if (best === undefined || from > (best.from ?? -Infinity)) best = row
  }
  return best
}

/**
 * Price one usage sample at its own instant.
 * @returns `{ priced, peak, cost, credits }`; `priced` is false when the route
 * has no price row, and `credits` is set instead of `cost` for a Token Plan.
 */
export function priceUsage(provider, model, buckets, ms) {
  if (isTokenPlan(provider)) {
    const table = TOKEN_PLAN_CREDITS[model]
    if (table === undefined) return { priced: false, peak: false, cost: 0, credits: 0 }
    const credits = (buckets.cacheRead * table.cacheHit
      + buckets.cacheMiss * table.cacheMiss
      + buckets.output * table.output) / 1e6
    return { priced: true, peak: false, cost: 0, credits }
  }

  const row = resolveRow(provider, model, ms)
  if (row === undefined) return { priced: false, peak: false, cost: 0, credits: 0 }
  const peak = !isOffPeak(ms, row.discount)
  const scale = peak ? 1 : (row.discount?.offPeakRatio ?? 0.5)
  const cost = (buckets.cacheRead * row.rates.cacheHit
    + buckets.cacheMiss * row.rates.cacheMiss
    + buckets.cacheWrite * row.rates.cacheWrite
    + buckets.output * row.rates.output) * scale / 1e6
  return { priced: true, peak, cost, credits: 0 }
}
