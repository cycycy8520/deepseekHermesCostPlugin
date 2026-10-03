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
stateDocument = {
  ok: true,
  version: 1,
  revision: 7,
  config: { ...host.resolveConfig(null), flushMs: 600 },
  ledger: {},
}

runInThisContext(bundle, { filename: 'dsh-cost-meter-client.js' })
if (definition === null) throw new Error('the bundle never called window.__ModuleLoader__.load')
const client = definition.factory(require)
client.apply(ctx)

const usageOf = (overrides = {}) => ({
  cacheReadTokens: 0, uncachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, ...overrides,
})
const row = usage => ({
  projectionValues: {
    tokenUsage: usage,
    modelSelection: { lastUsed: { provider: 'deepseek-official', model: 'deepseek-flash' } },
  },
})

await new Promise(resolve => setTimeout(resolve, 50))
snapshot = { ids: ['session-a'], byId: { 'session-a': row(usageOf()) } }
sessionSubscriber()
snapshot = {
  ids: ['session-a'],
  byId: { 'session-a': row(usageOf({ cacheReadTokens: 100000, uncachedInputTokens: 50000, outputTokens: 20000 })) },
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

check('module id is the package name', definition.id === 'dsh-cost-meter', definition.id)
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
  accountText.includes(zhStrings.dashActivity) && !accountText.includes(zhStrings.reportScope),
  accountText.slice(0, 90))
check('dashboard shows a priced total', /¥0\.13/.test(accountText), accountText.slice(0, 100))

/** Every element of a rendered tree, flattened. */
const treeNodes = node => {
  if (node === null || node === undefined || typeof node !== 'object') return []
  if (Array.isArray(node)) return node.flatMap(treeNodes)
  return [node, ...treeNodes(node.children ?? [])]
}

// Click the projects tab: the views are peers of one entry, so switching has to
// work without a reload, and the second render keeps the hook state a click set.
const projectsTabButton = treeNodes(accountTree).find(node => node.type === 'button'
  && flatten(node.children).includes(projectsTab))
check('the projects tab is a real button', projectsTabButton !== undefined)
if (projectsTabButton !== undefined) {
  projectsTabButton.props.onClick()
  const projectsText = flatten(renderSurface(
    React.createElement(costPanel.component, shellProps), true)).replace(/\s+/g, ' ')
  check('clicking it switches to the project view',
    projectsText.includes(zhStrings.reportScope) && !projectsText.includes(zhStrings.dashActivity),
    projectsText.slice(0, 90))
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

const pillEntry = registrations.find(item => item.spec?.name === 'conversation.composer.dock')
let pillText = ''
let pillError = null
try {
  pillText = flatten(renderSurface(React.createElement(pillEntry.component, { ...shellProps, sessionId: 'session-a' }))).replace(/\s+/g, ' ')
} catch (caught) {
  pillError = caught
}
check('composer pill renders without throwing', pillError === null, pillError === null ? pillText.slice(0, 60) : String(pillError))

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
check('headline figures stay large', Math.max(...fontSizes) >= 30, `max=${Math.max(...fontSizes)}px`)
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
