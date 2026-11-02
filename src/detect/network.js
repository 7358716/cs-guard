/**
 * cs-guard — 网络分片坏检测
 *
 * 设计依据：v3 §12.1。生产环境实测症状：
 *  · 全站可达 ≠ 目标可达（GitHub 被重置、OpenAI 拒连、Gemini 超时）
 *  · 所以判据不能只测一个域名，必须**多目标分类**
 *
 * 纪律：**只上报，不自动改网络**（改代理/路由是高风险动作）
 *
 * @module cs-guard/detect/network
 */

/** 探测目标分类（每类一个代表，任一可达即该类健康） */
export const PROBE_TARGETS = Object.freeze([
  { id: 'dns-basic', label: '国内基础', url: 'https://www.baidu.com', cls: 'domestic' },
  { id: 'api-deepseek', label: 'DeepSeek API', url: 'https://api.deepseek.com', cls: 'model-api' },
  { id: 'npm-mirror', label: 'npm 镜像', url: 'https://registry.npmmirror.com', cls: 'package' },
  { id: 'github-api', label: 'GitHub API', url: 'https://api.github.com', cls: 'code-host' },
])

/**
 * 把探测结果归类成「分片坏」结论。
 * @param {Array<{id:string, ok:boolean, ms?:number, err?:string}>} results
 */
export function classifyNetwork(results = []) {
  const by = new Map(results.map((r) => [r.id, r]))
  const bad = []
  const ok = []
  for (const t of PROBE_TARGETS) {
    const r = by.get(t.id)
    if (!r) continue
    ;(r.ok ? ok : bad).push(t.id)
  }
  const verdict = bad.length === 0 ? 'healthy'
    : ok.length === 0 ? 'all-down'
    : 'partial'

  return {
    verdict,
    ok,
    bad,
    // 关键：给出「哪些能力受影响」而不是只报一个总数
    impact: bad.map((id) => {
      if (id === 'github-api') return '代码托管不可达（git 操作会失败，但对话不受影响）'
      if (id === 'api-deepseek') return '模型 API 不可达（可能导致全渠道失败）'
      if (id === 'npm-mirror') return '装包不可达'
      return '基础网络异常'
    }),
  }
}
