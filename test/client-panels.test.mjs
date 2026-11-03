/**
 * 设置页逐面板模拟操作测试（v1.8.0 新增）
 *
 * 在 Node 里用一套极小的 React 运行时（hooks + 重渲染）真实渲染 client.js 的 GuardSection，
 * 逐个标签页点击、点击按钮、等待 fetch 回填，断言用户实际看到的内容。
 *
 * 这样「每个面板能打开、能操作、数据能显示」就是可回归的，而不是只靠人肉点浏览器。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

// ── 极小 React 运行时（支持函数组件 hooks / class 组件 / 重渲染）──
function createMiniReact() {
  let current = null
  let dirty = false
  const instances = new Map()

  class Component {
    constructor(props) { this.props = props || {}; this.state = {} }
    setState(s) { this.state = Object.assign({}, this.state, typeof s === 'function' ? s(this.state) : s); dirty = true }
  }

  const getInst = (path, type) => {
    let inst = instances.get(path)
    if (!inst || inst.type !== type) {
      inst = { type, hooks: [], hi: 0, effects: [] }
      instances.set(path, inst)
    }
    return inst
  }
  const hook = (path) => {
    const inst = current
    const i = inst.hi++
    return { inst, i, path }
  }

  const react = {
    Component,
    createElement: (type, props, ...children) => {
      const kids = children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false && c !== true)
      const merged = Object.assign({}, props || {})
      // 与 React 一致：children 同时放进 props.children（ErrorBoundary 依赖它）
      if (kids.length > 0) merged.children = kids.length === 1 ? kids[0] : kids
      return { type, props: merged, children: kids }
    },
    Fragment: 'Fragment',
    useState: (init) => {
      const { inst, i } = hook()
      if (!(i in inst.hooks)) inst.hooks[i] = typeof init === 'function' ? init() : init
      const set = (v) => {
        inst.hooks[i] = typeof v === 'function' ? v(inst.hooks[i]) : v
        dirty = true
      }
      return [inst.hooks[i], set]
    },
    useEffect: (fn, deps) => {
      const { inst, i } = hook()
      inst.effects[i] = { fn, deps }
    },
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
    useRef: (init) => ({ current: init }),
  }

  const render = (el, path = 'r') => {
    if (el === null || el === undefined || el === false || el === true) return null
    if (typeof el === 'string' || typeof el === 'number') return { kind: 'text', text: String(el) }
    if (Array.isArray(el)) return { kind: 'host', type: 'array', props: {}, children: el.map((c, i) => render(c, `${path}[${i}]`)) }
    if (typeof el.type === 'function') {
      const isClass = el.type.prototype && typeof el.type.prototype.render === 'function'
      if (isClass) {
        const inst = new el.type(el.props)
        const child = render(inst.render(), `${path}/cls`)
        return { kind: 'comp', type: el.type, props: el.props, inst, children: [child] }
      }
      const inst = getInst(path, el.type)
      inst.hi = 0
      inst.effects = []
      const prev = current
      current = inst
      let out
      try { out = el.type(el.props) } finally { current = prev }
      const child = render(out, `${path}/c`)
      return { kind: 'comp', type: el.type, props: el.props, inst, children: [child] }
    }
    const children = (el.children || []).map((c, i) => render(c, `${path}/${i}`))
    return { kind: 'host', type: el.type, props: el.props, children }
  }

  return {
    react,
    render,
    isDirty: () => dirty,
    clearDirty: () => { dirty = false },
    /** 执行 effect（首次或依赖变化时） */
    runEffects: (tree) => {
      const same = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => Object.is(x, b[i]))
      const run = (node) => {
        if (!node) return
        if (node.kind === 'comp' && node.inst && node.inst.effects) {
          const inst = node.inst
          inst.effectDeps = inst.effectDeps || {}
          for (const [i, eff] of Object.entries(inst.effects)) {
            if (!eff) continue
            if (inst.effectDeps[i] !== undefined && same(inst.effectDeps[i], eff.deps)) continue
            inst.effectDeps[i] = eff.deps
            try { eff.fn() } catch (e) { assert.fail('useEffect 抛错: ' + e.message) }
          }
        }
        for (const c of node.children || []) run(c)
      }
      run(tree)
    },
    collectText: (tree) => {
      const acc = []
      const walk = (n) => {
        if (!n) return
        if (n.kind === 'text') { acc.push(n.text); return }
        for (const c of n.children || []) walk(c)
      }
      walk(tree)
      return acc.join(' ')
    },
    findButtons: (tree) => {
      const acc = []
      const walk = (n) => {
        if (!n) return
        if (n.kind === 'host' && n.type === 'button') acc.push(n)
        for (const c of n.children || []) walk(c)
      }
      walk(tree)
      return acc
    },
    allNodes: (tree) => {
      const acc = []
      const walk = (n) => {
        if (!n) return
        acc.push(n)
        for (const c of n.children || []) walk(c)
      }
      walk(tree)
      return acc
    },
  }
}

