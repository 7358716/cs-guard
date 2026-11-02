/**
 * cs-guard — 看护设置页（浏览器半身）
 *
 * ⚠️ 必须用 window.__ModuleLoader__.load({id, factory}) 包装（不是裸 ESM）。
 * 契约见 cs-myfree/src/client.js 头部注释（同一套）。
 */
window.__ModuleLoader__.load({
  id: 'cs-guard',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')
    const h = react.createElement

    const FAULTS = [
      { key: 'network', label: '网络分片坏', desc: '多目标分类 + 影响面说明', act: '只上报' },
      { key: 'context', label: '对话质量退化', desc: '上下文水位 + 退化模板', act: '压缩后重试' },
      { key: 'env', label: '环境（磁盘/内存）', desc: '水位阈值', act: '只上报' },
      { key: 'overcommit', label: 'overcommit 卡死', desc: 'Committed_AS / CommitLimit', act: '请求重启' },
      { key: 'config', label: '配置错误', desc: 'patch 引用 / !!js / bundles', act: '只上报' },
    ]

    const RULES = [
      ['读日志/审计做诊断', '允许'],
      ['改自己插件配置', '允许（备份+审计）'],
      ['改全局 patch/profile', '禁止'],
      ['重启 DSH', '仅无活跃轮次 + 限速 10 分钟 + 每日≤3 次'],
      ['安装/升级依赖', '禁止'],
      ['删除/移动文件', '永远人工确认'],
    ]

    const styles = {
      root: { padding: '16px', fontFamily: 'inherit', fontSize: '13px', lineHeight: '1.6' },
      h2: { fontSize: '15px', fontWeight: 600, margin: '0 0 4px' },
      sub: { opacity: 0.65, margin: '0 0 16px', fontSize: '12px' },
      cardTitle: { fontWeight: 600, margin: '0 0 8px' },
      card: { border: '1px solid rgba(128,128,128,0.25)', borderRadius: '6px', padding: '10px', marginBottom: '8px' },
      row: { display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderBottom: '1px solid rgba(128,128,128,0.12)' },
      hint: { marginTop: '12px', padding: '8px', borderRadius: '6px', background: 'rgba(128,128,128,0.08)', fontSize: '11px', opacity: 0.8 },
      warn: { padding: '8px', borderRadius: '6px', background: 'rgba(200,80,80,0.1)', fontSize: '12px', marginTop: '8px' },
    }

    function CsGuardSection() {
      return h('div', { style: styles.root },
        h('div', { style: styles.h2 }, '看护 / 守护 · cs-guard'),
        h('div', { style: styles.sub }, 'v1.0.2 · 零第三方依赖 · 与 cs-myfree 完全独立，可单独安装'),

        h('div', { style: styles.cardTitle }, '五类故障'),
        h('div', null, FAULTS.map((f) => h('div', { key: f.key, style: styles.card },
          h('div', { style: { fontWeight: 600, marginBottom: '2px' } }, f.label),
          h('div', { style: { opacity: 0.7, fontSize: '11px' } }, f.desc),
          h('div', { style: { marginTop: '4px', fontSize: '11px' } }, '恢复方式：', f.act),
        ))),

        h('div', { style: { ...styles.cardTitle, marginTop: '16px' } }, '权限边界'),
        h('div', null, RULES.map(([k, v]) => h('div', { key: k, style: styles.row },
          h('span', { style: { fontWeight: 500 } }, k),
          h('span', { style: { opacity: 0.75, textAlign: 'right', marginLeft: '12px' } }, v),
        ))),

        h('div', { style: styles.warn },
          '⚠️ 本插件不会自动删除任何文件。重启受三重限制：无活跃轮次、最小间隔 10 分钟、每日最多 3 次。',
        ),
        h('div', { style: styles.hint },
          '提示：本版为只读展示。巡检与一键体检功能在后续版本接入宿主 API 后开放。',
        ),
      )
    }

    const inject = ['slots']

    function apply(ctx) {
      try {
        if (!ctx || !ctx.slots || typeof ctx.slots.inject !== 'function') return
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'cs-guard',
          order: 210,
          label: () => '看护',
        }, CsGuardSection))
      } catch (err) {
        try { console.warn('[cs-guard] 设置分节注册失败：', err && err.message) } catch {}
      }
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
