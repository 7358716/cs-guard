/**
 * cs-guard — 配置预校验（在加载前发现语法/引用错误）
 *
 * 纪律：**只上报，不自动改配置**（改配置是高风险动作）
 *
 * @module cs-guard/detect/config
 */

/**
 * 检查 patch 是否引用了不存在的本地包。
 *
 * ⚠️ 判据看 **name**（真正被 import 的包名），不是 id：
 *    官方行常见 `id: agent-team` + `name: '@deepseek-ai/...'`，
 *    只看 id 会把官方行误报成「无法解析」。
 */
export function checkPatchRefs(patchText, resolveFn) {
  const problems = []
  const lines = String(patchText ?? '').split('\n')
  for (let i = 0; i < lines.length; i++) {
    // 🔴 v1.8.0 修复（真实 profile 误报）：只认**顶层 patch 条目**的 id
    //    （缩进 0，或 `- insert:` 下的条目缩进 ≤4）。
    //    旧实现匹配任意缩进的 `id:`，把插件 config 里的业务键当成包引用：
    //    实测 profile 的 cs-myfree 配置里 `lanes: - id: free  name: 免费车道`
    //    被误报成「patch 引用了无法解析的包: 免费车道」。
    const lead = /^(\s*)/.exec(lines[i])[1].length
    if (lead > 4) continue
    const idm = /^\s*-?\s*(?:insert:\s*)?(?:-\s*)?id:\s*([^\s#]+)/.exec(lines[i])
    if (!idm) continue
    const id = idm[1].trim()
    // 向后最多看 3 行找 name
    let name = id
    for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
      const nm = /^\s*name:\s*['"]?([^'"\s#]+)/.exec(lines[j])
      if (nm) { name = nm[1].trim(); break }
    }
    if (name.startsWith('@deepseek-ai/')) continue     // 官方包，宿主提供
    let ok = false
    try { ok = resolveFn ? Boolean(resolveFn(name)) : true } catch { ok = false }
    if (!ok) problems.push(`patch 引用了无法解析的包: ${name}（id=${id}）`)
  }
  return { ok: problems.length === 0, problems }
}

/** 检查 YAML 里是否误用了 !!js 标签（安全风险） */
export function checkJsTags(patchText) {
  const hits = []
  const lines = String(patchText ?? '').split('\n')
  lines.forEach((l, i) => { if (/!!js/.test(l)) hits.push({ line: i + 1, text: l.trim() }) })
  return { ok: hits.length === 0, hits }
}

/** 检查 profile bundles 与实际依赖是否一致 */
export function checkBundleConsistency(bundles = [], deps = {}) {
  const problems = []
  for (const b of bundles) {
    if (b.startsWith('@deepseek-ai/')) continue
    if (!(b in deps)) problems.push(`bundles 里有 ${b} 但 dependencies 缺失`)
  }
  return { ok: problems.length === 0, problems }
}
