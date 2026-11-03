import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assessDisk, assessMemory, assessMemoryHealth, assessOvercommit, assessStatfs, THRESHOLDS } from '../src/detect/env.js'

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
// ── v1.1.1 修复：overcommit 150% 是容器内正常现象，不能误报 ──
test('🔴 容器内 overcommit 150% 但内存充足 ⇒ 判 OK（不误报）', () => {
  const r = assessMemoryHealth({
    totalBytes: 100, freeBytes: 55,
    committedAS: 150, commitLimit: 100,
    inContainer: true,
  })
  assert.equal(r.level, 'ok', '必须判 OK —— 这是本机真实数据（151%）')
  assert.ok(r.signals.some((s) => /容器内正常偏高/.test(s)))
})
test('真正危险：可用内存极低 ⇒ critical', () => {
  assert.equal(assessMemoryHealth({ totalBytes: 100, freeBytes: 3 }).level, 'critical')
})
test('可用内存偏低 ⇒ warn', () => {
  assert.equal(assessMemoryHealth({ totalBytes: 100, freeBytes: 8 }).level, 'warn')
})
test('overcommit 极高时即使内存尚可也提级为 warn', () => {
  assert.equal(assessMemoryHealth({ totalBytes: 100, freeBytes: 50, committedAS: 400, commitLimit: 100, inContainer: true }).level, 'warn')
})
test('assessOvercommit 保留兼容但不再误判', () => {
  const r = assessOvercommit({ totalBytes: 100, freeBytes: 55, committedAS: 150, commitLimit: 100 })
  assert.notEqual(r.level, 'critical', '150% 不得再判 critical')
  assert.match(r.note, /容器内偏高属正常/)
})
test('阈值符合保守设定', () => {
  assert.equal(THRESHOLDS.diskCriticalPct, 95)
  assert.equal(THRESHOLDS.memCriticalPct, 95)
})

// ── v1.8.0：磁盘真实水位（此前 /diag 完全不读磁盘 ⇒ 环境页磁盘永远没数据）──
test('assessStatfs：正常换算 usedPct/剩余空间', () => {
  const r = assessStatfs({ blocks: 1000, bavail: 500, bsize: 4096 })
  assert.equal(r.level, 'ok')
  assert.equal(r.usedPct, 50)
})
test('assessStatfs：>95% 已用 ⇒ critical', () => {
  const r = assessStatfs({ blocks: 100, bavail: 2, bsize: 1024 })
  assert.equal(r.level, 'critical')
})
test('assessStatfs：字段缺失/非法 ⇒ unknown（不误判健康）', () => {
  for (const bad of [{}, { blocks: 0 }, { blocks: 'x', bavail: 1, bsize: 1 }]) {
    assert.equal(assessStatfs(bad).level, 'unknown')
  }
})
