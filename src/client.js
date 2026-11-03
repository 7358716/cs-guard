/**
 * cs-guard — Guard 看护界面（浏览器半身，完整交互版）
 *
 * ⚠️ 必须用 window.__ModuleLoader__.load({id, factory}) 包装（不是裸 ESM）。
 */
window.__ModuleLoader__.load({
  id: 'cs-guard',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')
    const h = react.createElement
    const API = '/cs-guard'

    const S = {
      root: { padding: '16px', fontFamily: 'inherit', fontSize: '13px', lineHeight: '1.6' },
      h2: { fontSize: '15px', fontWeight: 600, margin: '0 0 4px' },
      sub: { opacity: 0.65, margin: '0 0 14px', fontSize: '12px' },
      card: { border: '1px solid rgba(128,128,128,0.25)', borderRadius: '8px', padding: '12px 14px', marginBottom: '12px', background: 'rgba(128,128,128,0.04)' },
      row: { display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderBottom: '1px solid rgba(128,128,128,0.12)' },
      tabs: { display: 'flex', flexWrap: 'wrap', gap: '4px', marginBottom: '14px', borderBottom: '1px solid rgba(128,128,128,0.2)', paddingBottom: '8px' },
      tab: (on) => ({ cursor: 'pointer', padding: '3px 10px', borderRadius: '5px', fontSize: '12px', fontWeight: on ? 600 : 400, background: on ? 'rgba(128,128,128,0.18)' : 'transparent', border: '1px solid ' + (on ? 'rgba(128,128,128,0.4)' : 'transparent') }),
      btn: (primary) => ({ cursor: 'pointer', fontSize: '12px', padding: '3px 12px', borderRadius: '5px', border: '1px solid rgba(128,128,128,0.4)', background: primary ? 'rgba(64,160,96,0.18)' : 'transparent', color: 'inherit', fontWeight: primary ? 600 : 400 }),
      dim: { opacity: 0.65, fontSize: '11px' },
      bomb: { border: '1px solid rgba(200,80,80,0.5)', borderRadius: '8px', padding: '10px 12px', marginBottom: '12px', background: 'rgba(200,80,80,0.06)' },
    }

    const TABS = [
      { key: 'overview', label: '总览' },
      { key: 'network', label: '网络' },
      { key: 'context', label: '对话质量' },
      { key: 'env', label: '环境' },
      { key: 'config', label: '配置' },
      { key: 'repair', label: '恢复策略' },
    ]

    const FAULTS = [
      { key: 'network', label: '网络分片坏', desc: '多目标分类 + 影响面', act: '只上报' },
      { key: 'context', label: '对话质量退化', desc: '上下文水位 + 退化模板', act: '压缩后重试' },
      { key: 'env', label: '环境（磁盘/内存）', desc: '水位阈值', act: '只上报' },
      { key: 'overcommit', label: 'overcommit 卡死', desc: 'Committed_AS / CommitLimit', act: '请求重启' },
      { key: 'config', label: '配置错误', desc: 'patch 引用 / !!js / bundles', act: '只上报' },
    ]

    const RULES = [
      ['读日志/审计做诊断', '允许'],
      ['改自己插件配置', '允许（备份+审计）'],
      ['改全局 patch/profile', '禁止'],
      ['重启 DSH', '仅无活跃轮次 + 限速 10 分钟 + 每日 ≤3 次'],
      ['安装/升级依赖', '禁止'],
      ['删除/移动文件', '永远人工确认'],
    ]

    function api(path, opts) {
      return fetch(API + path, Object.assign({ credentials: 'same-origin', headers: { 'content-type': 'application/json' } }, opts || {}))
        .then(async (r) => {
          const t = await r.text().catch(() => '')
          if (!r.ok) throw new Error('HTTP ' + r.status + (t ? ' — ' + t.slice(0, 160) : ''))
          try { return JSON.parse(t) } catch { throw new Error('响应非 JSON') }
        })
    }

    function KV(props) {
      return h('div', { style: S.row },
        h('span', { style: { fontWeight: 500 } }, props.k),
        h('span', { style: Object.assign({ textAlign: 'right', marginLeft: '12px' }, props.dim ? S.dim : null) }, props.v))
    }

    // ── 错误边界（关键：一个分区崩了不能拖垮整页 → 白屏）──
    class ErrorBoundary extends react.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }
      static getDerivedStateFromError(error) { return { error: error } }
      componentDidCatch(error, info) {
        try { console.error('[cs-guard] 分区渲染失败：', (error && error.message) || error, info) } catch (_) {}
      }
      render() {
        if (this.state.error) {
          const err = this.state.error
          return h('div', {
            style: {
              border: '1px solid rgba(200,80,80,0.5)', borderRadius: '8px',
              padding: '12px 14px', background: 'rgba(200,80,80,0.06)',
            },
          },
            h('div', { style: { fontWeight: 600, color: 'var(--dsw-alias-state-error-primary)' } },
              '这个分区渲染失败了（其它分区不受影响）'),
            h('div', { style: { marginTop: '6px', fontSize: '11px', fontFamily: 'ui-monospace, monospace', opacity: 0.8 } },
              String((err && err.message) || err)),
            h('div', { style: { marginTop: '8px', fontSize: '11px', opacity: 0.65 } },
              '可以把这段错误发我。点其它标签页仍可使用。'))
        }
        return this.props.children
      }
    }

    function Safe(props) {
      return h(ErrorBoundary, null, h(props.View))
    }

    // ── 可编辑配置 ──
    function ConfigEditor(props) {
      const [cfg, setCfg] = react.useState(null)
      const [msg, setMsg] = react.useState(null)
      const [busy, setBusy] = react.useState(false)
      const [tick, setTick] = react.useState(0)

      react.useEffect(() => {
        api('/config')
          .then((d) => setCfg((d && d.config) || {}))
          .catch((e) => setMsg({ ok: false, error: String((e && e.message) || e) }))
      }, [tick])

      if (!cfg) return h('div', { style: S.dim }, msg ? msg.error : '加载配置…')

      const setPath = (path, v) => setCfg((c) => {
        const next = JSON.parse(JSON.stringify(c || {}))
        let cur = next
        for (let i = 0; i < path.length - 1; i++) { if (!cur[path[i]]) cur[path[i]] = {}; cur = cur[path[i]] }
        cur[path[path.length - 1]] = v
        return next
      })
      const val = (path) => path.reduce((o, k) => (o == null ? undefined : o[k]), cfg)

      const save = () => {
        setBusy(true); setMsg(null)
        api('/config', { method: 'POST', body: JSON.stringify(cfg) })
          .then((r) => setMsg(r.ok ? { ok: true, text: r.hint } : { ok: false, error: r.error }))
          .catch((e) => setMsg({ ok: false, error: String((e && e.message) || e) }))
          .then(() => setBusy(false))
      }

      return h('div', null,
        (props.fields || []).map((f) => h('div', { key: f.path.join('.'), style: { marginBottom: '10px' } },
          h('div', { style: { fontWeight: 500, marginBottom: '3px' } }, f.label),
          f.hint ? h('div', { style: Object.assign({ marginBottom: '4px' }, S.dim) }, f.hint) : null,
          f.type === 'bool'
            ? h('label', { style: { display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' } },
                h('input', { type: 'checkbox', checked: val(f.path) === true, onChange: (e) => setPath(f.path, e.target.checked) }),
                h('span', { style: S.dim }, val(f.path) === true ? '已开启' : '已关闭'))
            : h('input', {
                type: f.type === 'number' ? 'number' : 'text',
                style: Object.assign({}, S.input, f.type === 'number' ? { width: '180px' } : {}),
                value: val(f.path) == null ? '' : val(f.path),
                onChange: (e) => setPath(f.path, f.type === 'number' ? Number(e.target.value) : e.target.value),
              }))),
        h('div', { style: { display: 'flex', gap: '8px', marginTop: '12px' } },
          h('button', { style: S.btn(true), onClick: save, disabled: busy }, busy ? '保存中…' : '保存'),
          h('button', { style: S.btn(false), onClick: () => { setCfg(null); setMsg(null); setTick((n) => n + 1) } }, '重新加载')),
        msg ? h('div', { style: Object.assign({ marginTop: '10px' }, S.card, { borderColor: msg.ok ? 'rgba(64,160,96,0.5)' : 'rgba(200,80,80,0.5)' }) },
          h('div', { style: { fontWeight: 600 } }, msg.ok ? '✅ 已保存' : '❌ 保存失败'),
          h('div', { style: S.dim }, msg.text || msg.error || '')) : null,
      )
    }

    // ── 总览（一键体检）──
    function OverviewTab() {
      const [res, setRes] = react.useState(null)
      const [busy, setBusy] = react.useState(false)
      const run = () => {
        setBusy(true); setRes(null)
        api('/diag', { method: 'POST', body: JSON.stringify({}) })
          .then((r) => setRes(r))
          .catch((e) => setRes({ ok: false, summary: String((e && e.message) || e), checks: [] }))
          .then(() => setBusy(false))
      }
      return h('div', null,
        h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '10px' } },
          h('button', { style: S.btn(true), onClick: run, disabled: busy }, busy ? '体检中…' : '一键体检'),
          h('span', { style: S.dim }, '真实探测网络（4 个目标）+ 读内存/overcommit')),
        res ? h('div', { style: S.card },
          h('div', { style: { fontWeight: 600, marginBottom: '8px' } }, (res.ok ? '✅ ' : '❌ ') + (res.summary || '')),
          (res.checks || []).map((c, i) => h('div', { key: i, style: S.row },
            h('span', null, (c.ok === true ? '✅ ' : c.ok === false ? '❌ ' : '⏸ ') + c.name),
            h('span', { style: Object.assign({ textAlign: 'right', marginLeft: '12px' }, S.dim) }, String(c.detail || ''))))) : null)
    }

    // ── 网络 ──
    function NetworkTab() {
      const [res, setRes] = react.useState(null)
      const [busy, setBusy] = react.useState(false)
      const run = () => {
        setBusy(true); setRes(null)
        api('/diag', { method: 'POST', body: JSON.stringify({}) })
          .then((r) => setRes(r)).catch((e) => setRes({ error: String((e && e.message) || e) }))
          .then(() => setBusy(false))
      }
      return h('div', null,
        h('button', { style: S.btn(true), onClick: run, disabled: busy }, busy ? '探测中…' : '探测网络'),
        res && res.network ? h('div', { style: Object.assign({ marginTop: '10px' }, S.card) },
          h('div', { style: { fontWeight: 600, marginBottom: '6px' } },
            res.network.verdict === 'healthy' ? '✅ 全部可达' : res.network.verdict === 'partial' ? '⚠️ 分片损坏' : '❌ 全部不可达'),
          (res.network.results || []).map((r) => h('div', { key: r.id, style: S.row },
            h('span', null, (r.ok ? '✅ ' : '❌ ') + r.id),
            h('span', { style: Object.assign({ textAlign: 'right' }, S.dim) },
              r.ok ? (r.ms + 'ms  HTTP ' + r.http) : (r.error || '失败')))),
          (res.network.impact || []).length
            ? h('div', { style: Object.assign({ marginTop: '8px' }, S.dim) }, res.network.impact.map((x, i) => h('div', { key: i }, '· ' + x)))
            : null)
          : res && res.error ? h('div', { style: S.bomb }, res.error) : null)
    }

    // ── 对话质量 ──
    function ContextTab() {
      return h('div', { style: S.card },
        h('div', { style: { fontWeight: 600, marginBottom: '6px' } }, '上下文退化检测'),
        h(KV, { k: '预警水位', v: '250,000 tokens' }),
        h(KV, { k: '危险水位', v: '320,000 tokens' }),
        h(KV, { k: '退化模板', v: '5 组（中英文）' }),
        h('div', { style: Object.assign({ marginTop: '10px' }, S.dim) },
          '事故来源：实测某会话在 285k tokens 后连续 14 次输出「作为一个人工智能语言模型…」。' +
          '这不是会话损坏，是长上下文退化。检测到即「压缩后重试」，不是原样重试。'))
    }

    // ── 环境 ──
    function EnvTab() {
      const [res, setRes] = react.useState(null)
      const [busy, setBusy] = react.useState(false)
      const run = () => {
        setBusy(true); setRes(null)
        api('/diag', { method: 'POST', body: JSON.stringify({}) })
          .then((r) => setRes(r)).catch((e) => setRes({ error: String((e && e.message) || e) }))
          .then(() => setBusy(false))
      }
      const checks = (res && res.checks || []).filter((c) => /内存|overcommit/.test(c.name))
      return h('div', null,
        h('button', { style: S.btn(true), onClick: run, disabled: busy }, busy ? '读取中…' : '读取环境'),
        checks.length ? h('div', { style: Object.assign({ marginTop: '10px' }, S.card) },
          checks.map((c, i) => h(KV, { key: i, k: (c.ok === true ? '✅ ' : c.ok === false ? '❌ ' : '⏸ ') + c.name, v: String(c.detail || '') })))
          : res && res.error ? h('div', { style: S.bomb }, res.error) : null)
    }

    // ── 配置 ──
    function ConfigTab() {
      const [res, setRes] = react.useState(null)
      const [busy, setBusy] = react.useState(false)
      const run = () => {
        setBusy(true); setRes(null)
        api('/diag', { method: 'POST', body: JSON.stringify({}) })
          .then((r) => setRes(r)).catch((e) => setRes({ error: String((e && e.message) || e) }))
          .then(() => setBusy(false))
      }
      const cfg = (res && res.report && res.report.findings || []).filter((f) => f.type === 'config')
      return h('div', null,
        h('button', { style: S.btn(true), onClick: run, disabled: busy }, busy ? '检查中…' : '检查配置'),
        res ? h('div', { style: Object.assign({ marginTop: '10px' }, S.card) },
          cfg.length === 0
            ? h('div', { style: { color: 'var(--dsw-alias-state-success-primary)' } }, '✅ 未发现配置问题')
            : cfg.map((f, i) => h('div', { key: i, style: S.bomb }, f.detail)))
          : null)
    }

    // ── 恢复策略（可编辑）──
    function RepairTab() {
      return h('div', null,
        h('div', { style: S.card },
          h('div', { style: { fontWeight: 600, marginBottom: '8px' } }, '重启限制'),
          h(ConfigEditor, { fields: [
            { path: ['restart', 'minIntervalMs'], label: '最小间隔（毫秒）', type: 'number', hint: '600000 = 10 分钟' },
            { path: ['restart', 'maxPerDay'], label: '每日最多重启次数', type: 'number' },
            { path: ['restart', 'consecutiveBreaches'], label: '连续越线几次才动手', type: 'number', hint: '防抖，避免误判' },
            { path: ['restart', 'requireNoActiveTurns'], label: '有活跃对话时禁止重启', type: 'bool' },
          ] })),
        h('div', { style: S.card },
          h('div', { style: { fontWeight: 600, marginBottom: '8px' } }, '续跑规则'),
          h(ConfigEditor, { fields: [
            { path: ['resume', 'maxAttempts'], label: '最大续跑次数', type: 'number' },
            { path: ['resume', 'compactBeforeRetry'], label: '退化时先压缩再重试', type: 'bool', hint: '关掉会重复得到退化输出' },
          ] })),
        h('div', { style: S.card },
          h('div', { style: { fontWeight: 600, marginBottom: '8px' } }, '检测阈值'),
          h(ConfigEditor, { fields: [
            { path: ['context', 'warnTokens'], label: '上下文预警水位（tokens）', type: 'number' },
            { path: ['context', 'criticalTokens'], label: '上下文危险水位（tokens）', type: 'number' },
          ] })),
        h('div', { style: S.card },
          h('div', { style: { fontWeight: 600, marginBottom: '8px' } }, '监控开关'),
          h(ConfigEditor, { fields: [
            { path: ['watch', 'network'], label: '网络监控', type: 'bool' },
            { path: ['watch', 'context'], label: '对话质量监控', type: 'bool' },
            { path: ['watch', 'env'], label: '环境监控', type: 'bool' },
            { path: ['watch', 'overcommit'], label: 'overcommit 监控', type: 'bool' },
            { path: ['watch', 'config'], label: '配置监控', type: 'bool' },
          ] })),
        h('div', { style: { border: '1px solid rgba(200,80,80,0.5)', borderRadius: '8px', padding: '10px 12px', background: 'rgba(200,80,80,0.06)' } },
          h('div', { style: { fontWeight: 600 } }, '⚠️ 安全边界（不可修改）'),
          h('div', { style: Object.assign({ marginTop: '4px' }, S.dim) },
            '本插件永远不会自动删除或移动文件。重启请求还需同时满足：无活跃对话 + 未触发限速 + 未超每日上限。')),
      )
    }

    const VIEWS = { overview: OverviewTab, network: NetworkTab, context: ContextTab, env: EnvTab, config: ConfigTab, repair: RepairTab }

    function GuardSection() {
      const [tab, setTab] = react.useState('overview')
      const View = VIEWS[tab] || OverviewTab
      return h('div', { style: S.root },
        h('div', { style: S.h2 }, 'Guard'),
        h('div', { style: S.sub }, '看护 / 守护 · 零第三方依赖 · 与 Myfree 完全独立，可单独安装'),
        h('div', { style: S.card },
          h('div', { style: { fontWeight: 600, marginBottom: '6px' } }, '监控的五类故障'),
          FAULTS.map((f) => h('div', { key: f.key, style: S.row },
            h('span', null, f.label + h('span', { style: Object.assign({ marginLeft: '6px' }, S.dim) }, f.desc)),
            h('span', { style: S.dim }, f.act)))),
        h('div', { style: S.tabs }, TABS.map((t) => h('span', {
          key: t.key, style: S.tab(tab === t.key), onClick: () => setTab(t.key),
        }, t.label))),
        h(Safe, { View: View }))
    }

    const inject = ['slots']

    function apply(ctx) {
      try {
        if (!ctx || !ctx.slots || typeof ctx.slots.inject !== 'function') return
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section', id: 'cs-guard', order: 210, label: () => 'Guard',
        }, GuardSection))
      } catch (err) {
        try { console.warn('[cs-guard] 设置分节注册失败：', (err && err.message) || err) } catch (_) {}
      }
    }

    exports.apply = apply
    exports.inject = inject
    exports.GuardSection = GuardSection
    exports.TABS = TABS
    exports.ErrorBoundary = ErrorBoundary
    exports.Safe = Safe
    return module.exports
  },
})
