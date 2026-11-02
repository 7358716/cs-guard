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
 * 判定 overcommit 风险（Linux 特有，v3 §12.1 的「卡死」根因）。
 * @param {{committedAS?:number, commitLimit?:number}} s
 */
export function assessOvercommit(s = {}) {
  const as = Number(s.committedAS)
  const limit = Number(s.commitLimit)
  if (!Number.isFinite(as) || !Number.isFinite(limit) || limit <= 0) {
    return { level: 'unknown', ratio: null, advice: '无法读取 overcommit 信息' }
  }
  const ratio = as / limit
  const level = ratio >= 1 ? 'critical' : ratio >= 0.9 ? 'warn' : 'ok'
  return {
    level,
    ratio: Number(ratio.toFixed(2)),
    advice: level === 'critical' ? 'overcommit 已超限：进程分配内存会直接失败（这是「卡死」的典型成因）'
      : level === 'warn' ? 'overcommit 接近上限' : '正常',
  }
}
