// Offline smoke test for dsh-quote-chip/dsh/client.js
// 目标：在不动真实服务的前提下，验证模块能加载、apply 能挂载、以及
// 「引用」真的走了芯片分支（bail 被正确调用），没有 inputTriggers 时退回纯文本。

import { pathToFileURL, fileURLToPath } from 'node:url'

// 相对本文件定位被测模块：换机器、换克隆路径都能直接跑
const CLIENT = fileURLToPath(new URL('../dsh/client.js', import.meta.url))

// ---------- 极简 React 替身（带真实状态单元） ----------
let hookCells = []
let hookIndex = 0
let pendingEffects = []
const beginRender = () => { hookIndex = 0 }
const fakeReact = {
  createElement(type, props, ...children) {
    return { type, props: Object.assign({}, props, { children }) }
  },
  useRef(initial) {
    const i = hookIndex++
    const cells = hookCells
    if (cells.length <= i) cells[i] = { current: initial === null ? { ownerDocument: globalThis.document } : initial }
    return cells[i]
  },
  useState(initial) {
    const i = hookIndex++
    const cells = hookCells
    if (cells.length <= i) cells[i] = initial
    const set = (value) => { cells[i] = typeof value === 'function' ? value(cells[i]) : value }
    return [cells[i], set]
  },
  useEffect(fn) { pendingEffects.push(fn); return undefined },
}
const flushEffects = () => { const list = pendingEffects; pendingEffects = []; list.forEach((fn) => fn()) }

// ---------- 最小 DOM 替身 ----------
const listeners = {}
globalThis.document = {
  getElementById: () => null,
  createElement: () => ({ id: '', textContent: '' }),
  head: { appendChild: () => {} },
  addEventListener: (name, fn) => { listeners[name] = fn },
  removeEventListener: () => {},
  getSelection: () => null,
  defaultView: { innerWidth: 1200, innerHeight: 800 },
}

let captured = null
globalThis.window = { __ModuleLoader__: { load: (m) => { captured = m } } }

await import(pathToFileURL(CLIENT).href + '?t=' + Date.now())
if (captured === null) throw new Error('ModuleLoader.load was not called')
const mod = captured.factory((name) => {
  if (name === 'react') return fakeReact
  throw new Error('unexpected require: ' + name)
})
if (typeof mod.apply !== 'function') throw new Error('exports.apply missing')

// ---------- 组装假的宿主环境 ----------
function makeEnv(opts) {
  const env = {
    sources: [],
    slots: [],
    bailCalls: [],
    isSubagent: opts.isSubagent === true,
    origin: opts.origin,
    store: { draft: '', draftRev: 7, phase: 'plain' },
    actions: { drafted: [], submitted: 0 },
  }
  env.actions.setDraft = (t) => { env.actions.drafted.push(t); env.store.draft = t }
  env.actions.submit = () => { env.actions.submitted += 1 }
  const actx = { bail: (subject, name, payload) => { env.bailCalls.push({ name, payload }); return true } }
  const sessionsService = { scope: (id) => (id === 's1' ? actx : undefined) }
  const inputTriggers = { registerSource: (src) => { env.sources.push(src); return () => {} } }
  const slots = {
    inject(key, gen) { const it = gen(); let r = it.next(); while (!r.done) r = it.next() },
    register(options, component) { env.slots.push({ options, component }); return () => {} },
  }
  env.ctx = {
    inject(deps, cb) {
      if (deps.includes('inputTriggers') && opts.triggers) cb({ inputTriggers })
      else if (deps.includes('sessions')) cb({ sessions: sessionsService })
      else if (deps.includes('slots')) cb({ slots })
    },
    effect(fn) { return fn() },
    get(name) {
      if (opts.triggers && name === 'inputTriggers') return inputTriggers
      if (name === 'sessions') return sessionsService
      return undefined
    },
  }
  return env
}

const inputs = (store) => {
  let i = 0
  const order = [store.draft, store.draftRev, store.phase]
  return () => order[i++]
}

function mount(env) {
  mod.apply(env.ctx)
  flushEffects()
}

