import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assessDisk, assessMemory, assessOvercommit, THRESHOLDS } from '../src/detect/env.js'

test('磁盘 ok/warn/critical 三档', () => {
  assert.equal(assessDisk({ totalBytes: 100, freeBytes: 50 }).level, 'ok')
  assert.equal(assessDisk({ totalBytes: 100, freeBytes: 10 }).level, 'warn')
  assert.equal(assessDisk({ totalBytes: 100, freeBytes: 2 }).level, 'critical')
})
test('磁盘缺数据不误判健康', () => {
  assert.equal(assessDisk({}).level, 'unknown')
})
test('内存三档', () => {
  assert.equal(assessMemory({ totalBytes: 100, freeBytes: 50 }).level, 'ok')
  assert.equal(assessMemory({ totalBytes: 100, freeBytes: 10 }).level, 'warn')
  assert.equal(assessMemory({ totalBytes: 100, freeBytes: 2 }).level, 'critical')
})
test('overcommit 超限 ⇒ critical（卡死根因）', () => {
  const r = assessOvercommit({ committedAS: 110, commitLimit: 100 })
  assert.equal(r.level, 'critical')
  assert.match(r.advice, /卡死/)
})
test('overcommit 接近 ⇒ warn', () => {
  assert.equal(assessOvercommit({ committedAS: 95, commitLimit: 100 }).level, 'warn')
})
test('阈值符合保守设定', () => {
  assert.equal(THRESHOLDS.diskCriticalPct, 95)
  assert.equal(THRESHOLDS.memCriticalPct, 95)
})
