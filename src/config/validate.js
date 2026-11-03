/**
 * cs-guard — 配置校验 / 降级（安全红线：绝不落盘凭据）
 *
 * 两类配置：
 *   ① 宿主 patch 里的**启动配置**（rawConfig）：dshHome / trustedHosts /
 *      probeTargets / probeTimeoutMs / profileName —— 类型错误时必须**安全降级**，
 *      绝不让 API 500 或把宿主启动搞坏。
 *   ② 设置页保存的**用户配置**（/config POST）：只允许白名单键，类型/范围逐项校验，
 *      凭据类字段一律拒绝（无凭据落盘）。
 *
 * @module cs-guard/config/validate
 */

import { PROBE_TARGETS } from '../detect/network.js'

export const CONFIG_SCHEMA = 'cs-guard/config/v1'

/** 数值范围（min/max，闭区间，整数） */
export const RANGES = Object.freeze({
  restart: {
    minIntervalMs: [60_000, 24 * 60 * 60 * 1000],
    maxPerDay: [1, 20],
    consecutiveBreaches: [1, 10],
  },
  resume: {
    maxAttempts: [0, 5],
  },
  context: {
    warnTokens: [10_000, 2_000_000],
    criticalTokens: [10_001, 4_000_000],
  },
})

/** 用户配置（/config 可写段）的键与类型 */
const SECTIONS = Object.freeze({
  restart: { minIntervalMs: 'number', maxPerDay: 'number', consecutiveBreaches: 'number', requireNoActiveTurns: 'bool' },
  resume: { maxAttempts: 'number', compactBeforeRetry: 'bool' },
  context: { warnTokens: 'number', criticalTokens: 'number' },
  watch: { network: 'bool', context: 'bool', env: 'bool', overcommit: 'bool', config: 'bool' },
})

/** 凭据类字段名（禁止通过 API 落盘）。注意：不得误伤 warnTokens/criticalTokens。 */
const SECRET_KEY_RE = /^(?:api[-_]?key|apikey|access[-_]?token|refresh[-_]?token|auth[-_]?token|token|secret|client[-_]?secret|password|passwd|credential|credentials|authorization|cookie)$/i

export function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function isSecretKey(key) {
  return SECRET_KEY_RE.test(String(key ?? ''))
}

/**
 * 递归脱敏（UI/API 只回掩码）。
 * 白名单配置键（warnTokens/criticalTokens）不脱敏。
 */
export function redactSecrets(obj, depth = 0) {
  if (depth > 6 || !isPlainObject(obj)) return obj
  const out = {}
  for (const [k, v] of Object.entries(obj)) {
    if (isSecretKey(k)) out[k] = '***'
    else if (isPlainObject(v)) out[k] = redactSecrets(v, depth + 1)
    else out[k] = v
  }
  return out
}

function err(errors, msg) { errors.push(msg) }

function checkNumber(section, key, value, errors) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    err(errors, `${section}.${key} 必须是数字`)
    return
  }
  if (!Number.isInteger(value)) {
    err(errors, `${section}.${key} 必须是整数`)
    return
  }
  const [min, max] = RANGES[section][key]
  if (value < min || value > max) err(errors, `${section}.${key} 超出范围（${min}..${max}）`)
}

/**
 * 校验设置页提交的用户配置。
 *
 * @param {unknown} body 解析后的 JSON 体
 * @param {{base?: object}} [opts] 现有配置（用于交叉校验 context 水位）
 * @returns {{ok:boolean, config?:object, errors:string[], warnings:string[]}}
 */
export function validateUserConfig(body, { base = {} } = {}) {
  const errors = []
  const warnings = []
  if (!isPlainObject(body)) {
    return { ok: false, errors: ['配置必须是 JSON 对象'], warnings }
  }

  const out = JSON.parse(JSON.stringify(base || {}))
  out.schema = CONFIG_SCHEMA
  if (body.schema !== undefined && body.schema !== CONFIG_SCHEMA) {
    warnings.push(`schema 已重置为 ${CONFIG_SCHEMA}`)
  }

  for (const [section, value] of Object.entries(body)) {
    if (section === 'schema') continue
    if (!(section in SECTIONS)) {
      // 未知键：凭据类直接拒绝（无凭据落盘），其余忽略并提示，不写入文件
      if (isSecretKey(section)) err(errors, `不允许通过 API 写入凭据类配置：${section}`)
      else warnings.push(`忽略未知配置项：${section}`)
      continue
    }
    if (!isPlainObject(value)) {
      err(errors, `${section} 必须是对象`)
      continue
    }
    if (!isPlainObject(out[section])) out[section] = {}
    for (const [key, v] of Object.entries(value)) {
      if (!(key in SECTIONS[section])) {
        if (isSecretKey(key)) err(errors, `不允许通过 API 写入凭据类配置：${section}.${key}`)
        else warnings.push(`忽略未知配置项：${section}.${key}`)
        continue
      }
      const type = SECTIONS[section][key]
      if (type === 'bool') {
        if (typeof v !== 'boolean') err(errors, `${section}.${key} 必须是布尔值`)
        else out[section][key] = v
      } else {
        checkNumber(section, key, v, errors)
        if (typeof v === 'number' && Number.isInteger(v)) out[section][key] = v
      }
    }
  }

  // 交叉校验：危险水位必须高于预警水位
  const warnAt = out?.context?.warnTokens
  const critAt = out?.context?.criticalTokens
  if (Number.isInteger(warnAt) && Number.isInteger(critAt) && critAt <= warnAt) {
    err(errors, 'context.criticalTokens 必须大于 context.warnTokens')
  }

  return errors.length === 0
    ? { ok: true, config: out, errors, warnings }
    : { ok: false, config: out, errors, warnings }
}

