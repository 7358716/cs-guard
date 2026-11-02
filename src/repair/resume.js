/**
 * cs-guard — 对话中断续跑决策
 *
 * 设计依据：v3 §12.1「对话中断」。真实场景（B 会话事故）：
 * 输出退化到「作为一个人工智能语言模型…」时，会话**没有崩**，
 * 但**预期结果没有产生** ⇒ 需要的是「压缩上下文后重试」，
 * 而不是「重发同一请求」（那只会再得到一次退化输出）。
 *
 * @module cs-guard/repair/resume
 */

/** 续跑动作 */
export const ACTION = Object.freeze({
  NONE: 'none',
  RETRY: 'retry',                 // 原样重试（瞬态失败）
  COMPACT_THEN_RETRY: 'compact',  // 先压上下文再试（退化场景）
  ASK_HUMAN: 'ask-human',         // 交人判断
})

/**
 * @param {object} o
 * @param {string} o.reason         中断原因（turn/end 的 reason.kind）
 * @param {number} o.attempt        本会话已续跑次数
 * @param {{degenerate:boolean, level:string, shouldCompact:boolean}} o.context
 * @param {number} o.maxAttempts
 */
export function decideResume({ reason, attempt = 0, context = {}, maxAttempts = 2 } = {}) {
  if (attempt >= maxAttempts) {
    return { action: ACTION.ASK_HUMAN, reason: `已续跑 ${attempt} 次仍未成功，交人判断` }
  }

  // 退化：必须先压缩，否则重试只会再退化一次
  if (context.degenerate === true || context.shouldCompact === true) {
    return { action: ACTION.COMPACT_THEN_RETRY, reason: '上下文退化：压缩历史后重试（原样重试会再退化）' }
  }

  switch (reason) {
    case 'error':
      return { action: ACTION.RETRY, reason: '回合异常结束，可重试' }
    case 'aborted':
      return { action: ACTION.RETRY, reason: '被中止，可重试' }
    case 'interrupted':
      return { action: ACTION.RETRY, reason: '连接中断，可重试' }
    default:
      return { action: ACTION.NONE, reason: '正常结束，无需续跑' }
  }
}

/** 压缩提示词（注入给模型的「简报」） */
export function compactPrompt(state = {}) {
  const { goal, done = [], pending = [], constraint = [] } = state
  const lines = ['【上下文已压缩，以下为当前进度简报】']
  if (goal) lines.push(`目标：${goal}`)
  if (done.length) lines.push(`已完成：${done.join('；')}`)
  if (pending.length) lines.push(`待办：${pending.join('；')}`)
  if (constraint.length) lines.push(`约束：${constraint.join('；')}`)
  lines.push('请从中断处继续，不要重复已完成的工作。')
  return lines.join('\n')
}
