/**
 * 宿主 profile 配置预检回归测试（v1.8.0 新增）
 *
 * 环境/配置故障：profile package.json 损坏、bundles 缺依赖、cordis.patch.yml 含 !!js /
 * 引用无法解析的包 —— 这些此前**没有任何检测路径**（/diag 从不读 profile）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspectProfile, detectProfileName, makeResolver, DEFAULT_PROFILE } from '../src/detect/profile.js'

async function makeHome({ pkg, patch, profile = 'web' } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'cs-guard-profile-'))
  const dir = join(home, 'profiles', profile)
  await mkdir(dir, { recursive: true })
  if (pkg !== undefined) await writeFile(join(dir, 'package.json'), typeof pkg === 'string' ? pkg : JSON.stringify(pkg, null, 2))
  if (patch !== undefined) await writeFile(join(dir, 'cordis.patch.yml'), patch)
  return { home, dir }
}

const goodPkg = {
  name: 'dsh-profile-web',
  dependencies: { 'cs-guard': 'link:.' },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'cs-guard'] } },
}

test('健康 profile：checks 全绿、无 finding', async () => {
  const { home } = await makeHome({
    pkg: goodPkg,
    patch: '- id: cs-guard\n  name: cs-guard\n',
  })
  const r = await inspectProfile({ dshHome: home, resolveFn: () => true })
  assert.equal(r.findings.length, 0, JSON.stringify(r.findings))
  assert.ok(r.checks.every((c) => c.ok !== false))
  assert.equal(r.profileName, 'web')
  await rm(home, { recursive: true, force: true })
})

test('package.json JSON 损坏 ⇒ 检出（环境故障）', async () => {
  const { home } = await makeHome({ pkg: '{ "dsh": ', patch: '' })
  const r = await inspectProfile({ dshHome: home, resolveFn: () => true })
  assert.ok(r.findings.some((f) => /JSON 损坏/.test(f.detail)))
  assert.ok(r.checks.some((c) => c.ok === false))
  await rm(home, { recursive: true, force: true })
})

test('package.json 缺失 ⇒ 检出', async () => {
  const { home } = await makeHome({ patch: '' })
  const r = await inspectProfile({ dshHome: home })
  assert.ok(r.findings.some((f) => /不可读|找不到/.test(f.detail)))
  await rm(home, { recursive: true, force: true })
})

test('bundles 有但 dependencies 缺失 ⇒ 检出', async () => {
  const { home } = await makeHome({
    pkg: { name: 'x', dependencies: {}, dsh: { profile: { bundles: ['cs-guard'] } } },
    patch: '',
  })
  const r = await inspectProfile({ dshHome: home, resolveFn: () => true })
  assert.ok(r.findings.some((f) => /bundles 里有 cs-guard/.test(f.detail)))
  await rm(home, { recursive: true, force: true })
})

test('patch 含 !!js ⇒ 检出（安全风险）', async () => {
  const { home } = await makeHome({ pkg: goodPkg, patch: 'foo: !!js/function >\n  return 1\n' })
  const r = await inspectProfile({ dshHome: home, resolveFn: () => true })
  assert.ok(r.findings.some((f) => /!!js/.test(f.detail)))
  await rm(home, { recursive: true, force: true })
})

test('patch 引用无法解析的包 ⇒ 检出（配置故障）', async () => {
  const { home } = await makeHome({
    pkg: goodPkg,
    patch: '- id: ghost\n  name: ghost-plugin\n',
  })
  const r = await inspectProfile({ dshHome: home, resolveFn: () => false })
  assert.ok(r.findings.some((f) => /无法解析/.test(f.detail)))
  await rm(home, { recursive: true, force: true })
})

test('detectProfileName：env > argv > 默认', () => {
  assert.equal(detectProfileName({ argv: ['node', 'dsh', '--profile', 'rescue'], env: {} }), 'rescue')
  assert.equal(detectProfileName({ argv: ['node', 'dsh'], env: { DSH_PROFILE: 'tui' } }), 'tui')
  assert.equal(detectProfileName({ argv: ['node', 'dsh'], env: {} }), DEFAULT_PROFILE)
  assert.equal(detectProfileName({ argv: ['node', 'dsh', '--profile', '../evil'], env: {} }), DEFAULT_PROFILE)
})

test('makeResolver 对不存在包返回 false，不抛', () => {
  const fn = makeResolver('/tmp/definitely-not-a-profile')
  assert.equal(fn('cs-guard'), false)
  assert.equal(typeof fn, 'function')
})
