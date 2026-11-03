/**
 * 配置校验 / 降级 / 脱敏的回归测试（v1.8.0 新增）
 *
 * 覆盖真实故障注入发现的缺陷：
 *  · 非对象 body 被当配置落盘（"abc"/[1,2] ⇒ config 里出现 "0","1","2" 键）
 *  · dshHome 类型错误 ⇒ POST /config 500（path 参数类型错误）
 *  · 凭据类字段可被写入磁盘
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeBootConfig, validateUserConfig, parseProbeTargets, redactSecrets,
  isPlainObject, CONFIG_SCHEMA,
} from '../src/config/validate.js'
import { PROBE_TARGETS } from '../src/detect/network.js'

// ── 用户配置校验 ──
test('非对象 body 一律拒绝（字符串/数组/null）', () => {
  for (const b of ['abc', [1, 2], null, 42]) {
    const r = validateUserConfig(b, { base: {} })
    assert.equal(r.ok, false, `应拒绝 ${JSON.stringify(b)}`)
    assert.match(r.errors.join('；'), /必须是 JSON 对象/)
  }
})

test('未知键只提示不落盘（不再把 "0"/"1"/"2" 写进配置）', () => {
  const r = validateUserConfig({ restart: { maxPerDay: 5 }, junk: 1 }, { base: {} })
  assert.equal(r.ok, true)
  assert.equal(r.config.junk, undefined)
  assert.ok(r.warnings.some((w) => w.includes('junk')))
})

test('凭据类字段拒绝写入（无凭据落盘）', () => {
  const r = validateUserConfig({ apiKey: 'sk-secret', restart: { maxPerDay: 2 } }, { base: {} })
  assert.equal(r.ok, false)
  assert.match(r.errors.join('；'), /凭据/)
})

test('嵌套凭据类字段同样拒绝', () => {
  const r = validateUserConfig({ restart: { maxPerDay: 2, token: 'x' } }, { base: {} })
  assert.equal(r.ok, false)
  assert.match(r.errors.join('；'), /凭据/)
})

test('数值类型错误被拒', () => {
  const r = validateUserConfig({ restart: { maxPerDay: '5' } }, { base: {} })
  assert.equal(r.ok, false)
  assert.match(r.errors.join('；'), /必须是数字/)
})

test('数值超范围被拒', () => {
  const r = validateUserConfig({ restart: { maxPerDay: 999 } }, { base: {} })
  assert.equal(r.ok, false)
  assert.match(r.errors.join('；'), /超出范围/)
})

test('布尔类型必须严格是 boolean', () => {
  const r = validateUserConfig({ watch: { network: 1 } }, { base: {} })
  assert.equal(r.ok, false)
  assert.match(r.errors.join('；'), /必须是布尔值/)
})

test('context 危险水位必须高于预警水位', () => {
  const base = { schema: CONFIG_SCHEMA, context: { warnTokens: 250000, criticalTokens: 320000 } }
  const r = validateUserConfig({ context: { warnTokens: 300000, criticalTokens: 300000 } }, { base })
  assert.equal(r.ok, false)
  assert.match(r.errors.join('；'), /criticalTokens 必须大于/)
})

test('合法配置通过并强制 schema', () => {
  const r = validateUserConfig({ restart: { maxPerDay: 2 }, context: { warnTokens: 100000, criticalTokens: 200000 } }, { base: {} })
  assert.equal(r.ok, true)
  assert.equal(r.config.schema, CONFIG_SCHEMA)
  assert.equal(r.config.restart.maxPerDay, 2)
  assert.equal(r.config.context.criticalTokens, 200000)
})

// ── 启动配置降级 ──
test('rawConfig 是字符串/数组时安全降级不抛', () => {
  for (const raw of ['oops', [1], 42]) {
    const r = normalizeBootConfig(raw)
    assert.ok(Array.isArray(r.probeTargets))
    assert.equal(r.probeTargets.length, 4)
    assert.ok(r.warnings.length > 0)
  }
})

test('dshHome 类型错误 ⇒ undefined + warning（不再让 API 500）', () => {
  const r = normalizeBootConfig({ dshHome: 123 })
  assert.equal(r.dshHome, undefined)
  assert.match(r.warnings.join('；'), /dshHome/)
})

test('dshHome 合法字符串保留', () => {
  assert.equal(normalizeBootConfig({ dshHome: '/tmp/x' }).dshHome, '/tmp/x')
})

test('trustedHosts 非数组 ⇒ [] + warning', () => {
  const r = normalizeBootConfig({ trustedHosts: 'localhost' })
  assert.deepEqual(r.trustedHosts, [])
  assert.match(r.warnings.join('；'), /trustedHosts/)
})

test('trustedHosts 数组过滤非字符串项', () => {
  const r = normalizeBootConfig({ trustedHosts: ['a.example', 42, '', 'b.example'] })
  assert.deepEqual(r.trustedHosts, ['a.example', 'b.example'])
})

test('probeTimeoutMs 被限制在 200..15000', () => {
  assert.equal(normalizeBootConfig({ probeTimeoutMs: 1 }).probeTimeoutMs, 200)
  assert.equal(normalizeBootConfig({ probeTimeoutMs: 999999 }).probeTimeoutMs, 15000)
  assert.equal(normalizeBootConfig({ probeTimeoutMs: '2500' }).probeTimeoutMs, 2500)
})

test('probeTargets 非法 ⇒ 回落到内置目标', () => {
  for (const bad of ['x', [], [{ id: 'a' }], [{ id: 'a', url: 'ftp://x', label: 'x' }]]) {
    const r = normalizeBootConfig({ probeTargets: bad })
    assert.equal(r.probeTargets.length, PROBE_TARGETS.length)
    assert.ok(r.warnings.some((w) => w.includes('probeTargets')))
  }
})

test('probeTargets 合法自定义目标被采纳', () => {
  const r = normalizeBootConfig({
    probeTargets: [{ id: 'blackhole', label: '黑洞', url: 'http://10.255.255.1:81/', cls: 'test' }],
  })
  assert.equal(r.probeTargets.length, 1)
  assert.equal(r.probeTargets[0].id, 'blackhole')
})

test('probeTargets URL 内嵌凭据被拒绝（日志/UI 不得带凭据）', () => {
  const w = []
  const out = parseProbeTargets([{ id: 'x', url: 'https://user:pass@example.com/', label: 'x' }], w)
  assert.equal(out, null)
  assert.match(w.join('；'), /不得内嵌凭据/)
})

test('probeTargets id 重复被拒绝', () => {
  const w = []
  const out = parseProbeTargets([
    { id: 'x', url: 'https://a.example/', label: 'a' },
    { id: 'x', url: 'https://b.example/', label: 'b' },
  ], w)
  assert.equal(out, null)
  assert.match(w.join('；'), /重复/)
})

// ── 脱敏 ──
test('redactSecrets 只打码凭据类键，不误伤 warnTokens/criticalTokens', () => {
  const out = redactSecrets({
    schema: CONFIG_SCHEMA,
    context: { warnTokens: 250000, criticalTokens: 320000 },
    apiKey: 'sk-xxx',
    nested: { token: 'abc', password: 'p' },
  })
  assert.equal(out.context.warnTokens, 250000)
  assert.equal(out.context.criticalTokens, 320000)
  assert.equal(out.apiKey, '***')
  assert.equal(out.nested.token, '***')
  assert.equal(out.nested.password, '***')
})

test('isPlainObject 判定', () => {
  assert.equal(isPlainObject({}), true)
  assert.equal(isPlainObject([]), false)
  assert.equal(isPlainObject(null), false)
  assert.equal(isPlainObject('x'), false)
})
