/**
 * cs-guard — 对话中断续跑决策
 *
 * 设计依据：v3 §12.1「对话中断」。真实场景（B 会话事故）：
 * 输出退化到「作为一个人工智能语言模型…」时，会话**没有崩**，
 * 但**预期结果没有产生** ⇒ 需要的是「压缩上下文后重试」，
 * 而不是「重发同一请求」（那只会再得到一次退化输出）。
 *
 * 🔴 v1.8.0 修复（用**真实会话日志**做的故障数据注入）：
 *   实测宿主 `turn/end.reason.kind` 的真实取值（本机 12 个会话、111 条 turn/end）：
 *      completed 67 / error 27 / interrupted 9 / max-tokens 7 / aborted 1
 *   旧实现只认 error / aborted / interrupted，其余一律 NONE ⇒ 两类**真实**误判：
 *     · max-tokens（输出触顶，实测 7 次）→ 被当成「正常结束」，什么都不做；
 *     · aborted + reason.kind=user（用户主动中止）→ 被当成「可重试」，
 *       会在用户明确取消后自动重发请求（违背用户意图）。
 *   另外 error 里大量是**重试无用**的错误（缺凭据 / 无 adapter / 权限被拦，实测 13 次），
 *   盲目重试只会再失败一次 ⇒ 交人。
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

/** 重试无意义的错误码（凭据/适配器/权限问题，实测真实出现） */
export const NO_RETRY_ERROR_CODES = Object.freeze([
  'MISSING_CREDENTIAL',
  'NO_ADAPTER',
  'PERMISSION_DENIED',
  'INVALID_REQUEST',
  'UNAUTHORIZED',
  'INVALID_API_KEY',
  'AUTHENTICATION_FAILED',
  'FORBIDDEN',
])

/** 瞬态失败 kind（可原样重试） */
const RETRYABLE_KINDS = Object.freeze(['error', 'aborted', 'interrupted'])

/** 明确「正常结束」的 kind */
const TERMINAL_KINDS = Object.freeze(['completed', 'normal', 'none'])

function normalizeReason(reason) {
  if (typeof reason === 'string') return { kind: reason, sub: null, code: null }
  if (reason && typeof reason === 'object') {
    const kind = typeof reason.kind === 'string' ? reason.kind : ''
    const sub = typeof reason.reason === 'object' && reason.reason !== null
      ? (typeof reason.reason.kind === 'string' ? reason.reason.kind : null)
      : (typeof reason.reason === 'string' ? reason.reason : null)
    const code = typeof reason.error?.code === 'string' ? reason.error.code.toUpperCase() : null
    return { kind, sub, code }
  }
  return { kind: '', sub: null, code: null }
}

/**
 * @param {object} o
 * @param {string|{kind:string, reason?:any, error?:{code?:string}}} o.reason 中断原因（turn/end 的 reason 或 kind）
 * @param {number} o.attempt 本会话已续跑次数
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

  const r = normalizeReason(reason)

  // 输出触顶（真实场景：max-tokens）⇒ 压缩后重试，不能原样重发
  if (r.kind === 'max-tokens') {
    return { action: ACTION.COMPACT_THEN_RETRY, reason: '输出触顶（max-tokens）：压缩历史后重试，否则会再次触顶' }
  }

  // 用户主动中止 ⇒ 尊重用户意图，不自动重发
  if (r.kind === 'aborted' && r.sub === 'user') {
    return { action: ACTION.ASK_HUMAN, reason: '用户主动中止：不自动重发，交人确认' }
  }

  // 重试无用的错误（缺凭据/无适配器/权限拦截）⇒ 交人
  if (r.kind === 'error' && r.code && NO_RETRY_ERROR_CODES.includes(r.code)) {
    return { action: ACTION.ASK_HUMAN, reason: `错误码 ${r.code}：重试无解（凭据/适配器/权限问题），交人处理` }
  }

  if (RETRYABLE_KINDS.includes(r.kind)) {
    if (r.kind === 'error') return { action: ACTION.RETRY, reason: '回合异常结束，可重试' }
    if (r.kind === 'aborted') return { action: ACTION.RETRY, reason: '被中止，可重试' }
    return { action: ACTION.RETRY, reason: '连接中断，可重试' }
  }

  if (TERMINAL_KINDS.includes(r.kind)) {
    return { action: ACTION.NONE, reason: '正常结束，无需续跑' }
  }

  // 未知 kind：不猜「正常」，交人（比误判 NONE 安全）
  return { action: ACTION.ASK_HUMAN, reason: `未知结束原因「${r.kind || '空'}」：交人判断` }
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
