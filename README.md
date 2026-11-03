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
| **网络分片坏** | 多目标分类（国内基础 / 模型 API / npm / GitHub；支持自定义目标+超时） | 只上报 + 影响面说明 |
| **对话质量退化** | 上下文水位 + 退化模板词库 | 压缩后重试（原样重试会再退化） |
| **环境（磁盘/内存）** | `fs.statfs` 磁盘水位 + 跨平台内存/overcommit | 只上报（删文件永不自动） |
| **overcommit 卡死** | `Committed_AS / CommitLimit` | 进程外 supervisor 请求重启 |
| **配置错误** | profile `package.json` / `cordis.patch.yml` / bundles / `!!js` / 本插件 config 损坏 | 只上报 |
| **对话中断** | 真实 `turn/end.reason`（completed/error/interrupted/max-tokens/aborted） | 决策 API：压缩 / 重试 / 交人 |

## HTTP API（设置页数据源）

全部走本地安全围栏：回环+localhost 直连放行；其余**委托宿主 `connection` 服务做真实会话校验**
（HMAC 签名 + 可信 Host），拿不到校验能力时 fail-closed。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/cs-guard/health` | 健康检查 |
| GET | `/cs-guard/state` | 当前配置/目标/阈值 |
| POST | `/cs-guard/diag` | 一键体检（网络/磁盘/内存/配置，探测并行） |
| GET | `/cs-guard/config` | 读配置（脱敏，带 `configError`） |
| POST | `/cs-guard/config` | 写配置（白名单+范围校验；损坏文件先备份；凭据类字段拒绝） |
| GET/POST | `/cs-guard/resume` | 对话中断续跑决策（压缩/重试/交人） |

## 三条设计纪律

1. **只检测 + 上报 + 受限恢复**，不碰 `agent/request-error` 与 `llm/stream`（已被占满，碰了必然静默失效）
2. **重启复用现有 `dsh-restart-guard` 通道**，不另造 PM2/cron
3. **删文件永远人工确认**，本插件不做

## 安全边界

- UI/API 只回**掩码**；凭据类字段一律拒绝写入（无凭据落盘）
- 配置文件 `~/.dsh/cs-guard/config.json` 原子写，目录 `0700` / 文件 `0600`；损坏文件先备份再覆盖
- 日志与错误统一脱敏（URL userinfo / token / Bearer / sk-*）
- 路由围栏**不再**按 `dsh-auth-` cookie 名字放行（v1.7.0 可被伪造 cookie 绕过）

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
npm test            # 190 项单测/集成测试（含真实 HTTP API、认证围栏、逐面板渲染）
npm run test:static # 结构自检
```

## v1.8.0 修复（故障注入实测驱动）

- **安全**：路由围栏改为委托宿主 `connection` 服务真实校验 —— 修复「伪造 `dsh-auth-*` cookie 即可读写配置」的认证绕过（生产公网入口实测 200 ⇒ 修复后 401/403）。
- **检测**：`/diag` 补上磁盘与 profile 配置检查（原先配置页永远 ✅、环境页磁盘永远没数据）。
- **准确**：partial 网络不再显示「全部通过」；自定义探测目标参与分类；并行探测（断网等待从 N×timeout 降到 ~1×timeout）。
- **健壮**：启动配置类型错误安全降级（不再 POST /config 500）；非对象/越界/凭据类配置拒绝落盘；损坏 config 先备份。
- **对话中断**：按真实 `turn/end.reason` 修正决策 —— `max-tokens` ⇒ 压缩重试、用户主动 `aborted` ⇒ 交人、凭据/适配器/权限类 error ⇒ 交人；新增 `/resume` 决策接口与设置页面板。
- **可观测**：插件 apply 抛错时除宿主 logger 外再兜底 `console.error`，不再「静默降级」。

## 许可

MIT
