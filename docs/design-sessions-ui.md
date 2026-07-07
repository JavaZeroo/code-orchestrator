# 会话界面优化：工具结果上行 · 列表信息架构 · v2 融合

版本：2026-07-07
状态：规划定稿（用户已确认），四期实现
关系：继 design-ui-ia.md（任务中心）之后的第二轮 UI 优化，聚焦「会话」tab 与会话视图。

---

## 0. 诊断（全部已在代码坐实）

1. **工具结果不上行（协议级缺口）**：`tool-call-end` 只带 call id（`sessionProtocol.ts:35`），mapper 丢弃 SDK `tool_result` 内容（`mapper.ts:49`）——网页看得见 agent 跑了什么命令，看不见输出。审批卡只渲染入参 raw JSON。
2. **会话列表平铺流水账**：dead/live 混排（77:9）、流水线代跑会话与人工会话混排、无分组/搜索/时间戳、标题=cwd 尾段。
3. **新建会话与 v2 脱节**：手填 cwd、机器取第一台、模型硬编码三个（LLM 端点注册表不联动、无 effort）、容器会话入口孤悬项目页。
4. **Timeline 毛刺**：无条件自动滚底、thinking 斜体占屏、`file` 事件有 schema 无 UI。
5. **性能远虑（先记账）**：打开会话全量重放事件，长会话会痛。

## 分期

### P1 · 工具结果上行 + 卡片升级（protocol + runner + web）
- `sessionToolCallEndEventSchema` 加 `output?: string`（mapper 侧截断 ~4KB）与 `isError?: boolean`（额外字段全 optional，线协议向后兼容；vendored 文件改动保留 VENDOR.md 注记）。
- `mapper.ts`：从 `tool_result` block 提取文本内容（string 或 content block 数组两种形态都要处理），`is_error` 透传。
- `Timeline.tsx` ToolCard：展开区显示输出（等宽、可滚动、保留 Edit 的 diff 渲染）；失败态红徽章「失败」。
- ApprovalCard 按工具类型渲染：Bash 显示命令行、Edit/Write 显示 diff/内容，其余才落 JSON。
- **部署注意**：动 runner —— deploy.sh 不重启 co-runner，合并后需人工在无活跃会话窗口重启。

### P2 · 会话列表信息架构（web + 少量 server，与 P1 并行）
- 迁移 `0011_session-title.sql`：`sessions` 加 `title text`（additive；含迁移 → deploy.sh 会拒绝自动部署，人工 apply + 部署）。
- spawn 链路支持 `title`（API body → 落库）；designer / 任务受理会话 spawn 时自动命名（如「设计流程」「新建任务对话」）；普通会话默认 null。
- 列表（App.tsx SessionsScreen）：
  - 三段分组：进行中（starting/thinking/waiting_*）/ 空闲 / 历史（dead，默认折叠显示计数）；
  - 筛选：全部 / 人工会话 / 工作流代跑（按 runId 有无）；顶部搜索框（匹配 title/cwd/model/id）；
  - 行信息：title ?? cwd 尾段、相对时间、模型、成本（usage.costUsd）；工作流会话给「跳到 run」按钮（复用 App.openRun）。
- 显示 title 的兜底：无 title 且无事件加载时用 cwd 尾段（不做首条消息回填，避免 N+1 查询）。

### P3 · 新建会话融入 v2（web + 少量 server；等 P1 部署完，避免 protocol 撞车）
- 机器默认选 labels 含 dev 的（复用「不取第一台」不变量）；
- 模型下拉 = 内置三别名 + LLM 端点注册表（`/api/llm` 已有）；加 effort 下拉（协议已支持）；
- 选项目 → cwd 建议该项目物化目录；baseImage 项目给「容器内执行」开关，吸收 ProjectsPage 的 LaunchContainer（入口统一，项目页保留跳转）。

### P4 · Timeline 打磨（纯 web；等 P1 合并后再动 Timeline.tsx）
- 智能滚动：仅当视口在底部时跟随，离底显示「↓ 新消息」浮标；
- thinking 默认折叠为一行「思考 N 字 ▸」；turn 分隔线带时间戳；
- `file` 事件渲染（协议 `sessionFileEventSchema` 已有）。

## 撞车矩阵

| 期 | protocol | runner | server | Timeline.tsx | SessionView.tsx | App.tsx | NewSession.tsx |
|---|---|---|---|---|---|---|---|
| P1 | ✓ | ✓ | | ✓ | | | |
| P2 | | | ✓(迁移+spawn) | | | ✓ | |
| P3 | | | ✓(spawn) | | | | ✓ |
| P4 | | | | ✓ | ✓ | | |

P1‖P2 并行；P3 待 P1 部署；P4 待 P1 合并。
