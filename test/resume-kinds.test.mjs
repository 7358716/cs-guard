/**
 * 对话中断续跑决策 —— 用**真实宿主会话日志**里出现过的 reason 做回归（v1.8.0 新增）
 *
 * 数据来源（只读统计本机 ~/.dsh/sessions，12 个会话 / 111 条 turn/end）：
 *   completed 67 · error 27 · interrupted 9 · max-tokens 7 · aborted 1
 *   error 的 code 真实出现过：MISSING_CREDENTIAL / NO_ADAPTER / PERMISSION_DENIED /
 *   INVALID_REQUEST / SERVER / UNKNOWN（其中前四个重试无解 ⇒ 应交人）
 *   aborted 带子原因 {kind:'user'}（用户主动取消 ⇒ 不得自动重发）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decideResume, ACTION, NO_RETRY_ERROR_CODES } from '../src/repair/resume.js'

const d = (o) => decideResume(o)

test('真实 kind：completed ⇒ 不动作', () => {
  assert.equal(d({ reason: 'completed' }).action, ACTION.NONE)
  assert.equal(d({ reason: { kind: 'completed' } }).action, ACTION.NONE)
})

test('真实 kind：interrupted ⇒ 重试', () => {
  assert.equal(d({ reason: 'interrupted' }).action, ACTION.RETRY)
})

test('真实 kind：error（瞬态，如 HTTP 502）⇒ 重试', () => {
  assert.equal(d({ reason: { kind: 'error', error: { code: 'SERVER', status: 502 } } }).action, ACTION.RETRY)
})

test('🔴 真实 kind：max-tokens（实测 7 次）⇒ 压缩后重试，不再当成正常结束', () => {
  const r = d({ reason: 'max-tokens' })
  assert.equal(r.action, ACTION.COMPACT_THEN_RETRY)
  assert.match(r.reason, /触顶/)
})

test('🔴 真实 kind：aborted + user（用户主动中止）⇒ 交人，不自动重发', () => {
  const r = d({ reason: { kind: 'aborted', reason: { kind: 'user' } } })
  assert.equal(r.action, ACTION.ASK_HUMAN)
  assert.match(r.reason, /主动中止/)
})

test('aborted 非用户原因 ⇒ 可重试', () => {
  assert.equal(d({ reason: { kind: 'aborted' } }).action, ACTION.RETRY)
})

test('🔴 真实 error code：MISSING_CREDENTIAL ⇒ 交人（重试无解）', () => {
  const r = d({ reason: { kind: 'error', error: { code: 'MISSING_CREDENTIAL' } } })
  assert.equal(r.action, ACTION.ASK_HUMAN)
  assert.match(r.reason, /MISSING_CREDENTIAL/)
})

test('🔴 真实 error code：NO_ADAPTER ⇒ 交人', () => {
  assert.equal(d({ reason: { kind: 'error', error: { code: 'NO_ADAPTER' } } }).action, ACTION.ASK_HUMAN)
})

test('🔴 真实 error code：PERMISSION_DENIED ⇒ 交人', () => {
  assert.equal(d({ reason: { kind: 'error', error: { code: 'PERMISSION_DENIED' } } }).action, ACTION.ASK_HUMAN)
})

test('真实 error code：INVALID_REQUEST ⇒ 交人', () => {
  assert.equal(d({ reason: { kind: 'error', error: { code: 'INVALID_REQUEST' } } }).action, ACTION.ASK_HUMAN)
})

test('NO_RETRY_ERROR_CODES 覆盖面', () => {
  for (const code of ['MISSING_CREDENTIAL', 'NO_ADAPTER', 'PERMISSION_DENIED', 'INVALID_REQUEST', 'UNAUTHORIZED']) {
    assert.ok(NO_RETRY_ERROR_CODES.includes(code))
  }
})

test('退化上下文优先级高于 reason（先压缩）', () => {
  assert.equal(d({ reason: 'max-tokens', context: { degenerate: true } }).action, ACTION.COMPACT_THEN_RETRY)
  assert.equal(d({ reason: 'error', context: { shouldCompact: true } }).action, ACTION.COMPACT_THEN_RETRY)
})

test('续跑次数用尽 ⇒ 交人', () => {
  assert.equal(d({ reason: 'error', attempt: 2, maxAttempts: 2 }).action, ACTION.ASK_HUMAN)
})

test('未知 kind ⇒ 交人（不猜“正常结束”）', () => {
  const r = d({ reason: 'something-new' })
  assert.equal(r.action, ACTION.ASK_HUMAN)
  assert.match(r.reason, /未知结束原因/)
})

test('空/缺失 reason ⇒ 交人', () => {
  assert.equal(d({}).action, ACTION.ASK_HUMAN)
})
