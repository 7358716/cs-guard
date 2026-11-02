/**
 * cs-guard — 设置界面（浏览器半身，单文件）
 *
 * 显示：五类故障状态、当前生效策略、最近巡检结论
 * 用自有 id `cs-guard`（不复用内置页 id）。
 *
 * @module cs-guard/client
 */

const NAME = 'cs-guard'

export const name = `${NAME}-client`
export const version = '0.2.0'

/** 设置页分区 */
export const SECTIONS = [
  { id: 'overview', label: '看护总览', desc: '五类故障一句话状态' },
  { id: 'network', label: '网络', desc: '分片坏检测与影响面' },
  { id: 'context', label: '对话质量', desc: '上下文水位与退化检测' },
  { id: 'env', label: '环境', desc: '磁盘 / 内存 / overcommit' },
  { id: 'config', label: '配置', desc: 'patch 引用与 bundles 一致性' },
  { id: 'repair', label: '恢复策略', desc: '重启限速与续跑规则' },
]

export function apply(ctx) {
  const slots = ctx?.slots
  if (!slots?.inject) return
  slots.inject('settings.section', () => ({
    id: `${NAME}-section`,
    name: `${NAME}-section`,
    label: '看护',
    order: 210,
    render: renderSettings,
  }))
}

export function renderSettings(state = {}) {
  return {
    title: '看护 / 守护',
    version,
    sections: SECTIONS.map((s) => ({ ...s, body: sectionBody(s.id, state) })),
  }
}

function sectionBody(id, s) {
  switch (id) {
    case 'overview':
      return {
        level: s.report?.level ?? 'unknown',
        summary: s.report?.summary ?? '尚未巡检',
        findings: s.report?.findings ?? [],
      }
    case 'network':
      return { verdict: s.network?.verdict ?? 'unknown', bad: s.network?.bad ?? [], impact: s.network?.impact ?? [] }
    case 'context':
      return { level: s.context?.level ?? 'unknown', inputTokens: s.context?.inputTokens ?? null, degenerate: s.context?.degenerate ?? false, advice: s.context?.advice ?? '' }
    case 'env':
      return { disk: s.disk ?? null, memory: s.memory ?? null, overcommit: s.overcommit ?? null }
    case 'config':
      return { problems: s.configProblems ?? [] }
    case 'repair':
      return {
        restart: { minIntervalMin: 30, maxPerDay: 3, requireNoActiveTurns: true },
        resume: { maxAttempts: 2, compactBeforeRetry: true },
        // 明确告知：删文件永不自动
        deletedFiles: '永不自动删除（需人工确认）',
      }
    default:
      return {}
  }
}

export function selfCheck() {
  return { ok: SECTIONS.length === 6, count: SECTIONS.length }
}
