# code-orchestrator 设计 v2：项目为一等公民 · 容器化执行 · 资源感知调度

版本：v2（2026-07-06）
状态：grill 定稿（11 问），进入分阶段实现
关系：本文是对 `design.md` 的增量，聚焦「弱化文件夹、项目=完整系统、多设备、NPU/GPU 依赖管理」。M1 垂直切片仍以 `design.md` 为准。

---

## 0. 一句话

把「项目」从 forge+repo 策略容器，升成**一等逻辑实体**：它在多台机器上**按需就地物化**，agent 在 **co 拥有的容器**里干活，卡在 `docker run` 时绑定，依赖用**按版本激活的插件**管理，memory 是 **agent 后端的原生文件**由 co 跨机同步。用户只提任务、不挑机器。

---

## 1. 十一条决议（grill 结论）

| # | 决议 | 关键取舍 |
|---|---|---|
| Q1 | **项目 = 逻辑实体（Postgres 为真相）+ 按机器就地物化（B）** | 不钉死一台机；根目录降级为每机缓存，坏了重物化 |
| Q2 | **agent 跑在执行环境内（模型①），substrate = 容器** | 就地读代码/看日志/dump/profiling；卡在建容器时绑定 |
| Q3 | **co 主动拥有并启动容器（A），按会话粒度** | 卡预留 = 容器生命周期；worktree 隔离 = 容器隔离 |
| Q4 | **资源 = 通用设备模型 + 每 kind 适配器 + Postgres 预留账本** | v1 机器粒度（见 Q11）；Ascend 首个适配器 |
| Q5 | **memory = 后端原生文件，co 只做 git 同步 + 物化** | Claude Code：`CLAUDE.md`＋`~/.claude/…/memory`；后端=适配器 |
| Q6 | **每机声明数据盘根；项目根 = 容器内稳定 `/workspace`** | 用户不碰宿主机物理路径；co 托管卷布局 |
| Q7 | **依赖 = 薄 base 镜像 + 按版本激活的 EnvComponent** | 不进镜像、数据盘按版本缓存；版本每 run 选、默认取项目 |
| Q8 | **插件机制：类型化扩展点 + 两层（系统级 / 项目自带）** | 领域插件=声明式+沙箱脚本、住项目仓、不进 co-server |
| Q9 | **调度 = 黏性 + 溢出；没资源排队（FIFO）** | 优先热机；付一次冷物化才溢出；训练不因暂时没卡失败 |
| Q10 | **密钥 v1 环境变量注入（forge + LLM）** | 简单优先；短期 scoped token 留作后路 |
| Q11 | **v1 单机 + 一机一任务（机器粒度分配）** | 多机分布式 / 多任务共享卡 = v2；预留账本退化成机器 busy/free |

---

## 2. 分层架构

```
项目（Project，Postgres 真相）
  ├─ 身份：forge+repo、薄 base 镜像、加速器需求 {kind}、默认工作流、默认组件版本
  ├─ memory：中心 bare git 仓（co-server 托管）
  └─ 组件清单：EnvComponent[]（住项目仓 .co/，声明式 resolve/activate）
        │  按需在「某台机器」物化 ↓
机器（Machine / runner）
  ├─ 数据盘根 DATA_ROOT（/data1、/data2…，每机自报）
  ├─ 加速器清单 resources[{kind,index}]（每机自报，Ascend 适配器 detect）
  └─ 物化目录 <DATA_ROOT>/co/
        ├─ base/<项目slug>/            项目 git 检出（clone 一次）
        ├─ cache/<组件>/<版本>/        依赖按版本缓存（CANN/MindSpore/hp…）
        └─ wt/<会话key>/               per-会话 worktree（本地盘）
                │  起容器 ↓
容器（co 拥有，per 会话）
  ├─ docker run --device …（绑该机全部卡，Q11）+ 挂载 workspace 卷 + memory 卷
  ├─ /workspace = 项目根（worktree），agent 的 cwd
  ├─ ~/.claude/…/memory = memory 卷（会话结束 commit+push 到中心仓）
  ├─ /workspace/.co/out = dump/profiling/日志（持久卷）
  └─ 启动序列：activate 各 EnvComponent（按选定版本）→ 起 agent 后端
```

## 3. 数据模型变更（增量，全部 additive）

- `machines`：新增 `dataRoot text`、`resources jsonb`（`[{kind,index,model?}]`，替代死字段 `npu`）。心跳刷新 `lastActiveAt`。
- `projects`：新增 `baseImage text`、`accel jsonb`（`{kind}` 或 null）、`components jsonb`（组件默认版本 `{name:version}`）、`memoryRepo text`（中心 bare 仓路径）。保留现有 forge/repo/autonomy/guardrails/models/vars。
- 新表 `project_materializations`：`(projectId, machineId)` → `basePath, status(materializing|ready|failed), lastUsedAt`（黏性调度 + 冷/热判定）。
- 新表 `resource_reservations`：`(machineId)` → `sessionId, status(reserved|active|released), kind, acquiredAt, releasedAt`（v1 机器粒度：一机一活跃预留）。
- 新表 `task_queue`：`id, projectId, kind, payload, priority, status(pending|scheduled|running|done|failed), enqueuedAt`（没资源时排队）。
- `sessions`：新增 `projectId`、`containerId`（docker 容器 id）、`reservationId`。

> 迁移纪律：drizzle journal 与库不同步 → **新表/新列手写 SQL 直接 apply**，不跑 `drizzle-kit generate`（会重列存量表）。全部 additive，不破坏在跑的 co（保持 `autonomy=manual`）。

## 4. 分阶段计划

- **M1 · 项目物化 + 容器执行下沉 runner**
  数据模型增量；runner 加 `DATA_ROOT` 配置 + `workspace.provision` RPC（在目标 runner 上 clone/worktree，取代 server-local）+ `container.run/exec/rm` RPC（docker）；session spawn 改为「provision on runner → docker run → 容器内起 agent」。密钥注入。旧 forge+repo 项目走「无加速器/无容器」退化路径不受影响。
- **M2 · 机器粒度预留 + 调度队列**
  Ascend accelerator 适配器（`npu-smi` detect + `--device` bindFlags）；`pickMachine` 升级为资源感知（黏性+溢出）；`resource_reservations` 账本 + co-server 重启对账；`task_queue` + reconciler（没机排队、有机自动派）。
- **M3 · EnvComponent 插件 + 依赖管理**
  `EnvComponent` 扩展点（`resolve`/`activate` 契约）；项目 `.co/` 加载；数据盘按版本缓存目录约定；版本选择 UI（每 run 选、默认取项目）；CANN/MindSpore/hyper-parallel 三个样例组件（住 mindformers 项目仓，不进 co 核心）。
- **M4 · memory 同步 + 项目切换**
  AgentBackend 适配器（v1 Claude Code：声明记忆路径）；中心 bare memory 仓 + 容器物化/回写；Web 顶部项目切换器 + 全局 scoping（看板/需求/工作流/会话）。

## 5. 安全与迁移底线

- 容器永远低权；co-server 保持又小又可信（握加密 token、做合并）。领域插件=沙箱脚本、不进 co-server。
- Forge 暂内建（要 token）；插件沙箱做扎实后再放开。
- 现有 co 项目在整个迁移中保持 `autonomy=manual`、旧路径继续可跑；每阶段增量上线、健康门 + 回滚（`scripts/deploy.sh`）。
- 「我来批准合入」不变：auto 档仍需 CI 绿 + 评审 LGTM + 未碰护栏。
