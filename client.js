/**
 * Cost meter — exact CNY spend for every priced route, plus the settings page
 * that owns the effective-dated price table.
 *
 * The harness already publishes every number the accounting needs:
 *   - `tokenUsage`       four disjoint billing buckets, exact and cumulative
 *   - `modelSelection`   the route that produced those tokens
 *
 * A session row in the Client session list carries both as `projectionValues`,
 * which is why conversations that were never opened are still priceable.
 *
 * Accounting is a differential fold: the first time a conversation is seen its
 * current totals become a baseline and it starts at zero, and every later
 * increase is charged at the rate in force AT THE MOMENT IT IS OBSERVED. That
 * is why no session log is read here: the tier is knowable from the wall clock
 * as the counter moves, so nothing has to be reconstructed after the fact. An
 * offline backfill, which prices each request at its own logged instant, is a
 * separate future step.
 */

window.__ModuleLoader__.load({
  // Must equal the npm package name: the browser module table keys by it.
  id: 'dsh-cost-meter',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    // The portal is a nicety, not a requirement: without react-dom the dialog
    // renders inline inside the pill's own positioned span.
    let ReactDOM = null
    try {
      ReactDOM = require('react-dom')
    } catch (error) {
      ReactDOM = null
    }

    const NS = 'dsh-cost'
    const BUCKETS = ['cacheRead', 'cacheMiss', 'cacheWrite', 'output']
    const EMPTY_OBJECT = {}
    const EMPTY_ARRAY = []
    const SYMBOLS = { CNY: '¥', USD: '$', CREDITS: '' }

    // ------------------------------------------------------------- utilities

    const pad = value => String(value).padStart(2, '0')

    /** Beijing calendar parts for one instant; DeepSeek's windows are published in both zones. */
    function beijingParts(ms) {
      const d = new Date(ms + 8 * 3600 * 1000)
      return {
        date: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
        weekday: d.getUTCDay(),
        hour: d.getUTCHours() + d.getUTCMinutes() / 60,
      }
    }

    /** Beijing calendar day for one instant, matching the tariff's own zone. */
    const dayKey = ms => beijingParts(ms).date

    /** @returns whether the discounted tier applies to a request observed at `ms`. */
    function isOffPeak(ms, discount, holidays) {
      if (discount === undefined) return false
      const { date, weekday, hour } = beijingParts(ms)
      if (discount.weekdaysOnly !== false && (weekday === 0 || weekday === 6)) return true
      if (holidays.has(date)) return true
      const peakHours = Array.isArray(discount.peakHours) ? discount.peakHours : []
      return !peakHours.some(pair => hour >= pair[0] && hour < pair[1])
    }

    const instantOf = value => {
      if (typeof value !== 'string' || value.length === 0) return undefined
      const ms = Date.parse(value)
      return Number.isFinite(ms) ? ms : undefined
    }

    /**
     * Resolve the price row in force for one route at one instant.
     *
     * A model name is not a price, so the window decides: `deepseek-v4-flash`
     * is two different products either side of 2026-09-10. Among the rows whose
     * window contains `atMs`, the exact model or `provider/model` match wins
     * over a trailing-`*` match, and the latest window start wins within a tier.
     * @returns the winning row, or undefined when the route was never priced.
     */
    function findModel(models, provider, model, atMs, holidays) {
      if (!Array.isArray(models)) return undefined
      const qualified = `${provider}/${model}`
      let bestExact
      let bestWild
      let exactFrom = -Infinity
      let wildFrom = -Infinity
      for (const entry of models) {
        if (entry === null || typeof entry !== 'object') continue
        const pattern = entry.match
        if (typeof pattern !== 'string') continue
        const from = instantOf(entry.from) ?? -Infinity
        const to = instantOf(entry.to) ?? Infinity
        if (!(atMs >= from && atMs < to)) continue
        if (pattern === qualified || pattern === model) {
          if (from > exactFrom) {
            exactFrom = from
            bestExact = entry
          }
          continue
        }
        if (pattern.endsWith('*')) {
          const prefix = pattern.slice(0, -1)
          if ((qualified.startsWith(prefix) || model.startsWith(prefix)) && from > wildFrom) {
            wildFrom = from
            bestWild = entry
          }
        }
      }
      const entry = bestExact ?? bestWild
      if (entry === undefined) return undefined
      // Effective dating alone does not say whether the tier applies now.
      return { entry, offPeak: isOffPeak(atMs, entry.discount, holidays) }
    }

    const bucketsOf = usage => ({
      cacheMiss: usage.uncachedInputTokens ?? 0,
      cacheRead: usage.cacheReadTokens ?? 0,
      cacheWrite: usage.cacheWriteTokens ?? 0,
      output: usage.outputTokens ?? 0,
    })

    const zeroBuckets = () => ({ cacheMiss: 0, cacheRead: 0, cacheWrite: 0, output: 0 })

    /**
     * One day's slice of a session.
     *
     * Per-bucket money rides along so a date-range filter can slice the cost
     * composition chart, not only the totals.
     */
    const blankDay = () => ({ tokens: 0, cost: 0, credits: 0, byBucket: zeroBuckets() })

    /** Accumulate one priced sample into a session's day map. */
    function addToDay(map, ms, tokens, cost, credits, byBucket) {
      const key = dayKey(ms)
      const day = map[key] ?? blankDay()
      day.tokens += tokens
      day.cost += cost
      day.credits += credits
      for (const bucket of BUCKETS) day.byBucket[bucket] += byBucket[bucket] ?? 0
      map[key] = day
    }

    const subtract = (next, base) => ({
      cacheMiss: next.cacheMiss - base.cacheMiss,
      cacheRead: next.cacheRead - base.cacheRead,
      cacheWrite: next.cacheWrite - base.cacheWrite,
      output: next.output - base.output,
    })

    const isZero = delta => BUCKETS.every(key => delta[key] === 0)
    const hasNegative = delta => BUCKETS.some(key => delta[key] < 0)
    const totalOf = value => BUCKETS.reduce((sum, key) => sum + value[key], 0)

    /**
     * Price one delta under a resolved row.
     * @returns per-bucket amounts, their total, and whether the total is money
     * or Token Plan Credits (`tokenPlan` routes are a subscription).
     */
    function priceDelta(delta, resolved) {
      const entry = resolved.entry
      const rates = entry.rates
      const scale = resolved.offPeak ? (entry.discount === undefined ? 0.5 : entry.discount.offPeakRatio) : 1
      const rows = {
        cacheRead: delta.cacheRead * rates.cacheHit * scale / 1e6,
        cacheMiss: delta.cacheMiss * rates.cacheMiss * scale / 1e6,
        cacheWrite: delta.cacheWrite * rates.cacheWrite * scale / 1e6,
        output: delta.output * rates.output * scale / 1e6,
      }
      return {
        rows,
        total: BUCKETS.reduce((sum, key) => sum + rows[key], 0),
        tokenPlan: entry.tokenPlan === true,
        currency: entry.currency,
      }
    }

    const isCredits = currency => typeof currency === 'string' && currency.toUpperCase() === 'CREDITS'

    function formatMoney(value, symbol) {
      if (!Number.isFinite(value)) return '--'
      if (value === 0) return `${symbol}0.00`
      if (value < 0.01) return `${symbol}${value.toFixed(4)}`
      return `${symbol}${value.toFixed(2)}`
    }

    const formatCredits = value => `${value < 10 ? value.toFixed(1) : value.toFixed(0)} cr`

    function formatTokens(value) {
      if (!Number.isFinite(value)) return '--'
      if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`
      if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`
      if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`
      return String(value)
    }

    const formatExact = value => (Number.isFinite(value) ? value.toLocaleString('en-US') : '--')

    // ------------------------------------------------------------------ style

    const hairline = 'color-mix(in srgb, currentColor 16%, transparent)'
    const SOFT = 'color-mix(in srgb, currentColor 55%, transparent)'
    const FAINT = 'color-mix(in srgb, currentColor 38%, transparent)'
    const PILL = {
      display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 9px',
      border: `1px solid ${hairline}`, borderRadius: 999,
      background: 'color-mix(in srgb, currentColor 7%, transparent)',
      color: 'inherit', font: 'inherit', fontSize: 12, lineHeight: 1.5, cursor: 'pointer',
    }
    const PANEL = {
      position: 'fixed', zIndex: 60, width: 340, padding: 12,
      border: `1px solid ${hairline}`, borderRadius: 12,
      background: 'color-mix(in srgb, Canvas 92%, CanvasText)',
      color: 'CanvasText', font: 'inherit', fontSize: 12, lineHeight: 1.6,
      boxShadow: '0 10px 30px rgba(0,0,0,.30)',
    }
    const ROW = { display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'baseline' }
    const MUTED = { color: SOFT, fontSize: 11 }
    const FAINTED = { color: FAINT, fontSize: 10.5 }
    const RULE = { height: 1, background: hairline, margin: '8px 0' }
    const WARN = { color: '#d29343' }
    const SECTION_TITLE = { fontSize: 13, fontWeight: 600, margin: '0 0 8px' }
    const GROUP = {
      border: `1px solid ${hairline}`, borderRadius: 10, padding: 12, marginBottom: 14,
    }
    const INPUT = {
      width: '100%', boxSizing: 'border-box', padding: '3px 6px',
      border: `1px solid ${hairline}`, borderRadius: 6,
      background: 'color-mix(in srgb, currentColor 5%, transparent)',
      color: 'inherit', font: 'inherit', fontSize: 11.5,
    }
    const TH = {
      textAlign: 'left', padding: '2px 5px', fontWeight: 500, color: SOFT,
      fontSize: 10.5, whiteSpace: 'nowrap',
    }
    // A native select popup is drawn by the OS, not the page: it inherits none
    // of the page's colours and renders light regardless of the app theme,
    // which makes light-on-white options unreadable. `color-scheme` plus
    // explicit option colours is the only thing that reaches it.
    const DARK_UI = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
      : true
    /** A select needs the scheme stated, or its popup stays light. */
    const SELECT = { ...INPUT, colorScheme: DARK_UI ? 'dark' : 'light' }
    const OPTION = DARK_UI
      ? { background: '#24262b', color: '#e8eaed' }
      : { background: '#ffffff', color: '#1f2126' }
    const TD = { padding: '3px 5px', verticalAlign: 'middle' }
    const BUTTON = {
      padding: '4px 12px', border: `1px solid ${hairline}`, borderRadius: 8,
      background: 'color-mix(in srgb, currentColor 8%, transparent)',
      color: 'inherit', font: 'inherit', fontSize: 12, cursor: 'pointer',
    }
    const COLUMNS = ['match', 'from', 'to', 'cacheHit', 'cacheMiss', 'cacheWrite', 'output', 'currency']
    /**
     * Rows the composer dialog shows before it stops listing.
     *
     * The dialog is a floating layer, so the list is a ranking rather than a
     * browser: the most expensive conversations answer "where did the money go"
     * without any scrolling, and the count beside the total keeps the hidden
     * remainder honest.
     */
    const TOP_ROWS = 20
    /** Checkbox rows the session picker renders before it asks for a search. */
    const PICK_ROWS = 50
    /** Fixed column widths, so a value never squeezes its own header into a sliver. */
    const WIDTHS = [168, 140, 140, 68, 74, 64, 64, 54, 40, 30]
    const TABLE_WIDTH = WIDTHS.reduce((sum, width) => sum + width, 0)

    // ----------------------------------------------------------------- locale

    const ZH = {
      title: '花费估算',
      session: '本对话',
      project: '本项目',
      grandTotal: '全部合计',
      outsideProject: '项目外 {count} 个',
      moreRows: '按金额降序，仅显示前 {shown} 个 · 另有 {hidden} 个未显示（共 {total} 个）',
      pickSearch: '搜索对话标题或 id',
      pickLimited: '匹配 {total} 个，仅显示前 {shown} 个 · 用搜索缩小范围',
      pickMatched: '匹配 {count} 个',
      reportTitle: '项目花费',
      reportIntro: '按项目、对话、模型和计费桶汇总已计价的花费。数据来自本机账本——先去「花费计价」跑一次计算，这里才会包含历史。',
      reportScope: '范围',
      reportAllProjects: '全部项目',
      reportTotalCost: '总花费',
      reportTotalTokens: '总 token',
      reportProjects: '项目数',
      reportConversations: '对话数',
      reportByBucket: '花费构成（按计费桶）',
      reportByProject: '项目分布',
      reportByConversation: '对话分布',
      reportByModel: '按模型',
      reportTop: '对话明细',
      reportCount: '共 {count} 条',
      colConversation: '对话',
      colProject: '项目',
      colModel: '模型',
      colTokens: 'token',
      colCost: '花费',
      reportPage: '第 {page} / {pages} 页 · 共 {total} 条',
      reportPrev: '上一页',
      reportNext: '下一页',
      reportEmpty: '还没有可统计的数据 —— 先在「花费计价」里跑一次计算。',
      reportMultiModel: '多模型',
      reportNoModel: '未归因',
      reportOther: '其他',
      reportNoProject: '未归入项目',
      dashTitle: '账号花费',
      dashBack: '返回全部项目',
      dashAllTime: '全部时间',
      dash30: '近 30 天',
      dash7: '近 7 天',
      dashLlmTime: '模型用时',
      dashToolTime: '工具用时',
      dashAllTimeOnly: '全期，不随日期过滤',
      dashCacheRead: '缓存读取 tok',
      dashEmpty: '还没有可统计的数据',
      dashEmptyHint: '先去「花费计价」跑一次计算，把历史日志里的花费回溯进账本。',
      dashActivity: 'Token 活动',
      dashDaily: '每天',
      dashWeekly: '每周',
      dashCumulative: '累计',
      dashMetricToken: 'Token',
      dashMetricCost: '花费',
      dashSince: '起',
      dashDays: '共 {count} 天',
      dashDaysWithData: '有数据 {count} 天',
      dashHeatTotal: '合计',
      dashByProject: '项目排行',
      dashUndated: '{count} 个对话缺少按天数据，未计入所选时间段',
      dashNeedBackfill: '{count} 个对话缺少按天数据 · 在「花费计价」重跑一次计算即可补齐',
      colDuration: '用时',
      conversations: '{count} 个对话',
      cacheRead: '缓存读取',
      cacheMiss: '未缓存输入',
      cacheWrite: '缓存写入',
      output: '输出',
      charged: '已计价',
      offPeak: '当前低谷时段（半价）',
      peak: '当前高峰时段（全价）',
      unpriced: '{count} tok 无价目，未计入',
      footnote: '按实测 token 差分 × 当时单价累加',
      excludeBaseline: '（不含装插件前的 {tokens} tok）',
      untitled: '未命名对话',
      subscription: '订阅套餐额度',
      settingsTitle: '花费计价',
      settingsIntro: '单价为「高峰价」，人民币／百万 token。低谷时段按折扣系数计。'
        + '同一模型可有多行，用生效／失效时间区分不同时期的价格——模型改名或调价时必须这样做。',
      colMatch: '模型 / provider',
      colFrom: '生效自（ISO，可空）',
      colTo: '失效于（ISO，可空）',
      colCacheHit: '命中',
      colCacheMiss: '未缓存',
      colCacheWrite: '写入',
      colOutput: '输出',
      colCurrency: '币种',
      colPlan: '套餐',
      addRow: '+ 添加模型',
      remove: '删除',
      globalTitle: '全局',
      currency: '显示币种',
      flushMs: '账本写入间隔（毫秒）',
      holidays: '低谷节假日',
      holidaysNote: '共 {count} 天（北京时间日历日）',
      save: '保存',
      saving: '保存中…',
      saved: '已保存',
      failed: '保存失败：{reason}',
      unsaved: '有未保存的改动',
      planHint: '勾选「套餐」表示该路线来自预购订阅，用量以 Credits 计，不计入金额。',
      backfillTitle: '计算未评估信息',
      backfillIntro: '读取会话日志，把每一笔请求按它自己发生时刻的单价重新计价，并替换该会话现有的估算值。'
        + '这会覆盖「装插件之后」的累加值——日志值更准，因为它按请求实际发生的时间计价，而不是按浏览器看到它增长的时间。',
      scopeAll: '全部会话（{count}）',
      scopeProject: '按项目',
      scopeProjectCount: '按项目（{count}）',
      scopePicked: '挑选特定会话（{count}）',
      backfillRun: '开始计算（{count} 个）',
      backfillRunning: '计算中…',
      backfillProgress: '已完成 {done} / {total}',
      backfillSum: '本次合计',
      backfillFailed: ' · {count} 个读取失败',
      backfillMismatch: ' · {count} 个与投影不符',
      backfillPick: '选择项目',
      backfillError: '计算失败：{reason}',
      backfillNoTarget: '请先选择要计算的会话',
      backfillReady: '回溯服务已就绪',
      backfillUnavailable: '回溯服务未就绪：host 路由未注册（改过 host 代码后需要重启 harness）',
    }
    const EN = {
      title: 'Cost estimate',
      session: 'This conversation',
      project: 'This project',
      grandTotal: 'All conversations',
      outsideProject: '{count} outside this project',
      moreRows: 'Sorted by cost, showing the top {shown} · {hidden} more not shown (of {total})',
      pickSearch: 'Search title or id',
      pickLimited: '{total} match, showing the first {shown} · narrow with a search',
      pickMatched: '{count} match',
      reportTitle: 'Project spend',
      reportIntro: 'Spend aggregated by project, conversation, model and billing bucket, from this machine\'s ledger. Run a compute in Cost first, or history will not be included.',
      reportScope: 'Scope',
      reportAllProjects: 'All projects',
      reportTotalCost: 'Total spend',
      reportTotalTokens: 'Total tokens',
      reportProjects: 'Projects',
      reportConversations: 'Conversations',
      reportByBucket: 'Spend by billing bucket',
      reportByProject: 'By project',
      reportByConversation: 'By conversation',
      reportByModel: 'By model',
      reportTop: 'Conversations',
      reportCount: '{count} total',
      colConversation: 'Conversation',
      colProject: 'Project',
      colModel: 'Model',
      colTokens: 'Tokens',
      colCost: 'Cost',
      reportPage: 'Page {page} / {pages} · {total} rows',
      reportPrev: 'Previous',
      reportNext: 'Next',
      reportEmpty: 'Nothing to report yet - run a compute in Cost first.',
      reportMultiModel: 'Multiple',
      reportNoModel: 'Unattributed',
      reportOther: 'Other',
      reportNoProject: 'No project',
      dashTitle: 'Account spend',
      dashBack: 'Back to all projects',
      dashAllTime: 'All time',
      dash30: 'Last 30 days',
      dash7: 'Last 7 days',
      dashLlmTime: 'Model time',
      dashToolTime: 'Tool time',
      dashAllTimeOnly: 'all time; not date-filtered',
      dashCacheRead: 'Cache-read tokens',
      dashEmpty: 'Nothing to report yet',
      dashEmptyHint: 'Run a compute in Cost first, to fold the history in your session logs into the ledger.',
      dashActivity: 'Token activity',
      dashDaily: 'Daily',
      dashWeekly: 'Weekly',
      dashCumulative: 'Cumulative',
      dashMetricToken: 'Tokens',
      dashMetricCost: 'Cost',
      dashSince: 'onward',
      dashDays: '{count} days',
      dashDaysWithData: '{count} days with data',
      dashHeatTotal: 'total',
      dashByProject: 'By project',
      dashUndated: '{count} conversations have no per-day data and are outside the selected range',
      dashNeedBackfill: '{count} conversations have no per-day data - rerun a compute in Cost to fill them in',
      colDuration: 'Time',
      conversations: '{count} conversations',
      cacheRead: 'Cache read',
      cacheMiss: 'Uncached input',
      cacheWrite: 'Cache write',
      output: 'Output',
      charged: 'Charged',
      offPeak: 'Off-peak now (half price)',
      peak: 'Peak now (full price)',
      unpriced: '{count} tok has no price entry and is not charged',
      footnote: 'Measured token deltas x the rate at the time',
      excludeBaseline: '({tokens} tok before install excluded)',
      untitled: 'Untitled',
      subscription: 'Subscription quota',
      settingsTitle: 'Cost',
      settingsIntro: 'Rates are PEAK prices, currency per million tokens; the off-peak tier applies a discount.'
        + ' One model may have several rows distinguished by effective dates — required whenever a model is renamed or repriced.',
      colMatch: 'Model / provider',
      colFrom: 'Effective from (ISO, optional)',
      colTo: 'Effective to (ISO, optional)',
      colCacheHit: 'Hit',
      colCacheMiss: 'Miss',
      colCacheWrite: 'Write',
      colOutput: 'Out',
      colCurrency: 'Cur.',
      colPlan: 'Plan',
      addRow: '+ Add model',
      remove: 'Remove',
      globalTitle: 'Global',
      currency: 'Display currency',
      flushMs: 'Ledger flush interval (ms)',
      holidays: 'Off-peak holidays',
      holidaysNote: '{count} dates (Beijing calendar)',
      save: 'Save',
      saving: 'Saving...',
      saved: 'Saved',
      failed: 'Save failed: {reason}',
      unsaved: 'Unsaved changes',
      planHint: 'Checking Plan marks a prepaid subscription route: usage is counted in Credits and never in money.',
      backfillTitle: 'Compute unevaluated history',
      backfillIntro: 'Reads session logs and reprices every request at the rate in force when IT ran, replacing the'
        + " session's existing estimate. This also overwrites what accumulated since install — the log figure is"
        + ' more accurate, because it prices each request when it happened rather than when the browser saw the counter move.',
      scopeAll: 'All sessions ({count})',
      scopeProject: 'By project',
      scopeProjectCount: 'By project ({count})',
      scopePicked: 'Pick sessions ({count})',
      backfillRun: 'Compute ({count})',
      backfillRunning: 'Computing...',
      backfillProgress: '{done} / {total} done',
      backfillSum: 'This run',
      backfillFailed: ' · {count} unreadable',
      backfillMismatch: ' · {count} disagree with the projection',
      backfillPick: 'Choose a project',
      backfillError: 'Compute failed: {reason}',
      backfillNoTarget: 'Choose the sessions to compute first',
      backfillReady: 'Backfill service ready',
      backfillUnavailable: 'Backfill service unavailable: the Host route is not registered (host code changes need a harness restart)',
    }

    // ------------------------------------------------------------------ apply

    return {
      inject: ['slots', 'locale', 'sessions', 'remote', 'remote.settings'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, 'zh', ZH), 'dsh-cost: zh')
        ctx.effect(() => ctx.locale.register(NS, 'en', EN), 'dsh-cost: en')
        const t = ctx.locale.bind(NS)

        /** Resolved configuration: models, holidays, currency, flush cadence. */
        let config = null
        /** The raw namespace view, so the settings page edits what is stored. */
        let view = null
        /** sessionId -> accumulated row. Authoritative in this browser tab. */
        const ledger = new Map()
        let revision = 0
        let loaded = false
        let version = 0
        let writeTimer = null
        let inFlight = false
        let retries = 0
        const listeners = new Set()

        const notify = () => {
          version += 1
          for (const listener of listeners) {
            try {
              listener()
            } catch (error) {
              ctx.logger?.warn?.(`cost meter: listener failed: ${String(error)}`)
            }
          }
        }

        const subscribe = listener => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        }

        /** Unwrap a Remote result, tolerating both the wrapped and raw shapes. */
        function unwrap(result) {
          if (result === null || typeof result !== 'object') return result
          if (result.ok === true) return result.value
          if (result.ok === false) return undefined
          return result
        }

        function adoptConfig(value) {
          const models = Array.isArray(value?.models) ? value.models : []
          const holidays = Array.isArray(value?.holidays) ? value.holidays : []
          config = {
            currency: typeof value?.currency === 'string' ? value.currency : 'CNY',
            flushMs: Number.isFinite(value?.flushMs) ? value.flushMs : 4000,
            models,
            holidays: new Set(holidays),
          }
        }

        function adoptLedger(raw) {
          if (raw === null || typeof raw !== 'object') return
          for (const [sessionId, row] of Object.entries(raw)) {
            if (row === null || typeof row !== 'object') continue
            // An empty model means attribution never worked for this row, which
            // is a defect state rather than a real "no price entry" result
            // (that one still records its model id). Drop it and re-baseline.
            if (typeof row.model !== 'string' || row.model.length === 0) continue
            ledger.set(sessionId, {
              baseline: { ...zeroBuckets(), ...(row.baseline ?? {}) },
              byBucket: { ...zeroBuckets(), ...(row.byBucket ?? {}) },
              charged: { ...zeroBuckets(), ...(row.charged ?? {}) },
              byDay: row.byDay !== null && typeof row.byDay === 'object' ? { ...row.byDay } : {},
              cost: Number.isFinite(row.cost) ? row.cost : 0,
              credits: Number.isFinite(row.credits) ? row.credits : 0,
              unpriced: Number.isFinite(row.unpriced) ? row.unpriced : 0,
              model: row.model,
              updatedAt: Number.isFinite(row.updatedAt) ? row.updatedAt : 0,
            })
          }
        }

        /** Pull configuration, and the ledger on first load only. */
        async function pull(adoptRows) {
          try {
            const payload = unwrap(await ctx.remote.settings.describe())
            const namespaces = Array.isArray(payload?.namespaces) ? payload.namespaces : []
            const found = namespaces.find(entry => entry?.ns === NS)
            if (found === undefined) return false
            revision = Number.isFinite(found.revision) ? found.revision : 0
            view = found
            adoptConfig(found.value)
            if (adoptRows) {
              // The ledger is machine-written, and the registered schema gates
              // only the RESOLVED value. Reading the RAW user layer keeps a
              // column the running Host does not yet know about: the schema
              // would strip `byDay` on the way out, so the data would be
              // written but unreadable until the process restarted. `user`
              // ships in the same descriptor (`describe()` documents it as the
              // raw user layer) and `adoptLedger` sanitizes defensively.
              adoptLedger(found.user?.ledger ?? found.value?.ledger)
            }
            return true
          } catch (error) {
            ctx.logger?.warn?.(`cost meter: settings read failed: ${String(error)}`)
            return false
          }
        }

        /** Rows changed since the last successful write; the rest need no resend. */
        const dirtyRows = new Set()

        function snapshotLedger(only) {
          const rows = {}
          if (only === undefined) {
            for (const [sessionId, row] of ledger) rows[sessionId] = row
            return rows
          }
          for (const sessionId of only) {
            const row = ledger.get(sessionId)
            if (row !== undefined) rows[sessionId] = row
          }
          return rows
        }

        async function write(patch) {
          const payload = unwrap(await ctx.remote.settings.update(NS, patch, revision))
          if (Number.isFinite(payload?.revision)) revision = payload.revision
          return payload
        }

        /**
         * Send only the rows that changed.
         *
         * `settings.update` merges recursively, so a sparse ledger patch lands
         * beside the rows it does not mention. Resending the whole ledger would
         * make every write O(conversations) — megabytes per flush once a project
         * has hundreds of them — for no benefit.
         */
        async function flush() {
          writeTimer = null
          if (!loaded || inFlight || dirtyRows.size === 0) return
          const pending = [...dirtyRows]
          inFlight = true
          try {
            await write({ ledger: snapshotLedger(pending) })
            for (const sessionId of pending) dirtyRows.delete(sessionId)
            retries = 0
          } catch (error) {
            // A concurrent writer moved the revision: re-read and try again.
            // The dirty set survives, so the next attempt resends the same rows.
            if (retries < 3) {
              retries += 1
              ctx.logger?.warn?.(`cost meter: ledger write rejected, re-reading: ${String(error)}`)
              await pull(false)
              schedule()
            } else {
              ctx.logger?.warn?.(`cost meter: ledger write gave up: ${String(error)}`)
            }
          } finally {
            inFlight = false
          }
        }

        function schedule() {
          if (writeTimer !== null) return
          writeTimer = setTimeout(flush, config?.flushMs ?? 4000)
        }

        /** Charge every conversation whose cumulative totals moved since last look. */
        function fold(state) {
          if (config === null || state === null || typeof state !== 'object') return
          const ids = Array.isArray(state.ids) ? state.ids : EMPTY_ARRAY
          const byId = state.byId ?? EMPTY_OBJECT
          const now = Date.now()
          let dirty = false

          for (const sessionId of ids) {
            const row = byId[sessionId]
            const usage = row?.projectionValues?.tokenUsage
            if (usage === undefined) continue
            const buckets = bucketsOf(usage)
            const selection = row?.projectionValues?.modelSelection
            const used = selection?.lastUsed ?? selection?.next
            const route = { provider: used?.provider, model: used?.model }
            const entry = ledger.get(sessionId)

            if (entry === undefined) {
              // First sight: this conversation starts counting from here.
              ledger.set(sessionId, {
                baseline: buckets,
                byBucket: zeroBuckets(),
                charged: zeroBuckets(),
                byDay: {},
                cost: 0,
                credits: 0,
                unpriced: 0,
                model: typeof route.model === 'string' ? route.model : '',
                updatedAt: now,
              })
              dirtyRows.add(sessionId)
              dirty = true
              continue
            }

            const delta = subtract(buckets, entry.baseline)
            if (isZero(delta)) continue
            if (hasNegative(delta)) {
              // Totals moved backwards (fork or replaced projection): re-baseline.
              entry.baseline = buckets
              entry.updatedAt = now
              dirtyRows.add(sessionId)
              dirty = true
              continue
            }

            const resolved = findModel(config.models, route.provider, route.model, now, config.holidays)
            if (resolved === undefined) {
              // Never invent a price: the tokens are counted, the money is not.
              entry.unpriced += totalOf(delta)
              addToDay(entry.byDay, now, totalOf(delta), 0, 0, zeroBuckets())
            } else {
              const priced = priceDelta(delta, resolved)
              if (priced.tokenPlan) {
                // A subscription draws Credits, not money. Letting its
                // per-bucket amounts into `byBucket` would add credits to a
                // currency total in every composition chart.
                entry.credits += priced.total
                addToDay(entry.byDay, now, totalOf(delta), 0, priced.total, zeroBuckets())
              } else {
                entry.cost += priced.total
                addToDay(entry.byDay, now, totalOf(delta), priced.total, 0, priced.rows)
              }
              for (const key of BUCKETS) {
                if (!priced.tokenPlan) entry.byBucket[key] += priced.rows[key]
                entry.charged[key] += delta[key]
              }
            }
            entry.baseline = buckets
            if (typeof route.model === 'string' && route.model.length > 0) entry.model = route.model
            entry.updatedAt = now
            dirtyRows.add(sessionId)
            dirty = true
          }

          if (dirty) {
            notify()
            schedule()
          }
        }

        if (ctx.sessions?.list !== undefined) {
          ctx.effect(() => ctx.sessions.list.subscribe(() => fold(ctx.sessions.list.getSnapshot())),
            'dsh-cost: session list observation')
        }
        ctx.effect(() => () => {
          if (writeTimer !== null) clearTimeout(writeTimer)
        }, 'dsh-cost: ledger timer')

        void pull(true).then(async ok => {
          loaded = ok
          if (ok) {
            if (ctx.sessions?.list !== undefined) fold(ctx.sessions.list.getSnapshot())
            // Persist the effective-dated defaults once, so the settings page
            // edits stored values instead of describing implicit ones. Skipped
            // when the Host resolves the old shape: writing dates it does not
            // understand would persist rows it then strips.
            const models = Array.isArray(view?.value?.models) ? view.value.models : []
            const dated = models.some(model => model !== null && typeof model === 'object'
              && Object.prototype.hasOwnProperty.call(model, 'from'))
            const stored = view?.user !== null && typeof view?.user === 'object'
              && Array.isArray(view.user.models) && view.user.models.length > 0
            if (dated && !stored) {
              try {
                await write({
                  models,
                  currency: view.value.currency,
                  holidays: view.value.holidays,
                })
                await pull(false)
                ctx.logger?.info?.('cost meter: seeded the price table into settings')
              } catch (error) {
                ctx.logger?.warn?.(`cost meter: price table seeding failed: ${String(error)}`)
              }
            }
          }
          notify()
        })
        void probeBackfill()

        // ------------------------------------------------------------ the pill

        const selectById = state => state?.byId ?? EMPTY_OBJECT
        const selectItems = state => state?.items ?? EMPTY_ARRAY

        /** The amount one ledger row should be labelled with: money, or Credits. */
        function amountOf(row) {
          return row.credits > 0 && row.cost === 0
            ? formatCredits(row.credits)
            : formatMoney(row.cost, config === null ? '¥' : (SYMBOLS[config.currency] ?? `${config.currency} `))
        }

        function CostMeter(props) {
          const { sessionId, useSessions, useWorkspaces } = props
          const [, bump] = React.useReducer(count => count + 1, 0)
          React.useEffect(() => subscribe(bump), [])
          const byId = useSessions(selectById)
          const items = useWorkspaces(selectItems)
          const [open, setOpen] = React.useState(false)
          const [anchor, setAnchor] = React.useState(null)
          const rootRef = React.useRef(null)

          // Touch the version so a ledger change re-renders this subtree.
          void version

          const symbol = config === null ? '¥' : (SYMBOLS[config.currency] ?? `${config.currency} `)
          const entry = ledger.get(sessionId)
          // A row exists only once the conversation reported tokens.
          if (config === null || entry === undefined) return null

          const isPlan = entry.credits > 0 && entry.cost === 0
          const label = isPlan ? formatCredits(entry.credits) : formatMoney(entry.cost, symbol)
          const workspace = items.find(item => (item?.sessionIds ?? EMPTY_ARRAY).includes(sessionId))
          const memberIds = workspace?.sessionIds ?? EMPTY_ARRAY
          const members = memberIds
            .map(id => {
              const row = ledger.get(id)
              if (row === undefined) return null
              if (totalOf(row.charged) === 0 && row.cost === 0 && row.credits === 0) return null
              return {
                id,
                title: byId[id]?.displayTitle ?? byId[id]?.title ?? t('untitled'),
                cost: row.cost,
                credits: row.credits,
                amount: amountOf(row),
                unpriced: row.unpriced,
              }
            })
            .filter(Boolean)
            // Biggest spend first: the point of the list is where the money went.
            .sort((a, b) => b.cost - a.cost)
          const projectCost = members.reduce((sum, member) => sum + member.cost, 0)
          const projectCredits = members.reduce((sum, member) => sum + member.credits, 0)
          const unpricedTotal = members.reduce((sum, member) => sum + member.unpriced, 0)
          // Everything this browser tab has priced, not just this project.
          let grandCost = 0
          let grandCredits = 0
          let tracked = 0
          for (const row of ledger.values()) {
            grandCost += row.cost
            grandCredits += row.credits
            if (row.cost > 0 || row.credits > 0) tracked += 1
          }
          const outsideProject = tracked - members.filter(m => m.cost > 0 || m.credits > 0).length
          /** Money plus, when the routes also drew a subscription, its Credits. */
          const money = (cost, credits) => formatMoney(cost, symbol)
            + (credits > 0 ? ` + ${formatCredits(credits)}` : '')
          const anyPeak = config.models.some(model =>
            model.discount !== undefined && !isOffPeak(Date.now(), model.discount, config.holidays))

          const toggle = () => {
            const element = rootRef.current
            if (element && typeof element.getBoundingClientRect === 'function') {
              setAnchor(element.getBoundingClientRect())
            }
            setOpen(value => !value)
          }

          const baselineTokens = totalOf(entry.baseline) - totalOf(entry.charged)
          const panel = h('div', {
            role: 'dialog', 'aria-label': t('title'), style: {
              ...PANEL,
              ...(anchor === null ? {} : {
                left: Math.max(8, Math.min(anchor.left, window.innerWidth - 356)),
                bottom: window.innerHeight - anchor.top + 8,
              }),
            },
          },
            h('div', { style: { ...ROW, fontWeight: 600 } },
              h('span', null, isPlan ? `${t('title')} · ${t('subscription')}` : t('title')),
              h('span', null, label),
            ),
            h('div', { style: RULE }),
            h('div', { style: MUTED }, `${t('session')}${entry.model ? ` · ${entry.model}` : ''}`),
            ...BUCKETS.filter(key => entry.charged[key] > 0).map(key => h('div', { key },
              h('div', { style: ROW },
                h('span', { style: MUTED }, t(key)),
                h('span', null, `${formatExact(entry.charged[key])} tok`),
              ),
              !isPlan && h('div', { style: { ...ROW, ...FAINTED } },
                h('span', null, t('charged')),
                h('span', null, formatMoney(entry.byBucket[key], symbol)),
              ),
            )),
            baselineTokens > 0 && h('div', { style: { ...FAINTED, marginTop: 4 } },
              t('excludeBaseline', { tokens: formatExact(baselineTokens) })),
            entry.unpriced > 0 && h('div', { style: { ...FAINTED, ...WARN, marginTop: 4 } },
              t('unpriced', { count: formatExact(entry.unpriced) })),

            members.length > 0 && h(React.Fragment, null,
              h('div', { style: RULE }),
              h('div', { style: { ...ROW, fontWeight: 600 } },
                h('span', { style: MUTED }, `${t('project')}${workspace?.title ? ` ${workspace.title}` : ''}`
                  + ` · ${t('conversations', { count: members.length })}`),
                h('span', null, money(projectCost, projectCredits)),
              ),
              ...members.slice(0, TOP_ROWS).map(member => h('div', { key: member.id, style: ROW },
                h('span', {
                  title: member.title,
                  style: {
                    ...MUTED, maxWidth: 220, overflow: 'hidden',
                    textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  },
                }, `${member.id === sessionId ? '▸ ' : ''}${member.title}`),
                h('span', { style: member.unpriced > 0 ? WARN : undefined }, member.amount),
              )),
              members.length > TOP_ROWS && h('div', { style: { ...FAINTED, marginTop: 4 } },
                t('moreRows', {
                  shown: TOP_ROWS,
                  hidden: members.length - TOP_ROWS,
                  total: members.length,
                })),
              outsideProject > 0 && h('div', {
                style: { ...ROW, fontWeight: 600, marginTop: 6, paddingTop: 6, borderTop: `1px solid ${hairline}` },
              },
                h('span', { style: MUTED }, `${t('grandTotal')} · ${t('conversations', { count: tracked })}`
                  + (outsideProject > 0 ? `（${t('outsideProject', { count: outsideProject })}）` : '')),
                h('span', null, money(grandCost, grandCredits)),
              ),
              unpricedTotal > 0 && h('div', { style: { ...FAINTED, ...WARN, marginTop: 4 } },
                t('unpriced', { count: formatExact(unpricedTotal) })),
            ),

            h('div', { style: RULE }),
            h('div', { style: FAINTED },
              `${anyPeak ? t('peak') : t('offPeak')} · ${t('footnote')}`),
          )

          return h('span', {
            ref: rootRef,
            style: { display: 'inline-flex', position: 'relative' },
          },
            h('button', {
              type: 'button', style: PILL, onClick: toggle, title: `${t('title')} ${label}`,
              'aria-haspopup': 'dialog', 'aria-expanded': open, 'aria-label': `${t('title')} ${label}`,
            },
              h('span', { style: { fontWeight: 700, opacity: 0.85 } }, symbol.trim() || 'cr'),
              h('span', null, label.slice((symbol.trim() || 'cr').length)),
              entry.unpriced > 0 && h('span', { style: { ...WARN, fontSize: 10 } }, '•'),
            ),
            open && (ReactDOM?.createPortal !== undefined
              ? ReactDOM.createPortal(panel, document.body)
              : panel),
          )
        }

        // ------------------------------------------------------------- backfill

        /**
         * Whether the Host's backfill route answered.
         *
         * Probed once at startup because a route that failed to register is
         * otherwise indistinguishable from a working one until the user has
         * already waited on a click.
         */
        let backfillReady

        async function probeBackfill() {
          try {
            const response = await fetch('/api/cost/backfill', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ sessions: [] }),
            })
            backfillReady = response.ok
          } catch {
            backfillReady = false
          }
          notify()
        }

        /** Current cumulative totals for one session, straight from the live list. */
        function currentTotals(sessionId) {
          const usage = ctx.sessions?.list?.getSnapshot()?.byId?.[sessionId]
            ?.projectionValues?.tokenUsage
          return usage === undefined ? undefined : bucketsOf(usage)
        }

        /**
         * Price one session's logged samples at each request's own instant.
         *
         * `charged` counts only what a price row actually covered, so
         * `totalOf(charged) + unpriced` is exactly the log's own token total —
         * which is what makes the projection comparison below a real check.
         * @param samples - `{t, p, m, b}` frames from the Host.
         * @returns money, Credits, unpriced tokens, and the per-bucket split.
         */
        function priceSamples(samples) {
          let cost = 0
          let credits = 0
          let unpriced = 0
          const byBucket = zeroBuckets()
          const charged = zeroBuckets()
          const byDay = {}
          const models = new Set()
          for (const sample of samples) {
            const buckets = {
              cacheMiss: sample.b?.[0] ?? 0,
              cacheRead: sample.b?.[1] ?? 0,
              cacheWrite: sample.b?.[2] ?? 0,
              output: sample.b?.[3] ?? 0,
            }
            if (isZero(buckets)) continue
            const resolved = findModel(config.models, sample.p, sample.m, sample.t, config.holidays)
            if (resolved === undefined) {
              // Never invent a price: the tokens are recorded, the money is not.
              unpriced += totalOf(buckets)
              addToDay(byDay, sample.t, totalOf(buckets), 0, 0, zeroBuckets())
              continue
            }
            const priced = priceDelta(buckets, resolved)
            if (priced.tokenPlan) {
              credits += priced.total
              addToDay(byDay, sample.t, totalOf(buckets), 0, priced.total, zeroBuckets())
            } else {
              cost += priced.total
              addToDay(byDay, sample.t, totalOf(buckets), priced.total, 0, priced.rows)
            }
            for (const key of BUCKETS) {
              if (!priced.tokenPlan) byBucket[key] += priced.rows[key]
              charged[key] += buckets[key]
            }
            if (typeof sample.m === 'string' && sample.m.length > 0) models.add(sample.m)
          }
          return { cost, credits, unpriced, byBucket, charged, byDay, model: [...models].join(', ') }
        }

        /**
         * Replace one session's row with log-derived truth.
         *
         * The baseline moves to the session's totals as of the log's end, so
         * live accumulation continues from the backfilled figure instead of
         * re-charging history, and the dialog's "before install" note falls to
         * zero on its own.
         */
        function applyBackfill(sessionId, priced, totals) {
          ledger.set(sessionId, {
            baseline: totals ?? { ...zeroBuckets() },
            byBucket: priced.byBucket,
            charged: priced.charged,
            byDay: priced.byDay ?? {},
            cost: priced.cost,
            credits: priced.credits,
            unpriced: priced.unpriced,
            model: priced.model,
            updatedAt: Date.now(),
          })
          dirtyRows.add(sessionId)
        }

        /**
         * Ask the Host to read logs, then price every returned sample locally.
         *
         * Pricing stays on this side on purpose: the backfill and the live
         * accumulator then share one rate resolver, so the two can never drift.
         * The folded totals are compared against the `tokenUsage` projection
         * already in the session list, which turns the harness's own number
         * into a check on this engine rather than a second opinion.
         * @param sessions - session ids to evaluate.
         * @param onProgress - called after every frame with running totals.
         */
        async function runBackfill(sessions, onProgress) {
          const response = await fetch('/api/cost/backfill', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessions }),
          })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          if (response.body === null) throw new Error('backfill stream unavailable')

          const reader = response.body.getReader()
          const decoder = new TextDecoder()
          let total = sessions.length
          let done = 0
          let failed = 0
          let matched = 0
          let mismatched = 0
          let cost = 0
          let credits = 0
          let buffer = ''

          const handle = frame => {
            if (frame.type === 'start') {
              total = frame.total ?? total
            } else if (frame.type === 'progress' || frame.type === 'done') {
              done = frame.done ?? done
            } else if (frame.type === 'error') {
              failed += 1
              done += 1
            } else if (frame.type === 'session') {
              const priced = priceSamples(frame.samples ?? [])
              const totals = currentTotals(frame.sessionId)
              applyBackfill(frame.sessionId, priced, totals)
              cost += priced.cost
              credits += priced.credits
              done += 1
              if (totals !== undefined) {
                const folded = totalOf(priced.charged) + priced.unpriced
                if (folded === totalOf(totals)) matched += 1
                else mismatched += 1
              }
            }
            onProgress?.({ done, total, failed, matched, mismatched, cost, credits })
          }

          for (;;) {
            const chunk = await reader.read()
            if (chunk.done === true) break
            buffer += decoder.decode(chunk.value, { stream: true })
            const lines = buffer.split('\n')
            buffer = lines.pop() ?? ''
            for (const line of lines) {
              if (line.length === 0) continue
              try {
                handle(JSON.parse(line))
              } catch {
                // A malformed frame must not discard the sessions around it.
              }
            }
          }

          notify()
          schedule()
          return { done, total, failed, matched, mismatched, cost, credits }
        }

        // --------------------------------------------------------- settings page

        /** Clone the resolved config into an editable draft of plain JSON. */
        function draftFrom(value) {
          const models = Array.isArray(value?.models) ? value.models : []
          const holidays = Array.isArray(value?.holidays) ? value.holidays : []
          return {
            currency: typeof value?.currency === 'string' ? value.currency : 'CNY',
            flushMs: Number.isFinite(value?.flushMs) ? value.flushMs : 4000,
            models: models.map(model => ({
              match: model.match ?? '',
              from: model.from ?? '',
              to: model.to ?? '',
              currency: model.currency ?? 'CNY',
              cacheHit: model.rates?.cacheHit ?? 0,
              cacheMiss: model.rates?.cacheMiss ?? 0,
              cacheWrite: model.rates?.cacheWrite ?? 0,
              output: model.rates?.output ?? 0,
              offPeakRatio: model.discount === undefined ? '' : (model.discount.offPeakRatio ?? 0.5),
              tokenPlan: model.tokenPlan === true,
            })),
            holidays,
          }
        }

        const numberOrZero = text => {
          const value = Number.parseFloat(text)
          return Number.isFinite(value) ? value : 0
        }

        function CostSettings(props) {
          const { useSessions, useWorkspaces } = props
          const [, bump] = React.useReducer(count => count + 1, 0)
          React.useEffect(() => subscribe(bump), [])
          // Both are declared standard props; the identity fallback keeps hook
          // order stable should a shell ever stop providing one.
          const identity = () => EMPTY_OBJECT
          const useSessionSel = typeof useSessions === 'function' ? useSessions : identity
          const useWorkspaceSel = typeof useWorkspaces === 'function' ? useWorkspaces : identity
          const byId = useSessionSel(selectById)
          const items = useWorkspaceSel(selectItems)
          const [draft, setDraft] = React.useState(null)
          const [status, setStatus] = React.useState('')
          const [busy, setBusy] = React.useState(false)
          const [scope, setScope] = React.useState('all')
          const [projectCwd, setProjectCwd] = React.useState('')
          const [picked, setPicked] = React.useState(EMPTY_OBJECT)
          const [pickQuery, setPickQuery] = React.useState('')
          const [progress, setProgress] = React.useState(null)
          const [note, setNote] = React.useState('')

          // Grouping is computed inline below rather than memoized: `byId` has
          // been observed to keep one object identity while its contents grow,
          // so a memo keyed on that reference goes stale while an inline read
          // sees the new rows. 89 entries cost nothing to regroup per render.

          void version
          React.useEffect(() => {
            if (draft === null && view !== null) setDraft(draftFrom(view.value))
          })
          if (config === null || draft === null) {
            return h('div', { style: MUTED }, '…')
          }

          const allIds = Object.keys(byId)
          // Membership comes from the workspace registry — the same account the
          // composer dialog and the report use — so "this project" cannot mean
          // two different sets of conversations on two different surfaces.
          // (`projectCwd` keeps its name from when this grouped by directory;
          // it now holds a workspace id.)
          const projects = items
            .map(item => ({
              workspaceId: item?.workspaceId ?? '',
              label: item?.title ?? t('reportNoProject'),
              ids: (item?.sessionIds ?? EMPTY_ARRAY).filter(id => byId[id] !== undefined),
            }))
            .filter(group => group.ids.length > 0)
            .sort((a, b) => b.ids.length - a.ids.length)
          const selectedProject = projects.find(group => group.workspaceId === projectCwd)
          const pickedIds = Object.keys(picked).filter(id => picked[id] === true)
          // The picker renders a bounded, searchable slice: at a few thousand
          // conversations an unbounded checkbox list is both slow and unusable.
          const pickLabel = id => byId[id]?.displayTitle ?? byId[id]?.title ?? id
          const pickNeedle = pickQuery.trim().toLowerCase()
          const pickMatches = pickNeedle.length === 0 ? allIds : allIds.filter(id =>
            pickLabel(id).toLowerCase().includes(pickNeedle) || id.includes(pickNeedle))
          const pickShown = pickMatches.slice(0, PICK_ROWS)
          const targets = scope === 'all'
            ? allIds
            : scope === 'project'
              ? (selectedProject?.ids ?? EMPTY_ARRAY)
              : pickedIds
          const symbol = SYMBOLS[config.currency] ?? `${config.currency} `

          const startBackfill = async () => {
            if (targets.length === 0) {
              setNote(t('backfillNoTarget'))
              return
            }
            setBusy(true)
            setNote('')
            setProgress({ done: 0, total: targets.length, failed: 0, matched: 0, mismatched: 0, cost: 0, credits: 0 })
            try {
              setProgress(await runBackfill(targets, setProgress))
            } catch (error) {
              setNote(t('backfillError', { reason: String(error).slice(0, 140) }))
            } finally {
              setBusy(false)
            }
          }

          const scopeOption = (value, label) => h('label', {
            key: value, style: { ...MUTED, display: 'inline-flex', alignItems: 'center', gap: 5 },
          },
            h('input', {
              type: 'radio', name: 'cost-backfill-scope', checked: scope === value,
              onChange: () => setScope(value),
            }),
            label,
          )

          const patchRow = (index, key, value) => {
            setDraft(current => {
              const models = current.models.slice()
              models[index] = { ...models[index], [key]: value }
              return { ...current, models }
            })
            setStatus('')
          }
          const cell = (index, key) => h('input', {
            style: INPUT, value: String(draft.models[index][key] ?? ''),
            onChange: event => patchRow(index, key, event.target.value),
          })
          const numCell = (index, key) => h('input', {
            style: { ...INPUT, textAlign: 'right' }, inputMode: 'decimal',
            value: String(draft.models[index][key] ?? ''),
            onChange: event => patchRow(index, key, numberOrZero(event.target.value)),
          })

          const save = async () => {
            setBusy(true)
            setStatus('')
            try {
              const models = draft.models
                .filter(row => String(row.match).trim().length > 0)
                .map(row => ({
                  match: String(row.match).trim(),
                  currency: row.currency || 'CNY',
                  from: String(row.from).trim() || null,
                  to: String(row.to).trim() || null,
                  rates: {
                    cacheHit: row.cacheHit, cacheMiss: row.cacheMiss,
                    cacheWrite: row.cacheWrite, output: row.output,
                  },
                  ...(row.offPeakRatio === '' || row.offPeakRatio === null
                    ? {}
                    : {
                      discount: {
                        offPeakRatio: row.offPeakRatio,
                        peakHours: [[9, 12], [14, 18]],
                        weekdaysOnly: true,
                      },
                    }),
                  tokenPlan: row.tokenPlan === true,
                }))
              if (models.length === 0) {
                setStatus(t('failed', { reason: 'no rows' }))
                return
              }
              await write({ models, currency: draft.currency, flushMs: draft.flushMs })
              await pull(false)
              setDraft(null)
              setStatus(t('saved'))
              notify()
            } catch (error) {
              setStatus(t('failed', { reason: String(error).slice(0, 120) }))
            } finally {
              setBusy(false)
            }
          }

          return h('div', null,
            h('h3', { style: SECTION_TITLE }, t('settingsTitle')),
            h('div', { style: { ...MUTED, marginBottom: 12, maxWidth: 720 } }, t('settingsIntro')),

            h('div', { style: GROUP },
              h('div', { style: { overflowX: 'auto' } },
                h('table', { style: { width: TABLE_WIDTH, tableLayout: 'fixed', borderCollapse: 'collapse' } },
                  h('colgroup', null, ...WIDTHS.map((width, at) => h('col', { key: String(at), style: { width } }))),
                  h('thead', null, h('tr', null,
                    ...COLUMNS.map(key => h('th', { key, style: TH }, t(`col${key[0].toUpperCase()}${key.slice(1)}`))),
                    h('th', { style: { ...TH, textAlign: 'center' } }, t('colPlan')),
                    h('th', { style: TH }, ''),
                  )),
                  h('tbody', null, ...draft.models.map((row, index) => h('tr', { key: String(index) },
                    h('td', { style: TD }, cell(index, 'match')),
                    h('td', { style: TD }, cell(index, 'from')),
                    h('td', { style: TD }, cell(index, 'to')),
                    h('td', { style: TD }, numCell(index, 'cacheHit')),
                    h('td', { style: TD }, numCell(index, 'cacheMiss')),
                    h('td', { style: TD }, numCell(index, 'cacheWrite')),
                    h('td', { style: TD }, numCell(index, 'output')),
                    h('td', { style: TD }, cell(index, 'currency')),
                    h('td', { style: { ...TD, textAlign: 'center' } }, h('input', {
                      type: 'checkbox', checked: row.tokenPlan === true,
                      onChange: event => patchRow(index, 'tokenPlan', event.target.checked),
                    })),
                    h('td', { style: { ...TD, textAlign: 'center' } }, h('button', {
                      type: 'button', title: t('remove'), 'aria-label': t('remove'),
                      style: {
                        width: 22, height: 22, padding: 0, lineHeight: 1,
                        border: `1px solid ${hairline}`, borderRadius: 6,
                        background: 'transparent', color: SOFT,
                        font: 'inherit', fontSize: 14, cursor: 'pointer',
                      },
                      onClick: () => {
                        setDraft(current => ({
                          ...current,
                          models: current.models.filter((_, at) => at !== index),
                        }))
                        setStatus('')
                      },
                    }, '\u00d7')),
                  ))),
                ),
              ),
              h('div', { style: { ...FAINTED, marginTop: 8 } }, t('planHint')),
              h('button', {
                type: 'button',
                style: { ...BUTTON, marginTop: 10 },
                onClick: () => {
                  setDraft(current => ({
                    ...current,
                    models: [...current.models, {
                      match: '', from: '', to: '', currency: current.currency,
                      cacheHit: 0, cacheMiss: 0, cacheWrite: 0, output: 0,
                      offPeakRatio: '', tokenPlan: false,
                    }],
                  }))
                  setStatus('')
                },
              }, t('addRow')),
            ),

            h('div', { style: GROUP },
              h('div', { style: { fontWeight: 600, marginBottom: 8 } }, t('globalTitle')),
              h('div', { style: { display: 'flex', gap: 20, flexWrap: 'wrap' } },
                h('label', { style: MUTED }, `${t('currency')}`,
                  h('input', {
                    style: { ...INPUT, width: 90, marginLeft: 8 },
                    value: draft.currency,
                    onChange: event => { setDraft({ ...draft, currency: event.target.value }); setStatus('') },
                  })),
                h('label', { style: MUTED }, `${t('flushMs')}`,
                  h('input', {
                    style: { ...INPUT, width: 90, marginLeft: 8 }, inputMode: 'numeric',
                    value: String(draft.flushMs),
                    onChange: event => {
                      setDraft({ ...draft, flushMs: numberOrZero(event.target.value) })
                      setStatus('')
                    },
                  })),
              ),
              h('div', { style: { ...MUTED, marginTop: 10 } },
                `${t('holidays')} · ${t('holidaysNote', { count: draft.holidays.length })}`),
            ),

            h('div', { style: GROUP },
              h('div', { style: { fontWeight: 600, marginBottom: 6 } }, t('backfillTitle')),
              h('div', { style: { ...MUTED, marginBottom: 10, maxWidth: 720 } }, t('backfillIntro')),
              h('div', { style: { ...FAINTED, marginBottom: 10, ...(backfillReady === false ? WARN : {}) } },
                backfillReady === undefined
                  ? '…'
                  : (backfillReady ? t('backfillReady') : t('backfillUnavailable'))),

              h('div', { style: { display: 'flex', gap: 18, flexWrap: 'wrap', marginBottom: 10 } },
                scopeOption('all', t('scopeAll', { count: allIds.length })),
                scopeOption('project', t('scopeProjectCount', { count: projects.length })),
                scopeOption('picked', t('scopePicked', { count: pickedIds.length })),
              ),

              scope === 'project' && h('select', {
                style: { ...SELECT, width: 380, marginBottom: 8 },
                value: projectCwd,
                onChange: event => setProjectCwd(event.target.value),
              },
                h('option', { value: '', style: OPTION }, t('backfillPick')),
                ...projects.map(group => h('option', {
                  key: group.workspaceId || 'none', value: group.workspaceId, style: OPTION,
                }, `${group.label} · ${group.ids.length}`)),
              ),

              scope === 'picked' && h('div', { style: { marginBottom: 8 } },
                h('input', {
                  style: { ...INPUT, width: 380, marginBottom: 6 },
                  placeholder: t('pickSearch'),
                  value: pickQuery,
                  onChange: event => setPickQuery(event.target.value),
                }),
                h('div', {
                  style: {
                    maxHeight: 220, overflowY: 'auto', padding: 8,
                    border: `1px solid ${hairline}`, borderRadius: 8,
                  },
                }, ...pickShown.map(id => h('label', {
                  key: id, style: { ...MUTED, display: 'block', lineHeight: 1.8 },
                },
                  h('input', {
                    type: 'checkbox', checked: picked[id] === true,
                    onChange: event => setPicked(current => ({ ...current, [id]: event.target.checked })),
                  }),
                  ` ${byId[id]?.displayTitle ?? byId[id]?.title ?? id}`,
                ))),
                h('div', { style: { ...FAINTED, marginTop: 4 } },
                  pickMatches.length > PICK_ROWS
                    ? t('pickLimited', { shown: PICK_ROWS, total: pickMatches.length })
                    : t('pickMatched', { count: pickMatches.length })),
              ),

              h('div', { style: { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' } },
                h('button', {
                  type: 'button', style: BUTTON, disabled: busy,
                  onClick: () => { void startBackfill() },
                }, busy ? t('backfillRunning') : t('backfillRun', { count: targets.length })),
                // Kept enabled with nothing selected so the click explains
                // itself, instead of a dead button that says nothing.
                note.length > 0 && h('span', { style: { ...MUTED, ...WARN } }, note),
                progress !== null && h('span', { style: MUTED },
                  t('backfillProgress', { done: progress.done, total: progress.total })),
                progress !== null && h('span', { style: FAINTED },
                  `${t('backfillSum')} ${formatMoney(progress.cost, symbol)}`
                  + (progress.credits > 0 ? ` + ${formatCredits(progress.credits)}` : '')
                  + (progress.failed > 0 ? t('backfillFailed', { count: progress.failed }) : '')
                  + (progress.mismatched > 0 ? t('backfillMismatch', { count: progress.mismatched }) : '')),
              ),
            ),

            h('div', { style: { display: 'flex', alignItems: 'center', gap: 12 } },
              h('button', {
                type: 'button', style: BUTTON, disabled: busy, onClick: () => { void save() },
              }, busy ? t('saving') : t('save')),
              status.length > 0 && h('span', { style: MUTED }, status),
              status.length === 0 && view !== null && h('span', { style: FAINTED },
                `${t('unsaved')} · rev ${revision}`),
            ),
          )
        }

        // ------------------------------------------------------------ the report

        /** Palette for the charts. Mid-saturation so it reads on light and dark. */
        const SERIES = ['#5b8def', '#4ea87a', '#d29343', '#c65f6b', '#8e7cc3', '#4aa8b0', '#9aa0a6']
        /** Slices beyond this are folded into one "other" wedge. */
        const PIE_SLICES = 6
        /** Conversations per detail page. */
        const REPORT_PAGE = 15
        /** Side-by-side chart groups only pair up when the column is wide enough. */
        const REPORT_COLUMN = '1 1 400px'

        /** One horizontal bar: a filled div, so no chart library is needed. */
        function Bar({ label, value, max, color, text, share }) {
          const width = max > 0 ? Math.max(value / max * 100, value > 0 ? 0.5 : 0) : 0
          return h('div', { style: { marginBottom: 7 } },
            h('div', { style: { ...ROW, ...MUTED, marginBottom: 2 } },
              h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, label),
              // The figure is what the reader came for; emphasis belongs here,
              // never on a footnote about missing data.
              h('span', { style: { fontWeight: 600, color: 'inherit' } },
                `${text}${share === undefined ? '' : ` · ${share}`}`),
            ),
            h('div', {
              style: {
                height: 8, borderRadius: 4, overflow: 'hidden',
                background: 'color-mix(in srgb, currentColor 10%, transparent)',
              },
            }, h('div', { style: { width: `${width}%`, height: '100%', background: color } })),
          )
        }

        /**
         * SVG pie.
         *
         * A single 100% slice cannot be expressed as an arc (start and end
         * coincide), so that case draws a circle instead of a degenerate path.
         */
        function Pie({ slices }) {
          const total = slices.reduce((sum, slice) => sum + slice.value, 0)
          if (!(total > 0)) return null
          if (slices.length === 1) {
            return h('svg', { viewBox: '0 0 100 100', width: 150, height: 150 },
              h('circle', { cx: 50, cy: 50, r: 42, fill: slices[0].color }))
          }
          let angle = -Math.PI / 2
          const paths = []
          for (const [index, slice] of slices.entries()) {
            const sweep = slice.value / total * Math.PI * 2
            const from = angle
            angle += sweep
            const x1 = 50 + 42 * Math.cos(from)
            const y1 = 50 + 42 * Math.sin(from)
            const x2 = 50 + 42 * Math.cos(angle)
            const y2 = 50 + 42 * Math.sin(angle)
            paths.push(h('path', {
              key: String(index),
              d: `M50,50 L${x1.toFixed(3)},${y1.toFixed(3)} A42,42 0 ${sweep > Math.PI ? 1 : 0} 1 ${x2.toFixed(3)},${y2.toFixed(3)} Z`,
              fill: slice.color,
            }))
          }
          return h('svg', { viewBox: '0 0 100 100', width: 150, height: 150 }, ...paths)
        }

        /** Fold a list into at most `limit` named totals plus one remainder row. */
        function topWithOther(rows, limit) {
          const sorted = [...rows].sort((a, b) => b.value - a.value)
          if (sorted.length <= limit) return sorted
          const head = sorted.slice(0, limit)
          const rest = sorted.slice(limit).reduce((sum, row) => sum + row.value, 0)
          return [...head, { label: t('reportOther'), value: rest }]
        }

        function CostReport(props) {
          const { useSessions, useWorkspaces } = props
          const [, bump] = React.useReducer(count => count + 1, 0)
          React.useEffect(() => subscribe(bump), [])
          const identity = () => EMPTY_OBJECT
          const useSessionSel = typeof useSessions === 'function' ? useSessions : identity
          const useWorkspaceSel = typeof useWorkspaces === 'function' ? useWorkspaces : identity
          const byId = useSessionSel(selectById)
          const items = useWorkspaceSel(selectItems)
          const [scope, setScope] = React.useState('')
          const [page, setPage] = React.useState(0)
          void version
          if (config === null) return h('div', { style: MUTED }, '…')

          const symbol = SYMBOLS[config.currency] ?? `${config.currency} `
          const money = value => formatMoney(value, symbol)
          const labelOf = id => byId[id]?.displayTitle ?? byId[id]?.title ?? id

          // Project membership comes from the workspace registry's own
          // `sessionIds`, the same account the composer dialog and the sidebar
          // use. Grouping by `cwd` instead looks equivalent and is not: every
          // session that ever ran in a directory shares it, so archived
          // sessions and sessions owned elsewhere got folded in and the two
          // surfaces disagreed about the same project.
          const ownerOf = new Map()
          for (const item of items) {
            for (const id of item?.sessionIds ?? EMPTY_ARRAY) ownerOf.set(id, item)
          }
          const projectLabel = workspaceId => {
            const item = items.find(candidate => candidate?.workspaceId === workspaceId)
            return item?.title ?? t('reportNoProject')
          }

          // Only conversations that actually carry a figure; a baselined row
          // that never ran is noise in every chart.
          const all = []
          for (const [id, row] of ledger) {
            if (row.cost === 0 && row.credits === 0 && totalOf(row.charged) === 0) continue
            all.push({
              id,
              workspaceId: ownerOf.get(id)?.workspaceId ?? '',
              title: labelOf(id),
              cost: row.cost,
              credits: row.credits,
              tokens: totalOf(row.charged),
              byBucket: row.byBucket,
              models: typeof row.model === 'string' && row.model.length > 0
                ? row.model.split(', ')
                : [],
            })
          }
          const rows = scope === '' ? all : all.filter(row => row.workspaceId === scope)

          const sumBy = (list, pick) => list.reduce((sum, row) => sum + pick(row), 0)
          const totalCost = sumBy(rows, row => row.cost)
          const totalCredits = sumBy(rows, row => row.credits)
          const totalTokens = sumBy(rows, row => row.tokens)

          const byProject = new Map()
          for (const row of rows) {
            const group = byProject.get(row.workspaceId)
              ?? { workspaceId: row.workspaceId, value: 0, tokens: 0, count: 0 }
            group.value += row.cost
            group.tokens += row.tokens
            group.count += 1
            byProject.set(row.workspaceId, group)
          }
          const projects = [...byProject.values()].sort((a, b) => b.value - a.value)
          // Scoped to one project, a project-share pie is a single 100% circle
          // and says nothing; the useful split at that point is which of ITS
          // conversations the money went to.
          const pieByProject = scope === ''
          const pieSlices = topWithOther(
            pieByProject
              ? projects.map(group => ({ label: projectLabel(group.workspaceId), value: group.value }))
              : rows.map(row => ({ label: row.title, value: row.cost })),
            PIE_SLICES,
          ).map((slice, index) => ({ ...slice, color: SERIES[index % SERIES.length] }))

          const buckets = BUCKETS.map((key, index) => ({
            key,
            value: sumBy(rows, row => row.byBucket[key] ?? 0),
            color: SERIES[index % SERIES.length],
          }))
          const bucketMax = Math.max(0, ...buckets.map(entry => entry.value))

          const byModel = new Map()
          for (const row of rows) {
            const name = row.models.length === 1
              ? row.models[0]
              : (row.models.length === 0 ? t('reportNoModel') : t('reportMultiModel'))
            byModel.set(name, (byModel.get(name) ?? 0) + row.cost)
          }
          const models = [...byModel.entries()]
            .map(([label, value]) => ({ label, value }))
            .sort((a, b) => b.value - a.value)
          const modelMax = Math.max(0, ...models.map(entry => entry.value))

          const ranked = [...rows].sort((a, b) => b.cost - a.cost)
          const pageCount = Math.max(1, Math.ceil(ranked.length / REPORT_PAGE))
          const current = Math.min(page, pageCount - 1)
          const pageRows = ranked.slice(current * REPORT_PAGE, (current + 1) * REPORT_PAGE)

          const share = value => (totalCost > 0 ? `${(value / totalCost * 100).toFixed(1)}%` : '—')
          const stat = (value, label) => h('div', { key: label, style: { minWidth: 110 } },
            h('div', { style: { fontSize: 18, fontWeight: 600 } }, value),
            h('div', { style: FAINTED }, label),
          )
          const cell = (content, extra) => h('td', {
            style: { ...TD, ...(extra ?? {}), borderBottom: `1px solid ${hairline}` },
          }, content)

          const body = h(React.Fragment, null,
            all.length === 0 && h('div', { style: { ...MUTED, ...WARN } }, t('reportEmpty')),

            all.length > 0 && h(React.Fragment, null,
              h('div', { style: { ...MUTED, marginBottom: 10, display: 'flex', alignItems: 'center', gap: 8 } },
                t('reportScope'),
                h('select', {
                  style: { ...SELECT, width: 300 },
                  value: scope,
                  onChange: event => { setScope(event.target.value); setPage(0) },
                },
                  h('option', { value: '', style: OPTION }, `${t('reportAllProjects')}（${all.length}）`),
                  ...projects.map(group => h('option', {
                    key: group.workspaceId || 'none', value: group.workspaceId, style: OPTION,
                  }, `${projectLabel(group.workspaceId)} · ${group.count}`)),
                ),
              ),

              h('div', { style: GROUP },
                h('div', { style: { display: 'flex', gap: 28, flexWrap: 'wrap' } },
                  stat(money(totalCost) + (totalCredits > 0 ? ` + ${formatCredits(totalCredits)}` : ''), t('reportTotalCost')),
                  stat(formatTokens(totalTokens), t('reportTotalTokens')),
                  stat(String(projects.length), t('reportProjects')),
                  stat(String(rows.length), t('reportConversations')),
                ),
              ),

              h('div', { style: GROUP },
                h('div', { style: { fontWeight: 600, marginBottom: 10 } }, t('reportByBucket')),
                ...buckets.filter(entry => entry.value > 0 || entry.key !== 'cacheWrite').map(entry =>
                  h(Bar, {
                    key: entry.key,
                    label: t(entry.key),
                    value: entry.value,
                    max: bucketMax,
                    color: entry.color,
                    text: money(entry.value),
                    share: share(entry.value),
                  })),
              ),

              h('div', { style: { display: 'flex', gap: 14, flexWrap: 'wrap' } },
                h('div', { style: { ...GROUP, flex: REPORT_COLUMN } },
                  h('div', { style: { fontWeight: 600, marginBottom: 10 } },
                    pieByProject ? t('reportByProject') : t('reportByConversation')),
                  h('div', { style: { display: 'flex', gap: 18, alignItems: 'center', flexWrap: 'wrap' } },
                    h(Pie, { slices: pieSlices }),
                    h('div', { style: { flex: '1 1 150px' } },
                      ...pieSlices.map((slice, index) => h('div', {
                        key: String(index), style: { ...ROW, ...MUTED, marginBottom: 4 },
                      },
                        h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 } },
                          h('span', {
                            style: {
                              width: 9, height: 9, borderRadius: 2, background: slice.color,
                              display: 'inline-block', flex: '0 0 auto',
                            },
                          }),
                          h('span', {
                            style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                          }, slice.label),
                        ),
                        h('span', { style: { flex: '0 0 auto' } }, `${money(slice.value)} ${share(slice.value)}`),
                      )),
                    ),
                  ),
                ),

                h('div', { style: { ...GROUP, flex: REPORT_COLUMN } },
                  h('div', { style: { fontWeight: 600, marginBottom: 10 } }, t('reportByModel')),
                  models.length === 0 && h('div', { style: FAINTED }, '—'),
                  ...models.slice(0, 8).map((entry, index) => h(Bar, {
                    key: entry.label,
                    label: entry.label,
                    value: entry.value,
                    max: modelMax,
                    color: SERIES[index % SERIES.length],
                    text: money(entry.value),
                    share: share(entry.value),
                  })),
                ),
              ),

              h('div', { style: GROUP },
                h('div', { style: { fontWeight: 600, marginBottom: 10 } },
                  `${t('reportTop')} · ${t('reportCount', { count: ranked.length })}`),
                h('div', { style: { overflowX: 'auto' } },
                  h('table', { style: { width: '100%', minWidth: 520, tableLayout: 'fixed', borderCollapse: 'collapse' } },
                    h('colgroup', null,
                      h('col', { style: { width: '34%' } }),
                      h('col', { style: { width: '20%' } }),
                      h('col', { style: { width: '18%' } }),
                      h('col', { style: { width: '14%' } }),
                      h('col', { style: { width: '14%' } }),
                    ),
                    h('thead', null, h('tr', null,
                      h('th', { style: TH }, t('colConversation')),
                      h('th', { style: TH }, t('colProject')),
                      h('th', { style: TH }, t('colModel')),
                      h('th', { style: { ...TH, textAlign: 'right' } }, t('colTokens')),
                      h('th', { style: { ...TH, textAlign: 'right' } }, t('colCost')),
                    )),
                    h('tbody', null, ...pageRows.map(row => h('tr', { key: row.id },
                      cell(h('span', {
                        title: row.title,
                        style: { display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                      }, row.title)),
                      cell(projectLabel(row.workspaceId), FAINTED),
                      cell(row.models.length === 1 ? row.models[0] : t('reportMultiModel'), FAINTED),
                      cell(formatTokens(row.tokens), { ...FAINTED, textAlign: 'right' }),
                      cell(money(row.cost), { textAlign: 'right' }),
                    ))),
                  ),
                ),
                h('div', { style: { ...MUTED, display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 } },
                  h('button', {
                    type: 'button', style: BUTTON, disabled: current === 0,
                    onClick: () => setPage(Math.max(0, current - 1)),
                  }, t('reportPrev')),
                  h('span', null, t('reportPage', { page: current + 1, pages: pageCount, total: ranked.length })),
                  h('button', {
                    type: 'button', style: BUTTON, disabled: current >= pageCount - 1,
                    onClick: () => setPage(Math.min(pageCount - 1, current + 1)),
                  }, t('reportNext')),
                ),
              ),
            ),
          )

          // This is a main panel now, so it already owns the full column; the
          // former settings-section fullscreen escape hatch is gone with it.
          return h('div', { style: { padding: '18px 24px 40px', maxWidth: 1180, margin: '0 auto' } },
            h('h3', { style: { ...SECTION_TITLE, margin: '0 0 4px' } }, t('reportTitle')),
            h('div', { style: { ...MUTED, marginBottom: 14, maxWidth: 720 } }, t('reportIntro')),
            body,
          )
        }

        // ----------------------------------------------------------- dashboard

        /** Duration in the compact form DASHBOARD.md §7.1 specifies. */
        function formatDuration(ms) {
          const seconds = Math.round(ms / 1000)
          if (seconds < 60) return `${seconds}秒`
          const minutes = Math.floor(seconds / 60)
          if (minutes < 60) return `${minutes}分${seconds % 60}秒`
          return `${Math.floor(minutes / 60)}小时${minutes % 60}分`
        }

        /** Weeks the activity grid always spans — a year, like a contribution graph. */
    const HEAT_WEEKS = 53

    /** Five-step ramp for one heatmap scale; step 0 is the empty cell. */
        const HEAT = [
          'color-mix(in srgb, currentColor 9%, transparent)',
          '#1f4a7a', '#2f6fb0', '#4a94d8', '#7fbcf0',
        ]

        /** Bucket one value into the ramp. */
        function levelOf(value, max) {
          if (!(value > 0)) return 0
          if (!(max > 0)) return 1
          const ratio = value / max
          if (ratio > 0.75) return 4
          if (ratio > 0.5) return 3
          if (ratio > 0.25) return 2
          return 1
        }

        /** Every Beijing calendar day from `from` to `to`, inclusive. */
        function daysBetween(from, to) {
          const out = []
          for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86400000) {
            out.push(new Date(t).toISOString().slice(0, 10))
          }
          return out
        }

        /**
         * Activity heatmap.
         *
         * The grid spans only the days the ledger actually covers — drawing a
         * fixed year would leave most of it blank and read as breakage rather
         * than as a short history.
         * @param props - `{ days, values, size, format, detailOf, onHover }`.
         */
        function ActivityHeatmap({ days, values, size, format, detailOf, onHover }) {
          const CELL = 12
          const GAP = 3
          const STEP = CELL + GAP
          if (days.length === 0) return null
          const first = days[0]
          const firstWeekday = new Date(`${first}T00:00:00Z`).getUTCDay()
          const columns = Math.ceil((days.length + firstWeekday) / 7)
          const width = columns * STEP
          const height = 7 * STEP
          const cells = []
          const months = []
          let lastMonth = ''
          let lastLabelColumn = -1

          for (const [index, day] of days.entries()) {
            const slot = index + firstWeekday
            const column = Math.floor(slot / 7)
            const row = slot % 7
            const level = levelOf(values[day] ?? 0, size)
            cells.push(h('rect', {
              key: day,
              x: column * STEP,
              y: row * STEP,
              width: CELL,
              height: CELL,
              rx: 2.5,
              fill: HEAT[level],
            }))
            const month = day.slice(0, 7)
            if (month !== lastMonth) {
              lastMonth = month
              // A month can begin in the column its predecessor already labels
              // (a grid starting mid-week), and two labels at one x render as
              // stacked text. Skip the collision instead of drawing it.
              if (column > lastLabelColumn) {
                lastLabelColumn = column
                months.push({ column, label: `${Number(month.slice(5, 7))}月` })
              }
            }
          }

          return h('div', { style: { position: 'relative' } },
            h('div', { style: { display: 'flex', gap: 8, alignItems: 'flex-start' } },
              h('div', {
                style: { ...FAINTED, width: 26, textAlign: 'right', lineHeight: `${STEP}px`, paddingTop: 1 },
              }, '一', h('div', null, '三'), h('div', null, '五')),
              h('svg', {
                viewBox: `0 0 ${width} ${height}`,
                width,
                height,
                role: 'img',
                'aria-label': format(values),
                onMouseLeave: () => onHover(null),
              },
                ...cells.map(cell => h('rect', {
                  ...cell.props,
                  onMouseEnter: event => onHover({
                    day: cell.key,
                    value: values[cell.key] ?? 0,
                    detail: detailOf === undefined ? undefined : detailOf(cell.key),
                    x: event.currentTarget.getBoundingClientRect().left,
                    y: event.currentTarget.getBoundingClientRect().top,
                  }),
                })),
              ),
            ),
            h('div', { style: { ...FAINTED, position: 'relative', height: 14, marginLeft: 34, width } },
              ...months.map(entry => h('span', {
                key: `${entry.label}-${String(entry.column)}`,
                // nowrap: without it a label near the right edge wraps to two
                // lines and reads as broken text rather than a month.
                style: { position: 'absolute', left: entry.column * STEP, whiteSpace: 'nowrap' },
              }, entry.label)),
            ),
          )
        }

        /** Sidebar icon for the dashboard panel. */
        function CostIcon({ size, active }) {
          return h('svg', {
            viewBox: '0 0 24 24', width: size, height: size,
            'aria-hidden': true, style: { display: 'block', opacity: active ? 1 : 0.75 },
          },
            h('circle', {
              cx: 12, cy: 12, r: 8.5, fill: 'none',
              stroke: 'currentColor', strokeWidth: 1.6,
            }),
            h('path', {
              d: 'M12 7.2v9.6M9.6 9.6h3.4a1.9 1.9 0 0 1 0 3.8H9.6m0 0h4',
              fill: 'none', stroke: 'currentColor', strokeWidth: 1.6,
              strokeLinecap: 'round', strokeLinejoin: 'round',
            }),
          )
        }

        /**
         * Sidebar icon for the per-project panel.
         *
         * Deliberately a different glyph from the account one: two adjacent rows
         * in the same list must be told apart at 16px, where a shared coin shape
         * would read as the same button twice.
         */
        function ReportIcon({ size, active }) {
          return h('svg', {
            viewBox: '0 0 24 24', width: size, height: size,
            'aria-hidden': true, style: { display: 'block', opacity: active ? 1 : 0.75 },
          },
            h('rect', {
              x: 4, y: 4, width: 16, height: 16, rx: 3, fill: 'none',
              stroke: 'currentColor', strokeWidth: 1.6,
            }),
            h('path', {
              d: 'M8 15.5v-3M12 15.5v-7M16 15.5v-4.5',
              fill: 'none', stroke: 'currentColor', strokeWidth: 1.7,
              strokeLinecap: 'round',
            }),
          )
        }

        /** The dashboard page. */
        function CostDashboard(props) {
          const { useSessions, useWorkspaces } = props
          const [, bump] = React.useReducer(count => count + 1, 0)
          React.useEffect(() => subscribe(bump), [])
          const identity = () => EMPTY_OBJECT
          const useSessionSel = typeof useSessions === 'function' ? useSessions : identity
          const useWorkspaceSel = typeof useWorkspaces === 'function' ? useWorkspaces : identity
          const byId = useSessionSel(selectById)
          const items = useWorkspaceSel(selectItems)
          const [scope, setScope] = React.useState('')
          const [range, setRange] = React.useState('all')
          const [mode, setMode] = React.useState('day')
          const [metric, setMetric] = React.useState('token')
          const [page, setPage] = React.useState(0)
          const [hover, setHover] = React.useState(null)

          void version
          if (config === null) return h('div', { style: { padding: 24, ...MUTED } }, '…')

          const symbol = SYMBOLS[config.currency] ?? `${config.currency} `
          const money = value => formatMoney(value, symbol)
          const statsOf = id => byId[id]?.projectionValues?.sessionStats

          const ownerOf = new Map()
          for (const item of items) {
            for (const id of item?.sessionIds ?? EMPTY_ARRAY) ownerOf.set(id, item)
          }
          const projectTitle = workspaceId =>
            items.find(item => item?.workspaceId === workspaceId)?.title ?? t('reportNoProject')

          // Every conversation that carries a figure, with its day map and its
          // all-time timing counters (those are not sliceable by date).
          const all = []
          for (const [id, row] of ledger) {
            if (row.cost === 0 && row.credits === 0 && totalOf(row.charged) === 0) continue
            const stats = statsOf(id)
            all.push({
              id,
              workspaceId: ownerOf.get(id)?.workspaceId ?? '',
              title: byId[id]?.displayTitle ?? byId[id]?.title ?? id,
              cost: row.cost,
              credits: row.credits,
              tokens: totalOf(row.charged),
              cacheRead: row.charged.cacheRead ?? 0,
              byBucket: row.byBucket,
              byDay: row.byDay ?? {},
              updatedAt: row.updatedAt,
              // Absent stats are not zero time; the table must say so.
              hasStats: stats !== undefined,
              models: typeof row.model === 'string' && row.model.length > 0
                ? row.model.split(', ')
                : [],
              llmMs: stats?.llmMs ?? 0,
              toolMs: stats?.toolMs ?? 0,
              ttftMs: stats?.ttftMs ?? 0,
              ttftSteps: stats?.ttftSteps ?? 0,
              decodeMs: stats?.decodeMs ?? 0,
              decodeTokens: stats?.decodeTokens ?? 0,
            })
          }
          const scoped = scope === '' ? all : all.filter(row => row.workspaceId === scope)

          // Date filter. Only the per-day map can be sliced, so timing and
          // conversation counts fall back to all-time and say so.
          const days = range === 'all' ? 0 : Number(range)
          const cutoff = days === 0 ? '' : dayKey(Date.now() - (days - 1) * 86400000)
          const inRange = day => cutoff === '' || day >= cutoff

          let totalCost = 0
          let totalCredits = 0
          let totalTokens = 0
          let cacheReadTokens = 0
          let llmMs = 0
          let toolMs = 0
          let ttftMs = 0
          let ttftSteps = 0
          let decodeMs = 0
          let decodeTokens = 0
          const bucketCost = zeroBuckets()
          const dayTotals = new Map()
          const rangedCost = new Map()
          const activeDays = new Set()
          const undated = []

          for (const row of scoped) {
            llmMs += row.llmMs
            toolMs += row.toolMs
            ttftMs += row.ttftMs
            ttftSteps += row.ttftSteps
            decodeMs += row.decodeMs
            decodeTokens += row.decodeTokens
            cacheReadTokens += row.cacheRead

            const keys = Object.keys(row.byDay)
            if (keys.length === 0) {
              undated.push(row)
              continue
            }
            let rowCost = 0
            for (const day of keys) {
              const cell = row.byDay[day]
              const slot = dayTotals.get(day) ?? { tokens: 0, cost: 0, credits: 0 }
              slot.tokens += cell.tokens
              slot.cost += cell.cost
              slot.credits += cell.credits
              dayTotals.set(day, slot)
              if (!inRange(day)) continue
              totalCost += cell.cost
              totalCredits += cell.credits
              totalTokens += cell.tokens
              rowCost += cell.cost
              activeDays.add(day)
              for (const bucket of BUCKETS) bucketCost[bucket] += cell.byBucket?.[bucket] ?? 0
            }
            rangedCost.set(row.id, rowCost)
          }
          // Rows predating the per-day field still count toward an unfiltered
          // view; a range cannot place them, so they are disclosed instead.
          if (range === 'all') {
            for (const row of undated) {
              totalCost += row.cost
              totalCredits += row.credits
              totalTokens += row.tokens
              rangedCost.set(row.id, row.cost)
              for (const bucket of BUCKETS) bucketCost[bucket] += row.byBucket[bucket] ?? 0
            }
          }

          const conversations = range === 'all'
            ? scoped.length
            : scoped.filter(row => Object.keys(row.byDay).some(inRange)).length

          const projectGroups = new Map()
          for (const row of scoped) {
            const group = projectGroups.get(row.workspaceId)
              ?? { workspaceId: row.workspaceId, cost: 0, tokens: 0, count: 0 }
            group.cost += rangedCost.get(row.id) ?? 0
            group.tokens += row.tokens
            group.count += 1
            projectGroups.set(row.workspaceId, group)
          }
          const projects = [...projectGroups.values()]
            .filter(group => group.cost > 0 || group.count > 0)
            .sort((a, b) => b.cost - a.cost)

          const bucketTotal = BUCKETS.reduce((sum, key) => sum + bucketCost[key], 0)
          const bucketMax = Math.max(0, ...BUCKETS.map(key => bucketCost[key]))
          const ranked = [...scoped]
            .map(row => ({ ...row, viewedCost: rangedCost.get(row.id) ?? 0 }))
            .sort((a, b) => b.viewedCost - a.viewedCost)
          const pageCount = Math.max(1, Math.ceil(ranked.length / REPORT_PAGE))
          const current = Math.min(page, pageCount - 1)
          const pageRows = ranked.slice(current * REPORT_PAGE, (current + 1) * REPORT_PAGE)

          // Heatmap series. `total` is a running sum through each day.
          const dayKeys = [...dayTotals.keys()].sort()
          const today = dayKey(Date.now())
          // A contribution graph IS a calendar, so its shape must be STABLE.
          // The grid always spans the trailing 53 weeks and renders days with no
          // data as empty cells. Sizing it to the days that happen to carry data
          // collapses it to a single dot, which is no longer a calendar and
          // tells the reader nothing.
          const todayMs = Date.parse(`${today}T00:00:00Z`)
          // Extend to the Saturday of the current week so the last column is whole.
          const gridEndMs = todayMs + (6 - new Date(todayMs).getUTCDay()) * 86400000
          const gridStartMs = gridEndMs - (HEAT_WEEKS * 7 - 1) * 86400000
          const heatDays = daysBetween(
            new Date(gridStartMs).toISOString().slice(0, 10),
            new Date(gridEndMs).toISOString().slice(0, 10),
          )
          // The heatmap can be coloured by tokens or by money. Money is the
          // whole point of this plugin, so it must be selectable here and not
          // only in the charts below.
          const valueOfDay = cell => (metric === 'cost' ? (cell?.cost ?? 0) : (cell?.tokens ?? 0))
          const heatValues = {}
          if (mode === 'day') {
            for (const day of heatDays) heatValues[day] = valueOfDay(dayTotals.get(day))
          } else if (mode === 'week') {
            for (const day of heatDays) {
              const end = Date.parse(`${day}T00:00:00Z`)
              let sum = 0
              for (const key of dayKeys) {
                const at = Date.parse(`${key}T00:00:00Z`)
                if (at <= end && at > end - 7 * 86400000) sum += valueOfDay(dayTotals.get(key))
              }
              heatValues[day] = sum
            }
          } else {
            let running = 0
            for (const day of heatDays) {
              running += valueOfDay(dayTotals.get(day))
              heatValues[day] = running
            }
          }
          const heatMax = Math.max(0, ...Object.values(heatValues))
          const heatTotal = dayKeys.reduce((sum, day) => sum + valueOfDay(dayTotals.get(day)), 0)

          const shareOf = value => (totalCost > 0 ? `${(value / totalCost * 100).toFixed(1)}%` : '—')
          const card = (value, label, note) => h('div', { key: label, style: { minWidth: 150 } },
            h('div', { style: { fontSize: 28, fontWeight: 600, lineHeight: 1.25 } }, value),
            h('div', { style: FAINTED }, label),
            note !== undefined && h('div', { style: { ...FAINTED, marginTop: 2 } }, note),
          )

          const empty = all.length === 0
          if (empty) {
            return h('div', { style: { maxWidth: 640, margin: '80px auto', textAlign: 'center' } },
              h('div', { style: { fontSize: 15, fontWeight: 600, marginBottom: 8 } }, t('dashEmpty')),
              h('div', { style: MUTED }, t('dashEmptyHint')),
            )
          }

          const chip = (active, label, onClick) => h('button', {
            key: label, type: 'button', onClick,
            style: {
              ...BUTTON, padding: '3px 10px', fontSize: 11.5,
              background: active ? 'color-mix(in srgb, currentColor 16%, transparent)' : 'transparent',
              fontWeight: active ? 600 : 400,
            },
          }, label)

          return h('div', { style: { padding: '18px 24px 40px', maxWidth: 1180, margin: '0 auto' } },
            // ---- sticky filters
            h('div', {
              style: {
                position: 'sticky', top: 0, zIndex: 5, paddingBottom: 10, marginBottom: 14,
                background: 'color-mix(in srgb, Canvas 94%, CanvasText)',
                borderBottom: `1px solid ${hairline}`,
              },
            },
              h('div', { style: { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' } },
                h('span', { style: { fontSize: 15, fontWeight: 600 } }, t('dashTitle')),
                scope !== '' && h('button', {
                  type: 'button', style: { ...BUTTON, padding: '2px 10px', fontSize: 11.5 },
                  onClick: () => { setScope(''); setPage(0) },
                }, `← ${t('dashBack')}`),
                h('span', { style: { flex: 1 } }),
                h('select', {
                  style: { ...SELECT, width: 240 },
                  value: scope,
                  onChange: event => { setScope(event.target.value); setPage(0) },
                },
                  h('option', { value: '', style: OPTION }, `${t('reportAllProjects')}（${all.length}）`),
                  ...projects.map(group => h('option', {
                    key: group.workspaceId || 'none', value: group.workspaceId, style: OPTION,
                  }, `${projectTitle(group.workspaceId)} · ${group.count}`)),
                ),
                h('div', { style: { display: 'flex', gap: 4 } },
                  chip(range === 'all', t('dashAllTime'), () => { setRange('all'); setPage(0) }),
                  chip(range === '30', t('dash30'), () => { setRange('30'); setPage(0) }),
                  chip(range === '7', t('dash7'), () => { setRange('7'); setPage(0) }),
                ),
              ),
            ),

            // ---- statistic cards (rule 1: three questions above the fold)
            h('div', { style: { ...GROUP, display: 'flex', gap: 28, flexWrap: 'wrap' } },
              card(money(totalCost) + (totalCredits > 0 ? ` + ${formatCredits(totalCredits)}` : ''),
                t('reportTotalCost')),
              card(formatTokens(totalTokens), t('reportTotalTokens')),
              card(formatDuration(llmMs), t('dashLlmTime'), range === 'all' ? undefined : t('dashAllTimeOnly')),
              card(String(conversations), t('reportConversations')),
              card(formatTokens(cacheReadTokens), t('dashCacheRead')),
              card(formatDuration(toolMs), t('dashToolTime'), range === 'all' ? undefined : t('dashAllTimeOnly')),
            ),
            undated.length > 0 && range !== 'all' && h('div', { style: { ...FAINTED, marginBottom: 12 } },
              t('dashUndated', { count: undated.length })),

            // ---- activity heatmap (rule 6: adaptive span, never a fixed year)
            h('div', { style: GROUP },
              h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 10 } },
                h('span', { style: { fontWeight: 600 } }, t('dashActivity')),
                h('span', { style: { flex: 1 } }),
                h('div', { style: { display: 'flex', gap: 4 } },
                  chip(metric === 'token', t('dashMetricToken'), () => setMetric('token')),
                  chip(metric === 'cost', t('dashMetricCost'), () => setMetric('cost')),
                ),
                h('div', { style: { display: 'flex', gap: 4 } },
                  chip(mode === 'day', t('dashDaily'), () => setMode('day')),
                  chip(mode === 'week', t('dashWeekly'), () => setMode('week')),
                  chip(mode === 'total', t('dashCumulative'), () => setMode('total')),
                ),
              ),
              h(ActivityHeatmap, {
                days: heatDays,
                values: heatValues,
                size: heatMax,
                format: formatTokens,
                detailOf: day => dayTotals.get(day),
                onHover: setHover,
              }),
              h('div', { style: { ...FAINTED, marginTop: 8 } },
                `${heatDays[0] ?? '—'} ~ ${today} · ${t('dashDaysWithData', { count: dayKeys.length })}`
                + ` · ${t('dashHeatTotal')} `
                + (metric === 'cost' ? money(heatTotal) : `${formatTokens(heatTotal)} tok`)),
              // Deliberately faint, not a warning banner: this is a footnote
              // about missing data, and it must never out-shout the figures it
              // sits under. Emphasis belongs to the numbers.
              undated.length > 0 && h('div', { style: { ...FAINTED, marginTop: 4 } },
                t('dashNeedBackfill', { count: undated.length })),
              hover !== null && h('div', {
                style: {
                  position: 'fixed', zIndex: 1100, pointerEvents: 'none',
                  left: Math.min(hover.x + 12, window.innerWidth - 220),
                  top: Math.max(hover.y - 44, 8),
                  padding: '5px 9px', borderRadius: 8, fontSize: 11.5,
                  border: `1px solid ${hairline}`,
                  background: 'color-mix(in srgb, Canvas 92%, CanvasText)',
                  color: 'CanvasText', boxShadow: '0 6px 18px rgba(0,0,0,.3)',
                },
              }, `${hover.day} · ${formatTokens(hover.detail?.tokens ?? 0)} tok`
                + ` · ${money(hover.detail?.cost ?? 0)}`),
            ),

            // ---- composition and ranking
            h('div', { style: { display: 'flex', gap: 14, flexWrap: 'wrap' } },
              h('div', { style: { ...GROUP, flex: REPORT_COLUMN } },
                h('div', { style: { fontWeight: 600, marginBottom: 10 } }, t('reportByBucket')),
                ...BUCKETS.map((key, index) => h(Bar, {
                  key,
                  label: t(key),
                  value: bucketCost[key],
                  max: bucketMax,
                  color: SERIES[index % SERIES.length],
                  text: money(bucketCost[key]),
                  share: bucketTotal > 0 ? `${(bucketCost[key] / bucketTotal * 100).toFixed(1)}%` : '—',
                })),
              ),
              h('div', { style: { ...GROUP, flex: REPORT_COLUMN } },
                h('div', { style: { fontWeight: 600, marginBottom: 10 } }, t('dashByProject')),
                projects.length === 0 && h('div', { style: FAINTED }, '—'),
                ...projects.slice(0, 8).map((group, index) => h('div', {
                  key: group.workspaceId || 'none',
                  style: { marginBottom: 4, cursor: 'pointer' },
                  onClick: () => { setScope(group.workspaceId); setPage(0) },
                },
                  h(Bar, {
                    label: projectTitle(group.workspaceId),
                    value: group.cost,
                    max: projects[0].cost,
                    color: SERIES[index % SERIES.length],
                    text: money(group.cost),
                    share: shareOf(group.cost),
                  }),
                )),
                reportsNote(projects.length > 8, projects.length - 8),
              ),
            ),

            // ---- detail (rule 10: always paginated)
            h('div', { style: GROUP },
              h('div', { style: { fontWeight: 600, marginBottom: 10 } },
                `${t('reportTop')} · ${t('reportCount', { count: ranked.length })}`),
              h('table', { style: { width: '100%', minWidth: 640, tableLayout: 'fixed', borderCollapse: 'collapse' } },
                h('colgroup', null,
                  h('col', { style: { width: '30%' } }),
                  h('col', { style: { width: '18%' } }),
                  h('col', { style: { width: '16%' } }),
                  h('col', { style: { width: '12%' } }),
                  h('col', { style: { width: '12%' } }),
                  h('col', { style: { width: '12%' } }),
                ),
                h('thead', null, h('tr', null,
                  h('th', { style: TH }, t('colConversation')),
                  h('th', { style: TH }, t('colProject')),
                  h('th', { style: TH }, t('colModel')),
                  h('th', { style: { ...TH, textAlign: 'right' } }, t('colTokens')),
                  h('th', { style: { ...TH, textAlign: 'right' } }, t('colDuration')),
                  h('th', { style: { ...TH, textAlign: 'right' } }, t('colCost')),
                )),
                h('tbody', null, ...pageRows.map(row => h('tr', { key: row.id },
                  h('td', { style: { ...TD, borderBottom: `1px solid ${hairline}` } },
                    h('span', {
                      title: row.title,
                      style: { display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                    }, row.title)),
                  h('td', { style: { ...TD, ...FAINTED, borderBottom: `1px solid ${hairline}` } },
                    projectTitle(row.workspaceId)),
                  h('td', { style: { ...TD, ...FAINTED, borderBottom: `1px solid ${hairline}` } },
                    row.models.length === 1 ? row.models[0] : t('reportMultiModel')),
                  h('td', {
                    style: { ...TD, ...FAINTED, textAlign: 'right', borderBottom: `1px solid ${hairline}` },
                  }, formatTokens(row.tokens)),
                  h('td', {
                    style: { ...TD, ...FAINTED, textAlign: 'right', borderBottom: `1px solid ${hairline}` },
                  }, row.hasStats ? formatDuration(row.llmMs + row.toolMs) : '—'),
                  h('td', {
                    style: { ...TD, textAlign: 'right', borderBottom: `1px solid ${hairline}` },
                  }, money(row.viewedCost)),
                ))),
              ),
              h('div', { style: { ...MUTED, display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 } },
                h('button', {
                  type: 'button', style: BUTTON, disabled: current === 0,
                  onClick: () => setPage(Math.max(0, current - 1)),
                }, t('reportPrev')),
                h('span', null, t('reportPage', { page: current + 1, pages: pageCount, total: ranked.length })),
                h('button', {
                  type: 'button', style: BUTTON, disabled: current >= pageCount - 1,
                  onClick: () => setPage(Math.min(pageCount - 1, current + 1)),
                }, t('reportNext')),
              ),
            ),
          )
        }

        /** One-line disclosure that a list was truncated. */
        function reportsNote(condition, count) {
          return condition ? h('div', { style: { ...FAINTED, marginTop: 6 } }, `… +${count}`) : null
        }

        /**
         * Wrap one slot entry so a render failure stays legible.
         *
         * A thrown render used to blank the entire settings content column with
         * nothing to go on; a boundary turns that into one readable line, which
         * is the difference between "it broke" and "here is what broke".
         */
        const boundary = (label, Component) => {
          class Boundary extends React.Component {
            constructor(props) {
              super(props)
              this.state = { error: null }
            }

            static getDerivedStateFromError(error) {
              return { error }
            }

            render() {
              if (this.state.error !== null) {
                return h('div', { style: { ...MUTED, ...WARN, padding: 8, whiteSpace: 'pre-wrap' } },
                  `${label}: ${String(this.state.error)}`)
              }
              return h(Component, this.props)
            }
          }
          return Boundary
        }

        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'cost',
          order: 1,
        }, boundary('cost meter', CostMeter)))

        // Two sidebar panels, matching the two questions a spender asks:
        // "what have I spent in total" (account) and "where did it go"
        // (project). A sidebar panellist id addresses the main panel of the
        // same key, so the id and the key must agree.
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'cost',
          order: 1,
          label: () => t('dashTitle'),
        }, boundary('cost icon', CostIcon)))

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: 'cost',
        }, boundary('cost dashboard', CostDashboard)))

        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'cost-projects',
          order: 2,
          label: () => t('reportTitle'),
        }, boundary('cost report icon', ReportIcon)))

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: 'cost-projects',
        }, boundary('cost report', CostReport)))

        // Settings keeps only what configures the meter: the price table, the
        // ledger controls, and the backfill that fills in history.
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'cost',
          order: 12,
          label: () => t('settingsTitle'),
        }, boundary('cost settings', CostSettings)))
      },
    }
  },
})
