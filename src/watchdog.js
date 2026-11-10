/**
 * cs-guard — 自动续跑看门狗
 *
 * 设计依据：v3 §12 / recon §7-G1（「发现异常但无法触发恢复」是断点）
 *
 * 职责：监听 `turn/end` 事件，自动续跑（调用 decideResume 决策）。
 *
 * ⚠️ 定时巡检（/cs-guard/diag 周期调用）**不在本插件内排期**：
 *    schedule 服务需要「投递到哪个会话」，插件自身没有会话；
 *    由 cs-bots（房间内排期）或人工按需触发 /diag。保持零依赖 + 零会话耦合。
 *
 * 四条纪律（与 cs-guard 整体设计同源）：
 *   ① **零依赖**：不 import cs-myfree / cs-bots；只通过宿主 service 通信
 *   ② **绝不抛**：钩子内部任何异常只 warn，不影响会话本身（加载失败会被宿主降级）
 *   ③ **受限恢复**：只处理瞬态错误/退化，凭据/权限问题交人
 *   ④ **inject 优先**：cordis Context 的服务属性**必须**经 `ctx.inject(['x'])` 拿，
 *      直接读 `ctx.xxx` 会抛 "cannot get property ... without inject"
 *      （v1.9.0 两次上线实测：`ctx.schedule_create` / `ctx.sessionId` 直读均触发降级回滚）
 *
 * @module cs-guard/watchdog
 */

import { decideResume, compactPrompt, ACTION } from './repair/resume.js'
import { has, safeInject } from './compat.js'

/** 续跑配置默认值 */
export const WATCHDOG_DEFAULTS = Object.freeze({
  maxResumeAttempts: 2,      // 每会话最多自动续跑 N 次
  compactBeforeRetry: true,  // 退化时必须先压缩
})

/**
 * 安装自动续跑看门狗。
 *
 * @param {object} ctx cordis Context（必须提供 inject；on 可选）
 * @param {{maxResumeAttempts?: number}} config
 */