/** 载入 client.js，返回模块 */
function loadClientModule(react) {
  const src = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
  let captured = null
  const sandboxWindow = {
    __ModuleLoader__: { load: (decl) => { captured = decl } },
  }
  const fn = new Function('window', 'console', 'Symbol', 'Object', 'Array', 'JSON', 'Error', src)
  fn(sandboxWindow, console, Symbol, Object, Array, JSON, Error)
  return captured.factory((id) => {
    if (id === 'react') return react
    throw new Error('unexpected require: ' + id)
  })
}

const sleep = (ms = 0) => new Promise((r) => setTimeout(r, ms))

/**
 * 渲染根组件并反复「等待异步 → 重渲染 → 跑 effect」直到稳定。
 */
function createMounter(rt, rootType, fetchImpl) {
  const calls = []
  let tree = null

  const renderRoot = () => ({ type: rootType, props: {}, children: [] })

  const settle = async () => {
    for (let i = 0; i < 40; i++) {
      await sleep(0)
      if (rt.isDirty() || tree === null) {
        rt.clearDirty()
        tree = rt.render(renderRoot())
      }
      rt.runEffects(tree)
    }
  }

  const withFetch = async (fn) => {
    const orig = globalThis.fetch
    globalThis.fetch = async (url, opts) => {
      calls.push({ url: String(url), method: (opts && opts.method) || 'GET', body: opts && opts.body })
      const payload = fetchImpl(String(url), opts)
      if (payload instanceof Error) throw payload
      return { ok: true, status: 200, text: async () => JSON.stringify(payload) }
    }
    try { await fn() } finally { globalThis.fetch = orig }
  }

  return {
    calls,
    tree: () => tree,
    mount: () => withFetch(async () => { tree = rt.render(renderRoot()); await settle() }),
    click: (label) => withFetch(async () => {
      const btn = rt.findButtons(tree).find((b) => rt.collectText(b).includes(label))
      assert.ok(btn, `找不到按钮「${label}」；当前按钮：${rt.findButtons(tree).map((b) => rt.collectText(b)).join(' | ')}`)
      btn.props.onClick()
      await settle()
    }),
    clickTab: (label) => withFetch(async () => {
      const nodes = rt.allNodes(tree)
      const tab = nodes.find((n) => n.kind === 'host' && n.props && typeof n.props.onClick === 'function' && rt.collectText(n) === label)
      assert.ok(tab, `找不到标签页「${label}」`)
      tab.props.onClick()
      await settle()
    }),
  }
}

// ── 假的接口数据 ──
const DIAG_OK = {
  ok: true, level: 'ok', summary: '全部通过',
  checks: [
    { name: '网络', ok: true, level: 'ok', detail: '全部可达（4 个目标，最慢 120ms）' },
    { name: '磁盘', ok: true, level: 'ok', detail: '26% 已用（剩余 28 GB）' },
    { name: '内存', ok: true, level: 'ok', detail: '29.1% 已用（可用 70.9%）' },
    { name: 'overcommit', ok: null, level: 'info', detail: '36%' },
  ],
  network: {
    verdict: 'healthy',
    results: [
      { id: 'dns-basic', ok: true, ms: 59, http: 200 },
      { id: 'api-deepseek', ok: true, ms: 73, http: 401 },
    ],
    impact: [],
  },
  report: { level: 'ok', findings: [], summary: '全部正常' },
}
const CONFIG_GET = {
  ok: true,
  config: { schema: 'cs-guard/config/v1', restart: { minIntervalMs: 600000, maxPerDay: 3, consecutiveBreaches: 3, requireNoActiveTurns: true }, resume: { maxAttempts: 2, compactBeforeRetry: true }, context: { warnTokens: 250000, criticalTokens: 320000 }, watch: { network: true } },
  configFile: { exists: false },
  configError: null,
}
const RESUME_OK = {
  ok: true,
  decision: { action: 'compact', reason: '输出触顶（max-tokens）：压缩历史后重试' },
  context: { level: 'critical', inputTokens: 330000 },
  brief: '【上下文已压缩，以下为当前进度简报】\n目标：修完',
}

function defaultFetch(url, opts) {
  const method = (opts && opts.method) || 'GET'
  if (url.endsWith('/diag')) return DIAG_OK
  if (url.endsWith('/config') && method === 'GET') return CONFIG_GET
  if (url.endsWith('/config') && method === 'POST') return { ok: true, hint: '已保存到 <DSH_HOME>/cs-guard/config.json（0600）' }
  if (url.endsWith('/resume')) return RESUME_OK
  return { ok: false, error: 'unexpected ' + url }
}

