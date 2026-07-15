# Agent Capability Kernel：Harness Engineering 与 Loop Engineering

> 状态：Active design，作为 `docs/design-v2.md` 之后的 Agent 能力主线。
> 原则：保持现有 workflow 定义向后兼容，通过纵向闭环逐步吸收零散的 `reviseLoop`、backend 分支与文本裁决。

## 1. 北极星

给定一个仓库和一份任务契约，任一受支持的 Agent Backend 都能在隔离环境中：

1. 获得完成任务所需且可追溯的上下文；
2. 执行一次或多次有预算的 Attempt；
3. 收集 diff、测试、日志等 Evidence；
4. 由独立 Evaluator 判断验收标准是否满足；
5. 未通过时获得结构化反馈并继续修正；
6. 最终返回 `achieved`、`blocked` 或 `exhausted`，而不是把“模型回合结束”误认为成功。

成功结果必须是 **evidence-backed outcome**。

## 2. 范围与非目标

本设计关注提升 Agent 完成复杂工程任务的成功率，不把更多节点类型、更大 fanout 或更多模型投票本身视为能力提升。

首期非目标：

- 允许 workflow 图出现任意环；Loop 是 Agent 任务 Module 的内部实现，workflow 仍保持 DAG。
- 让生产 Prompt 自动自我修改；Harness 变更必须经过 benchmark 回归。
- 一开始就依赖模型裁判；先以命令、测试和静态检查等确定性 Evaluator 建立闭环。
- 替换 Claude/Codex SDK 自己的工具循环；co 在其外部增加任务级 Harness。

## 3. 当前差距

| 能力层 | 当前基础 | 主要差距 |
| --- | --- | --- |
| 执行环境 | worktree、容器、资源调度、审批 | 环境能力没有统一声明，宿主与容器差异会泄漏 |
| 会话控制 | spawn/resume/fork/send/interrupt | Backend Interface 过浅，能力判断散落在 runner |
| 上下文 | workflow 模板、角色文本、原生 memory | 缺少版本化 Context Pack 与 Attempt 交接物 |
| 验证 | `check` 命令、review 文本、meeting | Agent 回合正常结束仍可直接标记 done |
| 修正循环 | `reviseLoop`、瞬时错误重试 | 缺少统一状态机、预算、失败分类、证据和恢复语义 |
| 评测 | token/cost/turn usage | 缺少真实任务 benchmark 与质量指标 |

## 4. 模块与 Seam

### 4.1 `AgentCapabilityLoop` Module

对 workflow engine 暴露一个小 Interface：

```ts
run(task: TaskContract, context: ContextRef, policy: ExecutionPolicy): Promise<AgentOutcome>
```

Implementation 隐藏：Context Pack 装配、Backend 差异、Attempt journal、Evaluator 调用、反馈生成、checkpoint、预算与 Evidence 汇总。workflow 调用方不需要知道内部跑了几轮。

首期受现有事件驱动引擎约束，以上 Interface 以可持久化状态机而非单个长 Promise 落地。

### 4.2 `AgentBackendAdapter` Seam

Claude、Codex 是两个真实 Adapter。统一声明并实现：

- `spawn`、`resume`、`fork`、`send`、`interrupt`；
- permission、effort、MCP/custom tools、container 等 capability；
- 原生事件到 co 事件的归一化；
- 原生 session id 与 memory 路径。

调用方只基于 capability 协商，不再按 backend 名称散落分支。

### 4.3 `EvaluatorAdapter` Seam

统一输入为 Attempt + TaskContract，输出结构化 `EvaluationResult`。计划中的 Adapter：

1. command/test/static-check；
2. forge CI/review；
3. model/meeting judge；
4. browser/UI evidence；
5. human gate。

首期实现 command Evaluator，并保留旧 `check` 节点兼容层。

### 4.4 `WorkspaceAdapter` Seam

统一宿主/容器的 cwd、diff、artifact、checkpoint 和命令执行。首期已把 Evaluator、repo instruction 与 checkpoint 定向到宿主 `machine.exec/workspace.read` 或会话所属 `container.exec`；diff/artifact 继续沿现有 workspace 能力逐步收拢。

