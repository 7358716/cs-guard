import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decide, DECISION, DEFAULTS, buildRestartRequest } from '../src/supervisor/plan.js'
import { decideResume, ACTION, compactPrompt } from '../src/repair/resume.js'

const NOW = 10_000_000_000

// ── supervisor ──
test('内存正常 ⇒ OK', () => {
  assert.equal(decide({ memory: { committedAS: 50, commitLimit: 100 }, now: NOW }).decision, DECISION.OK)
})
test('接近上限 ⇒ WATCH', () => {
  const r = decide({ memory: { committedAS: 92, commitLimit: 100 }, now: NOW })
  assert.equal(r.decision, DECISION.WATCH)
})
test('越线但防抖未满 ⇒ WATCH（不贸然重启）', () => {
  const r = decide({ memory: { committedAS: 99, commitLimit: 100 }, state: { consecutive: 1 }, now: NOW })
  assert.equal(r.decision, DECISION.WATCH)
  assert.match(r.reason, /防抖/)
})
test('连续越线达阈值 ⇒ RESTART', () => {
  const r = decide({ memory: { committedAS: 99, commitLimit: 100 }, state: { consecutive: 2, lastRestartAt: 0, restartsToday: 0 }, now: NOW })
  assert.equal(r.decision, DECISION.RESTART)
  assert.equal(r.mustAudit, true)
})
test('今日重启达上限 ⇒ STOP（交人）', () => {
  const r = decide({ memory: { committedAS: 99, commitLimit: 100 }, state: { consecutive: 5, restartsToday: 3 }, now: NOW })
  assert.equal(r.decision, DECISION.STOP)
  assert.match(r.reason, /人工介入/)
})
test('限速中 ⇒ WATCH', () => {
  const r = decide({ memory: { committedAS: 99, commitLimit: 100 }, state: { consecutive: 5, restartsToday: 0, lastRestartAt: NOW - 1000 }, now: NOW })
  assert.equal(r.decision, DECISION.WATCH)
  assert.match(r.reason, /限速/)
})
test('读不到内存信息不误判', () => {
  assert.equal(decide({ memory: {}, now: NOW }).decision, DECISION.WATCH)
})
test('重启请求带守卫条件', () => {
  const r = buildRestartRequest({ reason: 'x' })
  assert.equal(r.guards.requireNoActiveTurns, true)
  assert.equal(r.guards.maxPerDay, DEFAULTS.maxRestartsPerDay)
})

// ── 续跑 ──
test('正常结束不续跑', () => {
  assert.equal(decideResume({ reason: 'normal' }).action, ACTION.NONE)
})
test('错误结束可重试', () => {
  assert.equal(decideResume({ reason: 'error' }).action, ACTION.RETRY)
})
test('退化场景必须先压缩再试（关键）', () => {
  const r = decideResume({ reason: 'error', context: { degenerate: true } })
  assert.equal(r.action, ACTION.COMPACT_THEN_RETRY)
  assert.match(r.reason, /原样重试会再退化/)
})
test('上下文应压缩时也走压缩路径', () => {
  assert.equal(decideResume({ reason: 'error', context: { shouldCompact: true } }).action, ACTION.COMPACT_THEN_RETRY)
})
test('续跑次数用尽交人', () => {
  const r = decideResume({ reason: 'error', attempt: 2, maxAttempts: 2 })
  assert.equal(r.action, ACTION.ASK_HUMAN)
})
test('压缩简报含目标与待办', () => {
  const p = compactPrompt({ goal: '做完插件', done: ['骨架'], pending: ['渠道层'] })
  assert.match(p, /目标：做完插件/)
  assert.match(p, /待办：渠道层/)
  assert.match(p, /不要重复已完成/)
})
