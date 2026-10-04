/**
 * The Client's pricing round-trip, with no browser involved.
 *
 * It loads the real bundle, runs `apply` against a stubbed shell, drives the
 * session subscription so the meter has something to price, and asserts the
 * priced ledger reaches the Host route. It then renders every surface through a
 * two-pass hook-capable renderer, so "the panel shows numbers" is checked too —
 * the failure this guards is a plugin that is registered, loaded, and blank.
 *
 * Usage: node tools/check-client-ledger.mjs [client.js]
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runInThisContext } from 'node:vm'

/** The Host half sits beside the Client bundle in this package. */
const clientPath = resolve(process.argv[2] ?? 'client.js')
const bundle = readFileSync(clientPath, 'utf8')
const hostPath = join(dirname(clientPath), 'index.js')

/* --------------------------------------------------------------- globals */

let definition = null
globalThis.window = { __ModuleLoader__: { load: candidate => { definition = candidate } } }

const calls = []
let stateDocument = null
globalThis.fetch = async (url, options = {}) => {
  const method = options.method ?? 'GET'
  calls.push({ url, method, body: options.body })
  if (url === '/api/cost/state' && method === 'GET') {
    return new Response(JSON.stringify(stateDocument), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  if (url === '/api/cost/state' && method === 'POST') {
    const body = JSON.parse(options.body)
    return new Response(JSON.stringify({ ok: true, revision: (body.revision ?? 0) + 1 }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  if (url === '/api/cost/config' && method === 'POST') {
    // The Host merges a config patch and answers the new revision; the stub has to do
    // the same, or a write that works in the product looks like a 404 here.
    const body = JSON.parse(options.body)
    stateDocument = { ...stateDocument, revision: (body.revision ?? 0) + 1, config: { ...stateDocument.config, ...(body.config ?? {}) } }
    return new Response(JSON.stringify({ ok: true, revision: stateDocument.revision }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  if (url === '/api/cost/backfill') {
    return new Response('{"type":"start","total":0}\n{"type":"done","done":0,"total":0}\n', { status: 200, headers: { 'content-type': 'application/x-ndjson' } })
  }
  return new Response('not found', { status: 404 })
}

/* ------------------------------------------------- hook-capable React stub */

const hookState = new Map()
let cursor = { index: 0, path: '' }
let pendingEffects = []

const slot = () => ({ key: `${cursor.path}#${cursor.index++}` })

const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  Component: class { constructor(props) { this.props = props ?? {}; this.state = {} } setState() {} },
  useReducer: (reducer, initial) => {
    const { key } = slot()
    if (!hookState.has(key)) hookState.set(key, initial)
    return [hookState.get(key), action => { hookState.set(key, reducer(hookState.get(key), action)) }]
  },
  useState: initial => {
    const { key } = slot()
    if (!hookState.has(key)) hookState.set(key, typeof initial === 'function' ? initial() : initial)
    return [hookState.get(key), next => { hookState.set(key, typeof next === 'function' ? next(hookState.get(key)) : next) }]
  },
  useEffect: effect => { slot(); pendingEffects.push(effect) },
  useLayoutEffect: effect => { slot(); pendingEffects.push(effect) },
  useMemo: factory => { slot(); return factory() },
  useCallback: fn => { slot(); return fn },
  useRef: value => { slot(); return { current: value } },
  useSyncExternalStore: (subscribe, get) => { slot(); return get() },
  memo: component => component,
  Fragment: 'Fragment',
}

const require = name => {
  if (name === 'react') return React
  throw new Error(`unexpected require: ${name}`)
}

/* ------------------------------------------------------------- shell stubs */

const registrations = []
const slots = {
  inject: (name, callback) => { callback(); return () => {} },
  register: (spec, component) => { registrations.push({ spec, component }); return () => {} },
  provideRoot: () => () => {},
  entries: () => [],
  entriesOfSlot: () => [],
  subscribe: () => () => {},
}

let sessionSubscriber = null
let snapshot = { ids: [], byId: {} }
const sessions = {
  list: {
    subscribe: listener => { sessionSubscriber = listener; return () => { sessionSubscriber = null } },
    getSnapshot: () => snapshot,
  },
}

const localeStrings = {}
const locale = {
  register: (ns, lang, table) => { localeStrings[`${ns}:${lang}`] = table },
  bind: ns => (key, params) => {
    const template = (localeStrings[`${ns}:zh`] ?? {})[key] ?? key
    return params === undefined
      ? template
      : template.replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? ''))
  },
}

const ctx = {
  effect: run => run(),
  logger: { info: () => {}, warn: message => console.log('client warn:', message), error: message => console.log('client error:', message) },
  locale,
  slots,
  sessions,
}

/* ---------------------------------------------------------------- harness */

const host = await import(pathToFileURL(hostPath).href)
/** A day well outside every window the UI offers, so the time axis is testable. */
const OLD_DAY = '2026-08-01'
const OLD_COST = 1.0
/** Today in the ledger's own day key, so a seeded row lands inside a window. */
const TODAY = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
stateDocument = {
  ok: true,
  version: 1,
  revision: 7,
  config: {
    ...host.resolveConfig(null),
    flushMs: 600,
    // A limit on the PROJECT only: the account view must then state that no limit
    // is set (and where one goes), and the drilled-in project must show the bar.
    budgets: { w1: { amount: 2, period: 'all' } },
  },
  ledger: {
    'session-old': {
      baseline: { cacheRead: 0, cacheMiss: 0, cacheWrite: 0, output: 0 },
      byBucket: { cacheRead: 0, cacheMiss: 0, cacheWrite: 0, output: 0 },
      charged: { cacheRead: 0, cacheMiss: 0, cacheWrite: 0, output: 1000 },
      byDay: {
        [OLD_DAY]: {
          tokens: 1000,
          cost: OLD_COST,
          credits: 0,
          byBucket: { cacheRead: 0, cacheMiss: 0, cacheWrite: 0, output: 1000 },
        },
      },
      cost: OLD_COST,
      credits: 0,
      unpriced: 0,
      model: 'deepseek-flash',
      updatedAt: 1,
    },
    // Usage whose route had no price entry: real tokens, no money. This row used
    // to be dropped from the whole view — tokens, duration and all — because the
    // only test was "has money or priced tokens".
    'session-unpriced-only': {
      baseline: { cacheRead: 0, cacheMiss: 0, cacheWrite: 0, output: 0 },
      byBucket: { cacheRead: 0, cacheMiss: 0, cacheWrite: 0, output: 0 },
      charged: { cacheRead: 0, cacheMiss: 0, cacheWrite: 0, output: 0 },
      byDay: {
        [TODAY]: {
          tokens: 4321,
          cost: 0,
          credits: 0,
          byBucket: { cacheRead: 0, cacheMiss: 0, cacheWrite: 0, output: 4321 },
        },
      },
      cost: 0,
      credits: 0,
      unpriced: 4321,
      model: '',
      updatedAt: 2,
    },
    // A session the plugin only ever met after the fact: the whole usage is
    // baseline, so every figure is zero — but the session ran for an hour, and
    // an hour of tool time must not disappear because nothing was charged.
    'session-baseline': {
      baseline: { cacheRead: 0, cacheMiss: 0, cacheWrite: 0, output: 0 },
      byBucket: { cacheRead: 0, cacheMiss: 0, cacheWrite: 0, output: 0 },
      charged: { cacheRead: 0, cacheMiss: 0, cacheWrite: 0, output: 0 },
      byDay: {},
      cost: 0,
      credits: 0,
      unpriced: 0,
      model: 'deepseek-flash',
      updatedAt: 3,
    },
    // A session whose wall time exists only in this plugin's own record: the host
    // carried no `sessionStats` for it. Without the ledger fallback its seven
    // hours of model time vanished from the panel's totals.
    'session-timed': {
      baseline: { cacheRead: 0, cacheMiss: 0, cacheWrite: 0, output: 0 },
      byBucket: { cacheRead: 0, cacheMiss: 0, cacheWrite: 0, output: 0 },
      charged: { cacheRead: 0, cacheMiss: 1000, cacheWrite: 0, output: 500 },
      byDay: {
        [TODAY]: {
          tokens: 1500,
          cost: 0.5,
          credits: 0,
          byBucket: { cacheRead: 0, cacheMiss: 1000, cacheWrite: 0, output: 500 },
        },
      },
      cost: 0.5,
      credits: 0,
      unpriced: 0,
      llmMs: 7 * 3600000,
      toolMs: 0,
      model: 'deepseek-flash',
      updatedAt: 4,
    },
  },
}

runInThisContext(bundle, { filename: 'dsh-hermes-cost-meter-client.js' })
if (definition === null) throw new Error('the bundle never called window.__ModuleLoader__.load')
const client = definition.factory(require)
client.apply(ctx)

const usageOf = (overrides = {}) => ({
  cacheReadTokens: 0, uncachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, ...overrides,
})
const row = (usage, stats) => ({
  projectionValues: {
    tokenUsage: usage,
    modelSelection: { lastUsed: { provider: 'deepseek-official', model: 'deepseek-flash' } },
    ...(stats === undefined ? {} : { sessionStats: stats }),
  },
})
/** One hour of tool time: the figure a dropped row takes with it. */
const HOUR_MS = 3600000

await new Promise(resolve => setTimeout(resolve, 50))
snapshot = { ids: ['session-a'], byId: { 'session-a': row(usageOf()) } }
sessionSubscriber()
snapshot = {
  ids: ['session-a', 'session-unpriced', 'session-baseline'],
  byId: {
    'session-a': row(usageOf({ cacheReadTokens: 100000, uncachedInputTokens: 50000, outputTokens: 20000 })),
    // Unpriced usage still has a live projection; so does the baselined session,
    // and that projection is the only place its duration exists.
    'session-unpriced': row(usageOf(), { llmMs: 0, toolMs: HOUR_MS, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0 }),
    'session-baseline': row(usageOf(), { llmMs: 0, toolMs: HOUR_MS, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0 }),
  },
}
sessionSubscriber()
await new Promise(resolve => setTimeout(resolve, 1200))

/* --------------------------------------------------------- two-pass render */

const render = (element, path, depth = 0) => {
  if (element === null || element === undefined) return element
  if (typeof element === 'string' || typeof element === 'number') return element
  if (Array.isArray(element)) return element.map((child, index) => render(child, `${path}.${index}`, depth))
  const { type, props, children } = element
  const childProps = children === undefined || children.length === 0 ? props : { ...props, children }
  if (typeof type === 'function') {
    const isClass = typeof type.prototype?.render === 'function'
    if (isClass) return render(new type(childProps).render(), `${path}<${type.name}>`, depth + 1)
    const previous = cursor
    cursor = { index: 0, path: `${path}<${type.name ?? 'anon'}>` }
    const output = type(childProps)
    const ownPath = cursor.path
    cursor = previous
    return render(output, ownPath, depth + 1)
  }
  return {
    type,
    props: childProps,
    children: (children ?? []).map((child, index) => render(child, `${path}.${index}`, depth + 1)),
  }
}

const renderSurface = (element, keepState = false) => {
  let tree = null
  // A fresh surface starts from fresh hook state; a re-render after a click has
  // to keep whatever that click set.
  if (keepState !== true) hookState.clear()
  for (let pass = 0; pass < 4; pass += 1) {
    pendingEffects = []
    tree = render(element, 'root', 0)
    if (pendingEffects.length === 0) break
    const effects = pendingEffects
    pendingEffects = []
    for (const effect of effects) effect()
  }
  return tree
}

const flatten = node => {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(flatten).join(' ')
  return flatten(node.children)
}

/** Input values are props, not children: the price table lives entirely there. */
const inputValues = node => {
  if (node === null || node === undefined || typeof node === 'string') return ''
  if (Array.isArray(node)) return node.map(inputValues).join(' ')
  const own = node.type === 'input' && node.props?.value !== undefined ? String(node.props.value) : ''
  return `${own} ${inputValues(node.children)}`
}

/* -------------------------------------------------------------- assertions */

const results = []
const check = (label, ok, detail = '') => {
  results.push(ok === true)
  console.log(`${ok === true ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : `  (${detail})`}`)
}

check('module id is the package name', definition.id === 'dsh-hermes-cost-meter', definition.id)
check('inject list dropped remote.settings',
  JSON.stringify(client.inject) === JSON.stringify(['slots', 'locale', 'sessions']), JSON.stringify(client.inject))
check('state route read once on load', calls.filter(c => c.url === '/api/cost/state' && c.method === 'GET').length === 1)
check('no settings-namespace call anywhere', !calls.some(entry => String(entry.url).includes('settings')))
check('backfill route probed', calls.filter(c => c.url === '/api/cost/backfill').length === 1)

const writes = calls.filter(c => c.url === '/api/cost/state' && c.method === 'POST')
check('priced ledger flushed to the host', writes.length >= 1, `writes=${writes.length}`)
const payload = writes.length === 0 ? null : JSON.parse(writes[writes.length - 1].body)
const stored = payload?.ledger?.['session-a']
check('flush carries the touched session row', stored !== undefined)
check('revision travelled with the write', payload?.revision === 7, `revision=${payload?.revision}`)
check('all four usage buckets charged',
  stored?.charged?.cacheRead === 100000 && stored?.charged?.cacheMiss === 50000 && stored?.charged?.output === 20000,
  JSON.stringify(stored?.charged))
check('cost priced above zero', (stored?.cost ?? 0) > 0, `cost=${stored?.cost}`)
check('day rows recorded for the heatmap', Object.keys(stored?.byDay ?? {}).length === 1,
  JSON.stringify(Object.keys(stored?.byDay ?? {})))
// The not-ready copy must name the route whose absence it reports: that string
// is the only thing telling a user the fix is a restart, not a refresh.
for (const lang of ['zh', 'en']) {
  const table = localeStrings[`dsh-cost:${lang}`] ?? {}
  check(`${lang} not-ready hint names the host route`,
    typeof table.notReadyMissingHint === 'string' && table.notReadyMissingHint.includes('/api/cost/state'),
    String(table.notReadyMissingHint ?? '').slice(0, 48))
}

const shellProps = {
  useSessions: selector => selector(snapshot),
  useWorkspaces: selector => selector({ items: [{ workspaceId: 'w1', title: 'md', sessionIds: ['session-a'] }] }),
}

// One sidebar entry, two views as tabs. The sidebar contract keys a panel by id
// and addresses the main slot by the same key, so a stray second entry shows up
// here as a longer list rather than as a missing panel.
const panelEntries = registrations.filter(item => item.spec?.name === 'sidebar.panellist')
const mainEntries = registrations.filter(item => item.spec?.name === 'main')
check('the sidebar carries exactly one spend entry',
  panelEntries.length === 1 && panelEntries[0].spec?.id === 'cost',
  panelEntries.map(item => item.spec?.id).join(',') || 'none')
check('the main slot carries exactly that key',
  mainEntries.length === 1 && mainEntries[0].spec?.key === 'cost',
  mainEntries.map(item => item.spec?.key).join(',') || 'none')

const costPanel = mainEntries[0]
const accountTree = renderSurface(React.createElement(costPanel.component, shellProps))
let accountText = ''
let accountError = null
try {
  accountText = flatten(accountTree).replace(/\s+/g, ' ')
} catch (caught) {
  accountError = caught
}
check('the spend panel renders content', accountError === null && accountText.trim().length > 0,
  accountError === null ? `${accountText.trim().length} chars` : String(accountError))

const zhStrings = localeStrings['dsh-cost:zh'] ?? {}
const accountTab = zhStrings.dashTitle
const projectsTab = zhStrings.reportTitle
check('both view tabs render',
  accountText.includes(accountTab) && accountText.includes(projectsTab),
  `${accountTab} / ${projectsTab}`)
check('account spend is the default view',
  accountText.includes(zhStrings.dashActivity) && !accountText.includes(zhStrings.reportByModel),
  accountText.slice(0, 90))
// 1.00 seeded on an old day + 0.132 priced live + 0.50 seeded today, so "all time"
// and "last 7 days" are different numbers and a view that ignores the window is
// caught.
const ALL_TIME_TOTAL = /¥1\.63/
const WEEK_TOTAL = /¥0\.63/
check('the account view totals all time by default', ALL_TIME_TOTAL.test(accountText), accountText.slice(0, 100))

// A conversation whose route had no price entry, and one the plugin only ever
// baselined, both ran: they must stay in the view (and in the totals) instead of
// being filtered out as "no figures".
check('unpriced usage stays in the view',
  accountText.includes('session-unpriced-only') && /4\.3K/.test(accountText),
  accountText.includes('session-unpriced-only')
    ? `listed, its tokens read ${accountText.match(/\d+(?:\.\d+)?K/)?.[0] ?? 'none'}`
    : 'dropped')
check('a baselined session still contributes its duration',
  accountText.includes('2小时0分'),
  accountText.match(/\d+小时[\d分秒]*/g)?.join(' ') ?? 'no duration rendered')

// The host's `sessionStats` is preferred when present, but it is not always
// carried: the wall time this plugin folded out of the log is the fallback, and
// without it a session with seven recorded hours contributed nothing.
check('recorded wall time survives a missing host projection',
  accountText.includes('7小时0分'),
  accountText.match(/\d+小时[\d分秒]*/g)?.join(' ') ?? 'no duration rendered')

// A limit drives a warning, so it has to be on screen next to the spend it limits
// — and the warning has to be a warning, not the same text as a normal figure.
// With no limit set for this scope, the line must still be there and must say how
// to set one: a feature that only appears after it is configured is invisible.
check('a scope without a budget offers the editor inline',
  accountText.includes(zhStrings.budgetTitle) && accountText.includes(zhStrings.budgetUnset)
    && accountText.includes(zhStrings.budgetSet) && accountText.includes('¥1.63'),
  accountText.match(/预算[^。]{0,80}/)?.[0] ?? 'no budget line')

check('the panel states the current peak tier',
  accountText.includes(zhStrings.tierNow)
    && (accountText.includes(zhStrings.tierPeak) || accountText.includes(zhStrings.tierOffPeak)),
  accountText.match(/峰谷：当前[^ ]{0,30}/)?.[0] ?? 'no tier line')

/** Press the button whose label matches, as a user would. */
const pressButton = (tree, label) => {
  const button = treeNodes(tree).find(node => node.type === 'button'
    && flatten(node.children).includes(label))
  if (button === undefined) return false
  button.props.onClick()
  return true
}


/** Every element of a rendered tree, flattened. */
const treeNodes = node => {
  if (node === null || node === undefined || typeof node !== 'object') return []
  if (Array.isArray(node)) return node.flatMap(treeNodes)
  return [node, ...treeNodes(node.children ?? [])]
}
// The editor must target the scope being SHOWN and must write it: an editor with its
// own scope picker defaulted to the account wrote the limit to the wrong scope while
// the reader was looking at a project, so the line looked inert.
const budgetButton = treeNodes(accountTree).find(node => node.type === 'button'
  && flatten(node.children).includes(zhStrings.budgetSet))
check('the inline editor has a set button', budgetButton !== undefined)
const configWritesBefore = calls.filter(c => c.url === '/api/cost/config' && c.method === 'POST').length
budgetButton?.props.onClick()
await new Promise(resolve => setTimeout(resolve, 30))
const configWrites = calls.filter(c => c.url === '/api/cost/config' && c.method === 'POST')
check('setting the limit writes it for the scope on screen',
  configWrites.length === configWritesBefore + 1
    && String(configWrites[configWrites.length - 1]?.body ?? '').includes('"budgets"')
    && String(configWrites[configWrites.length - 1]?.body ?? '').includes('100'),
  String(configWrites[configWrites.length - 1]?.body ?? '').slice(0, 120))
// The write must land on the scope the reader is looking at — the account here — and
// must be the amount they typed.
check('the limit is stored for the scope on screen',
  stateDocument.config.budgets?.['']?.amount === 100
    && stateDocument.config.budgets?.['']?.period === 'month',
  JSON.stringify(stateDocument.config.budgets ?? null))

// Click the projects tab: the views are peers of one entry, so switching has to
// work without a reload, and the second render keeps the hook state a click set.
const projectsTabButton = treeNodes(accountTree).find(node => node.type === 'button'
  && flatten(node.children).includes(projectsTab))
check('the projects tab is a real button', projectsTabButton !== undefined)
// Primary navigation must not be the smallest control on the page: this was a
// chip-sized segmented control and read as a filter instead of a view switch.
const tabStyle = projectsTabButton?.props?.style ?? {}
const tabFont = /calc\((\d+(?:\.\d+)?)px/.exec(String(tabStyle.fontSize ?? ''))
check('the view tabs are page-sized, not chips',
  String(tabStyle.padding) === '10px 26px' && Number(tabFont?.[1] ?? 0) >= 15,
  `padding=${tabStyle.padding} fontSize=${tabFont?.[1]}px`)

// A grey plane behind the title (and behind the selected tab) is chrome nobody
// asked for, and it is the one thing the reader noticed first. Both are gone;
// the floating composer dialog keeps its own opaque surface, which this does not
// cover because it is not part of the page header.
const accountTabButton = treeNodes(accountTree).find(node => node.type === 'button'
  && flatten(node.children).includes(accountTab))
check('neither view tab carries a fill',
  String(tabStyle.background) === 'transparent'
    && String(accountTabButton?.props?.style?.background) === 'transparent',
  `idle=${tabStyle.background} active=${accountTabButton?.props?.style?.background}`)
const headerBands = treeNodes(accountTree)
  .map(node => String(node.props?.style?.background ?? ''))
  .filter(background => background.includes('Canvas 9'))
check('no grey band sits behind the page header', headerBands.length === 0, headerBands[0] ?? 'none')

// The date axis: both views must narrow to a window, not just the account one.
check('the account view carries the time switch', pressButton(accountTree, zhStrings.dash7))
const accountWeekText = flatten(renderSurface(
  React.createElement(costPanel.component, shellProps), true)).replace(/\s+/g, ' ')
check('the account view narrows to the last 7 days',
  WEEK_TOTAL.test(accountWeekText) && accountWeekText.includes(zhStrings.costInRange),
  accountWeekText.slice(0, 100))

let projectsTree = null
if (projectsTabButton !== undefined) {
  projectsTabButton.props.onClick()
  projectsTree = renderSurface(React.createElement(costPanel.component, shellProps), true)
  const projectsText = flatten(projectsTree).replace(/\s+/g, ' ')
  check('clicking it switches to the project view',
    projectsText.includes(zhStrings.reportByModel) && !projectsText.includes(zhStrings.dashActivity),
    projectsText.slice(0, 90))
  check('the project view also totals all time by default',
    ALL_TIME_TOTAL.test(projectsText), projectsText.slice(0, 100))
  check('the project view carries the time switch', pressButton(projectsTree, zhStrings.dash7))
  const projectsWeekText = flatten(renderSurface(
    React.createElement(costPanel.component, shellProps), true)).replace(/\s+/g, ' ')
  check('the project view narrows to the last 7 days',
    WEEK_TOTAL.test(projectsWeekText) && projectsWeekText.includes(zhStrings.costInRange),
    projectsWeekText.slice(0, 100))

  /* ------------------------------------------------- the project drill-down */

  // The donut's SLICES must be targets too, not only the legend beside it: the
  // shape is what a reader aims at. The bucket donut on the account view has
  // nothing to drill into, so its slices must stay inert.
  const bucketSlices = treeNodes(accountTree)
    .filter(node => node.type === 'path' && typeof node.props?.onClick === 'function')
  check('the bucket donut is not a drill target', bucketSlices.length === 0,
    `clickable bucket slices=${bucketSlices.length}`)

  const pieSlices = treeNodes(projectsTree)
    .filter(node => node.type === 'path' && typeof node.props?.onClick === 'function')
  check('the project donut slices are drill targets', pieSlices.length >= 1,
    `clickable slices=${pieSlices.length}`)
  const sliceForProject = pieSlices.find(node => flatten(node).includes('md')) ?? pieSlices[0]
  if (sliceForProject !== undefined) {
    sliceForProject.props.onClick()
    const viaPieText = flatten(renderSurface(
      React.createElement(costPanel.component, shellProps), true)).replace(/\s+/g, ' ')
    check('clicking a pie slice drills into that project',
      viaPieText.includes(zhStrings.reportByConversation),
      viaPieText.slice(0, 90))
    // Back to "all projects" through the scope dropdown, so the checks below
    // start from the unscoped view again.
    const scopeSelect = treeNodes(projectsTree).find(node => node.type === 'select'
      && flatten(node.children).includes(zhStrings.reportAllProjects))
    if (scopeSelect !== undefined) scopeSelect.props.onChange({ target: { value: '' } })
  }

  /* ------------------------------------------------- the shared filter chrome */

  // The same control, drawn once. It had been drawn twice and drifted: the project
  // view wrapped its copy in a muted label, which greyed the select and shrank its
  // type, so the two tabs disagreed about which control they were looking at.
  const scopeSelects = tree => treeNodes(tree).filter(node => node.type === 'select'
    && flatten(node.children).includes(zhStrings.reportAllProjects))
  const accountScope = scopeSelects(accountTree)[0]
  const projectsScope = scopeSelects(projectsTree)[0]
  check('both views draw the scope picker identically',
    accountScope !== undefined && projectsScope !== undefined
      && String(accountScope.props.style.width) === String(projectsScope.props.style.width)
      && String(accountScope.props.style.colorScheme) === String(projectsScope.props.style.colorScheme)
      // `inherit` is what the shared input style sets; the project view used to
      // hand it the muted text colour by wrapping it in a muted label.
      && String(accountScope.props.style.color) === 'inherit'
      && String(projectsScope.props.style.color) === 'inherit',
    `width=${projectsScope?.props.style.width} color=${String(projectsScope?.props.style.color)}`)

  // The WHOLE bar is one component now: the back button used to exist only on the
  // account view, so the same screen offered different controls per tab.
  const barOf = tree => treeNodes(tree).find(node => node.type === 'div'
    && node.props?.style?.marginBottom === 14 && node.props?.style?.flexWrap === 'wrap'
    && treeNodes(node).some(child => child.type === 'select'))
  const barSignature = tree => {
    const bar = barOf(tree)
    if (bar === undefined) return '(no bar)'
    return (bar.children ?? [])
      // `scope !== '' && h(…)` is a boolean in React and an empty element in this
      // harness; it is not a control and must not count as one.
      .filter(child => child !== null && child !== undefined && child.type !== undefined)
      .map(child => {
        if (typeof child !== 'object') return String(child)
        if (child.type === 'button') return `button(${flatten(child.children).trim()})`
        if (child.type === 'select') return 'select'
        if (child.type === 'span') return 'spacer'
        return String(child.type)
      })
      .join('|')
  }
  // The panel lives in a flex column with `overflow: hidden`, so it has to scroll
  // itself; a percentage height there collapses to auto and the page is clipped.
  const pageStyle = node => treeNodes(node).find(entry => entry.props?.style?.maxWidth === 1440)
    ?.props.style
  const accountPage = pageStyle(accountTree)
  check('the panel scrolls instead of clipping its tail',
    accountPage?.overflowY === 'auto' && accountPage?.flex === '1 1 auto'
      && accountPage?.minHeight === 0,
    `overflowY=${String(accountPage?.overflowY)} flex=${String(accountPage?.flex)} minHeight=${String(accountPage?.minHeight)}`)

  // The project dimension must be a list you can act on: the ranking rows carry
  // the same drill-down the account view's bars do, and the donut's legend rows
  // are targets too — a chart you cannot click is a picture, not a report.
  const drillRows = treeNodes(projectsTree).filter(node => node.type === 'div'
    && node.props?.style?.cursor === 'pointer' && typeof node.props?.onClick === 'function')
  check('the project view lists clickable project rows', drillRows.length >= 1,
    `clickable rows=${drillRows.length}`)
  // Target the real workspace, not the no-project bucket: the fixture's
  // no-project row outranks it, and the sentinel that makes it clickable is
  // what this also exercises.
  const projectRow = drillRows.find(node => flatten(node).includes('md')) ?? drillRows[0]
  if (projectRow !== undefined) {
    projectRow.props.onClick()
    const scopedTree = renderSurface(React.createElement(costPanel.component, shellProps), true)
    const scopedText = flatten(scopedTree).replace(/\s+/g, ' ')
    check('clicking a project row drills into that project',
      scopedText.includes(zhStrings.reportByConversation),
      scopedText.slice(0, 90))
    // Inside a project the calendar comes first: "how long has this been going"
    // is answered by the project's own days, with the span stated under the grid
    // because the grid itself is always the trailing 53 weeks.
    const gridCells = treeNodes(scopedTree).filter(node => node.type === 'rect').length
    check('a drilled-in project shows its own activity calendar',
      scopedText.includes(zhStrings.dashActivity) && gridCells > 300,
      `cells=${gridCells}`)
    check('the project calendar states the working span',
      scopedText.includes(zhStrings.dashSpan.split('{')[0].trim()),
      scopedText.includes(zhStrings.dashSpan.split('{')[0].trim()) ? 'span line present' : 'missing')

    // …and the account view, scoped the same way, must offer the same bar: the
    // back button used to exist on one side only.
    const accountDrill = treeNodes(accountTree).find(node => node.type === 'div'
      && node.props?.style?.cursor === 'pointer' && typeof node.props?.onClick === 'function')
    if (accountDrill !== undefined) {
      accountDrill.props.onClick()
      const accountScoped = renderSurface(React.createElement(costPanel.component, shellProps), true)
      check('both views carry the same filter bar, scoped',
        barSignature(accountScoped) === barSignature(scopedTree)
          && barSignature(scopedTree).startsWith('button('),
        `${barSignature(accountScoped)} vs ${barSignature(scopedTree)}`)
    }
  }
  const noProjectRow = treeNodes(projectsTree).find(node =>
    node.props?.style?.cursor === 'pointer' && flatten(node).includes(zhStrings.reportNoProject)
    && typeof node.props?.onClick === 'function')
  check('the no-project bucket is drillable too', noProjectRow !== undefined)

  /* ------------------------------------------------- same module, same shape */

  // The two views are independent implementations of the same report, and they
  // had drifted: a shared module must render the same way on both, even where
  // the figures differ. These pin the four unifications.
  const styleOfNodes = tree => treeNodes(tree).map(node => node.props?.style ?? {})
  // Legend rows all share one shape (`ROW` + the legend margin), so the bucket
  // legend is identified by its labels: the project pie on the report view draws
  // the same swatch and the same row.
  const bucketLabels = ['cacheRead', 'cacheMiss', 'cacheWrite', 'output'].map(key => zhStrings[key])
  const legendRowsOf = tree => treeNodes(tree).filter(node => {
    const style = node.props?.style ?? {}
    if (style.justifyContent !== 'space-between' || style.marginBottom !== 6) return false
    return bucketLabels.includes(String(flatten(node.children)).trim().split(' ')[0])
  }).length
  const headersOf = tree => treeNodes(tree)
    .filter(node => node.type === 'th').map(node => flatten(node.children)).join('|')
  const maxFontOf = tree => {
    const sizes = styleOfNodes(tree)
      .map(style => /calc\((\d+(?:\.\d+)?)px/.exec(String(style.fontSize ?? '')))
      .filter(Boolean).map(match => Number(match[1]))
    return sizes.length === 0 ? 0 : Math.max(...sizes)
  }
  const statCardsOf = tree => styleOfNodes(tree).filter(style => style.minWidth === 128).length
  const dimmedLegendOf = tree => styleOfNodes(tree).filter(style => style.opacity === 0.55).length

  const accountTextNow = flatten(accountTree).replace(/\s+/g, ' ')
  const projectsTextNow = flatten(projectsTree).replace(/\s+/g, ' ')

  check('both views list every billing bucket',
    legendRowsOf(accountTree) === 4 && legendRowsOf(projectsTree) === 4,
    `account=${legendRowsOf(accountTree)} projects=${legendRowsOf(projectsTree)}`)
  check('the zero bucket is dimmed, not dropped',
    dimmedLegendOf(accountTree) >= 1,
    `dimmed rows=${dimmedLegendOf(accountTree)}`)
  check('both views render the same detail columns',
    headersOf(accountTree) === headersOf(projectsTree) && headersOf(accountTree).split('|').length === 6,
    headersOf(accountTree))
  check('both views size their summary figures the same',
    statCardsOf(accountTree) > 0 && maxFontOf(accountTree) === maxFontOf(projectsTree),
    `account max=${maxFontOf(accountTree)}px cards=${statCardsOf(accountTree)}`)
  check('the panel note belongs to the panel, not to one tab',
    accountTextNow.includes(zhStrings.reportIntro) && projectsTextNow.includes(zhStrings.reportIntro))

  // A legend that stretches to the group's width parks its money a screen away
  // from the labels it belongs to, which is unreadable however correct the
  // numbers are — so the legend block must be bounded on both views.
  const legendBlocks = tree => styleOfNodes(tree)
    .filter(style => typeof style.flex === 'string' && /^0 1 \d+px$/.test(style.flex)).length
  check('the legend stays beside its labels',
    legendBlocks(accountTree) >= 1 && legendBlocks(projectsTree) >= 2,
    `bounded legend blocks: account=${legendBlocks(accountTree)} projects=${legendBlocks(projectsTree)}`)
  check('both views state their cost basis',
    accountTextNow.includes(zhStrings.costAllTime) && projectsTextNow.includes(zhStrings.costAllTime),
    `${zhStrings.costAllTime}`)
}

const settingsEntry = registrations.find(item => item.spec?.name === 'settings.section')
let settingsText = ''
let settingsError = null
try {
  const settingsTree = renderSurface(React.createElement(settingsEntry.component, shellProps))
  settingsText = `${flatten(settingsTree)} ${inputValues(settingsTree)}`.replace(/\s+/g, ' ')
} catch (caught) {
  settingsError = caught
}
check('settings page renders the price table',
  settingsError === null && settingsText.includes('deepseek-v4-pro') && settingsText.includes('deepseek-flash'),
  settingsError === null ? `${settingsText.trim().length} chars` : String(settingsError))

// The budget editor and the reconciliation note are the two things a reader needs
// in order to set a limit and to trust the number it limits.
check('the settings page carries the budget editor',
  settingsText.includes(zhStrings.budgetTitle) && settingsText.includes(zhStrings.budgetAdd)
    && settingsText.includes(zhStrings.budgetScopeAccount),
  settingsText.includes(zhStrings.budgetAdd) ? 'editor present' : 'no editor')
check('the settings page explains how to reconcile with the official bill',
  settingsText.includes(zhStrings.reconTitle) && settingsText.includes(zhStrings.reconReasoning.slice(0, 12)),
  settingsText.includes(zhStrings.reconTitle) ? 'reconciliation present' : 'missing')

const pillEntry = registrations.find(item => item.spec?.name === 'conversation.composer.dock')
let pillText = ''
let pillError = null
try {
  pillText = flatten(renderSurface(React.createElement(pillEntry.component, { ...shellProps, sessionId: 'session-a' }))).replace(/\s+/g, ' ')
} catch (caught) {
  pillError = caught
}
check('composer pill renders without throwing', pillError === null, pillError === null ? pillText.slice(0, 60) : String(pillError))

/* ------------------------------------------- the popover closes from the outside */

// The dialog is tall and covers the page it describes, so it must close from
// outside itself as well as from its trigger. A listener registry stands in for
// the DOM here: what is asserted is that an open popover listens, and that the
// press it hears closes it.
const listeners = new Map()
const savedDocument = globalThis.document
globalThis.document = {
  addEventListener: (type, handler) => listeners.set(type, handler),
  removeEventListener: type => listeners.delete(type),
}
try {
  const pillProps = { ...shellProps, sessionId: 'session-a' }
  const triggerOf = tree => treeNodes(tree).find(node => node.type === 'button'
    && node.props?.['aria-haspopup'] === 'dialog')
  let pillTree = renderSurface(React.createElement(pillEntry.component, pillProps))
  check('the pill has a dialog trigger', triggerOf(pillTree) !== undefined)
  triggerOf(pillTree)?.props.onClick()
  pillTree = renderSurface(React.createElement(pillEntry.component, pillProps), true)
  check('the open popover is on screen', triggerOf(pillTree)?.props['aria-expanded'] === true)
  check('an open popover listens for an outside press', listeners.has('pointerdown'),
    [...listeners.keys()].join(',') || 'no listeners')

  listeners.get('pointerdown')?.({ target: {} })
  pillTree = renderSurface(React.createElement(pillEntry.component, pillProps), true)
  check('a press outside closes the popover', triggerOf(pillTree)?.props['aria-expanded'] === false,
    `aria-expanded=${String(triggerOf(pillTree)?.props['aria-expanded'])}`)

  triggerOf(pillTree)?.props.onClick()
  pillTree = renderSurface(React.createElement(pillEntry.component, pillProps), true)
  listeners.get('keydown')?.({ key: 'Escape' })
  pillTree = renderSurface(React.createElement(pillEntry.component, pillProps), true)
  check('Escape closes the popover', triggerOf(pillTree)?.props['aria-expanded'] === false)
} finally {
  if (savedDocument === undefined) delete globalThis.document
  else globalThis.document = savedDocument
}

/* ------------------------------------------------- sizing follows the harness */

// The theme publishes the reader's content size; a surface that hard-codes its
// own pixels stays at one size while every native panel follows the setting, and
// a centered fixed page width leaves most of a wide window empty. Both were true
// of every surface here, so both are pinned now.
const surfaces = [
  ['main[cost]', accountTree],
  ['settings.section[cost]', renderSurface(React.createElement(settingsEntry.component, shellProps))],
]
const markup = surfaces.map(([, tree]) => JSON.stringify(tree)).join('\n')

check('text sizes derive from the theme content size',
  markup.includes('--dsh-content-font-delta'),
  `${(markup.match(/--dsh-content-font-delta/g) ?? []).length} references`)
check('no hard-coded font-size survives',
  !/fontSize":\d/.test(markup) && !/font-size:\s*\d/.test(markup),
  (markup.match(/fontSize":\d[^,]*/g) ?? []).slice(0, 2).join(' | '))
check('price table stretches with a readable floor',
  markup.includes('TABLE_MIN_WIDTH') === false && markup.includes('820'),
  markup.includes('820') ? 'min-width 820px + percentage columns' : 'no floor found')

// Walk the rendered trees: sizing regressions are invisible in text assertions,
// and "the reader cannot read it" is a sizing claim.
const nodes = surfaces.flatMap(([, tree]) => {
  const walk = node => {
    if (node === null || node === undefined || typeof node !== 'object') return []
    if (Array.isArray(node)) return node.flatMap(walk)
    return [node, ...walk(node.children ?? [])]
  }
  return walk(tree)
})
const styles = nodes.map(node => node.props?.style ?? {}).filter(style => typeof style === 'object')
const fontSizes = styles
  .map(style => /calc\((\d+(?:\.\d+)?)px/.exec(String(style.fontSize ?? '')))
  .filter(Boolean)
  .map(match => Number(match[1]))

check('nothing renders below 12px at the default size',
  fontSizes.length > 0 && Math.min(...fontSizes) >= 12,
  `min=${Math.min(...fontSizes)}px across ${fontSizes.length} sizes`)
check('summary figures stay headline-sized', Math.max(...fontSizes) >= 24, `max=${Math.max(...fontSizes)}px`)
check('heatmap cells are enlarged',
  Math.max(...nodes.filter(node => node.type === 'rect').map(node => Number(node.props?.width ?? 0))) >= 16,
  `cell=${Math.max(...nodes.filter(node => node.type === 'rect').map(node => Number(node.props?.width ?? 0)))}px`)
check('the page insets on a wide window',
  styles.some(style => style.width === '100%' && Number(style.maxWidth) >= 1200 && Number(style.maxWidth) <= 1800),
  `max-width=${styles.map(style => style.maxWidth).filter(Boolean).join(',') || 'none'}`)

const rightAligned = styles
  .filter(style => style.textAlign === 'right' && Number.isFinite(style.minWidth))
  .map(style => style.minWidth)
check('money and share own separate right-aligned columns',
  rightAligned.filter(width => width >= 50).length >= 2, `columns=${[...new Set(rightAligned)].join(',')}`)

const donuts = nodes.filter(node => node.type === 'svg').length
const legendRows = styles.filter(style => style.width === 11 && style.borderRadius === 3).length
check('billing composition is a donut with a legend',
  donuts >= 2 && legendRows >= 3, `donuts=${donuts} legend rows=${legendRows}`)

const failed = results.filter(ok => ok !== true).length
console.log(`\n${results.length - failed}/${results.length} checks passed`)
if (failed > 0) process.exit(1)