## 5. 核心契约

### 5.1 TaskContract

```ts
interface TaskContract {
  objective?: string;
  acceptanceCriteria: AcceptanceCriterion[];
  requiredEvidence: EvidenceRequirement[];
  constraints: string[];
  budget: {
    maxAttempts: number;
    maxTurns?: number;
    maxCostUsd?: number;
    timeoutMs?: number;
  };
}
```

`objective` 缺省使用 Agent 节点 prompt。验收标准必须能映射到一个 Evaluator，首期为 command。

### 5.2 Attempt / Evaluation / Outcome

```ts
interface AgentAttempt {
  number: number;
  sessionId: string;
  startedAt: string;
  endedAt?: string;
  summary?: string;
  evaluations: EvaluationResult[];
  status: 'running' | 'passed' | 'failed' | 'errored';
}

interface AgentOutcome {
  status: 'achieved' | 'blocked' | 'exhausted';
  summary: string;
  evidence: Evidence[];
  attempts: AgentAttempt[];
  usage?: UsageSummary;
}
```

Attempt 与 Evaluation 以 append-only 事件作为审计真相，同时在 `node_states.output` 保存可恢复投影。

## 6. 状态机

```text
pending
  -> attempt_running
  -> evaluating
      -> achieved
      -> feedback_ready -> attempt_running
      -> blocked
      -> exhausted
```

关键规则：

- 未配置 `contract` 的旧 Agent 节点保持现有完成语义。
- 配置 `contract` 后，turn completed 只代表 Attempt 结束，不代表节点完成。
- 所有必需 Evaluator 通过后才能标记 `achieved/done`。
- 可修复失败且预算未耗尽时，反馈回灌同一活会话；会话已死则在同一 worktree 重新生成会话。
- 反馈发送携带稳定的 run/node/Attempt 幂等键；服务端在发送后崩溃恢复时不会让 runner 重复投递同一反馈。
- Evaluator 基础设施错误与“代码未通过”分开分类，不能错误消耗修正轮次。
- 进入 Evaluator、生成反馈与启动下一 Attempt 前都先更新 `node_states.output`；进程重启后结合该投影与 session/capability 事件恢复。
- `maxAttempts`、`maxTurns`、`maxCostUsd`、`timeoutMs` 都在 Attempt 边界执行，不能只声明不生效。
- Backend 无法提供已配置预算的测量值（例如 cost）时返回 `context_missing/blocked`，不能把 unknown 当成零。

## 7. Evidence 与失败分类

首期 Evidence：

- command：命令、exit code、截断后的 stdout/stderr、耗时；
- agent summary：Agent 的完成说明；
- session：session id、backend/model；
- usage：token、cost、turns（可用时）。

失败分类：

- `agent_transport`：API、网络、限流等；
- `agent_execution`：Agent 回合失败；
- `acceptance_failed`：实现未满足验收标准；
- `evaluator_infrastructure`：验证器无法运行；
- `context_missing`：缺少 cwd、机器或必要输入；
- `budget_exhausted`；
- `human_required`。

## 8. Benchmark

仓库内维护版本化 task cases。每个 case 至少包含：fixture/reference、TaskContract、期望 Evidence 与超时。第一批覆盖：

- 单文件 bug；
- 跨文件 feature；
- 重构且不得回归；
- typecheck/CI 修复；
- 前端交互；
- 中断恢复；
- 不完整需求的阻塞识别。

核心指标：solve rate、first-pass pass rate、attempts-to-pass、human interventions、time、tokens、cost、regression rate。Harness 或 Prompt 变更必须对同一 benchmark 做前后对比。

## 9. 实施顺序与验收

### Phase 0：契约与基线

- [x] protocol 增加 TaskContract、Evidence、Evaluation、Outcome schema；
- [x] workflow Agent 节点可选 `contract`；
- [x] schema 正反例测试；
- [x] benchmark case 格式、validator/reporter 与首批 smoke cases；
- [ ] 连接真实 Backend、自动产出 observation 的 benchmark execution driver。

验收：契约可版本化解析；旧 workflow 无需迁移。

### Phase 1：Evidence-backed command loop

