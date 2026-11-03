/**
 * HTTP API 集成测试（v1.8.0 新增）—— 真实 Node HTTP server，逐接口/逐面板的后端行为。
 *
 * 覆盖真实故障注入发现的缺陷：
 *  · /diag 从不检查配置与磁盘 ⇒ 配置页永远 ✅、环境页磁盘永远没数据（假绿）
 *  · partial 网络异常时 summary 仍显示「全部通过」（误导用户）
 *  · 网络探测串行 ⇒ 断网时等 4×timeout
 *  · POST /config 接受非对象 / 凭据字段 / 越界值
 *  · 损坏 config.json 被静默覆盖
 *  · 对话中断没有可调用入口
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerRoutes } from '../src/web/routes.js'
import { configDir, configPath } from '../src/config/store.js'

const GOOD_PKG = { name: 'dsh-profile-web', dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }

async function makeHome({ pkg = GOOD_PKG, patch = '# empty\n', profile = 'web', corruptGuardConfig = false } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'cs-guard-routes-'))
  const dir = join(home, 'profiles', profile)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'package.json'), typeof pkg === 'string' ? pkg : JSON.stringify(pkg))
  if (patch !== null) await writeFile(join(dir, 'cordis.patch.yml'), patch)
  if (corruptGuardConfig) {
    await mkdir(configDir(home), { recursive: true })
    await writeFile(configPath(home), '{"restart":{"maxPerDay":9}, BROKEN')
  }
  return home
}

/** 起一个真实的 HTTP server，把 registerRoutes 注册的路由挂上去 */
async function startGuardServer(opts = {}) {
  const routes = new Map()
  const webServer = { register: ({ path, handler }) => routes.set(path, handler) }
  const n = registerRoutes(webServer, opts)
  const server = http.createServer((req, res) => {
    let pathname = '/'
    try { pathname = new URL(req.url, 'http://x').pathname } catch { /* ignore */ }
    const handler = routes.get(pathname)
    if (!handler) { res.writeHead(404); res.end('not found'); return }
    Promise.resolve(handler(req, res)).catch(() => { try { res.writeHead(500); res.end('handler error') } catch { /* ignore */ } })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    n,
    routes,
    port,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

/** 原始 http 请求（可自由设置 Host / Cookie，测试认证围栏） */
function request(port, path, { method = 'GET', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body))
    const req = http.request({
      host: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }),
        ...headers,
      },
    }, (res) => {
      let text = ''
      res.on('data', (c) => { text += c })
      res.on('end', () => {
        let json
        try { json = JSON.parse(text) } catch { json = text }
        resolve({ status: res.statusCode, json, headers: res.headers })
      })
    })
    req.on('error', reject)
    if (payload !== undefined) req.write(payload)
    req.end()
  })
}

/** 假 fetch：ok / 指定失败 / 带延迟 */
function fakeFetch({ failIds = [], delayMs = 0, status = 200 } = {}) {
  return async (url) => {
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs))
    const id = /baidu/.test(url) ? 'dns-basic'
      : /deepseek/.test(url) ? 'api-deepseek'
        : /npmmirror/.test(url) ? 'npm-mirror'
          : /github/.test(url) ? 'github-api' : 'custom'
    if (failIds.includes(id)) throw Object.assign(new TypeError('fetch failed'), { name: 'TypeError' })
    return { status, body: { cancel: async () => {} } }
  }
}
const okStatfs = async () => ({ blocks: 1000, bavail: 500, bsize: 4096 })
const baseOpts = (home, extra = {}) => ({
  version: '1.8.0-test',
  dshHome: home,
  profileName: 'web',
  fetchImpl: fakeFetch(),
  statfsImpl: okStatfs,
  resolveFn: () => true,
  osImpl: { totalmem: () => 1000, freemem: () => 500 },
  ...extra,
})

