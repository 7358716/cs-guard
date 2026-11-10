/**
 * cs-guard — 看护/守护插件入口
 *
 * 设计依据：design/08-架构设计方案-v3终版.md §12
 *
 * 职责：网络 / 环境 / 配置 / 崩溃 / 对话中断 五类故障的检测与恢复
 *
 * ⚠️ 三条纪律（v3 §12.2）：
 *  1. 只做检测 + 上报 + **受限**恢复，不碰 agent/request-error 与 llm/stream
 *  2. 重启复用现有 dsh-restart-guard 通道，不另造 supervisor/cron
 *  3. 只读消费 cs-myfree 的审计，**不 import 对方**（文件级约定）
 *
 * 权限收窄（v3 §12.4）：删除/移动文件**永远人工确认**，本插件不做。
 *
 * @module cs-guard
 */

import { classifyNetwork, PROBE_TARGETS } from './detect/network.js'
import { detectDegenerate, assessContext, DEFAULT_TOKEN_WARN, DEFAULT_TOKEN_CRITICAL } from './detect/context.js'
import { checkPatchRefs, checkJsTags, checkBundleConsistency } from './detect/config.js'
import { assessDisk, assessMemory, assessOvercommit, THRESHOLDS } from './detect/env.js'
import { decide as decideSupervise, buildRestartRequest, DECISION, DEFAULTS as SUPERVISE_DEFAULTS } from './supervisor/plan.js'
import { decideResume, compactPrompt, ACTION as RESUME_ACTION } from './repair/resume.js'
import { guardApply, makeLogger, safeEffect, safeProvide, safeInject, detectHostVersion, redactText } from './compat.js'
import { registerRoutes, PREFIX as API_PREFIX } from './web/routes.js'
import { normalizeBootConfig, validateUserConfig, redactSecrets } from './config/validate.js'
import { inspectProfile, detectProfileName, DEFAULT_PROFILE } from './detect/profile.js'
import { readConfigState, withDefaults, DEFAULTS, resolveDshHome } from './config/store.js'
import { installWatchdog } from './watchdog.js'

const NAME = 'cs-guard'
const VERSION = '1.9.0'

export const name = NAME
export const version = VERSION

/**
 * 汇总一次巡检（纯函数，便于测试）。
 * @param {object} input 各项检测的原始数据
 */
export function buildReport(input = {}) {
  const findings = []

  if (input.network) {
    // ⚠️ 修复（2026-11-04 测试）：之前 buildReport 调用 classifyNetwork 时不传 targets，
    //   导致自定义 probeTargets 全部宕机时 /diag 仍报"全部正常"（假绿）。
    const n = classifyNetwork(input.network, input.targets ?? input.probeTargets)
    if (n.verdict !== 'healthy') {
      findings.push({ type: 'network', level: n.verdict === 'all-down' ? 'critical' : 'warn', detail: n.impact.join('；') || '网络异常' })
    }
  }
  if (input.context) {
    const c = assessContext(input.context)
    if (c.shouldCompact) findings.push({ type: 'context', level: c.level, detail: c.advice })
    else if (c.degenerate) findings.push({ type: 'context', level: 'warn', detail: `检测到退化模板：${c.hit}` })
  }
  if (input.disk) {
    const d = assessDisk(input.disk)
    if (d.level === 'warn' || d.level === 'critical') findings.push({ type: 'disk', level: d.level, detail: d.advice })
  }
  if (input.memory) {
    const m = assessMemory(input.memory)
    if (m.level === 'warn' || m.level === 'critical') findings.push({ type: 'memory', level: m.level, detail: m.advice })
  }
  if (input.overcommit) {
    const o = assessOvercommit(input.overcommit)
    if (o.level === 'warn' || o.level === 'critical') findings.push({ type: 'overcommit', level: o.level, detail: o.advice })
  }
  if (input.patch) {
    const p = checkPatchRefs(input.patch, input.resolveFn)
    if (!p.ok) findings.push({ type: 'config', level: 'warn', detail: p.problems.join('；') })
    const j = checkJsTags(input.patch)
    if (!j.ok) findings.push({ type: 'config', level: 'warn', detail: `patch 含 !!js 标签（第 ${j.hits[0].line} 行）` })
  }
  if (input.profile) {
    const b = checkBundleConsistency(input.profile.bundles, input.profile.deps)
    if (!b.ok) findings.push({ type: 'config', level: 'warn', detail: b.problems.join('；') })
  }
  // 本插件自己的配置文件损坏（环境故障）：必须上报，不能静默用默认值
  if (input.configError) {
    findings.push({ type: 'config', level: 'warn', detail: `cs-guard 配置文件异常：${input.configError}` })
  }

  const worst = findings.reduce((acc, f) => (f.level === 'critical' ? 'critical' : acc === 'critical' ? 'critical' : f.level === 'warn' ? 'warn' : acc), 'ok')
  return {
    at: Date.now(),
    level: findings.length === 0 ? 'ok' : worst,
    findings,
    summary: findings.length === 0 ? '全部正常' : `${findings.length} 项需注意（最高 ${worst}）`,
  }
}

