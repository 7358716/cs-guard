/**
 * 配置存储回归测试（v1.8.0 新增）
 *
 * 环境故障注入发现：损坏的 config.json 被**静默**当成空配置，下一次保存直接覆盖
 * （用户配置无备份丢失）。现在要求：读取带状态、写入前备份坏文件、错误可上报。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, readdir, chmod, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readConfigState, writeConfig, quarantineConfig, configDir, configPath, withDefaults, DEFAULTS,
} from '../src/config/store.js'

const tmp = () => mkdtemp(join(tmpdir(), 'cs-guard-store-'))

test('目录不存在 ⇒ exists=false 且 error=null（首次使用）', async () => {
  const home = await tmp()
  const st = await readConfigState(home)
  assert.equal(st.exists, false)
  assert.equal(st.error, null)
  assert.deepEqual(st.config, {})
  await rm(home, { recursive: true, force: true })
})

test('JSON 损坏 ⇒ 返回 error（不再静默当默认值）', async () => {
  const home = await tmp()
  await mkdir(configDir(home), { recursive: true })
  await writeFile(configPath(home), '{"restart":{"maxPerDay":9}, BROKEN')
  const st = await readConfigState(home)
  assert.equal(st.exists, true)
  assert.match(st.error, /JSON 损坏/)
  assert.deepEqual(st.config, {})
  await rm(home, { recursive: true, force: true })
})

test('配置不是对象（数组）⇒ 报错', async () => {
  const home = await tmp()
  await mkdir(configDir(home), { recursive: true })
  await writeFile(configPath(home), '[1,2]')
  const st = await readConfigState(home)
  assert.match(st.error, /不是 JSON 对象/)
  await rm(home, { recursive: true, force: true })
})

test('写入成功：目录 0700、文件 0600（无凭据落盘的安全基线）', async () => {
  const home = await tmp()
  const r = await writeConfig(home, withDefaults({ restart: { maxPerDay: 2 } }))
  assert.equal(r.ok, true)
  if (process.platform !== 'win32') {
    const dirMode = (await stat(configDir(home))).mode & 0o777
    const fileMode = (await stat(configPath(home))).mode & 0o777
    assert.equal(dirMode, 0o700)
    assert.equal(fileMode, 0o600)
  }
  const st = await readConfigState(home)
  assert.equal(st.config.restart.maxPerDay, 2)
  await rm(home, { recursive: true, force: true })
})

test('损坏文件在写入前被改名备份（不删除、不覆盖）', async () => {
  const home = await tmp()
  await mkdir(configDir(home), { recursive: true })
  const bad = '{"restart":{"maxPerDay":9}, BROKEN'
  await writeFile(configPath(home), bad)
  const r = await writeConfig(home, withDefaults({}))
  assert.equal(r.ok, true)
  assert.ok(r.quarantined, '应返回备份路径')
  const names = await readdir(configDir(home))
  const backups = names.filter((n) => n.startsWith('config.json.broken-'))
  assert.equal(backups.length, 1)
  const saved = await readFile(join(configDir(home), backups[0]), 'utf8')
  assert.equal(saved, bad, '备份内容必须原样保留')
  assert.ok(!names.includes('.tmp'))
  await rm(home, { recursive: true, force: true })
})

test('quarantineConfig 没有坏文件时返回 ok=false 不抛', async () => {
  const home = await tmp()
  const r = await quarantineConfig(home)
  assert.equal(r.ok, false)
  await rm(home, { recursive: true, force: true })
})

test('父目录不可写 ⇒ 返回 error 而不是抛（API 不能再 500 泄内部栈）', async () => {
  if (process.platform === 'win32' || process.getuid?.() === 0) return
  const home = await tmp()
  // 让 <home>/cs-guard 无法创建：home 本身不可写
  await chmod(home, 0o500)
  try {
    const r = await writeConfig(home, withDefaults({}))
    assert.equal(r.ok, false)
    assert.ok(typeof r.error === 'string' && r.error.length > 0)
  } finally {
    await chmod(home, 0o700).catch(() => {})
    await rm(home, { recursive: true, force: true })
  }
})

test('withDefaults 深合并一层，不丢默认值', () => {
  const cfg = withDefaults({ restart: { maxPerDay: 1 } })
  assert.equal(cfg.restart.maxPerDay, 1)
  assert.equal(cfg.restart.minIntervalMs, DEFAULTS.restart.minIntervalMs)
  assert.equal(cfg.context.warnTokens, DEFAULTS.context.warnTokens)
})

test('配置目录路径被普通文件占用 ⇒ 明确报错（不 500、不静默）', async () => {
  const home = await tmp()
  await writeFile(join(home, 'cs-guard'), 'not a dir')
  const r = await writeConfig(home, withDefaults({}))
  assert.equal(r.ok, false)
  assert.match(r.error, /路径被占用/)
})
