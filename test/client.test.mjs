import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SECTIONS, selfCheck, renderSettings, apply } from '../src/client.js'
import { decideSupervise, buildRestartRequest, decideResume, compactPrompt } from '../src/index.js'

test('6 个设置分区', () => { assert.equal(SECTIONS.length, 6); assert.equal(selfCheck().ok, true) })
test('renderSettings 返回全部分区', () => {
  const r = renderSettings({})
  assert.equal(r.sections.length, 6)
  for (const s of r.sections) assert.ok(s.body !== undefined)
})
test('恢复策略明确「删文件永不自动」', () => {
  const r = renderSettings({})
  const b = r.sections.find((s) => s.id === 'repair').body
  assert.match(b.deletedFiles, /永不自动删除/)
})
test('apply 用自有 id', () => {
  const calls = []
  apply({ slots: { inject: (slot, fn) => calls.push(fn()) } })
  assert.equal(calls[0].id, 'cs-guard-section')
})
test('无 slots 不崩', () => { assert.doesNotThrow(() => apply({})) })
test('主入口已导出 supervise/resume', () => {
  assert.equal(typeof decideSupervise, 'function')
  assert.equal(typeof buildRestartRequest, 'function')
  assert.equal(typeof decideResume, 'function')
  assert.equal(typeof compactPrompt, 'function')
})
