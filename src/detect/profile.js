/**
 * cs-guard — 宿主 profile 配置预检（环境/配置故障检测）
 *
 * 真实故障场景（本机踩过）：
 *   · profile 的 package.json 被写坏 ⇒ 宿主**根本起不来**，必须提前报告；
 *   · cordis.patch.yml 引用了没安装的包 / 误用 `!!js` ⇒ 加载期报错；
 *   · bundles 里列了包但 dependencies 没装 ⇒ 启动被 skip。
 *
 * 纪律：**只读 + 只上报**，不修改宿主任何配置文件。
 *
 * @module cs-guard/detect/profile
 */

import { join } from 'node:path'
import { createRequire } from 'node:module'
import { checkPatchRefs, checkJsTags, checkBundleConsistency } from './config.js'

export const DEFAULT_PROFILE = 'web'
const MAX_FILE_BYTES = 512 * 1024

/**
 * 探测当前 profile 名（env → argv `--profile` → 默认 web）。
 * @param {{argv?:string[], env?:object}} [o]
 */
export function detectProfileName({ argv = process.argv, env = process.env } = {}) {
  try {
    const fromEnv = env?.DSH_PROFILE
    if (typeof fromEnv === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(fromEnv)) return fromEnv
    const i = argv.indexOf('--profile')
    if (i >= 0 && typeof argv[i + 1] === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(argv[i + 1])) return argv[i + 1]
  } catch { /* ignore */ }
  return DEFAULT_PROFILE
}

/** 用 profile 自己的 node_modules 解析包名（判断 patch 引用是否真的装得上） */
export function makeResolver(profileDir) {
  return function resolveFn(name) {
    try {
      const req = createRequire(join(profileDir, 'package.json'))
      req.resolve(name)
      return true
    } catch {
      return false
    }
  }
}

/**
 * 读取 profile 配置并做结构检查。
 *
 * @param {object} o
 * @param {string} [o.dshHome]
 * @param {string} [o.profileName]
 * @param {(p:string)=>Promise<string>} [o.readFileImpl]
 * @param {(name:string)=>boolean} [o.resolveFn]
 * @returns {Promise<{profileName:string, profileDir:string, checks:Array, findings:Array, patchText:string|null, packageData:object|null}>}
 */
export async function inspectProfile({ dshHome, profileName = DEFAULT_PROFILE, readFileImpl, resolveFn } = {}) {
  const home = dshHome || process.env.DSH_HOME || join(process.env.HOME || '.', '.dsh')
  const profileDir = join(home, 'profiles', profileName)
  const read = readFileImpl ?? (async (p) => {
    const fs = await import('node:fs/promises')
    const st = await fs.stat(p)
    if (st.size > MAX_FILE_BYTES) throw new Error('文件过大，跳过读取')
    return fs.readFile(p, 'utf8')
  })

  const checks = []
  const findings = []
  const out = { profileName, profileDir, checks, findings, patchText: null, packageData: null }
  const addCheck = (name, ok, detail) => checks.push({ name, ok, detail })
  const addFinding = (detail) => findings.push({ type: 'config', level: 'warn', detail })

  // ① package.json
  let pkg = null
  try {
    const text = await read(join(profileDir, 'package.json'))
    try { pkg = JSON.parse(text) } catch (e) {
      addCheck('profile package.json', false, `JSON 损坏：${e?.message ?? e}`)
      addFinding(`profile(${profileName}) package.json JSON 损坏：${e?.message ?? e}`)
    }
  } catch (e) {
    const code = e?.code ?? ''
    addCheck('profile package.json', false, code === 'ENOENT' ? '找不到 profile package.json' : `读取失败：${code || e?.message || e}`)
    addFinding(`profile(${profileName}) package.json 不可读（${code || e?.message || e}）`)
  }
  if (pkg) {
    out.packageData = pkg
    const bundles = Array.isArray(pkg?.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles : null
    const deps = pkg?.dependencies && typeof pkg.dependencies === 'object' ? pkg.dependencies : {}
    addCheck('profile package.json', true, `JSON 可解析（${bundles ? bundles.length + ' 个 bundle' : '无 bundles'}）`)
    if (!bundles) {
      addCheck('profile package.json', false, '缺少 dsh.profile.bundles')
      addFinding(`profile(${profileName}) package.json 缺少 dsh.profile.bundles`)
    } else {
      const b = checkBundleConsistency(bundles, deps)
      addCheck('bundles 一致性', b.ok, b.ok ? `${bundles.length} 个 bundle 均有依赖声明` : b.problems.join('；'))
      if (!b.ok) addFinding(b.problems.join('；'))
    }
  }

  // ② cordis.patch.yml
  let patchText = null
  try {
    patchText = await read(join(profileDir, 'cordis.patch.yml'))
    out.patchText = patchText
  } catch (e) {
    const code = e?.code ?? ''
    if (code !== 'ENOENT') addFinding(`profile(${profileName}) cordis.patch.yml 读取失败：${code || e?.message || e}`)
    addCheck('cordis.patch.yml', null, code === 'ENOENT' ? '未找到（使用默认 patch）' : '读取失败')
  }
  if (typeof patchText === 'string') {
    addCheck('cordis.patch.yml', true, `可读（${patchText.split('\n').length} 行）`)
    const js = checkJsTags(patchText)
    addCheck('patch !!js 标签', js.ok, js.ok ? '未发现 !!js' : `第 ${js.hits[0].line} 行含 !!js（安全风险）`)
    if (!js.ok) addFinding(`profile(${profileName}) cordis.patch.yml 含 !!js 标签（第 ${js.hits[0].line} 行）`)

    const resolver = resolveFn ?? makeResolver(profileDir)
    const refs = checkPatchRefs(patchText, resolver)
    addCheck('patch 引用解析', refs.ok, refs.ok ? '所有非官方引用均可解析' : refs.problems.join('；'))
    if (!refs.ok) addFinding(`profile(${profileName}) ${refs.problems.join('；')}`)
  }

  return out
}
