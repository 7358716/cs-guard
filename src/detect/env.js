/**
 * cs-guard — 环境健康检测（磁盘/内存/端口）
 *
 * 纪律：**只上报，不自动清理**（删除文件永远需要人工确认）
 *
 * @module cs-guard/detect/env
 */

/** 阈值（保守，避免误报） */
export const THRESHOLDS = Object.freeze({
  diskWarnPct: 85,
  diskCriticalPct: 95,
  memWarnPct: 85,
  memCriticalPct: 95,
})

/**
 * 判定磁盘水位。
 * @param {{totalBytes:number, freeBytes:number}} s
 */
export function assessDisk(s = {}) {
  const total = Number(s.totalBytes)
  const free = Number(s.freeBytes)
  if (!Number.isFinite(total) || !Number.isFinite(free) || total <= 0) {
    return { level: 'unknown', usedPct: null, advice: '无法读取磁盘信息' }
  }
  const usedPct = ((total - free) / total) * 100
  const level = usedPct >= THRESHOLDS.diskCriticalPct ? 'critical'
    : usedPct >= THRESHOLDS.diskWarnPct ? 'warn' : 'ok'
  return {
    level,
    usedPct: Number(usedPct.toFixed(1)),
    freeGB: Number((free / 1024 ** 3).toFixed(2)),
    advice: level === 'critical' ? '磁盘即将写满：会话日志可能写失败，建议清理'
      : level === 'warn' ? '磁盘使用偏高' : '正常',
  }
}

/** 判定内存水位 */
export function assessMemory(s = {}) {
  const total = Number(s.totalBytes)
  const free = Number(s.freeBytes)
  if (!Number.isFinite(total) || !Number.isFinite(free) || total <= 0) {
    return { level: 'unknown', usedPct: null, advice: '无法读取内存信息' }
  }
  const usedPct = ((total - free) / total) * 100
  const level = usedPct >= THRESHOLDS.memCriticalPct ? 'critical'
    : usedPct >= THRESHOLDS.memWarnPct ? 'warn' : 'ok'
  return {
    level,
    usedPct: Number(usedPct.toFixed(1)),
    advice: level === 'critical' ? '内存紧张：可能触发 OOM，建议重启后释放'
      : level === 'warn' ? '内存使用偏高' : '正常',
  }
}

/**
 * 判定内存整体健康状况。
 *
 * 🔴 教训（本机实测误报）：
 *    容器里 `Committed_AS` 必然大于 `CommitLimit`（实测 151%），
 *    因为它是**宿主所有进程**的承诺内存总和，不是容器的。
 *    **不能**用这个比值判危险 —— 会天天报假警。
 *
 * 正确判据（优先级递减）：
 *   ① `MemAvailable / MemTotal` —— 真正可用的内存比例（最可靠）
 *   ② `Committed_AS / CommitLimit` —— 仅作**辅助参考**，容器内放宽到 300%
 *   ③ 非 Linux（Windows/macOS）用 `os.totalmem/freemem`
 *
 * @param {{totalBytes?:number, freeBytes?:number, committedAS?:number, commitLimit?:number, inContainer?:boolean}} s
 */
export function assessMemoryHealth(s = {}) {
  const total = Number(s.totalBytes)
  const free = Number(s.freeBytes)
  const cas = Number(s.committedAS)
  const limit = Number(s.commitLimit)
  const inContainer = s.inContainer !== false   // 默认按容器处理（更宽松）

  if (!Number.isFinite(total) || !Number.isFinite(free) || total <= 0) {
    return { level: 'unknown', usedPct: null, advice: '无法读取内存信息', signals: [] }
  }

  const usedPct = ((total - free) / total) * 100
  const signals = []

  // 主判据：可用内存比例
  let level = 'ok'
  if (usedPct >= 95) level = 'critical'
  else if (usedPct >= 88) level = 'warn'
  signals.push(`可用内存 ${(100 - usedPct).toFixed(1)}%`)

  // 辅助判据：overcommit（容器内放宽）
  if (Number.isFinite(cas) && Number.isFinite(limit) && limit > 0) {
    const ratio = cas / limit
    const critRatio = inContainer ? 3.0 : 1.0
    const warnRatio = inContainer ? 2.0 : 0.9
    signals.push(`overcommit ${(ratio * 100).toFixed(0)}%${inContainer ? '（容器内正常偏高）' : ''}`)
    if (ratio >= critRatio && level === 'ok') level = 'warn'
  }

  return {
    level,
    usedPct: Number(usedPct.toFixed(1)),
    availableBytes: free,
    signals,
    advice: level === 'critical' ? '可用内存极低：可能触发 OOM，建议重启释放'
      : level === 'warn' ? '可用内存偏低：留意'
        : level === 'ok' ? '内存正常' : '无法判断',
  }
}

/**
 * 保留旧接口（兼容），但改为委托给 assessMemoryHealth。
 * @deprecated 用 assessMemoryHealth
 */
export function assessOvercommit(s = {}) {
  const h = assessMemoryHealth({
    totalBytes: Number(s.totalBytes) || 1,
    freeBytes: Number(s.freeBytes) || 1,
    committedAS: s.committedAS,
    commitLimit: s.commitLimit,
    inContainer: s.inContainer,
  })
  const cas = Number(s.committedAS)
  const limit = Number(s.commitLimit)
  const ratio = Number.isFinite(cas) && Number.isFinite(limit) && limit > 0 ? cas / limit : null
  return {
    level: h.level === 'critical' ? 'critical' : h.level === 'warn' ? 'warn' : 'ok',
    ratio: ratio === null ? null : Number(ratio.toFixed(2)),
    note: ratio === null ? '无法读取' : (ratio > 1 ? '容器内偏高属正常（Committed_AS 含宿主）' : '正常'),
    advice: h.advice,
  }
}