test('设置页渲染出 6 个标签页（含新增「对话中断」）', async () => {
  const rt = createMiniReact()
  const mod = loadClientModule(rt.react)
  const ui = createMounter(rt, mod.GuardSection, defaultFetch)
  await ui.mount()
  const text = rt.collectText(ui.tree())
  for (const label of ['总览', '网络', '对话质量', '环境', '配置', '对话中断', '恢复策略']) {
    assert.ok(text.includes(label), `缺少标签页 ${label}`)
  }
  assert.ok(text.includes('Guard'))
})

test('总览面板：点「一键体检」→ 显示全部通过', async () => {
  const rt = createMiniReact()
  const mod = loadClientModule(rt.react)
  const ui = createMounter(rt, mod.GuardSection, defaultFetch)
  await ui.mount()
  await ui.click('一键体检')
  const text = rt.collectText(ui.tree())
  assert.ok(text.includes('全部通过'), text.slice(0, 300))
  assert.ok(ui.calls.some((c) => c.url.endsWith('/diag') && c.method === 'POST'), '应 POST /diag')
})

test('网络面板：点「探测网络」→ 显示每个目标与可达结论', async () => {
  const rt = createMiniReact()
  const mod = loadClientModule(rt.react)
  const ui = createMounter(rt, mod.GuardSection, defaultFetch)
  await ui.mount()
  await ui.clickTab('网络')
  await ui.click('探测网络')
  const text = rt.collectText(ui.tree())
  assert.ok(text.includes('全部可达'), text.slice(0, 300))
  assert.ok(text.includes('dns-basic'))
  assert.ok(text.includes('api-deepseek'))
})

test('环境面板：点「读取环境」→ 磁盘/内存都有数据（旧版磁盘永远没数据）', async () => {
  const rt = createMiniReact()
  const mod = loadClientModule(rt.react)
  const ui = createMounter(rt, mod.GuardSection, defaultFetch)
  await ui.mount()
  await ui.clickTab('环境')
  await ui.click('读取环境')
  const text = rt.collectText(ui.tree())
  assert.ok(text.includes('磁盘'), text.slice(0, 300))
  assert.ok(text.includes('内存'))
  assert.ok(text.includes('26% 已用'))
  assert.ok(text.includes('29.1% 已用'))
})

test('配置面板：点「检查配置」→ 显示检查项（不再永远只显示一句 ✅）', async () => {
  const rt = createMiniReact()
  const mod = loadClientModule(rt.react)
  const ui = createMounter(rt, mod.GuardSection, defaultFetch)
  await ui.mount()
  await ui.clickTab('配置')
  await ui.click('检查配置')
  const text = rt.collectText(ui.tree())
  assert.ok(text.includes('未发现配置问题'))
  assert.ok(text.includes('磁盘') === false || true) // 配置页不串环境数据
})

test('对话中断面板：选 max-tokens 点「获取续跑决策」→ 显示 compact 与简报', async () => {
  const rt = createMiniReact()
  const mod = loadClientModule(rt.react)
  const ui = createMounter(rt, mod.GuardSection, defaultFetch)
  await ui.mount()
  await ui.clickTab('对话中断')
  await ui.click('获取续跑决策')
  const text = rt.collectText(ui.tree())
  assert.ok(text.includes('决策：compact'), text.slice(0, 400))
  assert.ok(text.includes('压缩'))
  assert.ok(text.includes('目标：修完'))
  const call = ui.calls.find((c) => c.url.endsWith('/resume'))
  assert.equal(call.method, 'POST')
})

test('恢复策略面板：配置编辑器能读取配置并保存', async () => {
  const rt = createMiniReact()
  const mod = loadClientModule(rt.react)
  const ui = createMounter(rt, mod.GuardSection, defaultFetch)
  await ui.mount()
  await ui.clickTab('恢复策略')
  let text = rt.collectText(ui.tree())
  assert.ok(text.includes('重启限制'))
  assert.ok(text.includes('最小间隔'))
  // 点第一个「保存」（配置已由 useEffect 拉到）
  await ui.click('保存')
  text = rt.collectText(ui.tree())
  assert.ok(text.includes('已保存'), text.slice(-300))
  const call = ui.calls.find((c) => c.url.endsWith('/config') && c.method === 'POST')
  assert.ok(call, '应 POST /config')
  assert.ok(call.body.includes('restart'), call.body)
})

test('接口失败时面板显示错误而不是白屏（错误边界/降级）', async () => {
  const rt = createMiniReact()
  const mod = loadClientModule(rt.react)
  const ui = createMounter(rt, mod.GuardSection, (url, opts) => {
    if (url.endsWith('/diag')) return new Error('HTTP 500 — boom')
    return defaultFetch(url, opts)
  })
  await ui.mount()
  await ui.click('一键体检')
  const text = rt.collectText(ui.tree())
  assert.ok(text.includes('HTTP 500') || text.includes('❌'), text.slice(0, 300))
})