test('/health 可用；/state 含六类故障与探测目标', async () => {
  const home = await makeHome()
  const s = await startGuardServer(baseOpts(home))
  try {
    const h = await request(s.port, '/cs-guard/health')
    assert.equal(h.status, 200)
    assert.equal(h.json.plugin, 'cs-guard')
    assert.equal(h.json.version, '1.8.0-test')
    const st = await request(s.port, '/cs-guard/state')
    assert.equal(st.status, 200)
    assert.equal(st.json.faults.length, 6)
    assert.ok(st.json.faults.some((f) => f.key === 'dialog'))
    assert.equal(st.json.targets.length, 4)
    assert.equal(s.n, 5)
  } finally { await s.close(); await rm(home, { recursive: true, force: true }) }
})

test('/diag 全健康 ⇒ level=ok、包含网络/磁盘/内存/配置检查', async () => {
  const home = await makeHome()
  const s = await startGuardServer(baseOpts(home))
  try {
    const r = await request(s.port, '/cs-guard/diag', { method: 'POST', body: {} })
    assert.equal(r.status, 200)
    const names = r.json.checks.map((c) => c.name)
    for (const n of ['网络', '磁盘', '内存', 'overcommit', 'cs-guard 配置', 'profile package.json', 'cordis.patch.yml']) {
      assert.ok(names.includes(n), `缺检查项 ${n}：${names.join(',')}`)
    }
    assert.equal(r.json.level, 'ok', JSON.stringify(r.json.checks))
    assert.equal(r.json.report.level, 'ok')
    assert.equal(r.json.summary, '全部通过')
    assert.equal(r.json.ok, true)
  } finally { await s.close(); await rm(home, { recursive: true, force: true }) }
})

test('🔴 partial 网络异常 ⇒ level=warn、ok=false、summary 不再「全部通过」', async () => {
  const home = await makeHome()
  const s = await startGuardServer(baseOpts(home, { fetchImpl: fakeFetch({ failIds: ['npm-mirror'] }) }))
  try {
    const r = await request(s.port, '/cs-guard/diag', { method: 'POST', body: {} })
    assert.equal(r.json.network.verdict, 'partial')
    assert.equal(r.json.level, 'warn')
    assert.equal(r.json.ok, false)
    assert.match(r.json.summary, /需注意/)
    assert.ok(r.json.report.findings.some((f) => f.type === 'network'))
  } finally { await s.close(); await rm(home, { recursive: true, force: true }) }
})

test('全断网 ⇒ level=critical、网络检查 false、影响面非空', async () => {
  const home = await makeHome()
  const s = await startGuardServer(baseOpts(home, {
    fetchImpl: fakeFetch({ failIds: ['dns-basic', 'api-deepseek', 'npm-mirror', 'github-api'] }),
  }))
  try {
    const r = await request(s.port, '/cs-guard/diag', { method: 'POST', body: {} })
    assert.equal(r.json.network.verdict, 'all-down')
    assert.equal(r.json.level, 'critical')
    const net = r.json.checks.find((c) => c.name === '网络')
    assert.equal(net.ok, false)
    assert.ok(r.json.network.impact.length >= 4)
  } finally { await s.close(); await rm(home, { recursive: true, force: true }) }
})

test('🔴 网络探测并行：4 × 120ms 延迟的总耗时 < 400ms（旧串行 ≥480ms）', async () => {
  const home = await makeHome()
  const s = await startGuardServer(baseOpts(home, { fetchImpl: fakeFetch({ delayMs: 120 }) }))
  try {
    const t0 = Date.now()
    const r = await request(s.port, '/cs-guard/diag', { method: 'POST', body: {} })
    const took = Date.now() - t0
    assert.equal(r.json.level, 'ok')
    assert.ok(took < 400, `并行探测过慢：${took}ms`)
  } finally { await s.close(); await rm(home, { recursive: true, force: true }) }
})

