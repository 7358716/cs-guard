/**
 * cs-guard — HTTP API
 *
 *   GET  /cs-guard/health   健康检查
 *   POST /cs-guard/diag     一键体检（真实探测网络/磁盘/内存/配置）
 *   GET  /cs-guard/state    当前状态
 *   GET  /cs-guard/config   读配置（脱敏，带 configError 状态）
 *   POST /cs-guard/config   写配置（白名单 + 范围校验 + 损坏文件先备份）
 *   POST /cs-guard/resume   对话中断续跑决策（压缩 / 重试 / 交人）
 *
 * 所有路由统一过 web/guard.js（host connection 真实会话校验）。
 *
 * @module cs-guard/web/routes
 */

import { join } from 'node:path'
import { buildReport } from '../index.js'
import { PROBE_TARGETS, classifyNetwork } from '../detect/network.js'
import { THRESHOLDS, assessMemoryHealth, assessStatfs } from '../detect/env.js'
import { assessContext } from '../detect/context.js'
import { judge, sendJson, safeErrorText } from './guard.js'
import {
  readConfigState, writeConfig, withDefaults, DEFAULTS, resolveDshHome, configPath,
} from '../config/store.js'
import { validateUserConfig, redactSecrets, isPlainObject } from '../config/validate.js'
import { inspectProfile, makeResolver, detectProfileName } from '../detect/profile.js'
import { decideResume, compactPrompt, ACTION, NO_RETRY_ERROR_CODES } from '../repair/resume.js'

export const PREFIX = '/cs-guard'

/** 读取请求体（限制大小，解析失败显式回报，不再「解析失败当 GET」） */
function readBody(req, limit = 512 * 1024) {
  return new Promise((resolve) => {
    let d = ''
    let settled = false
    const done = (v) => { if (!settled) { settled = true; resolve(v) } }
    req.on('data', (c) => {
      d += c
      if (d.length > limit) { try { req.destroy() } catch { /* ignore */ } done({ ok: false, error: '请求体过大' }) }
    })
    req.on('end', () => {
      if (d === '') return done({ ok: true, value: undefined })
      try { done({ ok: true, value: JSON.parse(d) }) } catch { done({ ok: false, error: '请求体不是合法 JSON' }) }
    })
    req.on('error', () => done({ ok: false, error: '读取请求体失败' }))
  })
}

/**
 * 探测单个 URL（超时即失败）。
 *
 * @returns {Promise<{ok:boolean, http?:number, ms:number, error?:string}>}
 */
