/**
 * cs-guard — 看护/守护（骨架 v0.1.0）
 *
 * 设计依据：design/08-架构设计方案-v3终版.md §12
 *
 * ⚠️ 职责边界（v3 §12.2）：
 *  · 只做**检测 + 上报 + 受限恢复**，不碰 agent/request-error 与 llm/stream 的恢复权
 *  · 重启复用现有 dsh-restart-guard 通道，不另造 supervisor/cron
 *  · 只读消费 cs-myfree 的审计，**不 import 对方**（文件级约定）
 *
 * @module cs-guard
 */

const NAME = 'cs-guard'
const VERSION = '0.1.0'

export const name = NAME
export const version = VERSION

/** 插件入口。刻意不声明任何硬依赖 —— 缺服务只降级功能。 */
export function apply(ctx) {
  const log = (m) => ctx.logger?.info?.(m)
  log(`[${NAME}] v${VERSION} 已加载（骨架版）`)

  // 五类故障检测器（后续实现）：网络 / 环境 / 配置 / 崩溃 / 对话中断
  // 当前为骨架：只建立 fiber，不做巡检。
  ctx.effect(() => () => { log(`[${NAME}] 已释放`) }, `${NAME}: root`)
}