/**
 * 插件入口（**经 guardApply 包装：任何异常都不会弄坏宿主启动**）
 *
 * 刻意不声明任何硬依赖 —— 缺服务只降级功能。
 */
export const apply = guardApply(function applyInner(ctx, rawConfig = {}) {
  const log = makeLogger(ctx, NAME)
  log.info(`v${VERSION} 启动（宿主 ${detectHostVersion(ctx) ?? '版本未知'}）`)

  // 🔴 配置故障必须**安全降级**：类型错误只记 warning，绝不让 apply 抛错 / API 500
  const boot = normalizeBootConfig(rawConfig)
  for (const w of boot.warnings) log.warn(`配置降级：${w}`)

  // 宿主 connection 服务（真实会话校验）：每请求惰性取，避免服务晚就绪拿不到
  const getConnection = () => {
    try {
      const viaGet = typeof ctx?.get === 'function' ? ctx.get('connection', false) : null
      if (viaGet) return viaGet
      return ctx?.connection ?? null
    } catch { return null }
  }

  // 释放钩子（宿主无 effect 就跳过）
  const effectOk = safeEffect(ctx, () => () => { log.info('已释放') }, `${NAME}: root`)
  if (!effectOk) log.debug('宿主无 effect：跳过释放钩子')

  // 暴露巡检接口（宿主无 provide 就跳过）
  const provided = safeProvide(ctx, 'cs-guard', {
    buildReport,
    detectDegenerate,
    assessContext,
    classifyNetwork,
    assessDisk,
    assessMemory,
    assessOvercommit,
    thresholds: THRESHOLDS,
    contextThresholds: { warn: DEFAULT_TOKEN_WARN, critical: DEFAULT_TOKEN_CRITICAL },
    probeTargets: boot.probeTargets,
    decideSupervise,
    buildRestartRequest,
    superviseDefaults: SUPERVISE_DEFAULTS,
    decideResume,
    compactPrompt,
  })
  if (provided) log.info('巡检接口已暴露')
  else log.warn('宿主无 provide：巡检接口仅内部可用（功能不受影响）')

  // ── 自动续跑看门狗（v1.9.0 新增；定时巡检不在本插件内排期）──
  // ⚠️ 服务（agents/suggest）一律经 ctx.inject 取；logger 显式传（不读 ctx.warn）
  installWatchdog(ctx, { warn: log.warn, info: log.info })

  // ── HTTP API（设置页数据源；全部过 guard）──
  const routesOk = safeInject(ctx, ['webServer'], (scoped) => {
    const ws = scoped?.webServer ?? (typeof scoped?.get === 'function' ? scoped.get('webServer', false) : null)
    if (!ws) { log.debug('无 webServer：HTTP API 未注册'); return }
    let n = 0
    try {
      n = registerRoutes(ws, {
        version: VERSION,
        dshHome: boot.dshHome,
        trustedHosts: boot.trustedHosts,
        probeTargets: boot.probeTargets,
        probeTimeoutMs: boot.probeTimeoutMs,
        profileName: boot.profileName ?? detectProfileName(),
        getConnection,
        logger: log,
      })
    } catch (err) {
      log.warn(`API 注册异常：${redactText(String(err?.message ?? err)).slice(0, 200)}`)
    }
    if (n > 0) log.info(`HTTP API 已注册 ${n} 条：${API_PREFIX}/*`)
    else log.warn('HTTP API 注册失败（设置页会显示无数据）')
  }, `${NAME}: webServer`)
  if (!routesOk) log.debug('宿主无 inject：跳过 HTTP API')

  log.info('启动完成')
}, NAME)

export {
  normalizeBootConfig, validateUserConfig, redactSecrets, inspectProfile,
  detectProfileName, DEFAULT_PROFILE, readConfigState, withDefaults, DEFAULTS, resolveDshHome,
  registerRoutes as registerGuardRoutes,
}
export { buildReport as report, classifyNetwork, detectDegenerate, assessContext, assessDisk, assessMemory, assessOvercommit, THRESHOLDS, decideSupervise, buildRestartRequest, DECISION, decideResume, compactPrompt, RESUME_ACTION }