export async function probeUrl(url, { fetchImpl = globalThis.fetch, timeoutMs = 6000 } = {}) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  const t0 = Date.now()
  try {
    const res = await fetchImpl(url, { method: 'GET', signal: ctrl.signal, redirect: 'manual' })
    // 不读 body（只要连通性），但显式取消，避免占住连接
    try { await res.body?.cancel?.() } catch { /* ignore */ }
    return { ok: true, http: res.status, ms: Date.now() - t0 }
  } catch (err) {
    const aborted = err?.name === 'AbortError' || /abort/i.test(String(err?.message ?? ''))
    return {
      ok: false,
      ms: Date.now() - t0,
      error: aborted ? `超时（>${timeoutMs}ms）` : safeErrorText(err, 80),
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 并行探测全部目标。
 *
 * 🔴 旧实现**串行**探测：断网时 4 个目标 × 6s 超时 = 用户要等 24s（实测 6.5s 才回一半）。
 *    现在并行 ⇒ 总耗时 ≈ 单个最长（默认 4s 上限）。
 */
export async function probeAll(targets, { fetchImpl, timeoutMs } = {}) {
  const results = await Promise.all(targets.map(async (t) => {
    const r = await probeUrl(t.url, { fetchImpl, timeoutMs })
    return { id: t.id, label: t.label, cls: t.cls, ...r }
  }))
  return results
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

/** 默认 statfs（Node 18.15+ / 22 可用） */
async function defaultStatfs(path) {
  const fs = await import('node:fs/promises')
  return fs.statfs(path)
}

/**
 * @returns {number} 注册条数
 */
export function registerRoutes(webServer, opts = {}) {
  if (!webServer || typeof webServer.register !== 'function') return 0
  const {
    trustedHosts = [], logger = console, fetchImpl = globalThis.fetch,
    now = () => Date.now(), readFileImpl, osImpl, statfsImpl, resolveFn,
    getConnection, probeTargets = PROBE_TARGETS, probeTimeoutMs = 4000,
    profileName = detectProfileName(),
  } = opts
  const dshHome = opts.dshHome
  const home = resolveDshHome(dshHome)
  const probeProfile = profileName

  let n = 0
  const route = (path, handler) => {
    try {
      webServer.register({
        kind: 'exact',
        path: `${PREFIX}${path}`,
        handler: async (req, res) => {
          const verdict = judge(req, { trustedHosts, getConnection })
          if (!verdict.ok) return sendJson(res, verdict.status ?? 403, { ok: false, error: verdict.reason })
          try {
            const method = String(req.method || 'GET').toUpperCase()
            let body
            if (method === 'POST' || method === 'PUT') {
              const parsed = await readBody(req)
              if (!parsed.ok) return sendJson(res, 400, { ok: false, error: parsed.error })
              body = parsed.value
            }
            const out = await handler({ req, res, body, method })
            if (out !== undefined) sendJson(res, 200, out)
          } catch (err) {
            logger.warn?.(`${path} 失败：${safeErrorText(err)}`)
            sendJson(res, 500, { ok: false, error: safeErrorText(err) })
          }
        },
      })
      n++
    } catch (err) {
      logger.warn?.(`注册 ${path} 失败：${safeErrorText(err)}`)
    }
  }

  route('/health', async () => ({ ok: true, plugin: 'cs-guard', version: opts.version ?? '1.0.5', at: now(), prefix: PREFIX }))

  route('/state', async () => ({
    ok: true,
    at: now(),
    version: opts.version ?? null,
    profile: probeProfile,
    targets: probeTargets.map((t) => ({ id: t.id, label: t.label, cls: t.cls })),
    probeTimeoutMs,
    thresholds: THRESHOLDS,
    faults: [
      { key: 'network', label: '网络分片坏', act: '只上报' },
      { key: 'context', label: '对话质量退化', act: '压缩后重试' },
      { key: 'env', label: '环境（磁盘/内存）', act: '只上报' },
      { key: 'overcommit', label: 'overcommit 卡死', act: '请求重启' },
      { key: 'config', label: '配置错误', act: '只上报' },
      { key: 'dialog', label: '对话中断', act: '压缩/重试/交人（决策 API）' },
    ],
  }))

  route('/diag', async () => {
    const checks = []
    // level: ok | warn | critical | info（info 只展示，不计入告警——如 overcommit 容器内偏高）
    const add = (name, level, detail) => checks.push({
      name, level, detail, ok: level === 'ok' ? true : level === 'info' ? null : false,
    })

    add('HTTP 路由', 'ok', `${PREFIX} 已注册 ${n} 条`)

    // ── 网络（真实探测，并行）──
    const t0 = now()
    const results = await probeAll(probeTargets, { fetchImpl, timeoutMs: probeTimeoutMs })
    const net = classifyNetwork(results, probeTargets)
    const maxMs = results.reduce((m, r) => Math.max(m, r.ms || 0), 0)
    add('网络', net.verdict === 'healthy' ? 'ok' : net.verdict === 'partial' ? 'warn' : 'critical',
      net.verdict === 'healthy' ? `全部可达（${results.length} 个目标，最慢 ${maxMs}ms）`
        : net.verdict === 'partial' ? `分片损坏：${net.bad.join(', ')}`
          : '全部不可达')

    // ── 磁盘（此前完全没实现：环境页「磁盘」永远没数据）──
    let disk = { level: 'unknown', usedPct: null, advice: '无法读取磁盘信息' }
    try {
      const st = await (statfsImpl ?? defaultStatfs)(home)
      disk = assessStatfs(st)
    } catch (err) {
      disk = { level: 'unknown', usedPct: null, advice: `无法读取磁盘信息（${safeErrorText(err, 60)}）` }
    }
    add('磁盘', disk.level === 'ok' ? 'ok' : disk.level === 'critical' ? 'critical' : 'warn',
      disk.level === 'unknown' ? disk.advice
        : `${disk.usedPct}% 已用（剩余 ${disk.freeGB} GB）· ${home}`)

    // ── 内存 / overcommit（跨平台）──
    const sys = await readSystemInfo({ readFileImpl, osImpl })
    const mem = assessMemoryHealth({
      totalBytes: sys.memory?.totalBytes,
      freeBytes: sys.memory?.freeBytes,
      committedAS: sys.overcommit?.committedAS,
      commitLimit: sys.overcommit?.commitLimit,
      inContainer: true,
    })
    add('内存', mem.level === 'ok' ? 'ok' : mem.level === 'critical' ? 'critical' : 'warn',
      mem.level === 'unknown'
        ? `无法读取（${process.platform}）`
        : `${mem.usedPct}% 已用（可用 ${(100 - mem.usedPct).toFixed(1)}%）· 来源：${sys.source ?? '未知'}`)
    add('overcommit', 'info',
      sys.overcommit
        ? `${(sys.overcommit.committedAS / sys.overcommit.commitLimit * 100).toFixed(0)}% · 容器内偏高属正常（已不作为判据）`
        : `不适用（${process.platform} 无此机制）`)

    // ── 配置（宿主 profile + 本插件配置；此前 /diag 完全没跑配置检查 ⇒ 配置页永远显示 ✅）──
    let prof = { checks: [], findings: [], patchText: null, packageData: null }
    try {
      prof = await inspectProfile({
        dshHome,
        profileName: probeProfile,
        readFileImpl,
        resolveFn: resolveFn ?? makeResolver(join(home, 'profiles', probeProfile)),
      })
      for (const c of prof.checks) {
        checks.push({
          name: c.name,
          detail: c.detail,
          level: c.ok === true ? 'ok' : c.ok === null ? 'info' : 'warn',
          ok: c.ok === true ? true : c.ok === null ? null : false,
        })
      }
    } catch (err) {
      add('配置', 'warn', `配置检查失败：${safeErrorText(err)}`)
    }

    const cfgState = await readConfigState(dshHome, { readFileImpl })
    if (cfgState.error) add('cs-guard 配置', 'warn', cfgState.error)
    else add('cs-guard 配置', 'ok', cfgState.exists ? '已保存配置可读（0600）' : '未保存过（使用默认值）')

    const report = buildReport({
      network: results,
      disk: disk.level === 'unknown' ? undefined : disk,
      memory: sys.memory ?? undefined,
      patch: typeof prof.patchText === 'string' ? prof.patchText : undefined,
      profile: prof.packageData ? { bundles: prof.packageData?.dsh?.profile?.bundles, deps: prof.packageData?.dependencies } : undefined,
      configError: cfgState.error ?? undefined,
      resolveFn,
    })

    const criticals = checks.filter((c) => c.level === 'critical').length
    const warns = checks.filter((c) => c.level === 'warn').length
    const level = criticals > 0 ? 'critical' : warns > 0 ? 'warn' : 'ok'
    return {
      ok: level === 'ok',
      level,
      at: now(),
      elapsedMs: now() - t0,
      checks,
      network: { verdict: net.verdict, results, impact: net.impact },
      disk,
      report,
      summary: criticals > 0
        ? `${criticals} 项异常${warns > 0 ? `（另 ${warns} 项需注意）` : ''}`
        : warns > 0 ? `${warns} 项需注意` : '全部通过',
    }
  })

  // ── 配置（可读写，带校验 / 脱敏 / 损坏备份）──
  route('/config', async ({ body, method, res }) => {
    if (method === 'GET' || method === 'HEAD') {
      const state = await readConfigState(dshHome, { readFileImpl })
      return {
        ok: true,
        config: redactSecrets(withDefaults(state.config)),
        defaults: redactSecrets(DEFAULTS),
        configFile: { path: configPath(dshHome), exists: state.exists },
        configError: state.error ?? null,
      }
    }
    if (method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
      return undefined
    }
    const base = withDefaults((await readConfigState(dshHome, { readFileImpl })).config)
    const v = validateUserConfig(body, { base })
    if (!v.ok) {
      sendJson(res, 400, { ok: false, error: '配置校验失败', errors: v.errors, warnings: v.warnings })
      return undefined
    }
    const w = await writeConfig(dshHome, v.config, { readFileImpl })
    if (!w.ok) {
      logger.warn?.(`保存配置失败：${w.error}`)
      return { ok: false, error: w.error, warnings: v.warnings, hint: '保存失败（详见 error）' }
    }
    return {
      ok: true,
      config: redactSecrets(v.config),
      warnings: v.warnings,
      ...(w.quarantined ? { quarantined: w.quarantined } : {}),
      hint: w.quarantined
        ? `已保存；原损坏配置已备份到 ${w.quarantined}`
        : '已保存到 <DSH_HOME>/cs-guard/config.json（0600）',
    }
  })

  // ── 对话中断：续跑决策（压缩 / 重试 / 交人）──
  route('/resume', async ({ body, method, res }) => {
    const cfg = withDefaults((await readConfigState(dshHome, { readFileImpl })).config)
    if (method === 'GET' || method === 'HEAD') {
      return {
        ok: true,
        actions: Object.values(ACTION),
        reasonKinds: ['completed', 'error', 'interrupted', 'max-tokens', 'aborted'],
        noRetryErrorCodes: NO_RETRY_ERROR_CODES,
        config: { maxAttempts: cfg.resume.maxAttempts, compactBeforeRetry: cfg.resume.compactBeforeRetry },
        note: 'POST { reason, attempt?, inputTokens?, text?, state? } 获取决策；自动执行仍交调用方/人（纪律：不碰 agent 钩子）',
      }
    }
    if (!isPlainObject(body)) {
      sendJson(res, 400, { ok: false, error: '请求体必须是 JSON 对象' })
      return undefined
    }
    const ctxIn = isPlainObject(body.context) ? body.context : {}
    const inputTokens = body.inputTokens ?? ctxIn.inputTokens
    const text = body.text ?? ctxIn.text
    const assessment = assessContext({
      inputTokens,
      text,
      warnAt: cfg.context.warnTokens,
      criticalAt: cfg.context.criticalTokens,
    })
    const decision = decideResume({
      reason: body.reason ?? ctxIn.reason,
      attempt: Number.isInteger(body.attempt) ? body.attempt : 0,
      context: Object.assign({}, assessment, ctxIn),
      maxAttempts: Number.isInteger(body.maxAttempts) ? body.maxAttempts : cfg.resume.maxAttempts,
    })
    return {
      ok: true,
      at: now(),
      decision,
      context: assessment,
      brief: decision.action === ACTION.COMPACT_THEN_RETRY ? compactPrompt(isPlainObject(body.state) ? body.state : {}) : null,
      config: { maxAttempts: cfg.resume.maxAttempts, compactBeforeRetry: cfg.resume.compactBeforeRetry },
    }
  })

  return n
}