test('🔴 磁盘检查失败 ⇒ 显式「无法读取」，不再假装全绿', async () => {
  const home = await makeHome()
  const s = await startGuardServer(baseOpts(home, {
    statfsImpl: async () => { throw new Error('statfs not supported') },
  }))
  try {
    const r = await request(s.port, '/cs-guard/diag', { method: 'POST', body: {} })
    const disk = r.json.checks.find((c) => c.name === '磁盘')
    assert.equal(disk.ok, false)
    assert.equal(disk.level, 'warn')
    assert.match(disk.detail, /无法读取磁盘信息/)
    assert.equal(r.json.level, 'warn')
  } finally { await s.close(); await rm(home, { recursive: true, force: true }) }
})

test('🔴 profile 配置含 !!js ⇒ /diag 配置页能报出来（此前永远 ✅）', async () => {
  const home = await makeHome({ patch: 'x: !!js/function >\n  return 1\n' })
  const s = await startGuardServer(baseOpts(home))
  try {
    const r = await request(s.port, '/cs-guard/diag', { method: 'POST', body: {} })
    assert.ok(r.json.report.findings.some((f) => f.type === 'config' && /!!js/.test(f.detail)))
    assert.equal(r.json.level, 'warn')
  } finally { await s.close(); await rm(home, { recursive: true, force: true }) }
})

test('🔴 cs-guard 自身 config.json 损坏 ⇒ /diag 与 /config 都显式报错', async () => {
  const home = await makeHome({ corruptGuardConfig: true })
  const s = await startGuardServer(baseOpts(home))
  try {
    const d = await request(s.port, '/cs-guard/diag', { method: 'POST', body: {} })
    const cfg = d.json.checks.find((c) => c.name === 'cs-guard 配置')
    assert.equal(cfg.ok, false)
    assert.match(cfg.detail, /JSON 损坏/)
    assert.ok(d.json.report.findings.some((f) => /cs-guard 配置文件异常/.test(f.detail)))

    const g = await request(s.port, '/cs-guard/config')
    assert.equal(g.status, 200)
    assert.match(g.json.configError, /JSON 损坏/)
    assert.equal(g.json.config.context.warnTokens, 250000)
  } finally { await s.close(); await rm(home, { recursive: true, force: true }) }
})

test('/config GET 返回脱敏配置 + 默认值', async () => {
  const home = await makeHome()
  const s = await startGuardServer(baseOpts(home))
  try {
    const r = await request(s.port, '/cs-guard/config')
    assert.equal(r.status, 200)
    assert.equal(r.json.config.schema, 'cs-guard/config/v1')
    assert.equal(r.json.config.watch.network, true)
    assert.equal(r.json.configFile.exists, false)
    assert.equal(r.json.configError, null)
  } finally { await s.close(); await rm(home, { recursive: true, force: true }) }
})

test('🔴 POST /config 非对象 body ⇒ 400（旧实现会写进 0/1/2 垃圾键）', async () => {
  const home = await makeHome()
  const s = await startGuardServer(baseOpts(home))
  try {
    for (const body of ['"abc"', '[1,2]', 'null']) {
      const r = await request(s.port, '/cs-guard/config', { method: 'POST', body })
      assert.equal(r.status, 400, `body=${body}`)
      assert.match(r.json.errors.join('；'), /JSON 对象/)
    }
    // 非法 JSON
    const bad = await request(s.port, '/cs-guard/config', { method: 'POST', body: '{oops' , headers: { 'content-type': 'application/json' } })
    assert.equal(bad.status, 400)
    const names = await readdir(configDir(home)).catch(() => [])
    assert.equal(names.length, 0)
  } finally { await s.close(); await rm(home, { recursive: true, force: true }) }
})

test('POST /config 越界/类型错误 ⇒ 400 且不落盘', async () => {
  const home = await makeHome()
  const s = await startGuardServer(baseOpts(home))
  try {
    const r = await request(s.port, '/cs-guard/config', { method: 'POST', body: { restart: { maxPerDay: 999 } } })
    assert.equal(r.status, 400)
    assert.match(r.json.errors.join('；'), /超出范围/)
    await assert.rejects(readFile(configPath(home), 'utf8'), /ENOENT/)
  } finally { await s.close(); await rm(home, { recursive: true, force: true }) }
})

