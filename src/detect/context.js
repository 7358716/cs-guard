/**
 * cs-guard — 上下文退化检测（事故催生的新检测项）
 *
 * 事故来源（2026-11-01 实测）：B 会话在 turn 7–19 连续产出 14 处
 * 「作为一个人工智能语言模型，我还没学习如何回答这个问题」，
 * 而 inputTokens 从 284,909 单调升到 368,300。
 *
 * 结论：**不是会话损坏，是长上下文退化**。
 * ⇒ 看护必须能识别「活着、也在产出，但产出是废话」这种状态。
 *
 * @module cs-guard/detect/context
 */

/** 退化模板词库（可扩展；多写法是必须的 —— 治假阴性） */
export const DEGENERATE_PATTERNS = Object.freeze([
  /作为(一个)?\s*(AI|人工智能|语言模型)/,
  /我(还没|无法|不能)(学习|回答|确定|理解)/,
  /\bas an ai( language model)?\b/i,
  /I (cannot|can't|am unable to) (help|answer|assist)/i,
  /我(只是)?一个(人工)?智能(助手|体)?[，,].{0,20}(无法|不能)/,
])

/** 默认上下文水位阈值（tokens）——超过即视为高危 */
export const DEFAULT_TOKEN_WARN = 250_000
export const DEFAULT_TOKEN_CRITICAL = 320_000

/**
 * 判定一次助手输出是否退化。
 * @param {string} text
 * @returns {{degenerate:boolean, hit:string|null}}
 */
export function detectDegenerate(text) {
  const s = String(text ?? '')
  if (s.length === 0) return { degenerate: false, hit: null }
  for (const re of DEGENERATE_PATTERNS) {
    const m = re.exec(s)
    if (m) return { degenerate: true, hit: m[0] }
  }
  return { degenerate: false, hit: null }
}

/**
 * 综合判定：上下文水位 + 输出质量。
 * @param {{inputTokens?:number, text?:string, warnAt?:number, criticalAt?:number}} s
 */
export function assessContext(s = {}) {
  const warnAt = s.warnAt ?? DEFAULT_TOKEN_WARN
  const critAt = s.criticalAt ?? DEFAULT_TOKEN_CRITICAL
  const tok = Number(s.inputTokens)
  const deg = detectDegenerate(s.text)

  const level = !Number.isFinite(tok) ? 'unknown'
    : tok >= critAt ? 'critical'
    : tok >= warnAt ? 'warn'
    : 'ok'

  const shouldCompact = level === 'critical' || (level === 'warn' && deg.degenerate)
  return {
    level,
    inputTokens: Number.isFinite(tok) ? tok : null,
    degenerate: deg.degenerate,
    hit: deg.hit,
    shouldCompact,
    advice: shouldCompact
      ? '上下文接近上限且已出现退化输出：建议压缩历史或冷重启 + 简报'
      : level === 'warn'
        ? '上下文已较高：留意输出质量'
        : '正常',
  }
}
