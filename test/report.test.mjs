import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildReport } from '../src/index.js'

test('全健康 ⇒ level ok', () => {
  const r = buildReport({
    network: [{ id: 'dns-basic', ok: true }],
    disk: { totalBytes: 100, freeBytes: 50 },
    memory: { totalBytes: 100, freeBytes: 50 },
  })
  assert.equal(r.level, 'ok')
  assert.match(r.summary, /全部正常/)
})

test('网络全断 ⇒ critical', () => {
  const r = buildReport({ network: [
    { id: 'dns-basic', ok: false }, { id: 'api-deepseek', ok: false },
    { id: 'npm-mirror', ok: false }, { id: 'github-api', ok: false },
  ]})
  assert.equal(r.level, 'critical')
})

test('上下文退化 ⇒ 出 finding（事故场景）', () => {
  const r = buildReport({ context: { inputTokens: 285000, text: '作为一个人工智能语言模型' } })
  assert.ok(r.findings.some((f) => f.type === 'context'))
})

test('可用内存极低 ⇒ critical（真危险）', () => {
  const r = buildReport({ memory: { totalBytes: 100, freeBytes: 2 } })
  assert.equal(r.level, 'critical')
})

test('磁盘满 ⇒ 出 finding', () => {
  const r = buildReport({ disk: { totalBytes: 100, freeBytes: 2 } })
  assert.ok(r.findings.some((f) => f.type === 'disk' && f.level === 'critical'))
})

test('patch 含 !!js ⇒ 出 finding', () => {
  const r = buildReport({ patch: 'a: !!js/function\n  x' })
  assert.ok(r.findings.some((f) => f.type === 'config'))
})

test('多项问题并存时取最严重级别', () => {
  const r = buildReport({
    memory: { totalBytes: 100, freeBytes: 2 },
    disk: { totalBytes: 100, freeBytes: 2 },
  })
  assert.equal(r.level, 'critical')
  assert.ok(r.findings.length >= 2)
})

test('空输入不崩且判 ok', () => {
  const r = buildReport({})
  assert.equal(r.level, 'ok')
})

// ── v1.8.0：本插件配置损坏必须进报告（环境故障不得静默）──
test('cs-guard 配置损坏 ⇒ 出 config finding（warn）', () => {
  const r = buildReport({ configError: '配置文件 JSON 损坏：Unexpected token' })
  assert.equal(r.level, 'warn')
  const f = r.findings.find((x) => x.type === 'config')
  assert.ok(f)
  assert.match(f.detail, /cs-guard 配置文件异常/)
})