test('POST /config 凭据类字段 ⇒ 400（无凭据落盘）', async () => {
  const home = await makeHome()
  const s = await startGuardServer(baseOpts(home))
  try {
    const r = await request(s.port, '/cs-guard/config', { method: 'POST', body: { apiKey: 'sk-1234567890' } })
    assert.equal(r.status, 400)
    assert.match(r.json.errors.join('；'), /凭据/)
  } finally { await s.close(); await rm(home, { recursive: true, force: true }) }
})

test('POST /config 合法 ⇒ 保存成功、文件 0600，GET 能读回', async () => {
  const home = await makeHome()
  const s = await startGuardServer(baseOpts(home))
  try {
    const r = await request(s.port, '/cs-guard/config', { method: 'POST', body: { restart: { maxPerDay: 2 } } })
    assert.equal(r.status, 200)
    assert.equal(r.json.ok, true)
    assert.equal(r.json.config.restart.maxPerDay, 2)
    const saved = JSON.parse(await readFile(configPath(home), 'utf8'))
    assert.equal(saved.restart.maxPerDay, 2)
    assert.equal(saved.context.warnTokens, 250000)
    if (process.platform !== 'win32') {
      const { stat } = await import('node:fs/promises')
      assert.equal((await stat(configPath(home))).mode & 0o777, 0o600)
    }
    const g = await request(s.port, '/cs-guard/config')
    assert.equal(g.json.config.restart.maxPerDay, 2)
  } finally { await s.close(); await rm(home, { recursive: true, force: true }) }
})

test('🔴 POST /config 覆盖损坏文件前先备份（不无痕丢配置）', async () => {
  const home = await makeHome({ corruptGuardConfig: true })
  const s = await startGuardServer(baseOpts(home))
  try {
    const r = await request(s.port, '/cs-guard/config', { method: 'POST', body: { restart: { maxPerDay: 2 } } })
    assert.equal(r.json.ok, true)
    assert.ok(r.json.quarantined, '返回里应含备份路径')
    assert.match(r.json.hint, /备份/)
    const names = await readdir(configDir(home))
    assert.equal(names.filter((x) => x.startsWith('config.json.broken-')).length, 1)
  } finally { await s.close(); await rm(home, { recursive: true, force: true }) }
})

test('不支持的方法 ⇒ 405', async () => {
  const home = await makeHome()
  const s = await startGuardServer(baseOpts(home))
  try {
    const r = await request(s.port, '/cs-guard/config', { method: 'PUT', body: {} })
    assert.equal(r.status, 405)
  } finally { await s.close(); await rm(home, { recursive: true, force: true }) }
})

test('/resume GET 返回动作列表；POST max-tokens ⇒ 压缩 + 简报', async () => {
  const home = await makeHome()
  const s = await startGuardServer(baseOpts(home))
  try {
    const g = await request(s.port, '/cs-guard/resume')
    assert.equal(g.status, 200)
    assert.ok(g.json.actions.includes('compact'))

    const r = await request(s.port, '/cs-guard/resume', {
      method: 'POST',
      body: { reason: 'max-tokens', attempt: 0, state: { goal: '修完 cs-guard', pending: ['提交'] } },
    })
    assert.equal(r.status, 200)
    assert.equal(r.json.decision.action, 'compact')
    assert.match(r.json.brief, /目标：修完 cs-guard/)
    assert.match(r.json.brief, /待办：提交/)
  } finally { await s.close(); await rm(home, { recursive: true, force: true }) }
})