function renderBridge(env) {
  const entry = env.slots.find((s) => s.options.id === 'quote-chip-bridge')
  if (!entry) throw new Error('bridge slot missing')
  if (!env.bridgeCells) env.bridgeCells = []
  hookCells = env.bridgeCells
  beginRender()
  entry.component({
    inputActions: env.actions,
    sessionId: 's1',
    useInput: inputs(env.store),
    // 普通会话 subagent === null；经目录打开的子会话才是 { address, ... }
    useSession: (selector) => selector({ subagent: env.isSubagent === true ? { address: { mode: 'continuable' } } : null }),
    // 列表 summary：子代理会话带 origin === 'subagent'
    useSessions: (selector) => selector({ byId: { s1: { origin: env.origin } } }),
  })
  flushEffects()
}

function renderToolbar(env) {
  const entry = env.slots.find((s) => s.options.id === 'quote-selection-toolbar')
  if (!entry) throw new Error('toolbar slot missing')
  if (!env.toolbarCells) env.toolbarCells = []
  hookCells = env.toolbarCells
  beginRender()
  const tree = entry.component({})
  flushEffects()
  return tree
}

function renderRecap(env) {
  const entry = env.slots.find((s) => s.options.id === 'quote-chip-recap')
  if (!entry) throw new Error('recap slot missing')
  if (!env.recapCells) env.recapCells = []
  hookCells = env.recapCells
  beginRender()
  const tree = entry.component({
    inputActions: env.actions,
    sessionId: 's1',
    useInput: inputs(env.store),
    useSession: (selector) => selector({ subagent: env.isSubagent === true ? { address: { mode: 'continuable' } } : null }),
    useSessions: (selector) => selector({ byId: { s1: { origin: env.origin } } }),
  })
  flushEffects()
  return tree
}

function findNode(node, predicate) {
  if (node === null || node === undefined || typeof node !== 'object') return null
  if (predicate(node)) return node
  const raw = node.props && node.props.children !== undefined ? node.props.children : []
  const flat = Array.isArray(raw) ? raw.flat(Infinity) : [raw]
  for (const kid of flat) {
    const hit = findNode(kid, predicate)
    if (hit) return hit
  }
  return null
}

function renderFlow(env) {
  const entry = env.slots.find((s) => s.options.id === 'quote-chip-flow')
  if (!entry) return null
  if (!env.flowCells) env.flowCells = []
  hookCells = env.flowCells
  beginRender()
  const tree = entry.component({})
  flushEffects()
  return tree
}

function findButton(node, label) {
  return findNode(node, (n) => {
    if (n.type !== 'button') return false
    const raw = n.props && n.props.children !== undefined ? n.props.children : []
    const flat = Array.isArray(raw) ? raw.flat(Infinity) : [raw]
    return flat[0] === label
  })
}

// 按钮里如果第一个孩子是图标元素，就用整棵子树的文字来匹配
function buttonText(node) {
  const raw = node.props && node.props.children !== undefined ? node.props.children : []
  const flat = Array.isArray(raw) ? raw.flat(Infinity) : [raw]
  return flat.map((k) => (typeof k === 'string' ? k : (k && k.props ? buttonText(k) : ''))).join('')
}

function findButtonLike(node, label) {
  return findNode(node, (n) => n.type === 'button' && buttonText(n).includes(label))
}

function select(text, anchor) {
  const range = { getBoundingClientRect: () => ({ left: 100, top: 300, width: 80, height: 20, bottom: 320 }) }
  const node = anchor || { nodeType: 1, tagName: 'P', parentElement: null }
  document.getSelection = () => ({
    isCollapsed: false,
    rangeCount: 1,
    anchorNode: node,
    focusNode: node,
    toString: () => text,
    getRangeAt: () => range,
  })
  listeners['selectionchange']()
}

let failures = 0
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + ' = ' + JSON.stringify(actual) + (ok ? '' : '  (expected ' + JSON.stringify(expected) + ')'))
}

