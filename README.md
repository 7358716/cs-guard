# cs-guard

> 看护 / 守护（DSH 插件）· 零第三方依赖 · 可独立安装使用

**与 cs-myfree 完全独立**：可单独安装、单独工作，不依赖对方。

## 安装

```bash
dsh plugin --profile <name> add github:7358716/cs-guard
```

## 管什么

| 故障类 | 检测方式 | 恢复方式 |
|---|---|---|
| **网络分片坏** | 多目标分类（国内基础 / 模型 API / npm / GitHub） | 只上报 + 影响面说明 |
| **对话质量退化** | 上下文水位 + 退化模板词库 | 压缩后重试（原样重试会再退化） |
| **环境（磁盘/内存）** | 水位阈值 | 只上报（删文件永不自动） |
| **overcommit 卡死** | `Committed_AS / CommitLimit` | 进程外 supervisor 请求重启 |
| **配置错误** | patch 引用 / `!!js` 标签 / bundles 一致性 | 只上报 |

## 三条设计纪律

1. **只检测 + 上报 + 受限恢复**，不碰 `agent/request-error` 与 `llm/stream`（已被占满，碰了必然静默失效）
2. **重启复用现有 `dsh-restart-guard` 通道**，不另造 PM2/cron
3. **删文件永远人工确认**，本插件不做

## 为什么要有进程外 supervisor

进程内检测器在 `overcommit 卡死` 时**自己也卡死**，救不了自己。
根因：Docker cgroup 的 `memory.max` 先撞 `CommitLimit` ⇒ 内核返回 ENOMEM ⇒
进程分配内存失败但**没被 OOM killer 杀掉** ⇒ 表现为「活着但不响应」。

## 权限收窄

| 动作 | 判定 |
|---|---|
| 读日志/审计做诊断 | ✅ 允许 |
| 改自己所属插件配置 | ✅ 允许（自动备份 + 审计） |
| 改全局 patch/profile | ❌ 禁止 |
| 重启 DSH | ⚠️ 仅无活跃轮次 + 限速（10 分钟）+ 每日上限 3 次 |
| 安装/升级依赖 | ❌ 禁止 |
| 删除/移动文件 | ❌ **永远人工确认** |

## 验证

```bash
npm test            # 57 项单元测试
npm run test:static
```

## 许可

MIT
