import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyNetwork, PROBE_TARGETS } from '../src/detect/network.js'

const all = (ok) => PROBE_TARGETS.map((t) => ({ id: t.id, ok }))

test('全通 ⇒ healthy', () => {
  assert.equal(classifyNetwork(all(true)).verdict, 'healthy')
})
test('全断 ⇒ all-down', () => {
  assert.equal(classifyNetwork(all(false)).verdict, 'all-down')
})
test('分片坏 ⇒ partial（这是生产真实情况）', () => {
  const r = PROBE_TARGETS.map((t) => ({ id: t.id, ok: t.id !== 'github-api' }))
  const v = classifyNetwork(r)
  assert.equal(v.verdict, 'partial')
  assert.deepEqual(v.bad, ['github-api'])
})
test('影响面说明不是空话', () => {
  const r = PROBE_TARGETS.map((t) => ({ id: t.id, ok: t.id !== 'api-deepseek' }))
  const v = classifyNetwork(r)
  assert.ok(v.impact.some((x) => x.includes('模型 API')))
})
test('缺结果不误判为健康', () => {
  const v = classifyNetwork([{ id: 'dns-basic', ok: true }])
  assert.equal(v.verdict, 'healthy', '只按已测目标判定')
  assert.equal(v.ok.length, 1)
})