/**
 * 归一化宿主 patch 里的启动配置。
 *
 * 🔴 铁律：任何类型错误都只降级 + 记 warning，**绝不抛错**（否则 apply 会把宿主拖下水）。
 *
 * @param {unknown} raw 宿主传入的 config
 * @returns {{dshHome?:string, trustedHosts:string[], profileName?:string, probeTimeoutMs:number, probeTargets:Array, warnings:string[]}}
 */
export function normalizeBootConfig(raw = {}) {
  const warnings = []
  let src = raw
  if (!isPlainObject(src)) {
    if (src !== undefined && src !== null) warnings.push('插件配置必须是对象，已忽略并回落到默认值')
    src = {}
  }
  const out = {
    dshHome: undefined,
    trustedHosts: [],
    profileName: undefined,
    probeTimeoutMs: 4000,
    probeTargets: PROBE_TARGETS.map((t) => ({ ...t })),
    warnings,
  }

  if (src.dshHome !== undefined) {
    if (typeof src.dshHome === 'string' && src.dshHome.trim() !== '' && !src.dshHome.includes('\0')) {
      out.dshHome = src.dshHome.trim()
    } else {
      warnings.push('dshHome 必须是字符串（已回落到 $DSH_HOME）')
    }
  }

  if (src.trustedHosts !== undefined) {
    if (Array.isArray(src.trustedHosts)) {
      const list = []
      for (const h of src.trustedHosts.slice(0, 20)) {
        if (typeof h === 'string' && h.trim() !== '') list.push(h.trim())
      }
      out.trustedHosts = list
      if (list.length !== src.trustedHosts.length) warnings.push('trustedHosts 含非字符串项，已忽略')
    } else {
      warnings.push('trustedHosts 必须是字符串数组（已忽略）')
    }
  }

  if (src.profileName !== undefined) {
    if (typeof src.profileName === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(src.profileName)) {
      out.profileName = src.profileName
    } else {
      warnings.push('profileName 非法（已回落为自动探测）')
    }
  }

  if (src.probeTimeoutMs !== undefined) {
    const n = Number(src.probeTimeoutMs)
    if (Number.isFinite(n)) {
      out.probeTimeoutMs = Math.min(15000, Math.max(200, Math.round(n)))
      if (out.probeTimeoutMs !== Math.round(n)) warnings.push('probeTimeoutMs 已限制到 200..15000ms')
    } else {
      warnings.push('probeTimeoutMs 必须是数字（已回落到 4000ms）')
    }
  }

  if (src.probeTargets !== undefined) {
    const parsed = parseProbeTargets(src.probeTargets, warnings)
    if (parsed) out.probeTargets = parsed
    else warnings.push('probeTargets 非法（已回落到内置 4 个目标）')
  }

  return out
}

/** 校验自定义探测目标（禁止 URL 内嵌凭据、禁止非 http(s) 协议） */
export function parseProbeTargets(value, warnings = []) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 8) return null
  const out = []
  const seen = new Set()
  for (const t of value) {
    if (!isPlainObject(t)) { warnings.push('probeTargets 项必须是对象'); return null }
    const { id, label, url, cls } = t
    if (typeof id !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(id)) { warnings.push('probeTargets.id 非法'); return null }
    if (seen.has(id)) { warnings.push(`probeTargets.id 重复：${id}`); return null }
    let u
    try { u = new URL(String(url)) } catch { warnings.push(`probeTargets.url 非法：${id}`); return null }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') { warnings.push(`probeTargets.url 协议必须是 http(s)：${id}`); return null }
    if (u.username || u.password) { warnings.push(`probeTargets.url 不得内嵌凭据：${id}`); return null }
    if (String(url).length > 2048) { warnings.push(`probeTargets.url 过长：${id}`); return null }
    seen.add(id)
    out.push({
      id,
      label: typeof label === 'string' && label.trim() !== '' ? label.trim().slice(0, 40) : id,
      url: u.toString(),
      cls: typeof cls === 'string' && cls.trim() !== '' ? cls.trim().slice(0, 40) : 'custom',
    })
  }
  return out
}