// ---------- 场景 A：inputTriggers 可用 → 芯片路径 ----------
const envA = makeEnv({ triggers: true })
mount(envA)
console.log('引用源:', envA.sources.map((s) => s.name).join(',') || '(none)',
  '| 槽位:', envA.slots.map((s) => s.options.name + '#' + s.options.id).join(', '))
renderBridge(envA)
renderToolbar(envA)
select('被选中的一段对话内容')
const treeA = renderToolbar(envA)
const quoteA = findButton(treeA, '引用')
if (!quoteA) throw new Error('quote button missing')
quoteA.props.onClick()

console.log('\n--- A. 有 inputTriggers（期望插芯片）')
check('bail 次数', envA.bailCalls.length, 1)
check('bail 事件名', envA.bailCalls[0] && envA.bailCalls[0].name, 'slash/input-insert-reference')
check('reference.source', envA.bailCalls[0] && envA.bailCalls[0].payload.reference.source, 'quote')
check('span', envA.bailCalls[0] && envA.bailCalls[0].payload.span, { start: 0, end: 0, draftRev: 7 })
check('chip 标签前缀', envA.bailCalls[0] && envA.bailCalls[0].payload.reference.label.slice(0, 3), '引用：')
check('ref 以空行结尾', envA.bailCalls[0] && envA.bailCalls[0].payload.reference.ref.slice(-2), '容\n\n'.slice(-2))
check('setDraft 次数', envA.actions.drafted.length, 0)

// ---------- 场景 B：无 inputTriggers → 纯文本降级 ----------
const envB = makeEnv({ triggers: false })
mount(envB)
renderBridge(envB)
renderToolbar(envB)
select('被选中的一段对话内容')
const treeB = renderToolbar(envB)
findButton(treeB, '引用').props.onClick()

console.log('\n--- B. 无 inputTriggers（期望降级为文本）')
check('bail 次数', envB.bailCalls.length, 0)
check('setDraft 次数', envB.actions.drafted.length, 1)
check('写入草稿', envB.actions.drafted[0], '【引用】\n> 被选中的一段对话内容\n【引用结束】\n')

// ---------- 场景 C：向子代理提问（唯一语义：后台可续聊） ----------
const envC = makeEnv({ triggers: true })
mount(envC)
renderBridge(envC)
renderToolbar(envC)
select('被选中的一段对话内容')
const treeC = renderToolbar(envC)
findButton(treeC, '向子代理提问').props.onClick()
const treeC2 = renderToolbar(envC)
check('提问框只有一个发送键', findButton(treeC2, '一次问完'), null)
const sendC = findButton(treeC2, '发送')
if (!sendC) throw new Error('send button missing')
sendC.props.onClick()
// setDraft 之后真实的输入机器会推回一次新草稿，桥接组件据此再渲一次并提交
renderBridge(envC)

console.log('\n--- C. 向子代理提问（期望组消息 + 提交，指令要求后台可续聊）')
check('setDraft 次数', envC.actions.drafted.length, 1)
check('提交次数', envC.actions.submitted, 1)
check('指令要求后台可续聊', (envC.actions.drafted[0] || '').includes('可续聊') && (envC.actions.drafted[0] || '').includes('run_in_background: true'), true)
check('消息含引用块', (envC.actions.drafted[0] || '').includes('> 被选中的一段对话内容'), true)
check('回到默认：不带任何收尾协议', (envC.actions.drafted[0] || '').includes('已答'), false)
check('只提示不要额外双推', (envC.actions.drafted[0] || '').includes('不要再用 send_message 额外推一份'), true)
check('父会话没有回流勾选框', findNode(treeC2, (n) => n.type === 'input' && n.props.type === 'checkbox'), null)

// ---------- 场景 I：子会话里的「主代理介入」按钮 ----------
const envI = makeEnv({ triggers: true, isSubagent: true })
mount(envI)
renderBridge(envI)
const recapBtn = findButtonLike(renderRecap(envI), '主代理介入')
if (!recapBtn) throw new Error('recap button missing')
recapBtn.props.onClick()
renderBridge(envI) // 输入机器推回草稿
renderRecap(envI) // 按钮组件再渲一次，触发提交握手