test('/resume：退化文本 + 高水位 ⇒ compact；用户主动中止 ⇒ ask-human', async () => {
  const home = await makeHome()
  const s = await startGuardServer(baseOpts(home))
  try {
    const degen = await request(s.port, '/cs-guard/resume', {
      method: 'POST',
      body: { reason: 'error', inputTokens: 330000, text: '作为一个人工智能语言模型，我还没学习如何回答这个问题' },
    })
    assert.equal(degen.json.decision.action, 'compact')
    assert.equal(degen.json.context.degenerate, true)
    assert.equal(degen.json.context.level, 'critical')

    const abort = await request(s.port, '/cs-guard/resume', {
      method: 'POST',
      body: { reason: { kind: 'aborted', reason: { kind: 'user' } } },
    })
    assert.equal(abort.json.decision.action, 'ask-human')
  } finally { await s.close(); await rm(home, { recursive: true, force: true }) }
})

test('/resume 非对象 body ⇒ 400', async () => {
  const home = await makeHome()
  const s = await startGuardServer(baseOpts(home))
  try {
    const r = await request(s.port, '/cs-guard/resume', { method: 'POST', body: '[1]' })
    assert.equal(r.status, 400)
  } finally { await s.close(); await rm(home, { recursive: true, force: true }) }
})

// ── 认证围栏（集成）──
test('🔴 公网 Host + 伪造 cookie ⇒ 403（旧实现 200）', async () => {
  const home = await makeHome()
  const s = await startGuardServer(baseOpts(home))
  try {
    const r = await request(s.port, '/cs-guard/config', {
      headers: { host: 'example.com', cookie: 'dsh-auth-forged' },
    })
    assert.equal(r.status, 403)
    assert.equal(r.json.error, 'auth-unverifiable')
  } finally { await s.close(); await rm(home, { recursive: true, force: true }) }
})

test('公网 Host + 有效会话（假 connection 放行）⇒ 200', async () => {
  const home = await makeHome()
  const conn = {
    requestRejection: (req) => {
      const c = req.headers.cookie
      if (c === 'dsh-auth-ok=v2.sig') return undefined
      if (!c) return 401
      return 403
    },
  }
  const s = await startGuardServer(baseOpts(home, { getConnection: () => conn }))
  try {
    const good = await request(s.port, '/cs-guard/config', { headers: { host: 'example.com', cookie: 'dsh-auth-ok=v2.sig' } })
    assert.equal(good.status, 200)
    const bad = await request(s.port, '/cs-guard/config', { headers: { host: 'example.com', cookie: 'dsh-auth-forged' } })
    assert.equal(bad.status, 403)
    const none = await request(s.port, '/cs-guard/config', { headers: { host: 'example.com' } })
    assert.equal(none.status, 401)
  } finally { await s.close(); await rm(home, { recursive: true, force: true }) }
})

test('回环直连（本机管理员）无需 cookie 仍可用', async () => {
  const home = await makeHome()
  const s = await startGuardServer(baseOpts(home))
  try {
    assert.equal((await request(s.port, '/cs-guard/health')).status, 200)
    assert.equal((await request(s.port, '/cs-guard/config')).status, 200)
  } finally { await s.close(); await rm(home, { recursive: true, force: true }) }
})

test('/diag 非法 JSON body ⇒ 400（不再当 GET 静默返回）', async () => {
  const home = await makeHome()
  const s = await startGuardServer(baseOpts(home))
  try {
    const r = await request(s.port, '/cs-guard/diag', { method: 'POST', body: '{bad', headers: { 'content-type': 'application/json' } })
    assert.equal(r.status, 400)
  } finally { await s.close(); await rm(home, { recursive: true, force: true }) }
})

test('未注册路径 ⇒ 404（路由是 exact，不误匹配其它插件前缀）', async () => {
  const home = await makeHome()
  const s = await startGuardServer(baseOpts(home))
  try {
    assert.equal((await request(s.port, '/cs-guard/nope')).status, 404)
    assert.equal((await request(s.port, '/cs-guardx/health')).status, 404)
  } finally { await s.close(); await rm(home, { recursive: true, force: true }) }
})
