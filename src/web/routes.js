/**
 * cs-guard — HTTP API
 *
 *   GET  /cs-guard/health   健康检查
 *   POST /cs-guard/diag     一键体检（真实探测网络/环境/配置）
 *   GET  /cs-guard/state    当前状态
 *
 * @module cs-guard/web/routes
 */

import { buildReport } from '../index.js'
import { PROBE_TARGETS, classifyNetwork } from '../detect/network.js'
import { THRESHOLDS, assessMemoryHealth } from '../detect/env.js'
import { judge, sendJson } from './guard.js'
import { readConfig, writeConfig, withDefaults, DEFAULTS } from '../config/store.js'

export const PREFIX = '/cs-guard'

async function readBody(req, limit = 512 * 1024) {
  return new Promise((resolve) => {
    let d = ''
    req.on('data', (c) => { d += c; if (d.length > limit) { req.destroy(); resolve(undefined) } })
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : undefined) } catch { resolve(undefined) } })
    req.on('error', () => resolve(undefined))
  })
}

/** 探测单个 URL（HEAD 优先，超时即失败） */
async function probeUrl(url, { fetchImpl, timeoutMs = 6000 }) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  const t0 = Date.now()
  try {
    const res = await fetchImpl(url, { method: 'GET', signal: ctrl.signal, redirect: 'manual' })
    return { ok: true, http: res.status, ms: Date.now() - t0 }
  } catch (err) {
    return { ok: false, ms: Date.now() - t0, error: String(err?.message ?? err).slice(0, 80) }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 读系统信息（**跨平台**）。
 *
 * 🔴 教训（Windows 实测）：`/proc/meminfo` 只存在于 Linux。
 *    Windows 上会读失败 → 之前显示「⏸ 无法读取」，等于功能废掉。
 *    改用 Node 内置 `os.totalmem()/freemem()`，三平台都可用。
 *
 * Linux 额外读 overcommit（只作辅助信号，容器内必然偏高）。
 */
export async function readSystemInfo({ readFileImpl, osImpl } = {}) {
  const os = osImpl ?? (await import('node:os')).default ?? (await import('node:os'))
  const read = readFileImpl ?? (async (p) => {
    const fs = await import('node:fs/promises')
    return fs.readFile(p, 'utf8')
  })

  const out = {
    memory: null,
    overcommit: null,
    platform: process.platform,
    source: null,
  }

  // ① 跨平台主路径：os 模块
  try {
    const total = os.totalmem()
    const free = os.freemem()
    if (Number.isFinite(total) && total > 0) {
      out.memory = { totalBytes: total, freeBytes: free }
      out.source = `os 模块（${process.platform}）`
    }
  } catch { /* ignore */ }

  // ② Linux 额外：overcommit（仅辅助，不参与主判定）
  if (process.platform === 'linux') {
    try {
      const mi = await read('/proc/meminfo')
      const get = (k) => {
        const m = new RegExp('^' + k + ':\\s+(\\d+) kB', 'm').exec(mi)
        return m ? Number(m[1]) * 1024 : null
      }
      const cas = get('Committed_AS')
      const cl = get('CommitLimit')
      if (cas && cl) out.overcommit = { committedAS: cas, commitLimit: cl }
      // os.freemem 在 Linux 上不含 cache，用 MemAvailable 更准
      const avail = get('MemAvailable')
      const total = get('MemTotal')
      if (avail && total) {
        out.memory = { totalBytes: total, freeBytes: avail }
        out.source = '/proc/meminfo（MemAvailable）'
      }
    } catch { /* 非 Linux 或读不到 */ }
  }

  return out
}

/**
 * @returns {number} 注册条数
 */
export function registerRoutes(webServer, opts = {}) {
  if (!webServer || typeof webServer.register !== 'function') return 0
  const {
    trustedHosts = [], logger = console, fetchImpl = globalThis.fetch,
    now = () => Date.now(), readFileImpl, osImpl, resolveFn,
  } = opts

  let n = 0
  const route = (path, handler) => {
    try {
      webServer.register({
        kind: 'exact',
        path: `${PREFIX}${path}`,
        handler: async (req, res) => {
          const verdict = judge(req, { trustedHosts })
          if (!verdict.ok) return sendJson(res, 403, { ok: false, error: verdict.reason })
          try {
            const body = req.method === 'POST' ? await readBody(req) : undefined
            const out = await handler({ req, res, body })
            if (out !== undefined) sendJson(res, 200, out)
          } catch (err) {
            logger.warn?.(`${path} 失败：${err?.message ?? err}`)
            sendJson(res, 500, { ok: false, error: String(err?.message ?? err).slice(0, 200) })
          }
        },
      })
      n++
    } catch (err) {
      logger.warn?.(`注册 ${path} 失败：${err?.message ?? err}`)
    }
  }

  route('/health', async () => ({ ok: true, plugin: 'cs-guard', version: opts.version ?? '1.0.5', at: now(), prefix: PREFIX }))

  route('/state', async () => ({
    ok: true,
    at: now(),
    targets: PROBE_TARGETS.map((t) => ({ id: t.id, label: t.label, cls: t.cls })),
    thresholds: THRESHOLDS,
    faults: [
      { key: 'network', label: '网络分片坏', act: '只上报' },
      { key: 'context', label: '对话质量退化', act: '压缩后重试' },
      { key: 'env', label: '环境（磁盘/内存）', act: '只上报' },
      { key: 'overcommit', label: 'overcommit 卡死', act: '请求重启' },
      { key: 'config', label: '配置错误', act: '只上报' },
    ],
  }))

  route('/diag', async () => {
    const checks = []
    const add = (name, ok, detail) => checks.push({ name, ok, detail })

    add('HTTP 路由', true, `${PREFIX} 已注册 ${n} 条`)

    // 网络（真实探测）
    const results = []
    for (const t of PROBE_TARGETS) {
      const r = await probeUrl(t.url, { fetchImpl })
      results.push({ id: t.id, ok: r.ok, ms: r.ms, http: r.http, error: r.error })
    }
    const net = classifyNetwork(results)
    add('网络', net.verdict === 'healthy' ? true : net.verdict === 'partial' ? null : false,
      net.verdict === 'healthy' ? `全部可达（${results.length} 个目标）`
        : net.verdict === 'partial' ? `分片损坏：${net.bad.join(', ')}`
          : '全部不可达')

    // 环境（跨平台）
    const sys = await readSystemInfo({ readFileImpl, osImpl })
    const mem = assessMemoryHealth({
      totalBytes: sys.memory?.totalBytes,
      freeBytes: sys.memory?.freeBytes,
      committedAS: sys.overcommit?.committedAS,
      commitLimit: sys.overcommit?.commitLimit,
      inContainer: true,
    })
    const report = buildReport({ network: results })
    add('内存', mem.level === 'ok' ? true : mem.level === 'warn' ? null : mem.level === 'critical' ? false : null,
      mem.level === 'unknown'
        ? `无法读取（${process.platform}）`
        : `${mem.usedPct}% 已用（可用 ${(100 - mem.usedPct).toFixed(1)}%）· 来源：${sys.source ?? '未知'}`)
    add('overcommit', null,
      sys.overcommit
        ? `${(sys.overcommit.committedAS / sys.overcommit.commitLimit * 100).toFixed(0)}% · 容器内偏高属正常（已不作为判据）`
        : `不适用（${process.platform} 无此机制）`)

    const fails = checks.filter((c) => c.ok === false).length
    return {
      ok: fails === 0, at: now(), checks,
      network: { verdict: net.verdict, results, impact: net.impact },
      report,
      summary: fails === 0 ? '全部通过' : `${fails} 项异常`,
    }
  })

  // ── 配置（可读写）──
  route('/config', async ({ body }) => {
    if (body === undefined) {
      const raw = await readConfig(opts.dshHome)
      return { ok: true, config: withDefaults(raw), defaults: DEFAULTS }
    }
    const merged = withDefaults(Object.assign({}, await readConfig(opts.dshHome), body))
    const ok = await writeConfig(opts.dshHome, merged)
    return { ok, config: merged, hint: ok ? '已保存到 ~/.dsh/cs-guard/config.json' : '保存失败' }
  })

  return n
}