console.log('\n--- I. 子会话「主代理介入」按钮')
check('提交次数', envI.actions.submitted, 1)
check('写入介入请求', (envI.actions.drafted[0] || '').includes('【主代理介入】'), true)
check('要求它自己写简报', (envI.actions.drafted[0] || '').includes('整理成一份给主代理的简报'), true)
check('要求列出不确定处', (envI.actions.drafted[0] || '').includes('不确定或未验证的地方'), true)

// ---------- 场景 K：草稿非空时按钮不动作 ----------
const envK = makeEnv({ triggers: true, isSubagent: true })
envK.store.draft = '我正在打的一段话'
mount(envK)
renderBridge(envK)
findButtonLike(renderRecap(envK), '主代理介入').props.onClick()
renderRecap(envK)

console.log('\n--- K. 草稿非空时回流按钮不动作')
check('不写入草稿', envK.actions.drafted.length, 0)
check('不提交', envK.actions.submitted, 0)

// ---------- 场景 L：普通会话里没有回流按钮 ----------
const envL = makeEnv({ triggers: true })
mount(envL)
renderBridge(envL)

console.log('\n--- L. 父/普通会话不渲染回流按钮')
check('回流按钮不存在', renderRecap(envL), null)


// ---------- 场景 F：草稿非空时不得覆盖 ----------
const envF = makeEnv({ triggers: true })
envF.store.draft = '我正在打的一段话'
mount(envF)
renderBridge(envF)
renderToolbar(envF)
select('被选中的一段对话内容')
findButton(renderToolbar(envF), '向子代理提问').props.onClick()
findButton(renderToolbar(envF), '发送').props.onClick()
renderBridge(envF)

console.log('\n--- F. 草稿非空（期望拒绝覆盖并提示）')
check('setDraft 次数', envF.actions.drafted.length, 0)
check('提交次数', envF.actions.submitted, 0)

// ---------- 场景 D：输入框内选区不触发 ----------
const envD = makeEnv({ triggers: true })
mount(envD)
renderBridge(envD)
renderToolbar(envD)
select('输入框里选中的文字', { nodeType: 1, tagName: 'DIV', isContentEditable: true, parentElement: null })
const treeD = renderToolbar(envD)

console.log('\n--- D. 输入框内的选区（期望不弹浮条）')
check('浮条未出现', findButton(treeD, '引用'), null)

// ---------- 场景 G：子代理会话里不出现提问键 ----------
const envG = makeEnv({ triggers: true })
envG.isSubagent = true
mount(envG)
renderBridge(envG)
renderToolbar(envG)
select('被选中的一段对话内容')
const treeG = renderToolbar(envG)

console.log('\n--- G. 子代理会话（浮条只留引用，提问键与回流键都不出现）')
check('仍可引用', findButton(treeG, '引用') !== null, true)
check('提问键已隐藏', findButton(treeG, '向子代理提问'), null)
check('回流不再占浮条', findButton(treeG, '回流结论'), null)

// ---------- 场景 H：子代理会话里的引用仍然可用 ----------
const envH = makeEnv({ triggers: true })
envH.isSubagent = true
mount(envH)
renderBridge(envH)
renderToolbar(envH)
select('被选中的一段对话内容')
findButton(renderToolbar(envH), '引用').props.onClick()

console.log('\n--- H. 子代理会话里引用依然插芯片')
check('bail 次数', envH.bailCalls.length, 1)
check('setDraft 次数', envH.actions.drafted.length, 0)

// ---------- 场景 J：只靠 summary.origin 认出子会话（快照 subagent 为 null） ----------
const envJ = makeEnv({ triggers: true, origin: 'subagent' })
mount(envJ)
renderBridge(envJ)
renderToolbar(envJ)
select('被选中的一段对话内容')
const treeJ = renderToolbar(envJ)

console.log('\n--- J. 快照没 address、只有 origin=subagent')
check('浮条隐藏提问键', findButton(treeJ, '向子代理提问'), null)
check('浮条仍然可引用', findButton(treeJ, '引用') !== null, true)

console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'))
process.exit(failures === 0 ? 0 : 1)
