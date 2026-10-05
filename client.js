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
  id: 'dsh-hermes-cost-meter',
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

    /**
     * Sizing follows the harness, not this file.
     *
     * The theme publishes the reader's content size as `--dsh-content-font-size`
     * (12–17px, default 14) plus `--dsh-content-font-delta`, its distance from
     * that default, and every native surface derives its own sizes from them.
     * Hard-coded pixels would pin this meter at one size while the rest of the
     * app tracks the setting, so each size below is the number the design was
     * drawn at PLUS that same delta: `size(13)` is 13px at the default and stays
     * proportionate at any other.
     */
    const size = px => `calc(${px}px + var(--dsh-content-font-delta, 0px))`
    /**
     * The page follows the column the harness gives it, within a readable width.
     *
     * No cap at all stretches a two-column dashboard across an ultrawide window
     * until every bar is a metre long; a pixel cap alone ignores the window. A
     * `max-width` does both: the rows stop growing once they are comfortable and
     * the gutter takes the rest.
     */
    const PAGE = {
      padding: '22px 32px 46px', width: '100%', maxWidth: 1440, margin: '0 auto',
      boxSizing: 'border-box',
      // The panel lands in ui-layout's centre column, which is a flex column with
      // `overflow: hidden`. A percentage height collapses to `auto` against that
      // indefinite container, so the leftover track is claimed the flex way and the
      // report scrolls inside it — without this, a long page is silently cut off at
      // the window edge with no scrollbar anywhere.
      flex: '1 1 auto', minHeight: 0, overflowY: 'auto', overflowX: 'hidden',
    }

    const hairline = 'color-mix(in srgb, currentColor 16%, transparent)'
    const SOFT = 'color-mix(in srgb, currentColor 55%, transparent)'
    const FAINT = 'color-mix(in srgb, currentColor 38%, transparent)'
    const PILL = {
      display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 9px',
      border: `1px solid ${hairline}`, borderRadius: 999,
      background: 'color-mix(in srgb, currentColor 7%, transparent)',
      color: 'inherit', font: 'inherit', fontSize: size(13), lineHeight: 1.5, cursor: 'pointer',
    }
    const PANEL = {
      position: 'fixed', zIndex: 60, width: 'min(340px, calc(100vw - 32px))', padding: 12,
      border: `1px solid ${hairline}`, borderRadius: 12,
      background: 'color-mix(in srgb, Canvas 92%, CanvasText)',
      color: 'CanvasText', font: 'inherit', fontSize: size(13), lineHeight: 1.6,
      boxShadow: '0 10px 30px rgba(0,0,0,.30)',
    }
    const ROW = { display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'baseline' }
    const MUTED = { color: SOFT, fontSize: size(13.5) }
    const FAINTED = { color: SOFT, fontSize: size(13) }
    /** Money and share own separate right-aligned columns, so rows scan vertically. */
    const NUMBER = { minWidth: 82, textAlign: 'right', fontWeight: 600, color: 'inherit' }
    const SHARE = { minWidth: 56, textAlign: 'right', color: SOFT, fontSize: size(13) }
    const RULE = { height: 1, background: hairline, margin: '8px 0' }
    const WARN = { color: '#d29343' }
    /** How many projects the budget bar names before folding the tail into one row. */
    const BUDGET_SEGMENTS = 6
    /** Over budget says something different from "getting close", and must look it. */
    const OVER = { color: '#e0685a' }
    const SECTION_TITLE = { fontSize: size(15), fontWeight: 600, margin: '0 0 8px' }
    const GROUP = {
      border: `1px solid ${hairline}`, borderRadius: 10, padding: 12, marginBottom: 14,
    }
    const INPUT = {
      width: '100%', boxSizing: 'border-box', padding: '3px 6px',
      border: `1px solid ${hairline}`, borderRadius: 6,
      background: 'color-mix(in srgb, currentColor 5%, transparent)',
      color: 'inherit', font: 'inherit', fontSize: size(13),
    }
    const TH = {
      textAlign: 'left', padding: '2px 5px', fontWeight: 500, color: SOFT,
      fontSize: size(13), whiteSpace: 'nowrap',
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
      color: 'inherit', font: 'inherit', fontSize: size(13), cursor: 'pointer',
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
    /**
     * Column weights, not pixels.
     *
     * The price table stretches with the window; the wrapper scrolls only once
     * the columns would be narrower than their own inputs.
     */
    const WIDTHS = ['20%', '16.6%', '16.6%', '8%', '8.8%', '7.6%', '7.6%', '6.4%', '4.8%', '3.6%']
    /** Below this the settings table scrolls instead of squeezing its inputs. */
    const TABLE_MIN_WIDTH = 820

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
      projFirst: '首次活动',
      projLast: '最近活动',
      projSpan: '项目跨度',
      projActiveDays: '活跃天数',
      projDays: '天',
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
      panelTitle: '花费统计',
      budgetTitle: '预算',
      budgetScopeAccount: '账号',
      budgetScope: '范围',
      budgetAmount: '金额',
      budgetPeriod: '周期',
      budgetPeriodDay: '今日',
      budgetPeriodMonth: '本月',
      budgetPeriodAll: '累计',
      budgetAdd: '添加预算',
      budgetUnset: '未设置上限',
      budgetSet: '设置上限',
      budgetEdit: '修改',
      budgetSave: '保存',
      budgetCancel: '取消',
      budgetSaving: '保存中…',
      budgetSaved: '已保存',
      budgetFailed: '保存失败（见浏览器控制台）',
      budgetOverBy: '已超支',
      balanceTitle: 'DeepSeek 余额',
      balanceGranted: '赠额',
      balanceToppedUp: '充值',
      balanceRefresh: '刷新',
      balanceLoading: '查询中…',
      balanceUnset: '未配置 DEEPSEEK_API_KEY（在设置 → 账号与余额 里配置后即可显示）',
      balanceFailed: '查询失败：{reason}',
      tierNow: '峰谷：当前',
      tierPeak: '高峰（全价）',
      tierOffPeak: '低谷（半价）',
      tierUntilPeak: '距转高峰',
      tierUntilOffPeak: '距转低谷',
      budgetSpentAll: '累计已花',
      budgetWhere: '去「设置 → 花费计价 → 预算」加一条，给这个范围设上限',
      budgetEmpty: '还没有预算。给账号或某个项目设一个上限，超支会在上方进度条里变红。',
      budgetWarn: '接近上限',
      budgetOver: '已超支',
      budgetHint: '金额与显示货币一致。项目预算按该项目自己的对话计算 —— "这个模块花了多少钱"就是这一行。',
      reconTitle: '对账口径',
      reconIntro: '本页所有金额都由插件自己按「每笔请求发生时刻」的价目算出，逐笔累加；下面是它和官方账单可能对不上的地方，先看这里再怀疑数字。',
      reconFormula: '计费口径：未缓存输入 × 未缓存单价 + 输出 × 输出单价 +（缓存读取 + 缓存写入）× 缓存命中单价。',
      reconReasoning: '推理/思维 token：供应商单独上报，官方账单不计费，本插件也不计入金额。',
      reconCurrency: '币种基准：¥ 直接使用官方人民币价目；其他货币按汇率换算，与官方人民币账单会有结构性差异 —— 建议对账时把货币切成 ¥。',
      reconDelay: '分钟级延迟：账本写入有 {ms} 毫秒去抖，正在流式返回的请求还没结算，所以刚用完的这一刻会偏小。',
      reconUnpriced: '无价目 token：{count} tok 没有匹配到价目，未计入金额（价目表里补一条即可）。',
      reconCoverage: '当前覆盖：{rows} 个对话 · 账本 {ledger} 行 · 插件 v{version}。',
      reconFile: '状态文件：{path}（删掉它等于清空历史）。',
      costAllTime: '花费为全时段',
      reportDrill: '点击下钻',
      costInRange: '花费为所选时间范围',
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
      dashSpan: '工作跨度 {span} 天：{from} → {to}（活跃 {days} 天）',
      dashByProject: '项目排行',
      dashUndated: '{count} 个对话缺少按天数据，未计入所选时间段',
      dashUntimed: '{count} 个对话没有用时数据 · 在「花费计价」重跑一次计算即可补齐',
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
      notReadyLoading: '插件正在加载…',
      notReadyMissing: '插件未就绪：host 半边没有加载',
      notReadyMissingHint: '插件的 host 路由 `/api/cost/state` 没有应答（HTTP 404），说明 host 半边没跑起来。装完插件后需要**重启一次 DeepSeek Harness**，只刷新页面不够——客户端半边会热更新，host 半边不会。',
      notReadyError: '插件未就绪：读不到花费文档',
      notReadyErrorHint: '与 host 的 `/api/cost/state` 通信失败，通常是 host 半边没加载或页面连不上。重启 DeepSeek Harness 后刷新页面。',
      notReadyRetry: '重新检测',
      notReadyShort: '未就绪',
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
      projFirst: 'First activity',
      projLast: 'Latest activity',
      projSpan: 'Project span',
      projActiveDays: 'Active days',
      projDays: 'days',
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
      panelTitle: 'Spend',
      budgetTitle: 'Budget',
      budgetScopeAccount: 'Account',
      budgetScope: 'Scope',
      budgetAmount: 'Amount',
      budgetPeriod: 'Period',
      budgetPeriodDay: 'Today',
      budgetPeriodMonth: 'This month',
      budgetPeriodAll: 'All time',
      budgetAdd: 'Add a budget',
      budgetUnset: 'no limit set',
      budgetSet: 'Set limit',
      budgetEdit: 'Edit',
      budgetSave: 'Save',
      budgetCancel: 'Cancel',
      budgetSaving: 'Saving…',
      budgetSaved: 'Saved',
      budgetFailed: 'Save failed (see the browser console)',
      budgetOverBy: 'over by',
      balanceTitle: 'DeepSeek balance',
      balanceGranted: 'granted',
      balanceToppedUp: 'topped up',
      balanceRefresh: 'Refresh',
      balanceLoading: 'Checking…',
      balanceUnset: 'DEEPSEEK_API_KEY is not configured (add it under Settings → Account & balance)',
      balanceFailed: 'Lookup failed: {reason}',
      tierNow: 'Peak pricing: now',
      tierPeak: 'peak (full rate)',
      tierOffPeak: 'off-peak (half rate)',
      tierUntilPeak: 'peak in',
      tierUntilOffPeak: 'off-peak in',
      budgetSpentAll: 'spent so far',
      budgetWhere: 'Add one under Settings → Cost → Budget to set a limit for this scope',
      budgetEmpty: 'No budget yet. Set a limit for the account or for one project; going over turns the bar above red.',
      budgetWarn: 'close to the limit',
      budgetOver: 'over budget',
      budgetHint: 'Amounts are in the display currency. A project budget counts that project\'s own conversations — this is the line that answers "what has this module cost me".',
      reconTitle: 'Reconciliation',
      reconIntro: 'Every amount here is priced by the plugin at the instant each request ran and summed per call. These are the places it can legitimately disagree with the official bill — check here before doubting a number.',
      reconFormula: 'Basis: uncached input × uncached rate + output × output rate + (cache read + cache write) × cache-hit rate.',
      reconReasoning: 'Reasoning tokens: the provider reports them separately, the official bill does not charge for them, and neither does this plugin.',
      reconCurrency: 'Currency: ¥ is booked straight on the official CNY price list; other currencies go through an exchange rate and carry a structural difference — switch to ¥ before reconciling.',
      reconDelay: 'Minute-level lag: the ledger write is debounced by {ms} ms and a stream still in flight is not settled, so the last moment reads low.',
      reconUnpriced: 'Unpriced tokens: {count} tok matched no price entry and is not charged (add a row to the price table to cover it).',
      reconCoverage: 'Currently covering {rows} conversations · {ledger} ledger rows · plugin v{version}.',
      reconFile: 'State file: {path} (deleting it clears the history).',
      costAllTime: 'Cost is all-time',
      reportDrill: 'Click to drill down',
      costInRange: 'Cost is within the selected range',
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
      dashSpan: 'Worked over {span} days: {from} → {to} ({days} active)',
      dashByProject: 'By project',
      dashUndated: '{count} conversations have no per-day data and are outside the selected range',
      dashUntimed: '{count} conversations have no duration data - rerun a compute in Cost to fill them in',
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
      notReadyLoading: 'Plugin is loading…',
      notReadyMissing: 'Plugin not ready: the host half never loaded',
      notReadyMissingHint: 'The plugin\'s host route `/api/cost/state` did not answer (HTTP 404), so the host half is not running. Installing a bundle needs **one DeepSeek Harness restart**; refreshing the page is not enough — the client half hot-reloads, the host half does not.',
      notReadyError: 'Plugin not ready: cannot read the cost document',
      notReadyErrorHint: 'Talking to the host\'s `/api/cost/state` failed — usually a host half that never loaded, or a page that lost its connection. Restart DeepSeek Harness, then refresh.',
      notReadyRetry: 'Check again',
      notReadyShort: 'not ready',
    }

    // ------------------------------------------------------------------ apply

    return {
      // `remote.settings` used to be required here, which meant a harness that
      // renamed or dropped that service killed the whole plugin at apply time.
      // The meter now reads its own Host routes with plain `fetch`, so only the
      // three long-lived UI services stay injected.
      inject: ['slots', 'locale', 'sessions'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, 'zh', ZH), 'dsh-cost: zh')
        ctx.effect(() => ctx.locale.register(NS, 'en', EN), 'dsh-cost: en')
        const t = ctx.locale.bind(NS)

        /** Resolved configuration: models, holidays, currency, flush cadence. */
        let config = null
        /**
         * Why `config` is still null, when it is.
         *
         * A null config used to surface as a bare `…` in the three panels and as
         * NOTHING AT ALL in the composer, so a Host half that never loaded was
         * indistinguishable from a plugin that was merely still booting. Worse,
         * the one line that named the real fix — "restart the harness" — lives
         * in the settings page BEHIND the early return this state can never
         * pass. Tracking the reason lets every surface say it.
         *
         * `'loading'` is the only transient value; the pill stays invisible for
         * it so a healthy start does not flash a warning.
         */
        let readiness = 'loading'
        /** Concrete evidence for the not-ready notice, e.g. the route's status. */
        let readinessDetail = ''
        /** The stored document, shaped like the settings page expects. */
        let view = null
        /**
         * Backoff for the Host-document read, in milliseconds.
         *
         * The Host half registers its routes from an asynchronous activation, so
         * the first read can lose that race; a bundle installed without a
         * restart answers 404 until the process is replaced. Retrying is what
         * keeps either case from settling into a dead panel, and the last delay
         * is the steady-state poll for a Host that appears later.
         */
        const RETRY_DELAYS = [500, 1000, 2000, 4000, 8000, 15000]
        /** Backoff cursor for that read. */
        let stateAttempt = 0
        /** Pending retry timer for that read. */
        let stateTimer = null
        /**
         * Whether this plugin instance was torn down.
         *
         * The first read fails asynchronously, so a teardown that only clears the
         * *current* timer can still be overtaken by a retry armed afterwards —
         * which is exactly what leaves a headless loader hanging on a timer
         * nobody will ever fire.
         */
        let stateDisposed = false
        /** sessionId -> accumulated row. Authoritative in this browser tab. */
        const ledger = new Map()
        let revision = 0
        /** The Host half's version, shown so 'which build am I running' is answerable. */
        let hostVersion = ''
        /** Absolute path of the Host's state document, shown in the reconciliation block. */
        let statePath = ''
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

        /** Adopt one Host configuration answer; every field falls back. */
        function adoptConfig(value) {
          const models = Array.isArray(value?.models) ? value.models : []
          const holidays = Array.isArray(value?.holidays) ? value.holidays : []
          config = {
            currency: typeof value?.currency === 'string' ? value.currency : 'CNY',
            flushMs: Number.isFinite(value?.flushMs) ? value.flushMs : 4000,
            models,
            holidays: new Set(holidays),
            // Budgets travel with the configuration and are read by the panel bar,
            // so dropping them here would silently disable every limit on screen.
            budgets: value?.budgets !== null && typeof value?.budgets === 'object' ? value.budgets : {},
          }
        }

        function adoptLedger(raw) {
          if (raw === null || typeof raw !== 'object') return
          for (const [sessionId, row] of Object.entries(raw)) {
            if (row === null || typeof row !== 'object') continue
            // An empty model is not a reason to throw a stored row away. Rows like
            // that are what a recompute produces when a log frame carries no model
            // id: the tokens and the money may be unknown, but the conversation
            // still ran, and discarding the row took its tokens AND its duration
            // out of every total on the page — silently, on the next load. Keep it
            // and let the "no price entry" path report it instead.
            ledger.set(sessionId, {
              baseline: { ...zeroBuckets(), ...(row.baseline ?? {}) },
              byBucket: { ...zeroBuckets(), ...(row.byBucket ?? {}) },
              charged: { ...zeroBuckets(), ...(row.charged ?? {}) },
              byDay: row.byDay !== null && typeof row.byDay === 'object' ? { ...row.byDay } : {},
              cost: Number.isFinite(row.cost) ? row.cost : 0,
              credits: Number.isFinite(row.credits) ? row.credits : 0,
              unpriced: Number.isFinite(row.unpriced) ? row.unpriced : 0,
              llmMs: Number.isFinite(row.llmMs) ? row.llmMs : undefined,
              toolMs: Number.isFinite(row.toolMs) ? row.toolMs : undefined,
              model: typeof row.model === 'string' ? row.model : '',
              updatedAt: Number.isFinite(row.updatedAt) ? row.updatedAt : 0,
            })
          }
        }

        /**
         * Pull the stored configuration, and the ledger on first load only.
         *
         * The document comes from this plugin's own Host route rather than a
         * settings namespace: `GET /api/cost/state` is answered by whatever
         * harness generation is running, so the plugin no longer breaks when the
         * settings API is replaced. A 404 here is the case the readiness model
         * exists to name — the Host half is not registered in this process.
         */
        async function pull(adoptRows) {
          try {
            const response = await fetch('/api/cost/state', {
              headers: { accept: 'application/json' },
            })
            if (response.status === 404 || response.status === 405) {
              // The Host half never registered its routes: almost always a fresh
              // install that was never restarted, since only the Client half of
              // a plugin bundle hot-reloads.
              readiness = 'missing'
              readinessDetail = `GET /api/cost/state → HTTP ${response.status}（host 半边没有注册这条路由）`
              return false
            }
            if (!response.ok) {
              readiness = 'error'
              readinessDetail = `GET /api/cost/state → HTTP ${response.status}`
              return false
            }
            const payload = await response.json()
            if (payload?.ok !== true || payload.config === null || typeof payload.config !== 'object') {
              readiness = 'error'
              readinessDetail = 'GET /api/cost/state 的应答不是有效的花费文档'
              return false
            }
            readiness = 'ready'
            readinessDetail = ''
            revision = Number.isFinite(payload.revision) ? payload.revision : 0
            hostVersion = typeof payload.pluginVersion === 'string' ? payload.pluginVersion : ''
            if (typeof payload.statePath === 'string' && payload.statePath.length > 0) statePath = payload.statePath
            // The settings page edits `view.value` and re-reads it after a save,
            // so the stored document is presented in the shape it already knows.
            view = { ns: NS, value: payload.config, user: payload.config, revision, writable: true }
            adoptConfig(payload.config)
            if (adoptRows) adoptLedger(payload.ledger)
            return true
          } catch (error) {
            readiness = 'error'
            readinessDetail = String(error)
            ctx.logger?.warn?.(`cost meter: state read failed: ${String(error)}`)
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

        /**
         * Send one patch to the Host document.
         *
         * A patch carrying `ledger` merges rows; anything else is a price-table
         * edit. Both answer `{ ok, revision }`, and the revision travels back so
         * the next write cannot be refused as stale.
         * @param patch - `{ ledger }` or the edited `{ models, currency, flushMs }`.
         * @returns the Host's answer envelope.
         * @throws when the Host refused the write, so the settings page can say so.
         */
        async function write(patch) {
          const carriesLedger = patch !== null && typeof patch === 'object' && 'ledger' in patch
          const response = await fetch(carriesLedger ? '/api/cost/state' : '/api/cost/config', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(carriesLedger
              ? { revision, ledger: patch.ledger }
              : { revision, config: patch }),
          })
          const payload = await response.json().catch(() => null)
          if (payload?.ok !== true) {
            throw new Error(payload?.error === 'revision'
              ? 'revision conflict (re-read and retried)'
              : (payload?.error ?? `HTTP ${response.status}`))
          }
          if (Number.isFinite(payload.revision)) revision = payload.revision
          readiness = 'ready'
          readinessDetail = ''
          return payload
        }

        /**
         * Send only the rows that changed.
         *
         * The Host merges a sparse ledger patch beside the rows it does not
         * mention. Resending the whole ledger would make every write
         * O(conversations) — megabytes per flush once a project has hundreds of
         * them — for no benefit.
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
          stateDisposed = true
          if (writeTimer !== null) clearTimeout(writeTimer)
          if (stateTimer !== null) clearTimeout(stateTimer)
        }, 'dsh-cost: ledger timer')

        /**
         * Read the Host document, retrying with backoff until it answers.
         *
         * The Host half registers its routes from an asynchronous activation, so
         * the first read can legitimately lose that race; a bundle installed
         * without a restart answers 404 until the process is replaced. Retrying
         * keeps either case from settling into a dead panel — the notice stays
         * up, with its reason, until a read succeeds. Nothing is seeded into
         * storage either: the Host already resolves the effective-dated built-in
         * table, so a fresh install reads prices without writing anything.
         * @param adoptRows - whether the ledger travels with this read.
         * @returns whether the read succeeded.
         */
        async function attemptLoad(adoptRows) {
          const ok = await pull(adoptRows)
          loaded = ok
          if (ok) {
            if (ctx.sessions?.list !== undefined) fold(ctx.sessions.list.getSnapshot())
            notify()
            return true
          }
          const delay = RETRY_DELAYS[Math.min(stateAttempt, RETRY_DELAYS.length - 1)]
          stateAttempt += 1
          if (stateDisposed) return false
          if (stateTimer !== null) clearTimeout(stateTimer)
          stateTimer = setTimeout(() => {
            stateTimer = null
            void attemptLoad(adoptRows)
          }, delay)
          notify()
          return false
        }

        /** Retry right now: what every not-ready surface's button calls. */
        function retryNow() {
          if (stateTimer !== null) {
            clearTimeout(stateTimer)
            stateTimer = null
          }
          stateAttempt = 0
          readiness = 'loading'
          notify()
          void attemptLoad(true)
        }

        void attemptLoad(true)
        void probeBackfill()


        // ------------------------------------------------- not-ready diagnostics

        /**
         * What every surface shows while the Host namespace is unavailable.
         *
         * Deliberately LOUD rather than a bare `…`. The failure it names — a
         * Host half that was never loaded — is fixed by restarting DeepSeek
         * Harness, and nothing else in the UI says so: the settings page's own
         * route banner sits *after* the guard that this state cannot pass.
         * @param props - `{ compact: true }` renders the composer-pill variant.
         */
        function NotReady(props) {
          // A restarted host is exactly what this panel is waiting for, so the
          // button drives the same retry loop the background poll uses.
          const retry = () => retryNow()
          if (props?.compact === true) {
            // A button, not a dead label: the fix is outside the page, so this
            // doubles as the "I restarted it, check again" control.
            return h('button', {
              type: 'button',
              style: { ...PILL, ...(readiness === 'loading' ? MUTED : WARN) },
              onClick: retry,
              title: `${notReadyTitle()}\n${notReadyHint()}`,
            }, readiness === 'loading' ? '…' : t('notReadyShort'))
          }
          return h('div', { style: { padding: 24, maxWidth: 620 } },
            h('div', {
              style: { fontWeight: 600, ...(readiness === 'loading' ? MUTED : WARN) },
            }, notReadyTitle()),
            h('div', { style: { ...FAINTED, marginTop: 8, lineHeight: 1.75 } }, notReadyHint()),
            readinessDetail === '' ? null
              : h('div', { style: { ...FAINTED, marginTop: 6, fontFamily: 'ui-monospace, monospace', fontSize: size(13) } },
                readinessDetail),
            h('button', {
              type: 'button', style: { ...PILL, marginTop: 14 }, onClick: retry,
            }, t('notReadyRetry')),
          )
        }

        /** @returns the headline for the current readiness state. */
        function notReadyTitle() {
          if (readiness === 'loading') return t('notReadyLoading')
          return readiness === 'missing' ? t('notReadyMissing') : t('notReadyError')
        }

        /** @returns the actionable sentence for the current readiness state. */
        function notReadyHint() {
          if (readiness === 'loading') return ''
          return readiness === 'missing' ? t('notReadyMissingHint') : t('notReadyErrorHint')
        }

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
          const panelRef = React.useRef(null)

          // Close on Escape, or on a press anywhere outside the pill and its
          // popover. The popover is tall and covers the page it describes, so a
          // trigger-only toggle leaves the reader with no way out that does not
          // also spend money. Capture phase, so a press on another control both
          // closes this and reaches that control.
          React.useEffect(() => {
            if (!open || typeof document === 'undefined') return undefined
            const onPointerDown = event => {
              const target = event.target
              if (rootRef.current?.contains(target)) return
              if (panelRef.current?.contains(target)) return
              setOpen(false)
            }
            const onKeyDown = event => {
              if (event.key === 'Escape') setOpen(false)
            }
            document.addEventListener('pointerdown', onPointerDown, true)
            document.addEventListener('keydown', onKeyDown)
            return () => {
              document.removeEventListener('pointerdown', onPointerDown, true)
              document.removeEventListener('keydown', onKeyDown)
            }
          }, [open])

          // Touch the version so a ledger change re-renders this subtree.
          void version

          const symbol = config === null ? '¥' : (SYMBOLS[config.currency] ?? `${config.currency} `)
          const entry = ledger.get(sessionId)
          // No configuration: the Host half is missing or unreachable. Staying
          // silent here is what made "installed but not restarted" look like a
          // plugin that does nothing at all.
          if (config === null) {
            return readiness === 'loading' ? null : h(NotReady, { compact: true })
          }
          // A row exists only once the conversation reported tokens. This is the
          // ordinary "no spend yet" case and stays invisible on purpose.
          if (entry === undefined) return null

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
            ref: panelRef,
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
              entry.unpriced > 0 && h('span', { style: { ...WARN, fontSize: size(13) } }, '•'),
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
         * zero on its own. `timing` is the wall times the Host folded out of the
         * same log, recorded here so the panel's duration figures survive a host
         * that does not project `sessionStats` for this session.
         */
        function applyBackfill(sessionId, priced, totals, timing) {
          ledger.set(sessionId, {
            baseline: totals ?? { ...zeroBuckets() },
            byBucket: priced.byBucket,
            charged: priced.charged,
            byDay: priced.byDay ?? {},
            cost: priced.cost,
            credits: priced.credits,
            unpriced: priced.unpriced,
            llmMs: timing?.llmMs,
            toolMs: timing?.toolMs,
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
              applyBackfill(frame.sessionId, priced, totals, frame.timing)
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
          const budgets = value?.budgets !== null && typeof value?.budgets === 'object' ? value.budgets : {}
          return {
            currency: typeof value?.currency === 'string' ? value.currency : 'CNY',
            flushMs: Number.isFinite(value?.flushMs) ? value.flushMs : 4000,
            budgets: Object.entries(budgets).map(([scope, entry]) => ({
              scope,
              amount: Number.isFinite(entry?.amount) ? entry.amount : 0,
              period: typeof entry?.period === 'string' ? entry.period : 'month',
            })),
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
          if (config === null) return h(NotReady, null)
          if (draft === null) return h('div', { style: MUTED }, '…')

          // Reconciliation needs the one figure the settings page cannot derive: how
          // many tokens were consumed that no price covered.
          const unpricedTotal = [...ledger.values()].reduce((sum, row) => sum + (row.unpriced ?? 0), 0)
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
          const selectedProject = projects.find(group => group.workspaceId === (projectCwd === NO_PROJECT ? '' : projectCwd))
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
          const patchBudget = (index, patch) => {
            setDraft(current => {
              const budgets = (current.budgets ?? []).slice()
              budgets[index] = { ...budgets[index], ...patch }
              return { ...current, budgets }
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
              // A limit the Host would reject (amount <= 0) is dropped here rather
              // than saved as a limit of zero, which would read as "over budget".
              const budgets = {}
              for (const entry of draft.budgets ?? []) {
                if (!(entry.amount > 0)) continue
                budgets[entry.scope] = { amount: entry.amount, period: entry.period }
              }
              await write({ models, currency: draft.currency, flushMs: draft.flushMs, budgets })
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
                h('table', { style: { width: '100%', minWidth: TABLE_MIN_WIDTH, tableLayout: 'fixed', borderCollapse: 'collapse' } },
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
                        font: 'inherit', fontSize: size(15), cursor: 'pointer',
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
              h('div', { style: GROUP },
              h('div', { style: { fontWeight: 600, marginBottom: 8 } }, t('budgetTitle')),
              h('div', { style: { ...MUTED, marginBottom: 10, maxWidth: 720 } }, t('budgetHint')),
              (draft.budgets ?? []).length === 0
                ? h('div', { style: FAINTED }, t('budgetEmpty'))
                : h('div', null, ...(draft.budgets ?? []).map((entry, index) => h('div', {
                  key: `${entry.scope}#${String(index)}`,
                  style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 },
                },
                  h('select', {
                    style: { ...SELECT, width: 'min(240px, 100%)' },
                    value: entry.scope,
                    onChange: event => patchBudget(index, { scope: event.target.value }),
                  },
                    h('option', { value: '', style: OPTION }, t('budgetScopeAccount')),
                    h('option', { value: NO_PROJECT, style: OPTION }, t('reportNoProject')),
                    ...items.map(item => h('option', {
                      key: item?.workspaceId ?? 'none', value: item?.workspaceId ?? '', style: OPTION,
                    }, `${projectNameOf(items, item?.workspaceId ?? '')} · ${(item?.sessionIds ?? EMPTY_ARRAY).length}`))),
                  h('input', {
                    style: { ...INPUT, width: 110, textAlign: 'right' },
                    inputMode: 'decimal',
                    value: String(entry.amount ?? ''),
                    onChange: event => patchBudget(index, { amount: numberOrZero(event.target.value) }),
                  }),
                  h('select', {
                    style: { ...SELECT, width: 130 },
                    value: entry.period,
                    onChange: event => patchBudget(index, { period: event.target.value }),
                  },
                    h('option', { value: 'day', style: OPTION }, t('budgetPeriodDay')),
                    h('option', { value: 'month', style: OPTION }, t('budgetPeriodMonth')),
                    h('option', { value: 'all', style: OPTION }, t('budgetPeriodAll'))),
                  h('button', {
                    type: 'button', title: t('remove'), 'aria-label': t('remove'),
                    style: {
                      width: 22, height: 22, padding: 0, lineHeight: 1,
                      border: `1px solid ${hairline}`, borderRadius: 6,
                      background: 'transparent', color: SOFT,
                      font: 'inherit', fontSize: size(15), cursor: 'pointer',
                    },
                    onClick: () => {
                      setDraft(current => ({
                        ...current,
                        budgets: (current.budgets ?? []).filter((_, at) => at !== index),
                      }))
                      setStatus('')
                    },
                  }, '×'),
                ))),
              h('button', {
                type: 'button',
                style: { ...BUTTON, marginTop: 4 },
                onClick: () => {
                  // The first scope nobody has a limit for yet, so a new row is
                  // never a silent duplicate of an existing one.
                  const used = new Set((draft.budgets ?? []).map(entry => entry.scope))
                  const free = ['', ...items.map(item => item?.workspaceId ?? ''), NO_PROJECT]
                    .find(scopeId => !used.has(scopeId))
                  setDraft(current => ({
                    ...current,
                    budgets: [...(current.budgets ?? []), { scope: free ?? '', amount: 100, period: 'month' }],
                  }))
                  setStatus('')
                },
              }, t('budgetAdd')),
            ),

            h('div', { style: { ...GROUP, marginTop: 14 } },
              h('div', { style: { fontWeight: 600, marginBottom: 8 } }, t('reconTitle')),
              h('div', { style: { ...MUTED, marginBottom: 10, maxWidth: 760 } }, t('reconIntro')),
              h('div', { style: { display: 'grid', gap: 6 } },
                ...[
                  t('reconFormula'),
                  t('reconReasoning'),
                  t('reconCurrency'),
                  t('reconDelay', { ms: config.flushMs }),
                  t('reconUnpriced', { count: formatExact(unpricedTotal) }),
                  t('reconCoverage', {
                    rows: ledger.size,
                    ledger: ledger.size,
                    version: hostVersion === '' ? '?' : hostVersion,
                  }),
                  statePath === '' ? null : t('reconFile', { path: statePath }),
                ].filter(Boolean).map((line, index) => h('div', { key: String(index), style: MUTED }, `· ${line}`)),
              ),
            ),

            h('div', { style: { fontWeight: 600, marginBottom: 6 } }, t('backfillTitle')),
              h('div', { style: { ...MUTED, marginBottom: 10, maxWidth: 720 } }, t('backfillIntro')),
              h('div', { style: { ...FAINTED, marginBottom: 10, ...(backfillReady === false ? WARN : {}) } },
                backfillReady === undefined
                  ? '…'
                  : (backfillReady ? t('backfillReady') : t('backfillUnavailable'))
                  + (hostVersion === '' ? '' : ` · dsh-hermes-cost-meter v${hostVersion}`)),

              h('div', { style: { display: 'flex', gap: 18, flexWrap: 'wrap', marginBottom: 10 } },
                scopeOption('all', t('scopeAll', { count: allIds.length })),
                scopeOption('project', t('scopeProjectCount', { count: projects.length })),
                scopeOption('picked', t('scopePicked', { count: pickedIds.length })),
              ),

              scope === 'project' && h('select', {
                style: { ...SELECT, width: 'min(380px, 100%)', marginBottom: 8 },
                value: projectCwd,
                onChange: event => setProjectCwd(event.target.value),
              },
                h('option', { value: '', style: OPTION }, t('backfillPick')),
                ...projects.map(group => h('option', {
                  key: group.workspaceId || 'none', value: group.workspaceId === '' ? NO_PROJECT : group.workspaceId, style: OPTION,
                }, `${group.label} · ${group.ids.length}`)),
              ),

              scope === 'picked' && h('div', { style: { marginBottom: 8 } },
                h('input', {
                  style: { ...INPUT, width: 'min(380px, 100%)', marginBottom: 6 },
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
        /**
     * Scope value for the rows that belong to no workspace.
     *
     * An empty scope means "every project", so the no-project rows need a value
     * of their own: they used to share the empty one, which made their ranking
     * row and their dropdown entry do nothing at all when picked.
     */
    const NO_PROJECT = 'no-project'
    const REPORT_PAGE = 15
        /** Side-by-side chart groups only pair up when the column is wide enough. */
        const REPORT_COLUMN = '1 1 400px'

        /** One horizontal bar: a filled div, so no chart library is needed. */
        function Bar({ label, value, max, color, text, share }) {
          const width = max > 0 ? Math.max(value / max * 100, value > 0 ? 0.5 : 0) : 0
          return h('div', { style: { marginBottom: 9 } },
            h('div', { style: { ...ROW, ...MUTED, marginBottom: 3 } },
              h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, label),
              // The figure is what the reader came for; emphasis belongs here,
              // never on a footnote about missing data. Money and share keep
              // separate columns so the two never read as one number.
              h('span', { style: { display: 'inline-flex', gap: 16, alignItems: 'baseline', flex: '0 0 auto' } },
                h('span', { style: NUMBER }, text),
                share === undefined ? null : h('span', { style: SHARE }, share)),
            ),
            h('div', {
              style: {
                height: 10, borderRadius: 5, overflow: 'hidden',
                background: 'color-mix(in srgb, currentColor 10%, transparent)',
              },
            }, h('div', { style: { width: `${width}%`, height: '100%', background: color } })),
          )
        }

        /**
         * One legend line for a part-to-whole chart.
         *
         * Swatch and name on the left, then the amount and the share in the same
         * two right-hand columns the bars use, so a donut and a bar list can sit
         * side by side without the numbers jumping. `onSelect` turns the row into
         * a drill-down, which is how a chart stops being a dead picture.
         * @param props - `{ color, label, text, share, dim, onSelect }`.
         */
        function LegendRow({ color, label, text, share, dim = false, onSelect }) {
          const clickable = typeof onSelect === 'function'
          return h('div', {
            onClick: clickable ? () => onSelect() : undefined,
            title: clickable ? `${label} · ${text} ${share ?? ''}`.trim() : undefined,
            style: {
              ...ROW, ...MUTED, marginBottom: 6,
              ...(dim ? { opacity: 0.55 } : {}),
              ...(clickable ? { cursor: 'pointer' } : {}),
            },
          },
            h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 0 } },
              h('span', {
                style: {
                  width: 11, height: 11, borderRadius: 3, background: color,
                  display: 'inline-block', flex: '0 0 auto',
                },
              }),
              h('span', {
                title: label,
                style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
              }, label),
            ),
            h('span', { style: { display: 'inline-flex', gap: 16, alignItems: 'baseline', flex: '0 0 auto' } },
              h('span', { style: NUMBER }, text),
              share === undefined ? null : h('span', { style: SHARE }, share)),
          )
        }

        /**
         * The time window a view is showing.
         *
         * `'all'` has no cutoff; the rest are day offsets, matched against the
         * Beijing day keys the ledger already stores, because a window that
         * cannot be placed on the calendar cannot be priced.
         * @param range - `'all' | '30' | '7'`.
         * @returns the inclusive first day key, or '' for all time.
         */
        function cutoffOf(range) {
          if (range === 'all') return ''
          const days = Number(range)
          return dayKey(Date.now() - (days - 1) * 86400000)
        }

        /**
         * Read one ledger row inside a date window.
         *
         * The per-day map is the only part of a row that can be sliced by date, so
         * a windowed read sums it; with no cutoff the row's own cumulative totals
         * are authoritative. Timing counters are all-time by nature and stay on
         * the row.
         * @param row - one ledger row.
         * @param cutoff - inclusive first day key, or ''.
         * @returns `{ cost, credits, tokens, byBucket }` for that window.
         */
        function sumRange(row, cutoff) {
          if (cutoff === '') {
            return {
              cost: row.cost, credits: row.credits, tokens: tokensOf(row), byBucket: row.byBucket,
            }
          }
          let cost = 0
          let credits = 0
          let tokens = 0
          const byBucket = zeroBuckets()
          for (const [day, cell] of Object.entries(row.byDay)) {
            if (day < cutoff) continue
            cost += cell.cost
            credits += cell.credits
            tokens += cell.tokens
            for (const key of BUCKETS) byBucket[key] += cell.byBucket?.[key] ?? 0
          }
          return { cost, credits, tokens, byBucket }
        }

        /**
         * One toggle chip: the plugin's only "button that is on or off" look.
         * @param props - `{ active, label, onClick, title }`.
         */
        function Chip({ active, label, onClick, title }) {
          return h('button', {
            type: 'button',
            title,
            'aria-pressed': active,
            onClick,
            style: {
              ...BUTTON,
              padding: '3px 10px',
              fontSize: size(13),
              background: active ? 'color-mix(in srgb, currentColor 16%, transparent)' : 'transparent',
              fontWeight: active ? 600 : 400,
            },
          }, label)
        }

        /**
         * Whether a conversation's figures describe something that happened.
         *
         * No money and no *priced* tokens is not the same as no usage. A request
         * whose route had no price entry still burned tokens — they are recorded as
         * unpriced — and a session the plugin first met after the fact is all
         * baseline. Both are real conversations with real duration, and skipping
         * them silently removed their tool time from every total on the page.
         * @param figures - `{ cost, credits, tokens }`, already windowed if needed.
         */
        function hasUsage(figures) {
          return (figures.cost ?? 0) > 0 || (figures.credits ?? 0) > 0 || (figures.tokens ?? 0) > 0
        }

        /**
         * A ledger row's token total: what a price covered plus what it did not.
         *
         * `charged` alone understates a row whose route was unpriced, and that is
         * exactly the row a reader is most likely to be squinting at.
         */
        function tokensOf(row) {
          return totalOf(row.charged) + (row.unpriced ?? 0)
        }

        /**
         * A row's measured duration, and where it came from.
         *
         * The session projection is the host's own answer and is preferred. The
         * wall times the backfill folded out of the same log are the fallback, for
         * the sessions the host does not project: without it, a machine whose
         * projection cache was cold reported one hour of tool time where its logs
         * hold dozens — with every other figure on the page correct.
         */
        function timingOf(stats, row) {
          if (stats !== undefined) return stats
          if (Number.isFinite(row?.llmMs) || Number.isFinite(row?.toolMs)) {
            return { llmMs: row.llmMs ?? 0, toolMs: row.toolMs ?? 0 }
          }
          return undefined
        }

        /** A workspace's display name, or the label for conversations in none. */
        function projectNameOf(items, workspaceId) {
          return items.find(item => item?.workspaceId === workspaceId)?.title ?? t('reportNoProject')
        }

        /**
         * The project scope picker both views filter by.
         *
         * One component because it had been drawn twice and drifted: the project
         * view wrapped its copy in a muted label, so the same control came out grey
         * and a size smaller there while the account view drew it plainly. The label
         * survives as the control's accessible name rather than as visible text.
         * @param props - `{ value, all, projects, labelOf, onChange }`.
         */
        function ScopePicker({ value, all, projects, labelOf, onChange }) {
          return h('select', {
            style: { ...SELECT, width: 'min(240px, 100%)' },
            value,
            'aria-label': t('reportScope'),
            onChange: event => onChange(event.target.value),
          },
            h('option', { value: '', style: OPTION }, `${t('reportAllProjects')}（${all.length}）`),
            ...projects.map(group => h('option', {
              key: group.workspaceId || 'none',
              value: group.workspaceId === '' ? NO_PROJECT : group.workspaceId,
              style: OPTION,
            }, `${labelOf(group.workspaceId)} · ${group.count}`)),
          )
        }

        /**
         * The filter bar both views carry: back, scope, time window.
         *
         * The whole bar is one component because its parts drifted twice — the
         * scope picker lost its label on one side, and the back button existed on
         * the other — so the same screen offered different controls depending on
         * the tab. A bar assembled in one place cannot disagree with itself.
         * @param props - `{ scope, all, projects, labelOf, onScope, range, onRange }`.
         */
        function ViewBar({ scope, all, projects, labelOf, onScope, range, onRange }) {
          return h('div', {
            style: { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 14 },
          },
            scope !== '' && h('button', {
              type: 'button', style: BUTTON, onClick: () => onScope(''),
            }, `← ${t('dashBack')}`),
            h(ScopePicker, { value: scope, all, projects, labelOf, onChange: onScope }),
            h('span', { style: { flex: 1 } }),
            h(RangeChips, { value: range, onChange: onRange }),
          )
        }

        /**
         * What a scope has spent inside a budget period.
         *
         * The per-day map is the only date-sliceable figure, so `day` and `month`
         * read it and `all` reads the row total. Every amount was priced at the
         * instant its own request ran, which is what lets this number be lined up
         * against the official bill at all.
         * @param rows - the rows of one scope.
         * @param period - `'day' | 'month' | 'all'`.
         * @param today - today's Beijing day key.
         * @param month - the current Beijing month (`YYYY-MM`).
         * @returns the spend inside the period.
         */
        function spentIn(rows, period, today, month) {
          if (period === 'all') return rows.reduce((sum, row) => sum + row.cost, 0)
          let total = 0
          for (const row of rows) {
            for (const [day, cell] of Object.entries(row.byDay ?? {})) {
              if (period === 'day' ? day !== today : !day.startsWith(month)) continue
              total += cell.cost ?? 0
            }
          }
          return total
        }

        /**
         * Write one scope's limit into the stored configuration.
         *
         * The panel and the settings page write through the same route, so a limit set
         * from the panel is the same record the settings editor later shows — there is
         * no second source of truth for a budget.
         * @param scopeId - `''` for the account, `NO_PROJECT`, or a workspace id.
         * @param amount - the limit; a non-positive limit is refused by the Host.
         * @param period - `'day' | 'month' | 'all'`.
         */
        async function saveBudget(scopeId, amount, period) {
          const current = view?.value ?? {}
          const budgets = { ...(current.budgets ?? {}), [scopeId]: { amount, period } }
          try {
            await write({ ...current, budgets })
            await pull(false)
            notify()
            return true
          } catch (error) {
            // The input already blocks a non-positive limit, so a failure here is a
            // transport problem rather than user error; keep it off the page.
            console.warn('dsh-cost: budget write failed', error)
            return false
          }
        }
        /**
         * The current peak/off-peak tier and the countdown to the next switch.
         *
         * Every rate in the price table halves or doubles at the switch, so "which tier
         * am I in and when does it change" is a fact about the bill, not decoration.
         * The next boundary is found by walking forward a minute at a time and asking
         * the same `isOffPeak` predicate the pricing uses — the tier is then guaranteed
         * to agree with what is actually charged, which a second window formula would
         * not be.
         * @param models - the configured price rows.
         * @param holidays - Beijing dates that count as off-peak.
         * @returns `{ offPeak, minutes }`, or undefined when no row has peak pricing.
         */
        function tierCountdown(models, holidays) {
          const discount = (models ?? []).map(row => row.discount).find(entry => entry !== undefined)
          if (discount === undefined) return undefined
          const now = Date.now()
          const offPeak = isOffPeak(now, discount, holidays)
          for (let step = 1; step <= 26 * 60; step += 1) {
            if (isOffPeak(now + step * 60000, discount, holidays) !== offPeak) {
              return { offPeak, minutes: step }
            }
          }
          return { offPeak, minutes: undefined }
        }

        /**
         * The tier line: which side of the peak boundary we are on, and how long.
         * @param props - `{ models, holidays }`.
         */
        /**
         * The account balance line: what the provider says is left, and a refresh.
         *
         * The key is never touched here — the Host reads it from the harness credential
         * store and answers over `/api/cost/balance`. An unconfigured key or a failed
         * request is stated on the line rather than shown as a zero balance, because a
         * silent zero is indistinguishable from an empty account.
         */
        function BalanceLine() {
          const [state, setState] = React.useState({ status: 'idle' })
          const load = React.useCallback(async () => {
            setState({ status: 'loading' })
            try {
              const response = await fetch('/api/cost/balance', { method: 'POST' })
              const payload = await response.json().catch(() => null)
              if (payload?.ok === true && payload.balance !== undefined) {
                setState({
                  status: 'ready', balance: payload.balance, available: payload.available !== false,
                })
                return
              }
              setState({
                status: payload?.configured === false ? 'unset' : 'failed',
                reason: payload?.reason ?? `HTTP ${response.status}`,
              })
            } catch (error) {
              setState({ status: 'failed', reason: String(error).slice(0, 120) })
            }
          }, [])
          React.useEffect(() => { void load() }, [load])
          const money = value => formatMoney(value, SYMBOLS[state.balance?.currency] ?? '¥')
          return h('div', {
            style: {
              display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap',
              marginBottom: 10, color: SOFT, fontSize: size(14),
            },
          },
            h('span', null, t('balanceTitle')),
            state.status === 'ready'
              ? h('span', { style: { fontWeight: 600, color: 'inherit', fontSize: size(15) } },
                money(state.balance.total),
                ` (${t('balanceGranted')} ${money(state.balance.granted)}`
                + ` · ${t('balanceToppedUp')} ${money(state.balance.toppedUp)})`)
              : null,
            state.status === 'unset' ? h('span', null, t('balanceUnset')) : null,
            state.status === 'failed'
              ? h('span', { style: WARN }, t('balanceFailed', { reason: state.reason }))
              : null,
            h('button', {
              type: 'button',
              style: { ...BUTTON, padding: '1px 8px', fontSize: size(13.5) },
              disabled: state.status === 'loading',
              onClick: () => { void load() },
            }, state.status === 'loading' ? t('balanceLoading') : t('balanceRefresh')),
          )
        }
        function TierLine({ models, holidays }) {
          const tier = tierCountdown(models, holidays)
          if (tier === undefined) return null
          const label = tier.offPeak ? t('tierOffPeak') : t('tierPeak')
          const when = tier.minutes === undefined
            ? ''
            : ` · ${tier.offPeak ? t('tierUntilPeak') : t('tierUntilOffPeak')} `
              + formatDuration(tier.minutes * 60000)
          return h('div', {
            // The tier decides the rate on every token in the table below, so it is body
            // text, not a footnote — 12px muted grey read as "hidden".
            style: { color: SOFT, fontSize: size(14), marginBottom: 8 },
          },
            `${t('tierNow')} `,
            h('span', { style: { fontWeight: 600, color: 'inherit' } }, label),
            when)
        }

        /**
         * The budget's per-project split, folded to the top rows plus one remainder.
         *
         * Only segments that spent something inside the budget's own period are listed,
         * and the tail becomes a single `其他` row: a machine with five hundred projects
         * must not turn the budget line into a five-hundred-row legend. Colors come from
         * the same series the donut and the rankings use, in the same order, so a segment
         * can be matched to those charts by colour alone.
         * @param rows - every row the budget covers.
         * @param period - `'day' | 'month' | 'all'`.
         * @param today - today's Beijing day key.
         * @param month - the current Beijing month.
         * @param labelOf - maps a scope key to its display name.
         * @returns `{ label, value, color }[]`, largest first.
         */
        function budgetSegmentsOf(rows, period, today, month, labelOf) {
          const byScope = new Map()
          for (const row of rows) {
            const key = row.workspaceId === undefined || row.workspaceId === '' ? NO_PROJECT : row.workspaceId
            const value = spentIn([row], period, today, month)
            if (!(value > 0)) continue
            byScope.set(key, (byScope.get(key) ?? 0) + value)
          }
          return topWithOther(
            [...byScope].map(([key, value]) => ({ label: labelOf(key), value })),
            BUDGET_SEGMENTS,
          ).map((segment, index) => ({ ...segment, color: SERIES[index % SERIES.length] }))
        }

        /**
         * The label a scope is known by, in both the bar and the settings editor. */
        function scopeLabelOf(scope, items) {
          if (scope === '') return t('budgetScopeAccount')
          if (scope === NO_PROJECT) return t('reportNoProject')
          return projectNameOf(items, scope)
        }

        /**
         * The budget line when this scope has no limit yet — with the editor inline.
         *
         * Three earlier versions of this failed in three different ways: the bar only
         * appeared once a budget existed; the editor lived at the bottom of a long
         * settings page; and the editor offered a scope dropdown whose default did not
         * follow the view, so setting a limit while looking at a project wrote it to the
         * account and the line looked inert. The editor now applies to **the scope being
         * shown** — the label beside it says which — and reports its own outcome, because
         * a button that appears to do nothing is worse than one that fails loudly.
         * @param props - `{ label, spent, money, onSave }`; `onSave(amount, period)`.
         */
        function BudgetHint({ label, spent, money, onSave }) {
          const [amount, setAmount] = React.useState(100)
          const [period, setPeriod] = React.useState('month')
          const [result, setResult] = React.useState('idle')
          const save = async () => {
            setResult('saving')
            setResult(await onSave(amount, period) ? 'saved' : 'failed')
          }
          return h('div', { style: { ...GROUP, padding: '10px 14px', marginBottom: 14 } },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
              h('span', { style: { fontWeight: 600 } }, t('budgetTitle')),
              h('span', { style: MUTED },
                `${label} · ${t('budgetSpentAll')} ${money(spent)} · ${t('budgetUnset')}`),
              h('span', { style: { flex: 1 } }),
              h('input', {
                style: { ...INPUT, width: 100, textAlign: 'right' },
                inputMode: 'decimal',
                'aria-label': t('budgetAmount'),
                value: String(amount),
                onChange: event => setAmount(numberOrZero(event.target.value)),
              }),
              h('select', {
                style: { ...SELECT, width: 120 },
                value: period,
                'aria-label': t('budgetPeriod'),
                onChange: event => setPeriod(event.target.value),
              },
                h('option', { value: 'day', style: OPTION }, t('budgetPeriodDay')),
                h('option', { value: 'month', style: OPTION }, t('budgetPeriodMonth')),
                h('option', { value: 'all', style: OPTION }, t('budgetPeriodAll'))),
              h('button', {
                type: 'button',
                style: BUTTON,
                disabled: !(amount > 0) || result === 'saving',
                onClick: () => { void save() },
              }, result === 'saving' ? t('budgetSaving') : t('budgetSet')),
              result === 'saved' ? h('span', { style: MUTED }, t('saved')) : null,
              result === 'failed' ? h('span', { style: WARN }, t('budgetFailed')) : null,
            ),
          )
        }

        /**
         * The budget bar: the limit, the spend, and how much of the limit is gone.
         *
         * "How much has this module cost me" is the question this panel is opened
         * with, so the limit for whatever scope the view is showing sits above the
         * figures it limits — account-wide when nothing is drilled into, and that
         * project's own limit once one is. A budget nobody can see is not a budget.
         * The window the limit is measured over is part of the label, and the three
         * windows are listed underneath: a bar reading "今日" beside a total that reads
         * all-time looks like the total changed, which is how a correct figure gets
         * reported as a bug.
         * @param props - `{ label, spent, amount, period, windows, segments, money, onSave }`.
         */
        function BudgetBar({ label, spent, amount, period, windows, segments, money, onSave }) {
          const [editing, setEditing] = React.useState(false)
          const [draftAmount, setDraftAmount] = React.useState(amount)
          const [draftPeriod, setDraftPeriod] = React.useState(period)
          const [result, setResult] = React.useState('idle')
          const ratio = amount > 0 ? spent / amount : 0
          const level = ratio >= 1 ? OVER : (ratio >= 0.8 ? WARN : undefined)
          const percent = `${(ratio * 100).toFixed(1)}%`
          // Segments are scaled against the larger of the limit and the spend, so going
          // over budget shrinks the bar instead of overflowing it; the limit is then
          // drawn as its own line, which says by how much it was passed.
          const parts = editing ? [] : (segments ?? []).filter(segment => segment.value > 0)
          const scale = Math.max(amount, spent, 0.0001)
          return h('div', { style: { ...GROUP, padding: '10px 14px', marginBottom: 14 } },
            h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' } },
              h('span', { style: { fontWeight: 600 } }, t('budgetTitle')),
              h('span', { style: MUTED },
                `${label} · ${t(`budgetPeriod${period[0].toUpperCase()}${period.slice(1)}`)}`),
              h('span', { style: { flex: 1 } }),
              h('span', { style: { fontWeight: 600 } }, `${money(spent)} / ${money(amount)}`),
              h('span', { style: { ...FAINTED, ...(level ?? {}) } },
                percent
                + (ratio >= 1
                  ? ` · ${t('budgetOver')} ${money(spent - amount)}`
                  : (ratio >= 0.8 ? ` · ${t('budgetWarn')}` : ''))),
              // A limit nobody can revise is a limit nobody keeps, so it is editable
              // here rather than only on a settings page.
              h('button', {
                type: 'button',
                style: { ...BUTTON, padding: '2px 10px', fontSize: size(13.5) },
                onClick: () => {
                  setDraftAmount(amount)
                  setDraftPeriod(period)
                  setResult('idle')
                  setEditing(value => !value)
                },
              }, editing ? t('budgetCancel') : t('budgetEdit')),
            ),
            windows === undefined
              ? null
              : h('div', { style: { color: SOFT, fontSize: size(13.5), marginTop: 6 } },
                `${t('budgetPeriodDay')} ${money(windows.day)}`
                + ` · ${t('budgetPeriodMonth')} ${money(windows.month)}`
                + ` · ${t('budgetPeriodAll')} ${money(windows.all)}`),
            editing
              ? h('div', {
                style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: 8 },
              },
                h('input', {
                  style: { ...INPUT, width: 100, textAlign: 'right' },
                  inputMode: 'decimal',
                  'aria-label': t('budgetAmount'),
                  value: String(draftAmount),
                  onChange: event => setDraftAmount(numberOrZero(event.target.value)),
                }),
                h('select', {
                  style: { ...SELECT, width: 120 },
                  value: draftPeriod,
                  'aria-label': t('budgetPeriod'),
                  onChange: event => setDraftPeriod(event.target.value),
                },
                  h('option', { value: 'day', style: OPTION }, t('budgetPeriodDay')),
                  h('option', { value: 'month', style: OPTION }, t('budgetPeriodMonth')),
                  h('option', { value: 'all', style: OPTION }, t('budgetPeriodAll'))),
                h('button', {
                  type: 'button',
                  style: BUTTON,
                  disabled: !(draftAmount > 0) || result === 'saving',
                  onClick: async () => {
                    setResult('saving')
                    const ok = await onSave(draftAmount, draftPeriod)
                    setResult(ok ? 'saved' : 'failed')
                    if (ok) setEditing(false)
                  },
                }, result === 'saving' ? t('budgetSaving') : t('budgetSave')),
                result === 'saved' ? h('span', { style: MUTED }, t('budgetSaved')) : null,
                result === 'failed' ? h('span', { style: WARN }, t('budgetFailed')) : null,
              )
              : h('div', {
                style: {
                  position: 'relative', height: 8, borderRadius: 4, marginTop: 8,
                  background: 'color-mix(in srgb, currentColor 14%, transparent)', overflow: 'hidden',
                },
              },
                ...(parts.length > 0
                  ? parts.map((segment, index) => h('div', {
                    key: `${segment.label}#${String(index)}`,
                    title: `${segment.label} · ${money(segment.value)}`,
                    style: {
                      display: 'inline-block', height: '100%', verticalAlign: 'top',
                      width: `${(segment.value / scale) * 100}%`, background: segment.color,
                    },
                  }))
                  : [h('div', {
                    key: 'total',
                    style: {
                      height: '100%', width: `${Math.min(100, Math.max(0, ratio * 100))}%`,
                      background: 'currentColor', opacity: level === OVER ? 1 : 0.75,
                      ...(level ?? {}),
                    },
                  })]),
                spent > amount
                  ? h('div', {
                    style: {
                      position: 'absolute', top: 0, bottom: 0, width: 2,
                      left: `${(amount / scale) * 100}%`, background: 'currentColor',
                    },
                  })
                  : null,
              ),
            // The legend names what each colour is; the tail is one `其他` row however
            // many projects it covers.
            !editing && parts.length > 0
              ? h('div', { style: { marginTop: 8 } },
                ...parts.map((segment, index) => h(LegendRow, {
                  key: `${segment.label}#${String(index)}`,
                  color: segment.color,
                  label: segment.label,
                  text: money(segment.value),
                  share: `${((segment.value / amount) * 100).toFixed(1)}%`,
                })))
              : null,
          )
        }

        /**
         * The time-window switch both views carry.
         *
         * A spend report without a date axis answers "how much ever", which is the
         * least useful question a bill can be asked; the account view had the
         * switch and the project view did not, so the same filter is rendered by
         * both from here.
         * @param props - `{ value, onChange }`.
         */
        function RangeChips({ value, onChange }) {
          return h('div', { style: { display: 'flex', gap: 4 } },
            ...[['all', t('dashAllTime')], ['30', t('dash30')], ['7', t('dash7')]].map(([key, label]) =>
              h(Chip, { key, active: value === key, label, onClick: () => onChange(key) })),
          )
        }

        /**
         * Part-to-whole composition: a donut with its legend.
         *
         * A billing bucket is a share of one total, which is what a donut states
         * directly; four full-width bars stated it as four lengths the reader had
         * to compare. Ranking stays on bars — order and magnitude are the point
         * there, and a many-slice pie would be worse than the list.
         *
         * Every bucket is listed, including a zero one: "cache writes cost
         * nothing" is a fact about the tariff, not an absence of data, and a row
         * that appears on one view and not the other is what made the two views
         * look like two products. Zero rows are dimmed instead of dropped.
         * @param props - `{ title, slices, money, empty, style }`.
         */
        function Composition({ title, slices, money, empty, style }) {
          const total = slices.reduce((sum, slice) => sum + slice.value, 0)
          return h('div', { style: { ...GROUP, ...style } },
            h('div', { style: { fontWeight: 600, marginBottom: 10 } }, title),
            total <= 0
              ? h(EmptyState, { title: empty, compact: true })
              : h('div', {
                style: {
                  display: 'flex', gap: 24, alignItems: 'center', flexWrap: 'wrap',
                  // Donut and legend read as one unit; letting the row stretch made
                  // the chart look abandoned on the left of an empty group.
                  maxWidth: 620,
                },
              },
                h(Pie, { slices: slices.filter(slice => slice.value > 0), size: 168 }),
                h(Legend, { slices, money }),
              ),
          )
        }

        /**
         * The legend beside a donut.
         *
         * Bounded on purpose. The money and share columns stay aligned across
         * rows, but a legend that stretches to the group's width parks them a
         * screen away from the labels they belong to — the numbers stop reading as
         * part of their row. `flex: 0 1 340px` keeps the pair together and still
         * wraps under the chart on a narrow panel.
         * @param props - `{ slices, money, onSelect }`; a zero slice is dimmed,
         * never dropped. `onSelect(slice)` makes every row a drill-down target.
         */
        function Legend({ slices, money, onSelect }) {
          const total = slices.reduce((sum, slice) => sum + slice.value, 0)
          const share = value => (total > 0 ? `${(value / total * 100).toFixed(1)}%` : '—')
          return h('div', { style: { flex: '0 1 340px', minWidth: 0 } },
            ...slices.map((slice, index) => h(LegendRow, {
              key: String(index),
              color: slice.color,
              label: slice.label,
              text: money(slice.value),
              share: share(slice.value),
              dim: !(slice.value > 0),
              onSelect: onSelect === undefined ? undefined : () => onSelect(slice),
            })),
          )
        }

        /**
         * SVG pie.
         *
         * A single 100% slice cannot be expressed as an arc (start and end
         * coincide), so that case draws a circle instead of a degenerate path.
         *
         * Slices are drill targets when the caller passes `onSelect`: the shape is
         * the part of the chart a reader aims at, and a share that can only be
         * acted on through the legend beside it is a picture rather than a control.
         * A slice with no `id` (the "other" remainder) is not clickable, because
         * there is nothing to drill into.
         * @param props - `{ slices, size, onSelect, titleOf }`; `size` is the drawn
         * diameter in px, `titleOf(slice)` supplies the hover text.
         */
        function Pie({ slices, size = 150, onSelect, titleOf }) {
          const total = slices.reduce((sum, slice) => sum + slice.value, 0)
          if (!(total > 0)) return null
          const target = slice => (typeof onSelect === 'function' && slice.id !== undefined
            ? {
              onClick: () => onSelect(slice),
              style: { cursor: 'pointer' },
              hitTitle: titleOf === undefined ? undefined : titleOf(slice),
            }
            : {})
          // `title` must be an SVG child element to become the native tooltip.
          const shape = (slice, drawing) => {
            const { hitTitle, ...handlers } = target(slice)
            return h(drawing.type, { ...drawing.props, ...handlers },
              hitTitle === undefined ? null : h('title', null, hitTitle))
          }
          if (slices.length === 1) {
            return h('svg', { viewBox: '0 0 100 100', width: size, height: size },
              shape(slices[0], {
                type: 'circle', props: { cx: 50, cy: 50, r: 42, fill: slices[0].color },
              }))
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
            paths.push(shape(slice, {
              type: 'path',
              props: {
                key: String(index),
                d: `M50,50 L${x1.toFixed(3)},${y1.toFixed(3)} A42,42 0 ${sweep > Math.PI ? 1 : 0} 1 ${x2.toFixed(3)},${y2.toFixed(3)} Z`,
                fill: slice.color,
              },
            }))
          }
          return h('svg', { viewBox: '0 0 100 100', width: size, height: size }, ...paths)
        }

        /** Fold a list into at most `limit` named totals plus one remainder row. */
        function topWithOther(rows, limit) {
          const sorted = [...rows].sort((a, b) => b.value - a.value)
          if (sorted.length <= limit) return sorted
          const head = sorted.slice(0, limit)
          const rest = sorted.slice(limit).reduce((sum, row) => sum + row.value, 0)
          return [...head, { label: t('reportOther'), value: rest }]
        }

        /**
         * One statistic in a page's summary row.
         *
         * Both views answer with figures, and they used to draw them at two
         * different sizes with two different paddings — the same "total spend"
         * read as a different element depending on the tab. The card is shared;
         * which figures a view shows is that view's business.
         * @param props - `{ value, label, note }`.
         */
        function StatCard({ value, label, note }) {
          return h('div', { style: { minWidth: 128 } },
            h('div', { style: { fontSize: size(24), fontWeight: 600, lineHeight: 1.3 } }, value),
            h('div', { style: FAINTED }, label),
            note === undefined ? null : h('div', { style: { ...FAINTED, marginTop: 2 } }, note),
          )
        }

        /** The summary row both views open with; `stats` are {@link StatCard} props. */
        function StatRow({ stats }) {
          return h('div', { style: GROUP },
            h('div', { style: { display: 'flex', gap: 28, flexWrap: 'wrap' } },
              ...stats.map(stat => h(StatCard, { key: stat.label, ...stat }))),
          )
        }

        /**
         * The one empty state.
         *
         * `compact` is the in-chart variant: a chart with no data states it in
         * place, while a page with no data states it where the page would be.
         * Both come from here so "no data" cannot look like two different bugs.
         * @param props - `{ title, hint, compact }`.
         */
        function EmptyState({ title, hint, compact = false }) {
          if (compact === true) {
            return h('div', { style: { ...FAINTED, padding: '4px 0' } }, title)
          }
          return h('div', { style: { maxWidth: 640, margin: '72px auto', textAlign: 'center' } },
            h('div', { style: { fontSize: size(15), fontWeight: 600, marginBottom: 8 } }, title),
            hint === undefined ? null : h('div', { style: MUTED }, hint),
          )
        }

        /**
         * The conversation detail table both views end with.
         *
         * One table, six columns, one pagination — the two views used to differ by
         * a whole column (duration) and by what the cost column MEANT, which is
         * the kind of difference that makes two numbers disagree without either
         * being wrong. The cost basis is passed in and printed beside the pager,
         * so the reader can see which one they are looking at.
         * @param props - `{ rows, total, page, pageCount, onPage, costNote, money, projectOf }`.
         */
        function ConversationTable({ rows, total, page, pageCount, onPage, costNote, money, projectOf }) {
          const cell = (content, extra) => h('td', {
            style: { ...TD, ...(extra ?? {}), borderBottom: `1px solid ${hairline}` },
          }, content)
          return h('div', { style: GROUP },
            h('div', { style: { fontWeight: 600, marginBottom: 10 } },
              `${t('reportTop')} · ${t('reportCount', { count: total })}`),
            h('div', { style: { overflowX: 'auto' } },
              h('table', {
                style: { width: '100%', minWidth: 640, tableLayout: 'fixed', borderCollapse: 'collapse' },
              },
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
                h('tbody', null, ...rows.map(row => h('tr', { key: row.id },
                  cell(h('span', {
                    title: row.title,
                    style: { display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                  }, row.title)),
                  cell(projectOf(row.workspaceId), FAINTED),
                  cell(row.models.length === 1 ? row.models[0] : t('reportMultiModel'), FAINTED),
                  cell(formatTokens(row.tokens), { ...FAINTED, textAlign: 'right' }),
                  cell(row.hasStats ? formatDuration(row.llmMs + row.toolMs) : '—',
                    { ...FAINTED, textAlign: 'right' }),
                  cell(money(row.cost), { textAlign: 'right' }),
                ))),
              ),
            ),
            h('div', { style: { ...MUTED, display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 } },
              h('button', {
                type: 'button', style: BUTTON, disabled: page === 0,
                onClick: () => onPage(Math.max(0, page - 1)),
              }, t('reportPrev')),
              h('span', null, t('reportPage', { page: page + 1, pages: pageCount, total })),
              h('button', {
                type: 'button', style: BUTTON, disabled: page >= pageCount - 1,
                onClick: () => onPage(Math.min(pageCount - 1, page + 1)),
              }, t('reportNext')),
              costNote === undefined ? null : h('span', { style: FAINTED }, costNote),
            ),
          )
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
          const [range, setRange] = React.useState('all')
          const [page, setPage] = React.useState(0)
          void version
          if (config === null) return h(NotReady, null)

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
          const projectLabel = workspaceId => projectNameOf(items, workspaceId)


          // Conversations that actually happened. A baselined row that never ran
          // is noise in every chart, but a row with no *priced* figure is not the
          // same thing — see `hasUsage`: unpriced tokens and session-only history
          // are still conversations, and dropping them hid their duration.
          const all = []
          const cutoff = cutoffOf(range)
          for (const [id, row] of ledger) {
            // Every figure on this view is read through the same window, so the
            // charts, the ranking and the detail table cannot disagree about what
            // "spend" means while a date filter is on.
            const windowed = sumRange(row, cutoff)
            const stats = byId[id]?.projectionValues?.sessionStats
            const timing = timingOf(stats, row)
            if (!hasUsage(windowed) && timing === undefined) continue
            // The timing counters ride along so the shared detail table can show
            // its duration column on this view too; they are not sliceable by
            // date, which is why they stay all-time figures.
            all.push({
              id,
              // The row's own workspace first: a spawned child session is not in any
              // workspace's sessionIds list, so the list alone cannot place it.
              workspaceId: row.workspaceId ?? ownerOf.get(id)?.workspaceId ?? '',
              title: labelOf(id),
              cost: windowed.cost,
              credits: windowed.credits,
              tokens: windowed.tokens,
              byBucket: windowed.byBucket,
              hasStats: timing !== undefined,
              llmMs: timing?.llmMs ?? 0,
              toolMs: timing?.toolMs ?? 0,
              models: typeof row.model === 'string' && row.model.length > 0
                ? row.model.split(', ')
                : [],
              // The per-day map rides along so a drilled-in project can show its
              // own calendar; it is the same map the account view reads.
              byDay: row.byDay ?? EMPTY_OBJECT,
            })
          }
          const rows = scope === '' ? all : all.filter(row => row.workspaceId === (scope === NO_PROJECT ? '' : scope))
          // The limit that applies to whatever this view is showing.
          const budgetToday = dayKey(Date.now())
          const budgetMonth = budgetToday.slice(0, 7)
          const budget = config.budgets?.[scope]

          // Project facts are read from the LEDGER, not from the windowed rows: how long
          // a project has been going and when it started are all-time facts, and a
          // seven-day filter must not be able to shrink them. The ledger's per-day map is
          // the only date source available here, so the figures are day-precise.
          const projectRows = scope === ''
            ? []
            : [...ledger.entries()].filter(([id]) =>
              (ownerOf.get(id)?.workspaceId ?? '') === (scope === NO_PROJECT ? '' : scope))
          const projectDays = [...new Set(projectRows.flatMap(([, row]) => Object.keys(row.byDay ?? {})))].sort()
          const projectFirst = projectDays[0] ?? '—'
          const projectLast = projectDays[projectDays.length - 1] ?? '—'
          const projectSpanDays = projectDays.length === 0 ? 0
            : Math.round((Date.parse(`${projectLast}T00:00:00Z`) - Date.parse(`${projectFirst}T00:00:00Z`)) / 86400000) + 1
          const projectLlmMs = projectRows.reduce((sum, [, row]) => sum + (row.llmMs ?? 0), 0)
          const projectToolMs = projectRows.reduce((sum, [, row]) => sum + (row.toolMs ?? 0), 0)

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
              ? projects.map(group => ({
                label: projectLabel(group.workspaceId), value: group.value, id: group.workspaceId,
              }))
              : rows.map(row => ({ label: row.title, value: row.cost, id: row.id })),
            PIE_SLICES,
          ).map((slice, index) => ({ ...slice, color: SERIES[index % SERIES.length] }))

          const buckets = BUCKETS.map((key, index) => ({
            key,
            value: sumBy(rows, row => row.byBucket[key] ?? 0),
            color: SERIES[index % SERIES.length],
          }))

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

          // Drilled into one project, the first question is "how long has this been
          // going", and the answer is a calendar: the project's own days, all-time
          // rather than windowed — a span you have narrowed to 7 days cannot say
          // how long the work has lasted.
          const projectDayTotals = new Map()
          if (scope !== '') {
            for (const row of rows) {
              for (const [day, cell] of Object.entries(row.byDay)) {
                const slot = projectDayTotals.get(day) ?? { tokens: 0, cost: 0, credits: 0 }
                slot.tokens += cell.tokens ?? 0
                slot.cost += cell.cost ?? 0
                slot.credits += cell.credits ?? 0
                projectDayTotals.set(day, slot)
              }
            }
          }

          const share = value => (totalCost > 0 ? `${(value / totalCost * 100).toFixed(1)}%` : '—')

          // One drill-down handler shared by the donut's slices, its legend rows
          // and the ranking bars; scoped to a single project the pie shows
          // conversations, which are not a scope this view can enter.
          const drillInto = pieByProject
            ? slice => { setScope(slice.id === '' ? NO_PROJECT : slice.id); setPage(0) }
            : undefined

          // No data at all is a page-level state, not a line of warning text: the
          // same component the account view uses says it the same way here.
          if (all.length === 0) {
            return h(EmptyState, { title: t('dashEmpty'), hint: t('dashEmptyHint') })
          }

          const body = h(React.Fragment, null,
            // ---- the same filter bar the account view carries
            h(ViewBar, {
              scope,
              all,
              projects,
              labelOf: projectLabel,
              onScope: next => { setScope(next); setPage(0) },
              range,
              onRange: next => { setRange(next); setPage(0) },
            }),

            // ---- which side of the peak boundary we are on, and the limit below it
            h(TierLine, { models: config.models, holidays: config.holidays }),
            h(BalanceLine, null),

            // ---- the limit for whatever scope this view is showing, always visible
            budget === undefined
              ? h(BudgetHint, {
                label: scopeLabelOf(scope, items),
                spent: spentIn(rows, 'all', budgetToday, budgetMonth),
                money,
                onSave: (amount, period) => saveBudget(scope, amount, period),
              })
              : h(BudgetBar, {
                label: scopeLabelOf(scope, items),
                spent: spentIn(rows, budget.period, budgetToday, budgetMonth),
                amount: budget.amount,
                period: budget.period,
                // Every project's share of the same period, coloured like the donut.
                windows: {
                  day: spentIn(rows, 'day', budgetToday, budgetMonth),
                  month: spentIn(rows, 'month', budgetToday, budgetMonth),
                  all: spentIn(rows, 'all', budgetToday, budgetMonth),
                },
                segments: budgetSegmentsOf(
                  rows, budget.period, budgetToday, budgetMonth, id => scopeLabelOf(id, items),
                ),
                money,
                onSave: (amount, period) => saveBudget(scope, amount, period),
              }),

            // ---- inside a project, its own calendar comes first: how long the
            // work has been going is the question a project view is opened with
            scope !== '' && h(ActivityPanel, { dayTotals: projectDayTotals, money }),

            h(StatRow, {
              stats: [
                {
                  value: money(totalCost) + (totalCredits > 0 ? ` + ${formatCredits(totalCredits)}` : ''),
                  label: t('reportTotalCost'),
                },
                { value: formatTokens(totalTokens), label: t('reportTotalTokens') },
                scope === ''
                  ? { value: String(projects.length), label: t('reportProjects') }
                  : { value: projectFirst, label: t('projFirst') },
                scope === ''
                  ? { value: String(rows.length), label: t('reportConversations') }
                  : { value: projectLast, label: t('projLast') },
                // Inside a project the row answers that project's own questions: when it
                // started, how long it has run, how many days were worked, and the wall
                // times — the windowed cards above stay about money and tokens.
                ...(scope === ''
                  ? []
                  : [
                    { value: `${projectSpanDays} ${t('projDays')}`, label: t('projSpan') },
                    { value: `${projectDays.length} ${t('projDays')}`, label: t('projActiveDays') },
                    {
                      value: formatDuration(projectLlmMs),
                      label: t('dashLlmTime'),
                      note: range === 'all' ? undefined : t('dashAllTimeOnly'),
                    },
                    {
                      value: formatDuration(projectToolMs),
                      label: t('dashToolTime'),
                      note: range === 'all' ? undefined : t('dashAllTimeOnly'),
                    },
                    { value: String(projectRows.length), label: t('reportConversations') },
                  ]),
              ],
            }),

            // ---- composition beside the model ranking: two half-width groups
            // rather than one full-width row with an empty right half
            h('div', { style: { display: 'flex', gap: 14, flexWrap: 'wrap' } },
              h(Composition, {
                title: t('reportByBucket'),
                slices: buckets.map(entry => ({ label: t(entry.key), value: entry.value, color: entry.color })),
                money,
                empty: t('reportEmpty'),
                style: { flex: REPORT_COLUMN, minWidth: 0, marginBottom: 14 },
              }),
              h('div', { style: { ...GROUP, flex: REPORT_COLUMN, minWidth: 0 } },
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

            // ---- the project dimension, both halves of it: the share a donut
            // states and the ranking a list states, each row a drill-down
            h('div', { style: { display: 'flex', gap: 14, flexWrap: 'wrap' } },
              h('div', { style: { ...GROUP, flex: REPORT_COLUMN, minWidth: 0 } },
                h('div', { style: { fontWeight: 600, marginBottom: 10 } },
                  pieByProject ? t('reportByProject') : t('reportByConversation')),
                h('div', {
                  style: { display: 'flex', gap: 22, alignItems: 'center', flexWrap: 'wrap', maxWidth: 620 },
                },
                  // Both the slices and the legend rows drill into the project:
                  // the shape is what a reader aims at, the list is what they
                  // read, and a chart where only the list works feels broken.
                  h(Pie, {
                    slices: pieSlices,
                    size: 168,
                    onSelect: drillInto,
                    titleOf: slice => `${slice.label} · ${money(slice.value)} ${share(slice.value)}`
                      + (drillInto === undefined ? '' : ` · ${t('reportDrill')}`),
                  }),
                  h(Legend, { slices: pieSlices, money, onSelect: drillInto }),
                ),
              ),

              h('div', { style: { ...GROUP, flex: REPORT_COLUMN, minWidth: 0 } },
                h('div', { style: { fontWeight: 600, marginBottom: 10 } }, t('dashByProject')),
                projects.length === 0 && h('div', { style: FAINTED }, '—'),
                ...projects.slice(0, 8).map((group, index) => h('div', {
                  key: group.workspaceId || 'none',
                  title: `${projectLabel(group.workspaceId)} · ${t('reportDrill')}`,
                  style: { marginBottom: 4, cursor: 'pointer' },
                  onClick: () => { setScope(group.workspaceId === '' ? NO_PROJECT : group.workspaceId); setPage(0) },
                },
                  h(Bar, {
                    label: projectLabel(group.workspaceId),
                    value: group.value,
                    max: projects[0].value,
                    color: SERIES[index % SERIES.length],
                    text: money(group.value),
                    share: share(group.value),
                  }),
                )),
                reportsNote(projects.length > 8, projects.length - 8),
              ),
            ),

            h(ConversationTable, {
              rows: pageRows,
              total: ranked.length,
              page: current,
              pageCount,
              onPage: setPage,
              costNote: range === 'all' ? t('costAllTime') : t('costInRange'),
              money,
              projectOf: projectLabel,
            }),
          )

          // This is a main panel now, so it already owns the full column; the
          // former settings-section fullscreen escape hatch is gone with it. The
          // panel header (title + tabs + filters) belongs to the tab host, not to
          // this view: two views under one entry must not each draw their own.
          return body
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
          // Big enough to read a day's value off the grid; a year of weeks still
          // fits the page's width, and the grid is the dashboard's main chart.
          const CELL = 16
          const GAP = 4
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
              rx: 3.5,
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
                // lines and reads as broken text rather than a broken month.
                style: { position: 'absolute', left: entry.column * STEP, whiteSpace: 'nowrap' },
              }, entry.label)),
            ),
          )
        }

        /**
         * The activity heatmap block: title, switches, calendar, caption.
         *
         * One component for both views. The account view feeds it every
         * conversation; a drilled-in project feeds it only that project's days,
         * which is how "how long has this been going" gets answered for a
         * project. The grid always spans the trailing {@link HEAT_WEEKS} weeks —
         * a contribution graph IS a calendar — so the span line underneath states
         * the part that a fixed grid cannot: the first and last day with data.
         * @param props - `{ dayTotals, money, note }`; `dayTotals` maps a day key
         * to `{ tokens, cost, credits }`, `note` is an optional faint footnote.
         */
        function ActivityPanel({ dayTotals, money, note }) {
          const [metric, setMetric] = React.useState('token')
          const [mode, setMode] = React.useState('day')
          const [hover, setHover] = React.useState(null)
          const dayKeys = [...dayTotals.keys()].sort()
          if (dayKeys.length === 0) return null

          const today = dayKey(Date.now())
          const todayMs = Date.parse(`${today}T00:00:00Z`)
          // Extend to the Saturday of the current week so the last column is whole.
          const gridEndMs = todayMs + (6 - new Date(todayMs).getUTCDay()) * 86400000
          const gridStartMs = gridEndMs - (HEAT_WEEKS * 7 - 1) * 86400000
          const heatDays = daysBetween(
            new Date(gridStartMs).toISOString().slice(0, 10),
            new Date(gridEndMs).toISOString().slice(0, 10),
          )
          // The heatmap can be coloured by tokens or by money. Money is the whole
          // point of this plugin, so it must be selectable here too.
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
          const firstDay = dayKeys[0]
          const lastDay = dayKeys[dayKeys.length - 1]
          const spanDays = Math.round(
            (Date.parse(`${lastDay}T00:00:00Z`) - Date.parse(`${firstDay}T00:00:00Z`)) / 86400000,
          ) + 1

          return h('div', { style: GROUP },
            h('div', {
              style: { display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 10, flexWrap: 'wrap' },
            },
              h('span', { style: { fontWeight: 600 } }, t('dashActivity')),
              h('span', { style: { flex: 1 } }),
              h('div', { style: { display: 'flex', gap: 4 } },
                h(Chip, {
                  active: metric === 'token', label: t('dashMetricToken'),
                  onClick: () => setMetric('token'),
                }),
                h(Chip, {
                  active: metric === 'cost', label: t('dashMetricCost'),
                  onClick: () => setMetric('cost'),
                }),
              ),
              h('div', { style: { display: 'flex', gap: 4 } },
                h(Chip, { active: mode === 'day', label: t('dashDaily'), onClick: () => setMode('day') }),
                h(Chip, { active: mode === 'week', label: t('dashWeekly'), onClick: () => setMode('week') }),
                h(Chip, {
                  active: mode === 'total', label: t('dashCumulative'),
                  onClick: () => setMode('total'),
                }),
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
            // "How long was this worked on": the grid is a fixed calendar, so the
            // span it covers and the span the data covers have to be said apart.
            h('div', { style: { ...FAINTED, marginTop: 4 } },
              t('dashSpan', { from: firstDay, to: lastDay, span: spanDays, days: dayKeys.length })),
            // Deliberately faint, not a warning banner: this is a footnote about
            // missing data, and it must never out-shout the figures it sits under.
            note === undefined ? null : h('div', { style: { ...FAINTED, marginTop: 4 } }, note),
            hover !== null && h('div', {
              style: {
                position: 'fixed', zIndex: 1100, pointerEvents: 'none',
                left: Math.min(hover.x + 12, window.innerWidth - 220),
                top: Math.max(hover.y - 44, 8),
                padding: '5px 9px', borderRadius: 8, fontSize: size(13),
                border: `1px solid ${hairline}`,
                background: 'color-mix(in srgb, Canvas 92%, CanvasText)',
                color: 'CanvasText', boxShadow: '0 6px 18px rgba(0,0,0,.3)',
              },
            }, `${hover.day} · ${formatTokens(hover.detail?.tokens ?? 0)} tok`
              + ` · ${money(hover.detail?.cost ?? 0)}`),
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

          const [page, setPage] = React.useState(0)

          void version
          if (config === null) return h(NotReady, null)

          const symbol = SYMBOLS[config.currency] ?? `${config.currency} `
          const money = value => formatMoney(value, symbol)
          const statsOf = id => byId[id]?.projectionValues?.sessionStats

          const ownerOf = new Map()
          for (const item of items) {
            for (const id of item?.sessionIds ?? EMPTY_ARRAY) ownerOf.set(id, item)
          }
          const projectTitle = workspaceId => projectNameOf(items, workspaceId)


          // Every conversation that carries a figure, with its day map and its
          // all-time timing counters (those are not sliceable by date).
          const all = []
          for (const [id, row] of ledger) {
            const stats = statsOf(id)
            const timing = timingOf(stats, row)
            const figures = { cost: row.cost, credits: row.credits, tokens: tokensOf(row) }
            // Zero usage AND no session stats means the plugin merely baselined a
            // conversation that never ran here; anything else is a real row.
            if (!hasUsage(figures) && timing === undefined) continue
            all.push({
              id,
              // The row's own workspace first: a spawned child session is not in any
              // workspace's sessionIds list, so the list alone cannot place it.
              workspaceId: row.workspaceId ?? ownerOf.get(id)?.workspaceId ?? '',
              title: byId[id]?.displayTitle ?? byId[id]?.title ?? id,
              cost: row.cost,
              credits: row.credits,
              tokens: tokensOf(row),
              cacheRead: row.charged.cacheRead ?? 0,
              byBucket: row.byBucket,
              byDay: row.byDay ?? {},
              updatedAt: row.updatedAt,
              // Absent timing is not zero time; the table must say so.
              hasStats: timing !== undefined,
              models: typeof row.model === 'string' && row.model.length > 0
                ? row.model.split(', ')
                : [],
              llmMs: timing?.llmMs ?? 0,
              toolMs: timing?.toolMs ?? 0,
              ttftMs: stats?.ttftMs ?? 0,
              ttftSteps: stats?.ttftSteps ?? 0,
              decodeMs: stats?.decodeMs ?? 0,
              decodeTokens: stats?.decodeTokens ?? 0,
            })
          }
          const scoped = scope === '' ? all : all.filter(row => row.workspaceId === (scope === NO_PROJECT ? '' : scope))
          // The limit that applies to whatever this view is showing.
          const budgetToday = dayKey(Date.now())
          const budgetMonth = budgetToday.slice(0, 7)
          const budget = config.budgets?.[scope]
          // A duration figure that silently omits conversations is worse than one
          // that says how many it could not measure.
          const untimed = scoped.filter(row => row.hasStats !== true).length

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

          const ranked = [...scoped]
            .map(row => ({ ...row, viewedCost: rangedCost.get(row.id) ?? 0 }))
            .sort((a, b) => b.viewedCost - a.viewedCost)
          const pageCount = Math.max(1, Math.ceil(ranked.length / REPORT_PAGE))
          const current = Math.min(page, pageCount - 1)
          const pageRows = ranked.slice(current * REPORT_PAGE, (current + 1) * REPORT_PAGE)

          // The heatmap block owns its own metric/mode/hover state now; this view
          // only says which days it is about.
          const heatNotes = []
          if (undated.length > 0 && range !== 'all') heatNotes.push(t('dashUndated', { count: undated.length }))
          if (undated.length > 0) heatNotes.push(t('dashNeedBackfill', { count: undated.length }))
          const heatNote = heatNotes.length === 0 ? undefined : heatNotes.join(' ')

          const shareOf = value => (totalCost > 0 ? `${(value / totalCost * 100).toFixed(1)}%` : '—')

          if (all.length === 0) {
            return h(EmptyState, { title: t('dashEmpty'), hint: t('dashEmptyHint') })
          }

          return h('div', null,
            // ---- the same filter bar the project view carries
            h(ViewBar, {
              scope,
              all,
              projects,
              labelOf: projectTitle,
              onScope: next => { setScope(next); setPage(0) },
              range,
              onRange: next => { setRange(next); setPage(0) },
            }),

            // ---- which side of the peak boundary we are on, and the limit below it
            h(TierLine, { models: config.models, holidays: config.holidays }),
            h(BalanceLine, null),

            // ---- the limit for whatever scope this view is showing, always visible
            budget === undefined
              ? h(BudgetHint, {
                label: scopeLabelOf(scope, items),
                spent: spentIn(scoped, 'all', budgetToday, budgetMonth),
                money,
                onSave: (amount, period) => saveBudget(scope, amount, period),
              })
              : h(BudgetBar, {
                label: scopeLabelOf(scope, items),
                spent: spentIn(scoped, budget.period, budgetToday, budgetMonth),
                amount: budget.amount,
                period: budget.period,
                // Every project's share of the same period, coloured like the donut.
                windows: {
                  day: spentIn(scoped, 'day', budgetToday, budgetMonth),
                  month: spentIn(scoped, 'month', budgetToday, budgetMonth),
                  all: spentIn(scoped, 'all', budgetToday, budgetMonth),
                },
                segments: budgetSegmentsOf(
                  scoped, budget.period, budgetToday, budgetMonth, id => scopeLabelOf(id, items),
                ),
                money,
                onSave: (amount, period) => saveBudget(scope, amount, period),
              }),

            // ---- statistic cards (rule 1: three questions above the fold)
            h(StatRow, {
              stats: [
                {
                  value: money(totalCost) + (totalCredits > 0 ? ` + ${formatCredits(totalCredits)}` : ''),
                  label: t('reportTotalCost'),
                },
                { value: formatTokens(totalTokens), label: t('reportTotalTokens') },
                {
                  value: formatDuration(llmMs),
                  label: t('dashLlmTime'),
                  note: range === 'all' ? undefined : t('dashAllTimeOnly'),
                },
                { value: String(conversations), label: t('reportConversations') },
                { value: formatTokens(cacheReadTokens), label: t('dashCacheRead') },
                {
                  value: formatDuration(toolMs),
                  label: t('dashToolTime'),
                  note: range === 'all' ? undefined : t('dashAllTimeOnly'),
                },
              ],
            }),
            untimed > 0 && h('div', { style: { ...FAINTED, marginBottom: 12 } },
              t('dashUntimed', { count: untimed })),

            // ---- activity heatmap (rule 6: adaptive span, never a fixed year)
            h(ActivityPanel, { dayTotals, money, note: heatNote }),

            // ---- composition and ranking
            h('div', { style: { display: 'flex', gap: 14, flexWrap: 'wrap' } },
              h(Composition, {
                title: t('reportByBucket'),
                slices: BUCKETS.map((key, index) => ({
                  label: t(key), value: bucketCost[key], color: SERIES[index % SERIES.length],
                })),
                money,
                empty: t('reportEmpty'),
                style: { flex: REPORT_COLUMN, minWidth: 0 },
              }),
              h('div', { style: { ...GROUP, flex: REPORT_COLUMN } },
                h('div', { style: { fontWeight: 600, marginBottom: 10 } }, t('dashByProject')),
                projects.length === 0 && h('div', { style: FAINTED }, '—'),
                ...projects.slice(0, 8).map((group, index) => h('div', {
                  key: group.workspaceId || 'none',
                  style: { marginBottom: 4, cursor: 'pointer' },
                  onClick: () => { setScope(group.workspaceId === '' ? NO_PROJECT : group.workspaceId); setPage(0) },
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
            h(ConversationTable, {
              rows: pageRows,
              total: ranked.length,
              page: current,
              pageCount,
              onPage: setPage,
              costNote: range === 'all' ? t('costAllTime') : t('costInRange'),
              money,
              projectOf: projectTitle,
            }),
          )
        }

        /** One-line disclosure that a list was truncated. */
        function reportsNote(condition, count) {
          return condition ? h('div', { style: { ...FAINTED, marginTop: 6 } }, `… +${count}`) : null
        }

        /**
         * The panel's view switch: two large tabs.
         *
         * Sized as page-level navigation rather than as a filter chip — these
         * switch the whole page, so they sit on their own full-width row under
         * the title, marked by an underline on the active one. No fills: a grey
         * plane behind a title reads as chrome nobody asked for, and the bar's own
         * hairline is the only line this switch needs.
         * @param props - `{ value, options, onChange }`; options are `{ value, label }`.
         */
        function Tabs({ value, options, onChange }) {
          return h('div', {
            style: { display: 'flex', gap: 4, borderBottom: `1px solid ${hairline}` },
          }, ...options.map(option => {
            const active = option.value === value
            return h('button', {
              key: option.value,
              type: 'button',
              'aria-pressed': active,
              onClick: () => onChange(option.value),
              style: {
                ...BUTTON,
                padding: '10px 26px',
                fontSize: size(16),
                fontWeight: active ? 600 : 500,
                color: active ? 'inherit' : SOFT,
                border: 'none',
                background: 'transparent',
                borderRadius: 0,
                borderBottom: `2px solid ${active ? 'currentColor' : 'transparent'}`,
                marginBottom: -1,
              },
            }, option.label)
          }))
        }

        /**
         * The single 「花费统计」 panel: one header, two views as tabs.
         *
         * Both views answer the same question from different angles, so they share
         * one sidebar entry and one page header; account spend is the default
         * because "what have I spent" is the question a spender arrives with. The
         * header is plain type on the page background — no band, no fill — and only
         * the visible view is mounted.
         * @param props - the slot host's shares, forwarded to the active view.
         */
        function CostPanel(props) {
          const [tab, setTab] = React.useState('account')
          return h('div', { style: PAGE },
            h('div', { style: { marginBottom: 14 } },
              h('div', { style: { fontSize: size(17), fontWeight: 600, marginBottom: 10 } }, t('panelTitle')),
              h(Tabs, {
                value: tab,
                onChange: setTab,
                options: [
                  { value: 'account', label: t('dashTitle') },
                  { value: 'projects', label: t('reportTitle') },
                ],
              }),
              // One line for the whole panel, not one per view: both views read
              // the same ledger, and a sentence that appears on only one tab is
              // how the two came to feel like two products.
              h('div', { style: { ...FAINTED, marginTop: 10, maxWidth: 820 } }, t('reportIntro')),
            ),
            tab === 'account' ? h(CostDashboard, props) : h(CostReport, props),
          )
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

        // One sidebar entry, two views: "what have I spent in total" (account) and
        // "where did it go" (project) are the same page asked two ways, and two
        // entries made the sidebar longer than the difference between them. A
        // sidebar panellist id addresses the main panel of the same key, so the id
        // and the key must still agree.
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'cost',
          order: 1,
          label: () => t('panelTitle'),
        }, boundary('cost icon', CostIcon)))

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: 'cost',
        }, boundary('cost panel', CostPanel)))

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
