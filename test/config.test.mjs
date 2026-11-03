import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkPatchRefs, checkJsTags, checkBundleConsistency } from '../src/detect/config.js'

test('能发现无法解析的自有 id', () => {
  const r = checkPatchRefs('- insert:\n    - id: ghost-plugin\n      name: ghost-plugin', () => false)
  assert.equal(r.ok, false)
  assert.ok(r.problems[0].includes('ghost-plugin'))
})
test('官方 id 不做解析检查（它们由宿主提供）', () => {
  const r = checkPatchRefs('- id: agent-team\n  name: @deepseek-ai/dsh-experimental-agent-team', () => false)
  assert.equal(r.ok, true)
})
test('能解析则通过', () => {
  assert.equal(checkPatchRefs('- insert:\n    - id: cs-myfree\n      name: cs-myfree', () => true).ok, true)
})
test('发现 !!js 标签（安全风险）', () => {
  const r = checkJsTags('foo: !!js/function >\n  return 1')
  assert.equal(r.ok, false)
  assert.equal(r.hits[0].line, 1)
})
test('无 !!js 则通过', () => {
  assert.equal(checkJsTags('foo: bar').ok, true)
})
test('bundles 有但 deps 没有 ⇒ 报警', () => {
  const r = checkBundleConsistency(['cs-myfree', 'cs-guard'], { 'cs-myfree': 'link:.' })
  assert.equal(r.ok, false)
  assert.ok(r.problems[0].includes('cs-guard'))
})
test('一致则通过', () => {
  assert.equal(checkBundleConsistency(['cs-myfree'], { 'cs-myfree': 'link:.' }).ok, true)
})


// ── v1.8.0 修复：插件 config 里的业务 id 不能被误报成包引用 ──
test('真实 profile 片段：lanes 里的 id/name 不误报（缩进 >4 不是 patch 条目）', () => {
  const patch = [
    '- id: cs-myfree',
    "  name: 'cs-myfree'",
    '  config:',
    '    lanes:',
    '      - id: free',
    '        name: 免费车道',
    '      - id: kilo',
    '        name: Kilo 免费池',
  ].join('\n')
  const r = checkPatchRefs(patch, (n) => n === 'cs-myfree')
  assert.equal(r.ok, true, r.problems.join('；'))
})

test('顶层未解析条目仍然能检出', () => {
  const r = checkPatchRefs('- id: ghost\n  name: ghost-plugin', () => false)
  assert.equal(r.ok, false)
})

test('insert 列表里的条目仍然能检出（缩进 4）', () => {
  const r = checkPatchRefs('- insert:\n    - id: ghost\n      name: ghost-plugin', () => false)
  assert.equal(r.ok, false)
})
