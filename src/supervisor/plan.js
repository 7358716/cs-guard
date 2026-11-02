/**
 * cs-guard — 进程外 supervisor 的决策逻辑（纯函数）
 *
 * 为什么必须有进程外 supervisor：
 *   进程内检测器在「overcommit 卡死」时**自己也卡死**，救不了自己。
 *   真实根因（v3 §12.1）：Docker cgroup 的 `memory.max` 先撞上
 *   `CommitLimit` ⇒ 宿主内核返回 ENOMEM ⇒ 进程分配内存失败但**没被 OOM killer 杀掉**
 *   ⇒ 表现为「活着但不响应」。
 *
 * 纪律：
 *  · **复用现有 dsh-restart-guard 通道**，不另造 PM2/cron
 *  · 只写「重启请求」文件，执行权在 supervisor 脚本
 *  · 限速 + 全审计
 *
 * @module cs-guard/supervisor/plan
 */

/** 决策 */
export const DECISION = Object.freeze({ OK: 'ok', WATCH: 'watch', RESTART: 'restart', STOP: 'stop' })

export const DEFAULTS = Object.freeze({
  commitWarnRatio: 0.9,
  commitRestartRatio: 0.98,
  consecutiveBreaches: 3,        // 连续 N 次越过重启线才动手（防抖）
  minIntervalMs: 30 * 60 * 1000, // 两次重启最小间隔
  maxRestartsPerDay: 3,
})

/**
 * 判定本次巡检该做什么。
 *
 * @param {object} o
 * @param {{committedAS:number, commitLimit:number}} o.memory
 * @param {{consecutive:number, lastRestartAt:number, restartsToday:number}} o.state
 * @param {number} o.now
 */
export function decide({ memory = {}, state = {}, now = Date.now() } = {}) {
  const cfg = DEFAULTS
  const as = Number(memory.committedAS)
  const limit = Number(memory.commitLimit)

  if (!Number.isFinite(as) || !Number.isFinite(limit) || limit <= 0) {
    return { decision: DECISION.WATCH, reason: '无法读取 overcommit 信息', consecutive: state.consecutive ?? 0 }
  }

  const ratio = as / limit
  const consecutive = ratio >= cfg.commitRestartRatio ? (state.consecutive ?? 0) + 1 : 0

  if (ratio < cfg.commitWarnRatio) {
    return { decision: DECISION.OK, ratio: r(ratio), reason: '内存压力正常', consecutive: 0 }
  }

  if (ratio < cfg.commitRestartRatio) {
    return { decision: DECISION.WATCH, ratio: r(ratio), reason: `接近上限（${(ratio * 100).toFixed(1)}%）`, consecutive }
  }

  // 越过重启线
  if (consecutive < cfg.consecutiveBreaches) {
    return { decision: DECISION.WATCH, ratio: r(ratio), reason: `越过重启线但未达防抖次数（${consecutive}/${cfg.consecutiveBreaches}）`, consecutive }
  }
  if (state.restartsToday >= cfg.maxRestartsPerDay) {
    return { decision: DECISION.STOP, ratio: r(ratio), reason: `今日已重启 ${state.restartsToday} 次，达上限 ⇒ 停止自动恢复，需人工介入`, consecutive }
  }
  if (state.lastRestartAt && now - state.lastRestartAt < cfg.minIntervalMs) {
    const waitS = Math.ceil((cfg.minIntervalMs - (now - state.lastRestartAt)) / 1000)
    return { decision: DECISION.WATCH, ratio: r(ratio), reason: `限速中，还需等 ${waitS}s`, consecutive }
  }

  return {
    decision: DECISION.RESTART,
    ratio: r(ratio),
    reason: `overcommit 达 ${(ratio * 100).toFixed(1)}%（连续 ${consecutive} 次）⇒ 请求重启`,
    consecutive,
    mustAudit: true,
  }
}

function r(x) { return Number(x.toFixed(3)) }

/** 重启请求文件内容（supervisor 脚本读它） */
export function buildRestartRequest({ reason, at = Date.now(), requestedBy = 'cs-guard' }) {
  return {
    schema: 'cs-guard/restart-request/v1',
    at,
    reason,
    requestedBy,
    // supervisor 必须校验这几项再执行
    guards: {
      requireNoActiveTurns: true,
      respectMinInterval: true,
      maxPerDay: DEFAULTS.maxRestartsPerDay,
    },
  }
}
