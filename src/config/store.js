/**
 * cs-guard — 配置存储（原子写 + 0600 + 损坏备份）
 *
 * 🔴 v1.8.0 修复（环境故障注入发现）：
 *   旧 `readConfig` 对**损坏的 config.json 静默返回 {}** —— 用户配置凭空丢失，
 *   下次保存还会**直接覆盖**坏文件（无备份、无告警）。实测：
 *     `printf '{"maxPerDay":9,BROKEN' > config.json` ⇒ GET /config 回默认值，没有任何提示。
 *   现在：读取带状态（exists/error），损坏文件在下次写入前**改名备份**（0600，不删除）。
 *
 * @module cs-guard/config/store
 */

import { readFile, writeFile, rename, mkdir, chmod, unlink, stat } from 'node:fs/promises'
import { join } from 'node:path'

export function resolveDshHome(dshHome) {
  if (typeof dshHome === 'string' && dshHome.trim() !== '') return dshHome.trim()
  if (typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== '') return process.env.DSH_HOME.trim()
  return join(process.env.HOME || '.', '.dsh')
}

export function configDir(dshHome) {
  return join(resolveDshHome(dshHome), 'cs-guard')
}

export function configPath(dshHome) {
  return join(configDir(dshHome), 'config.json')
}

export const DEFAULTS = Object.freeze({
  schema: 'cs-guard/config/v1',
  restart: {
    minIntervalMs: 10 * 60 * 1000,   // 两次重启最小间隔
    maxPerDay: 3,                    // 每日上限
    requireNoActiveTurns: true,      // 有活跃轮次时不许重启
    consecutiveBreaches: 3,          // 连续越线多少次才动手
  },
  resume: {
    maxAttempts: 2,                  // 最大续跑次数
    compactBeforeRetry: true,        // 退化时必须先压缩
  },
  context: {
    warnTokens: 250000,              // 上下文预警水位
    criticalTokens: 320000,          // 危险水位
  },
  watch: {
    network: true,
    context: true,
    env: true,
    overcommit: true,
    config: true,
  },
})

export function withDefaults(cfg = {}) {
  const out = JSON.parse(JSON.stringify(DEFAULTS))
  for (const [k, v] of Object.entries(cfg || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object') {
      out[k] = Object.assign({}, out[k], v)
    } else out[k] = v
  }
  return out
}

/**
 * 读取配置并返回**状态**（存在性 / 解析错误），供 /config 与 /diag 上报。
 *
 * @param {string} [dshHome]
 * @param {{readFileImpl?:(p:string)=>Promise<string>, statImpl?:(p:string)=>Promise<any>}} [opts]
 * @returns {Promise<{config:object, exists:boolean, error:string|null, path:string}>}
 */
export async function readConfigState(dshHome, { readFileImpl, statImpl } = {}) {
  const file = configPath(dshHome)
  const read = readFileImpl ?? ((p) => readFile(p, 'utf8'))
  const st = statImpl ?? stat
  let exists = false
  try { exists = Boolean(await st(file)) } catch { exists = false }

  let text
  try {
    text = await read(file)
  } catch (err) {
    const code = err?.code ?? ''
    if (code === 'ENOENT' || !exists) return { config: {}, exists: false, error: null, path: file }
    return { config: {}, exists, error: `配置文件不可读（${code || err?.message || err}）`, path: file }
  }
  try {
    const parsed = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { config: {}, exists: true, error: '配置文件不是 JSON 对象', path: file }
    }
    return { config: parsed, exists: true, error: null, path: file }
  } catch (err) {
    return { config: {}, exists: true, error: `配置文件 JSON 损坏：${err?.message ?? err}`, path: file }
  }
}

/** 兼容旧接口（只要配置本体） */
export async function readConfig(dshHome, opts) {
  return (await readConfigState(dshHome, opts)).config
}

/**
 * 把损坏的配置文件改名备份（不动内容、不删除）。失败不抛。
 * @returns {Promise<{ok:boolean, path?:string, error?:string}>}
 */
export async function quarantineConfig(dshHome) {
  const dir = configDir(dshHome)
  const file = configPath(dshHome)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const dest = join(dir, `config.json.broken-${stamp}`)
  try {
    await rename(file, dest)
    return { ok: true, path: dest }
  } catch (err) {
    return { ok: false, error: String(err?.code || err?.message || err) }
  }
}

/**
 * 原子写配置。
 *
 * @returns {Promise<{ok:boolean, error?:string, quarantined?:string}>}
 */
export async function writeConfig(dshHome, obj, { readFileImpl, statImpl } = {}) {
  const dir = configDir(dshHome)
  const file = configPath(dshHome)
  const mode = process.platform === 'win32' ? {} : { mode: 0o600 }
  let quarantined
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await chmod(dir, 0o700).catch(() => {})
    // 坏文件先备份再覆盖（避免用户配置无痕丢失）
    const state = await readConfigState(dshHome, { readFileImpl, statImpl })
    if (state.error && state.exists) {
      const q = await quarantineConfig(dshHome)
      if (q.ok) quarantined = q.path
    }
    const tmp = join(dir, `.${Date.now()}.${process.pid}.tmp`)
    try {
      await writeFile(tmp, JSON.stringify(obj, null, 2), mode)
      await chmod(tmp, 0o600).catch(() => {})
      await rename(tmp, file)
      return { ok: true, ...(quarantined ? { quarantined } : {}) }
    } catch (err) {
      await unlink(tmp).catch(() => {})
      return { ok: false, error: String(err?.message ?? err).slice(0, 200) }
    }
  } catch (err) {
    const code = String(err?.code || '')
    const friendly = code === 'EEXIST' || code === 'ENOTDIR'
      ? '配置目录路径被占用（不是目录），请人工检查'
      : ''
    return { ok: false, error: (friendly || String(err?.message || err)).slice(0, 200) }
  }
}