- [x] `AgentCapabilityLoop` 纯状态转换与测试；
- [x] engine 在 Agent turn-end 后执行 command Evaluator；
- [x] Attempt/Evaluation/Evidence 事件与 `node_states.output` 投影；
- [x] 失败反馈、预算、同会话重试、重启恢复；
- [x] 通过且 required Evidence 齐全后才写入下游 output。

验收：一个 Agent 节点能“实现 → 测试失败 → 根据反馈修复 → 测试通过”，且每轮可审计。

### Phase 2：Backend 深化

- [x] server/runner 共享 backend capability schema（含单项能力与 `allOf` 组合约束）；
- [x] runner registry 统一 spawn/resume/fork；
- [x] Claude/Codex 两个 Adapter；
- [x] Designer/TaskIntake 等通过 capability 协商；
- [x] API 可见 backend 能力与拒绝原因。

验收：新增 Backend 只需实现 Adapter 并注册，不修改 session 方法主流程。

已落地的操作入口：

- `pnpm benchmark:agent`：校验版本化 benchmark cases；传入 observation JSON 时输出能力指标、Harness 版本对比和逐 case gate（当前不负责启动真实 Agent）；
- `GET /api/agent-backends`：返回内置 Backend capability descriptor；
- `GET /api/capability/metrics`：从 append-only capability events 投影 solve/evaluation/failure/cost 指标；
- Run 图详情与时间线：展示 Attempt、Evaluation、Evidence-backed Outcome；
- Run 导出：保留 capability attempt/evaluation/outcome 的稳定标签与原始 payload。

### Phase 3：Repository Harness

- [x] Context Pack v1 manifest；
- [x] 根级 repo instructions 哈希、prior-attempt progress、Git HEAD/dirty checkpoint 的装配与版本记录；
- [ ] worktree 级日志/服务/浏览器入口；
- [ ] 架构约束与可修复错误信息。

验收：新 Attempt 能准确知道上轮做了什么、为什么失败、从哪里继续。

### Phase 4：Evaluator 扩展

- [ ] forge evaluator；
- [ ] model/meeting evaluator；
- [ ] browser/UI evaluator；
- [ ] human gate adapter；
- [x] 旧 `check` 节点委托给 command Evaluator Adapter；
- [ ] `check.reviseLoop` 与 agent review loop 的状态迁移统一到 Capability Module。

验收：workflow schema 不再需要为每种反馈环新增特殊循环字段。

### Phase 5：学习飞轮

- [x] 失败分类与 capability metrics 事件投影/API；
- [ ] capability dashboard；
- [ ] 事件转 benchmark case 的人工确认流程；
- [x] Harness 版本分组与 benchmark 对比；
- [ ] 重复反馈沉淀为 check/instruction/skill 的受控流程。

验收：任何“能力提升”都有可复现任务和回归数据支持。

## 10. 兼容与迁移

- 所有新字段先保持 optional；存量 workflow graph 继续解析。
- 数据库迁移只使用 additive SQL，不运行 `drizzle-kit generate`。
- 第一阶段复用 append-only events 与 `node_states.output`，验证模型稳定后再决定是否增加专用 attempt/evaluation 表。
- 旧 `check`、`reviseLoop` 保留，内部逐步委托给新 Module；删除须另立迁移决策。
- 每一阶段必须通过 protocol、server、runner typecheck 与全量 unit tests。

## 11. 首个纵向切片

```json
{
  "id": "implement",
  "type": "agent",
  "prompt": "实现需求并确保测试通过",
  "contract": {
    "acceptanceCriteria": [
      {
        "id": "unit-tests",
        "description": "服务端单测通过",
        "evaluator": {
          "kind": "command",
          "run": "pnpm --filter @co/server test:unit",
          "timeoutMs": 300000
        }
      }
    ],
    "requiredEvidence": ["evaluation"],
    "constraints": [],
    "budget": { "maxAttempts": 3 }
  }
}
```

预期行为：首轮 Agent 结束后执行测试；失败则保存 Evidence、生成精确反馈并进入第二 Attempt；测试通过后节点输出 `AgentOutcome(status=achieved)`，下游才可调度。