export function installWatchdog(ctx, config = {}) {
  const cfg = { ...WATCHDOG_DEFAULTS, ...config }

  // ⚠️ warn/info 优先取 ctx（宿主 logger），ctx 为空时用 noop
  // ⚠️ logger 由调用方显式传入（index.js 从 makeLogger 拿），不从 ctx 直读
  const warn = config.warn ?? (() => {})
  const info = config.info ?? (() => {})

  if (!ctx) {
    warn('[cs-guard] 无上下文：跳过看门狗安装')
    return
  }

  // ── 对话中断自动续跑（监听 turn/end 事件）──
  if (!has(ctx, 'on')) {
    warn('[cs-guard] 无 ctx.on：跳过自动续跑（需人工唤醒）')
    return
  }
  try {
    /** sessionId → 已续跑次数（防无限循环） */
    const attemptMap = new Map()

    // 唤醒能力：通过 inject 拿 agents 服务（宿主官方服务，非 cs-bots）
    let agentsSvc = null
    safeInject(ctx, ['agents'], (scoped) => {
      agentsSvc = scoped?.agents ?? (typeof scoped?.get === 'function' ? scoped.get('agents', false) : null)
    }, 'cs-guard: agents')

    // L4 记忆建议能力（可选，cs-bots 提供时才有）
    let suggestSvc = null
    safeInject(ctx, ['suggest'], (scoped) => {
      suggestSvc = scoped?.suggest ?? (typeof scoped?.get === 'function' ? scoped.get('suggest', false) : null)
    }, 'cs-guard: suggest')

    ctx.on('session/event', (subject, event) => {
      try {
        if (!event || typeof event.type !== 'string') return
        if (event.type !== 'turn/end') return

        const sessionId = subject?.id || subject?.sessionId || subject?.session?.id
        if (!sessionId || typeof sessionId !== 'string') return

        const reason = event.data?.reason
        if (!reason) return

        const attempt = attemptMap.get(sessionId) || 0
        if (attempt >= cfg.maxResumeAttempts) {
          info(`[cs-guard] 会话 ${sessionId} 已续跑${attempt}次，停止自动处理`)
          return
        }

        // 上下文退化检测：宿主未暴露 getSessionContext，退化判定由 decideResume 基于
        // reason 做（max-tokens/aborted 等）；degenerate=false 时不强制压缩。
        const context = {}

        const decision = decideResume({
          reason,
          attempt,
          context,
          maxAttempts: cfg.maxResumeAttempts,
        })
        if (!decision || decision.action === ACTION.NONE) return

        if (decision.action === ACTION.COMPACT_THEN_RETRY) {
          try {
            if (typeof compactPrompt === 'function') compactPrompt(sessionId)
            info(`[cs-guard] 会话 ${sessionId} 上下文已压缩`)
          } catch (e) {
            warn(`[cs-guard] 压缩失败：${e?.message ?? e}`)
          }
          _wake(agentsSvc, sessionId,
            '【自动续跑】检测到上下文退化或输出触顶，已压缩历史。请先核对当前状态，从断点继续，不要重复已完成的工作。')
        } else if (decision.action === ACTION.RETRY) {
          _wake(agentsSvc, sessionId,
            `【自动续跑】检测到瞬态错误（${reason.kind || 'unknown'}），正在重试。`)
        } else if (decision.action === ACTION.ASK_HUMAN) {
          _proposeAskHuman(suggestSvc, sessionId, decision.reason, attempt)
        }

        attemptMap.set(sessionId, attempt + 1)
        info(`[cs-guard] 会话 ${sessionId} 续跑决策：${decision.action}（${decision.reason}）`)
      } catch (error) {
        warn(`[cs-guard] 续跑钩子处理失败：${error?.message ?? error}`)
      }
    })

    info('[cs-guard] 自动续跑钩子已安装（监听 turn/end）')
  } catch (e) {
    warn(`[cs-guard] 安装续跑钩子失败：${e?.message ?? e}`)
  }
}

/**
 * 唤醒会话（通过宿主 agents 服务的 agent.followup）。
 *
 * @param {object|null} agentsSvc 宿主 agents 服务（inject 取得；为 null 时仅 warn）
 * @param {string} sessionId
 * @param {string} text
 * @returns {boolean} 是否成功唤醒
 */
function _wake(agentsSvc, sessionId, text) {
  if (!agentsSvc || !has(agentsSvc, 'get')) {
    return false
  }
  try {
    const agent = agentsSvc.get(sessionId)
    if (!agent || !has(agent, 'followup')) return false
    // source.kind 必须是 producer-owned（v4 格式拒绝 kind:'plugin'）
    agent.followup({
      content: [{ type: 'text', text }],
      source: { kind: 'cs-guard' },
    })
    return true
  } catch {
    return false
  }
}

/**
 * 提议一条 L4 记忆（交人判断）。
 *
 * @param {object|null} suggestSvc cs-bots suggest 服务（可选）
 * @param {string} sessionId
 * @param {string} reason
 * @param {number} attempt
 * @returns {boolean} 是否成功提议
 */
function _proposeAskHuman(suggestSvc, sessionId, reason, attempt) {
  if (!suggestSvc || !has(suggestSvc, 'suggest')) return false
  try {
    suggestSvc.suggest({
      kind: 'memory',
      layer: 'L4',
      payload: {
        content: `【续跑受阻】会话 ${sessionId} 已自动续跑${attempt}次仍未成功：${reason}。需人工介入：检查模型是否可用（429/缺凭据）、配置是否正确、是否需切换降级链。`,
        tags: ['auto-resume-blocked', 'cs-guard'],
      },
      reason: `cs-guard：会话 ${sessionId} 续跑受阻（${reason}）`,
      source: 'cs-guard',
      by: sessionId,
      confidence: 0.9,
    })
    return true
  } catch {
    return false
  }
}

/** 导出给测试用 */
export const _internals = { _wake, _proposeAskHuman }