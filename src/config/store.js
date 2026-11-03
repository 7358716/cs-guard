/**
 * cs-guard — 配置存储（原子写 + 0600）
 * @module cs-guard/config/store
 */

import { readFile, writeFile, rename, mkdir, chmod, unlink } from 'node:fs/promises'
import { join } from 'node:path'

export function configDir(dshHome) {
  return join(dshHome || process.env.DSH_HOME || join(process.env.HOME || '.', '.dsh'), 'cs-guard')
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

export async function readConfig(dshHome) {
  try {
    return JSON.parse(await readFile(join(configDir(dshHome), 'config.json'), 'utf8'))
  } catch {
    return {}
  }
}

export async function writeConfig(dshHome, obj) {
  const dir = configDir(dshHome)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const file = join(dir, 'config.json')
  const tmp = `${dir}/.${Date.now()}.tmp`
  try {
    await writeFile(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 })
    await chmod(tmp, 0o600).catch(() => {})
    await rename(tmp, file)
    return true
  } catch {
    await unlink(tmp).catch(() => {})
    return false
  }
}
