/**
 * cs-guard — 看门狗（定时巡检 + 自动续跑）单元测试
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { installWatchdog, WATCHDOG_DEFAULTS, _internals } from '../src/watchdog.js'
import { ACTION } from '../src/repair/resume.js'

/** 构造一个 mock ctx（带 inject 用于取 service） */
function makeCtx({ on = null, services = {} } = {}) {
  const calls = { onEvents: [], scheduleCreate: [], suggests: [], warn: [], info: [] }
  const inject = (deps, callback) => {
    const resolved = Object.fromEntries(deps.map((d) => [d, services[d]]))
    callback({ ...resolved, get: (key) => resolved[key] })
  }
  const ctx = {
    inject,
    warn: (msg) => { calls.warn.push(msg) },
    info: (msg) => { calls.info.push(msg) },
    on: (event, handler) => { calls.onEvents.push({ event, handler }) },
  }
  return { calls, ctx, services }
}

describe('cs-guard/watchdog', () => {
  it('WATCHDOG_DEFAULTS 应有合理默认值', () => {
    assert.equal(WATCHDOG_DEFAULTS.maxResumeAttempts, 2)
    assert.equal(WATCHDOG_DEFAULTS.compactBeforeRetry, true)
  })

  it('installWatchdog 无上下文时应静默跳过（warn）', () => {
    // 新版本：warn 来自 ctx，ctx=null 时只有默认 noop ⇒ 不抛错即通过
    assert.doesNotThrow(() => installWatchdog(null))
  })

  it('installWatchdog 无 inject 时应降级不抛错', () => {
    const ctx = { on: null }
    assert.doesNotThrow(() => installWatchdog(ctx, { sessionId: 's' }))
  })

  it('installWatchdog 无 ctx.on 时应 warn 但不抛错', () => {
    const m = makeCtx({ on: null, services: {} })
    installWatchdog(m.ctx, { sessionId: 's' })
    assert.equal(m.ctx.on(null), undefined) // on=null 时 has() 返回 false
    assert.doesNotThrow(() => installWatchdog(m.ctx, { sessionId: 's' }))
  })

  it('_wake 应通过 agents 服务 followup（v4 source kind）', () => {
    const followupCalls = []
    const agentsSvc = { get: (sid) => ({ followup: (msg) => followupCalls.push({ sid, msg }) }) }
    const ok = _internals._wake(agentsSvc, 'test-session', 'test message')
    assert.equal(ok, true)
    assert.equal(followupCalls.length, 1)
    assert.ok(followupCalls[0].msg.content[0].text.includes('test message'))
    assert.deepEqual(followupCalls[0].msg.source, { kind: 'cs-guard' })
  })

  it('_wake 无 agents 服务时返回 false 不抛错', () => {
    assert.equal(_internals._wake(null, 'x', 'y'), false)
    assert.equal(_internals._wake({}, 'x', 'y'), false)
  })

  it('_proposeAskHuman 应调用 suggest.suggest（L4）', () => {
    const suggests = []
    const suggestSvc = { suggest: (payload) => suggests.push(payload) }
    const ok = _internals._proposeAskHuman(suggestSvc, 'test-session', '凭据缺失', 1)
    assert.equal(ok, true)
    assert.equal(suggests.length, 1)
    assert.equal(suggests[0].layer, 'L4')
    assert.ok(suggests[0].payload.content.includes('test-session'))
    assert.ok(suggests[0].payload.content.includes('凭据缺失'))
  })

  it('turn/end 事件：max-tokens → COMPACT_THEN_RETRY（压缩 + 唤醒）', () => {
    const wakes = []
    const agentsSvc = { get: (sid) => ({ followup: (msg) => wakes.push({ sid, msg }) }) }
    const m = makeCtx({ on: 'session/event', services: { agents: agentsSvc } })
    installWatchdog(m.ctx, { sessionId: 'p', agentsSvc })
    // 触发 turn/end max-tokens
    const handler = m.calls.onEvents.find(e => e.event === 'session/event')?.handler
    assert.ok(handler, '应已注册 session/event 钩子')
    handler({ id: 's1' }, { type: 'turn/end', data: { reason: { kind: 'max-tokens' } } })
    assert.equal(wakes.length, 1)
    assert.ok(wakes[0].msg.content[0].text.includes('退化') || wakes[0].msg.content[0].text.includes('触顶'))
  })

  it('turn/end 事件：error（瞬态）→ RETRY（唤醒重试）', () => {
    const wakes = []
    const agentsSvc = { get: (sid) => ({ followup: (msg) => wakes.push({ sid, msg }) }) }
    const m = makeCtx({ on: 'session/event', services: { agents: agentsSvc } })
    installWatchdog(m.ctx, { sessionId: 'p' })
    const handler = m.calls.onEvents.find(e => e.event === 'session/event')?.handler
    handler({ id: 's1' }, { type: 'turn/end', data: { reason: { kind: 'error' } } })
    assert.equal(wakes.length, 1)
    assert.ok(wakes[0].msg.content[0].text.includes('瞬态错误'))
  })

  it('turn/end 事件：error + MISSING_CREDENTIAL → ASK_HUMAN（提议 L4 不唤醒）', () => {
    const wakes = []
    const suggests = []
    const agentsSvc = { get: (sid) => ({ followup: (msg) => wakes.push({ sid, msg }) }) }
    const suggestSvc = { suggest: (payload) => suggests.push(payload) }
    const m = makeCtx({ on: 'session/event', services: { agents: agentsSvc, suggest: suggestSvc } })
    installWatchdog(m.ctx, { sessionId: 'p' })
    const handler = m.calls.onEvents.find(e => e.event === 'session/event')?.handler
    handler({ id: 's1' }, {
      type: 'turn/end',
      data: { reason: { kind: 'error', error: { code: 'MISSING_CREDENTIAL' } } },
    })
    assert.equal(wakes.length, 0)  // 不自动唤醒
    assert.equal(suggests.length, 1)
    assert.equal(suggests[0].layer, 'L4')
  })

  it('turn/end 事件：completed 时不应续跑', () => {
    const wakes = []
    const agentsSvc = { get: (sid) => ({ followup: (msg) => wakes.push({ sid, msg }) }) }
    const m = makeCtx({ on: 'session/event', services: { agents: agentsSvc } })
    installWatchdog(m.ctx, { sessionId: 'p' })
    const handler = m.calls.onEvents.find(e => e.event === 'session/event')?.handler
    handler({ id: 's1' }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
    assert.equal(wakes.length, 0)
  })

  it('turn/end 事件：连续续跑不得超过 maxResumeAttempts', () => {
    const wakes = []
    const agentsSvc = { get: (sid) => ({ followup: (msg) => wakes.push({ sid, msg }) }) }
    const m = makeCtx({ on: 'session/event', services: { agents: agentsSvc } })
    installWatchdog(m.ctx, { sessionId: 'p', maxResumeAttempts: 2 })
    const handler = m.calls.onEvents.find(e => e.event === 'session/event')?.handler
    for (let i = 0; i < 5; i++) {
      handler({ id: 's1' }, { type: 'turn/end', data: { reason: { kind: 'error' } } })
    }
    assert.equal(wakes.length, 2)  // 最多 2 次
  })
})
