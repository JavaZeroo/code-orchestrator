# GitCode（gitcode.com）开放 API 调研报告

日期：2026-07-03
调研目的：为 code-orchestrator 的 `forge-gitcode` 模块（见 `docs/design.md` §2/§8/§12）确认 GitCode API 能力：per-user token 创建/更新 PR、发评论、读评审意见、读 CI 门禁状态、接收或轮询 issue/PR/评审事件。目标仓库 `mindspore/mindformers`。

信息来源与可信度标注：
- **[官方文档]** docs.gitcode.com（v2 文档为 JS 渲染的 Docusaurus 站，端点参数表在静态 HTML 中缺失；**v1 老文档 `docs.gitcode.com/v1-docs/en/docs/` 是静态渲染，参数表完整**，本报告参数主要取自 v1，端点清单以 v2 导航为准）
- **[实测]** 本机直接调用 `api.gitcode.com`（匿名 + 只读 token 调用，2026-07-03）
- **[实战]** 本机已有的 mindformers PR 工作流脚本/笔记（`~/.claude/skills/gitcode-pr-rfc-pipeline/`，含已跑通的完整 PR→门禁→合并链路），可视为已验证事实

---

## 1. 概述

- GitCode 是 CSDN 运营的代码托管平台，昇腾/MindSpore 生态（含 mindformers）2025 年起迁移至此。
- API base：`https://api.gitcode.com/api/v5`，风格为 **Gitee API v5 系**（路径、参数几乎逐字一致），底层实现带明显 GitLab 痕迹（merge_requests、discussions、mergeable_state、GitLab 式 webhook payload）。另有 `/api/v8` 前缀的新 API（Actions 流水线、企业版）。
- 文档站 docs.gitcode.com 实为 AtomGit 文档框架换皮（页面 title 仍是"AtomGit 帮助文档"），v2 端点页参数表不在静态 HTML 中（WebFetch/爬虫只能拿到端点路径），这是文档使用上的第一大坑。
- 返回码规范：POST 成功 201、DELETE 成功 204、**418 = WAF 判定"请求疑似不安全"**（真实存在，需要重试与正常 UA）、429 = 超限。[官方文档]

## 2. 认证与 Token

### 2.1 Personal Access Token（PAT）
- 创建入口：头像 → 个人设置 → 访问令牌 → 新建访问令牌；创建页 URL `https://gitcode.com/setting/token-classic`。[官方文档]
- 帮助文档明确：可"根据需要选择不同的范围，如项目、Issue 等"，可设**到期时间**，token **仅创建时可见一次**。[官方文档]
- **PAT 的具体 scope 枚举官方文档未列出（未确认）**。旁证：OAuth2 的 scope 列表为 `all_user / all_key / all_groups / all_projects / all_pr / all_issue / all_note / all_hook / all_repository`，PAT 创建页大概率是同一套粒度，需登录 `setting/token-classic` 页面人工确认。
- token 也可直接用于 git 推送：`https://<login>:<token>@gitcode.com/<owner>/<repo>.git`。[实战]

### 2.2 三种 API 认证方式 [官方文档+实测]

| 方式 | 用法 | 评价 |
|---|---|---|
| Bearer header | `Authorization: Bearer {token}` | **推荐**。实测在 /user、/repos、PR/issue 读写全链路可用 |
| PRIVATE-TOKEN header | `PRIVATE-TOKEN: {token}` | 等价可用；GitLab 习惯用户友好。部分端点的 401 报错文案即提示 "private-token required" |
| query 参数 | `?access_token={token}` | 可用但**不推荐**：token 进 URL，会落入日志/代理/Referer |

- 实战脚本经验：个别端点/时段对某种 header 形态返回 401/403/418，成熟做法是做**降级链**：`Bearer` → `token {t}`（GitHub 旧式）→ `PRIVATE-TOKEN` → `access_token` query。[实战]
- 匿名访问：公开仓库的 pulls/issues/comments/labels 列表可匿名读 [实测]；但 `GET /repos/{owner}/{repo}`（仓库详情）匿名返回 400 并要求 token [实测]——"公开数据可匿名"并非全端点一致，别依赖匿名。
- OAuth2（多用户系统备选）：授权码模式，`https://gitcode.com/oauth/authorize` + `https://gitcode.com/oauth/token`，access_token 有效期 1296000 秒（15 天），带 refresh_token 可刷新。[官方文档]

## 3. API 能力矩阵

约定：路径省略前缀 `https://api.gitcode.com/api/v5`。`*` = 必填。分页统一 `page`/`per_page`（上限 100，默认 20），总数在**响应头** `total_count` / `total_page`（issue 列表还有 `all_issues/open_issues/close_issues` 头）。[官方文档+实测]

### 3.1 Pull Request

| 能力 | 端点 | 关键参数 | 备注 |
|---|---|---|---|
| 列出 PR | `GET /repos/{owner}/{repo}/pulls` | `state`(all/open/closed/locked/merged)、`base`、`sort`(created/updated)、`direction`、`since`(ISO8601，更新时间)、`author`、`assignee`、`reviewer`、`labels`、`created_after/before`、`merged_after/before`、`only_count` | `since`+`sort=updated` 适合增量轮询；`state` 含 `merged`/`locked`，比 GitHub 多 |
| 创建 PR | `POST /repos/{owner}/{repo}/pulls` | `title*`、`head*`（同仓 `branch`，fork 写 `user:branch`）、`base*`、`body`、`draft`、`squash`、`squash_commit_message`、`prune_source_branch`、`milestone_number`、`labels`(逗号分隔)、`issue`(按 issue 自动填标题/正文)、`assignees`(审批人,逗号分隔)、`testers`(测试人)、`fork_path` | 已存在同分支 open PR 时返回 **409**，报错文案含已有 PR 号 `!NNNN`；**push 分支时 GitCode 可能自动创建 MR**（然后创建接口 409），要按"ensure 语义"写代码 [实战] |
| 更新 PR | `PATCH /repos/{owner}/{repo}/pulls/{number}` | `title`、`body`、`state`、`milestone_number`、`labels`、`draft` | **PATCH 响应体字段不可信（可能为 null），必须 re-GET 验证** [实战] |
| 获取 PR | `GET /repos/{owner}/{repo}/pulls/{number}` | — | 返回含 `head.sha`、`base`、`state`、`mergeable`、**`mergeable_state`（门禁快照，见 §5）**、`labels`、`assignees`、`testers`、`approval_reviewers`、`draft`、`squash_merge` [实测] |
| 合并 PR | `PUT /repos/{owner}/{repo}/pulls/{number}/merge` | `merge_method`：`merge`(默认)/`squash`/`rebase` | 权限受仓库合并策略约束（mindformers 普通贡献者无权，见 §8） |
| 是否已合并 | `GET /repos/{owner}/{repo}/pulls/{number}/merge` | — | 已合并返回 `{"message":"Pull Request已经合并"}` [实测] |
| PR 评论列表 | `GET /repos/{owner}/{repo}/pulls/{number}/comments` | `comment_type` 过滤：`diff_comment`(行级)/`pr_comment`(普通)、`direction` | 评论对象含 `id`、`body`、`comment_type`、`discussion_id`（GitLab 式讨论串 id）[实测] |
| 发 PR 评论（含**行级**） | `POST /repos/{owner}/{repo}/pulls/{number}/comments` | `body*`；行级评论加 `path`(文件相对路径)、`position`(**diff 中相对行号**)、`need_to_resolve`(true=须解决的评审意见) | **行级 code review 评论支持**；`need_to_resolve=true` 的评论会挂进"待解决讨论"，影响合并门禁（`resolve_discussion_passed`） |
| 编辑/删除评论 | `PATCH / DELETE /repos/{owner}/{repo}/pulls/comments/{id}` | `body*` | |
| 讨论串内回复 | `POST /repos/{owner}/{repo}/pulls/{number}/discussions/{discussion_id}/comments` | （参数表未确认） | v2 文档导航列出，参数未渲染 |
| 解决/恢复讨论 | `PUT /repos/{owner}/{repo}/pulls/{number}/comments/{discussion_id}` | （参数表未确认） | 同上，推测用于 resolve 状态切换 |
| 审查通过（approve） | `POST /repos/{owner}/{repo}/pulls/{number}/review` | `force`(仅管理员) | **Gitee 式"一键审查通过"**，不是 GitHub 式 review(approve/request_changes+body) 提交体 |
| 测试通过 | `POST /repos/{owner}/{repo}/pulls/{number}/test` | `force` | 同上，配合 `testers` 角色 |
| 重置审查/测试状态 | `PATCH /pulls/{number}/assignees` / `PATCH /pulls/{number}/testers` | `reset_all` | |
| 指派/取消审查人 | `POST / DELETE /repos/{owner}/{repo}/pulls/{number}/assignees` | `assignees*`(逗号分隔用户名) | 另有 `POST/DELETE .../approval-reviewers`、`GET .../option/approval-reviewers`（v2 新增，参数未确认） |
| PR 文件/提交 | `GET .../pulls/{number}/files`、`.../files-json`、`.../commits` | — | files-json 为结构化 diff |
| PR 操作日志 | `GET /repos/{owner}/{repo}/pulls/{number}/operate_logs` | `sort` | 事件流（打标签、指派、状态变化…），可做轮询审计源 |
| PR 标签 | `GET/POST/PUT/DELETE /repos/{owner}/{repo}/pulls/{number}/labels` | POST body 为标签名数组 | **CI 门禁状态就挂在 PR 标签上（§5）** |
| 关联 issue | `GET/POST /repos/{owner}/{repo}/pulls/{number}/issues`；解除 `DELETE .../pulls/{number}/issues`（v2 还列出 `POST .../linked-issues`） | POST body = **issue 内部 `id`（整数）组成的裸数组**，不是可见编号 | 先 `GET /repos/{owner}/{repo}/issues/{number}` 取 `id` 再 POST [实战] |

### 3.2 Issue

| 能力 | 端点 | 关键参数 | 备注 |
|---|---|---|---|
| 列出仓库 issue | `GET /repos/{owner}/{repo}/issues` | `state`(open/closed/all)、`labels`、`sort`(created/updated)、`direction`、`since`、`created_after/before`、`updated_after/before`、`assignee`、`creator`、`milestone` | `since`/`updated_after` 适合增量轮询；响应头带 open/close 计数 |
| 创建 issue | `POST /repos/{owner}/issues` | **注意路径只有 owner**；`repo*`(放 body)、`title*`、`body`、`assignee`、`milestone`、`labels`、`security_hole`(私密 issue) | 与 Gitee v5 相同的怪路径。**mindformers 上带 `assignee/assignee_ids` 会 403，不要传** [实战] |
| 更新 issue | `PATCH /repos/{owner}/issues/{number}` | `repo*`、`title`、`body`、`state`、`assignee`、`labels`… | **关闭 state 值是 `close`（不是 closed），重开是 `reopen`** [实战] |
| 获取单个 issue | `GET /repos/{owner}/{repo}/issues/{number}` | — | 返回 `id`(内部整数)与 `number`（**字符串**，如 "2399"）[实测] |
| issue 评论 | `POST/GET /repos/{owner}/{repo}/issues/{number}/comments`；仓库全量 `GET /repos/{owner}/{repo}/issues/comments`；编辑 `PATCH /repos/{owner}/{repo}/issues/comments/{id}`；删除 `DELETE` 同路径 | `body*` | |
| issue 操作日志 | `GET .../issues/{number}/operate_logs`（v1 文档"events Log"） | — | |
| issue 关联 PR | `GET /repos/{owner}/{repo}/issues/{number}/pull_requests` | — | v1 文档第 7 节 |

### 3.3 其他（与本项目相关）

| 能力 | 端点 | 备注 |
|---|---|---|
| 当前用户（token 校验） | `GET /user` | 返回 `login/name/id/email/...`，用于"这个 token 是谁"的落库校验 [实测] |
| 仓库详情 | `GET /repos/{owner}/{repo}` | 需认证（匿名 400）[实测] |
| 分支/commit/tag/release/milestone/label/member/搜索/组织 | 常规 Gitee v5 风格端点齐全 | 见 v1 文档各分类 |
| Actions 流水线（GitCode 自有 CI） | `GET /api/v8/repos/{owner}/{repo}/actions/runs` 等 | v8 API：runs / run 详情 / jobs / job 日志下载 / artifacts / runners。**mindformers 未使用**（实测 runs 为空），参数表未确认 |

## 4. Webhook 详情

### 4.1 管理 API（参数完整，[官方文档 v1]）

| 操作 | 端点 |
|---|---|
| 列出 | `GET /repos/{owner}/{repo}/hooks` |
| 创建 | `POST /repos/{owner}/{repo}/hooks` |
| 查询/更新/删除 | `GET/PATCH/DELETE /repos/{owner}/{repo}/hooks/{id}` |
| 测试投递 | `POST /repos/{owner}/{repo}/hooks/{id}/tests`（204） |

创建/更新参数：`url*`、`encryption_type`（**0=密码，1=签名密钥**）、`password`、以及 5 个事件开关（布尔）：

- `push_events`（推送代码）
- `tag_push_events`（推 tag）
- `issues_events`（issue 创建/关闭）
- `note_events`（**issue/PR/commit 的评论**）
- `merge_requests_events`（PR 创建与合并等）

**注意：没有流水线/CI/门禁事件、没有独立的"评审/approve"事件。** CI 状态变化不会推送（对我们是关键限制，见 §9）。

### 4.2 校验（secret）[官方帮助文档]

- 密码模式（encryption_type=0）：GitCode 在请求头带 `X-GitCode-Token: <密码>`，接收端比对明文。
- 签名模式（encryption_type=1）：请求头带 `X-GitCode-Signature-256: sha256=<签名>`，官方描述为"使用配置的密钥对请求内容进行加密（HMAC-SHA256），接收端用同样密钥计算比对"。**具体签名基串（是否纯 body、编码细节）文档未展开——未确认，接入时需用 `/hooks/{id}/tests` 实测对齐**。
- 通用头：`X-GitCode-Event`（事件类型：`Push Hook` / `Tag Push Hook` / `Issue Hook` / `Merge Request Hook` / `Note Hook`）、`X-GitCode-Delivery`（请求唯一 id，可做幂等去重）。

### 4.3 Payload 格式（GitLab 风格）[官方帮助文档]

- Push：`object_kind:"push"`，`before/after/ref/checkout_sha`、`commits[]`、`project.*`。
- Issue：`object_kind:"issue"`，`object_attributes.{iid,title,state(opened/closed),action(open/close/reopen/update),author,...}`。
- Merge Request：`object_kind:"merge_request"`，`object_attributes.{iid,title,state(opened/merged/closed),action(open/update/merge/close),source_branch,target_branch,last_commit,merge_status,...}`、`labels[]`、`issues[]`（关联 issue）、`changes.*`（字段变更 diff）。**含 `git_commit_no`（当前 head SHA）**，可直接驱动我们的 run/node 定位。
- Note：`object_kind:"note"`，`object_attributes.{note,discussion_id,noteable_type(Issue/MergeRequest/Commit),type(DiscussionNote 等),position,original_position,url,system}`，并随附 `issue` / `merge_request` / `commit` 对象。**行级评审意见走这里（position 有值）**——评审回流可用。
- 重试策略/超时：文档未写（**未确认**）。webhook 详情页有"请求发送记录"可人工查投递结果。

## 5. CI/门禁状态

GitCode 的 CI 形态分两层，别混淆：

1. **GitCode Actions（平台自有 CI）**：v8 API（§3.3），GitHub Actions 风格（runs/jobs/artifacts/runners）。mindformers **不用**它。
2. **MindSpore 生态门禁（OpenLiBing）**：mindspore 组织的 PR 门禁跑在外部系统 openlibing.com（MindSpore-Bot 桥接），**GitCode 上没有 commit status / checks API**（实测 `/statuses/{sha}`、`/commits/{sha}/status` 均 404）。状态回流只有两条通道：

   - **PR 标签（机器可读的权威信号）**：`ci-pipeline-running` / `SC-RUNNING`（静态检查中）→ `SC-SUCC` → 终态 `ci-pipeline-passed` 或 `ci-pipeline-failed` / `pr-ci-fail`。读 `GET /pulls/{n}/labels` 即可轮询。[实战+实测]
   - **MindSpore-Bot 的 PR 评论**：包含各 stage 表格与 openlibing.com `pipelineDetail` 链接（URL 内含 `pipelineRunId`，行内含 `jobRunId/stepRunId`）。失败日志可通过 OpenLiBing 网关 `https://www.openlibing.com/gateway/openlibing-cicd` 的接口无头拉取（本机 `gitcode_pr_gate_log.py` 已实现）。[实战]

   mindformers 门禁流水线结构：push 或 `/retest` 评论先触发快速 `PR-pipeline_Mindformers-codecheck`（约 3 分钟）；**codecheck 绿后再发一次 `/retest`** 才会跑完整 `PR-pipeline_Mindformers`（Antipoison / CodeCheck_Pylint / SCA / UT，约 10–30 分钟），通过后打 `ci-pipeline-passed` 标签。`/retest` 评论 POST 返回 200 不代表触发成功，要以 `ci-pipeline-running` 标签或新 bot 评论为准。[实战]

3. **PR 的 `mergeable_state`（一次 GET 拿全量门禁快照）** [实测]：`GET /pulls/{number}` 返回：

   ```
   mergeable_state: {
     state, conflict_passed, branch_missing_passed, non_ff_passed,
     mr_state_passed, merged_by_user_passed, work_in_progress_passed,
     resolve_discussion_passed, ci_state_passed, merge_by_self_passed,
     approval_reviewers_required_passed, approval_approvers_required_passed,
     approval_testers_required_passed, can_force_merge,
     merge_request_switch: { review_mode, merge_method,
       only_allow_merge_if_all_discussions_are_resolved,
       disable_merge_by_self, only_allow_merge_if_pipeline_succeeds, ... },
     reason: { <未过项>: <人类可读原因> }
   }
   ```

   `ci_state_passed`、`conflict_passed`、`resolve_discussion_passed` 是我们 `forge.ci` 事件的理想数据源；`merge_request_switch` 还顺带暴露了仓库合并策略。

4. **mindformers 真实合并门禁（标签维度）** [实战，已在合并 PR !8377 上实测验证]：`ci-pipeline-passed` ×1 + `approved` ×1 + `lgtm` ×2（呈现为 `lgtm-<reviewer>` 标签）+ 已关联 issue。`pr-check-fail`（micro-compass `/check-pr` 模板检查）是**咨询性的，不阻塞合并**（该 bot 在全仓范围误报）。`lgtm`/`approved` 由人类评审经 `/lgtm`、`/approve` 评论触发，API 无法代劳（且贡献者账号不能自批）。

## 6. 限流与配额

- 官方数字（v2 文档 429 条目原文）："用户超过了应用程序速率限制，**默认 400/分，4000/小时**"。粒度（per token / per IP / per user）官方未写——**未确认**，按 per-token-or-IP 保守设计。
- 实测响应头**没有** `X-RateLimit-*` / `Retry-After` 类字段（普通 200 响应上未观察到；429 场景未复现——未确认）。
- `418 I'm a teapot`：WAF 拒绝"疑似不安全请求"。实战脚本将 418 与 429/5xx 一起退避重试，并显式设置正常浏览器样 User-Agent——裸 UA（curl 默认）更易触发。[实战]
- 应对建议：客户端令牌桶（每 token ≤ 300/min 软上限，留 25% 余量）；对 418/429/502/503/504 指数退避重试；批量轮询用 `since`/`updated_after` + `per_page=100` 压请求数；每用户 token 天然分摊配额（我们 per-user token 设计正好受益）。

## 7. SDK 与兼容性

### 7.1 与 Gitee API v5 的兼容度：高（同源风格）

- 路径与参数高度一致：`/repos/{owner}/{repo}/pulls`、PR create 的 `title/head/base`、`merge_method=merge|squash|rebase`、issue 创建的"`POST /repos/{owner}/issues` + body 带 `repo`"怪癖、hooks 的 `*_events` 布尔开关，全部与 Gitee v5 同构。
- 差异点（改造 Gitee SDK 时要动的地方）：
  - base URL：`https://api.gitcode.com/api/v5`（Gitee 是 `https://gitee.com/api/v5`）。
  - GitCode 缺 Gitee 的 commit status（`/statuses`）等端点；多出 GitLab 式扩展：`discussions`、`approval-reviewers`、`operate_logs`、`files-json`、`mergeable_state`，以及 `/api/v8`（Actions、企业）。
  - 响应形态差异：issue `number` 是字符串；PR `state` 多 `merged/locked`；分页总数在响应头。
  - 认证差异：GitCode 支持 `PRIVATE-TOKEN` 与 `Authorization: Bearer`（Gitee v5 主用 `access_token` query）。
- 与 GitHub API 不兼容（路径、语义都不同），GitHub SDK 不可复用；概念上更接近"Gitee v5 皮 + GitLab 芯"。

### 7.2 SDK 现状

- **官方 SDK：无**（未发现官方维护的 forge API SDK；PyPI 的 `gitcode` 包是 AI hub 模型/数据集上传下载工具（OpenMind Hub 系），不是 forge API 客户端）。
- 社区：npm `@xbghc/gitcode-api`（TypeScript + Zod 校验 + 重试/ETag 缓存，覆盖 PR/issue/user/repo，`GITCODE_TOKEN` env）——与我们 TS 技术栈匹配，可评估后 vendor 或参考其类型定义；配套项目 `xbghc/gitcode-actions`（GitHub 上）整理过一份 gitcode API 文档。成熟度一般，建议只做参考。
- 本机已有资产：`~/.claude/skills/gitcode-pr-rfc-pipeline/scripts/`（Python stdlib 实现的幂等 PR/issue/link/retest/merge-state/门禁日志客户端）——**forge-gitcode 模块的行为规范可直接照抄其 choreography**（409 处理、re-GET 验证、标签轮询、OpenLiBing 日志拉取）。

## 8. mindformers 在 GitCode 上的实际形态

- 组织/路径：`https://gitcode.com/mindspore/mindformers`（namespace path 小写 `mindspore`，显示名 MindSpore；repo id 5422431，默认分支 `master`，public）。[实测]
- Web PR 路径是 GitLab 风格 `.../merge_requests/{n}`，API 仍用 `/pulls/{n}`；PR 引用写法 `!8377`。
- 公开可见性 [实测]：匿名可读 PR 列表/详情/评论/标签、issue 列表/详情；`GET /repos/...` 仓库详情需 token。门禁 bot 评论（含 openlibing 流水线链接与 stage 表）公开可见。
- 协作模型：fork → `<login>/mindformers` → 向上游发 PR（`head` 写 `<login>:<branch>`）。CLA 由 `mindspore-cla/yes` 标签体现。作者本人可用 `/retest` 驱动完整流水线（无需 committer），但合并需 maintainer（普通贡献者 `merged_by_user_passed=false`："do not have PUSH permission"）。[实战+实测]
- 仓库合并策略（`merge_request_switch` 实测值）：`review_mode=approval`、`merge_method=merge`、**`only_allow_merge_if_all_discussions_are_resolved=true`**（`need_to_resolve` 评论必须解决）、`disable_merge_by_self=true`、`only_allow_merge_if_pipeline_succeeds=false`（流水线经标签人审联动，而非硬性开关）。
- 已知坑：`/check-pr`（micro-compass）模板检查全仓误报、仅咨询性；lintrunner-pylint 门禁 lint **整个被改文件**而非 diff 行（改一行旧文件要清掉全文件历史告警，本地用 pylint==3.2.6 预检）；PR 提交描述需忠实复刻 `.gitcode/PULL_REQUEST_TEMPLATE.md`。[实战]

## 9. 对我们系统的集成建议

### 9.1 webhook vs 轮询：以轮询为主，webhook 为增强

决定性约束有三个：

1. **在上游 `mindspore/mindformers` 创建仓库级 webhook 需要仓库管理权限**——我们的用户是外部贡献者，大概率装不了（未确认具体所需角色，但 hooks API 对非管理员必然 403）。
2. webhook **没有 CI/流水线事件**，门禁状态本来就只能轮询（PR 标签或 mergeable_state）。
3. server 需公网可达才能收 webhook（design.md 已预设"公网不可达则轮询兜底"）。

落地建议：
- **M3 首发走纯轮询**，两级节奏：
  - 慢环（全仓）：`GET /pulls?state=open&sort=updated&since=<last_sync>` + `GET /issues?...&updated_after=`，60–120s 一轮，增量产生 `forge.*` 事件；
  - 快环（活跃 PR）：对本系统正在跟的 PR（有 run/node 绑定的），15–45s 轮 `GET /pulls/{n}/labels`（判 ci-pipeline-* 标签迁移）+ 按需 `GET /pulls/{n}`（取 mergeable_state）+ `GET /pulls/{n}/comments?comment_type=...`（新评审意见/bot 门禁评论，`X-GitCode-Delivery` 没有就用 comment id 去重）。
  - 预算：10 个活跃 PR × 3 请求 / 30s ≈ 60 req/min，单 token 400/min 内富余；且我们 per-user token 天然分摊。
- **webhook 作为可选加速**：若后续拿到 mindspore org 协作（或先在自己 fork/测试仓验证），用签名模式（`encryption_type=1`）+ 校验 `X-GitCode-Signature-256`，事件勾 `merge_requests_events + note_events + issues_events + push_events`；`X-GitCode-Delivery` 入事件日志做幂等键。**即便有 webhook，CI 标签轮询也不能撤**。
- 门禁日志深挖（失败原因喂给 nudge）：复用 `gitcode_pr_gate_log.py` 的 OpenLiBing 网关取日志方案，把 `failed_stages[].log.error_excerpt` 塞进 `forge.ci` 事件 payload。

### 9.2 per-user token 落地

- User 表存服务端加密的 `gitcode_token`（已定案）；录入时立即 `GET /user` 校验有效性并落 `login`，所有 forge 写操作前断言"token 身份 == 系统用户绑定身份"（防串号，实战脚本的 whoami 前置检查同款）。
- 统一客户端封装：`Authorization: Bearer` 主通道 + `PRIVATE-TOKEN` 降级；**禁止 access_token query**（日志泄漏）；固定正常 UA；对 418/429/5xx 指数退避；**所有 PATCH 后 re-GET 验证**；PR 创建实现为 ensure 语义（409 → 解析已有 PR 号 → PATCH）。
- 权限现实：普通贡献者 token 能做——创建/更新自己的 PR、发 PR/issue 评论（含 `/retest`）、建 issue、关联 issue、读一切公开数据；不能做——合并 upstream PR、打标签到 upstream PR（未确认边界）、`/review`/`/test` 通过、建 upstream webhook。工作流引擎里"合并"节点应设计为 **gate（通知 maintainer）而非 API 调用**。
- token 过期：PAT 可设到期时间 → 系统需要 token 失效检测（401 时给用户发通知要求换 token），别静默重试。

## 10. 未确认事项清单

| # | 事项 | 现状 | 建议动作 |
|---|---|---|---|
| 1 | PAT 的 scope 精确枚举与粒度 | 帮助文档只说"项目、Issue 等"；OAuth 侧有 all_* 九类 | 登录 `gitcode.com/setting/token-classic` 截图确认 |
| 2 | webhook 签名基串/算法细节（HMAC-SHA256 对 body？编码？） | 官方只给头名 `X-GitCode-Signature-256: sha256=…` | 建测试仓 webhook + `/hooks/{id}/tests` 实测对齐 |
| 3 | webhook 重试策略、超时、失败停用策略 | 文档未写 | 测试仓实测 |
| 4 | 限流 400/分·4000/时的计数粒度（token/IP/用户）；429 时是否带 Retry-After | 未见官方说明；未复现 429 | 压测或咨询官方 |
| 5 | v2 新增端点参数（discussions 回复/resolve、approval-reviewers、Actions v8 全套） | v2 文档参数表 JS 渲染抓不到 | 浏览器人工查 or 实测调用 |
| 6 | 在 upstream 仓库创建 webhook 所需的最低角色 | 推测需管理员 | 用有权限账号验证 |
| 7 | 普通贡献者对 upstream PR 打标签/`need_to_resolve` 评论的权限边界 | 未实测写操作 | 用测试 PR 验证 |
| 8 | GitCode Actions（v8）与 OpenLiBing 之外，MindSpore 是否有别的门禁通道（如 enterprise v8 API 可见性） | 未查 | 低优先级 |
| 9 | `POST /pulls/{number}/comments` 行级评论的 `position` 语义细节（diff 相对行号的精确计算） | v1 文档一句话描述 | 测试 PR 实测（对齐我们 diff 渲染） |
| 10 | 官方是否会发布 forge SDK / OpenAPI spec 文件 | 目前无官方 SDK；docs 站无法导出 spec | 关注 docs ChangeLog |

---

### 附：本次实测调用记录（可复现）

```bash
# 匿名可读（公开仓库）
curl "https://api.gitcode.com/api/v5/repos/mindspore/mindformers/pulls?state=open&per_page=1"
curl "https://api.gitcode.com/api/v5/repos/mindspore/mindformers/issues?state=open"
curl "https://api.gitcode.com/api/v5/repos/mindspore/mindformers/pulls/8377/labels"
# 需 token（Bearer 实测可用）
curl -H "Authorization: Bearer $GITCODE_TOKEN" "https://api.gitcode.com/api/v5/user"
curl -H "Authorization: Bearer $GITCODE_TOKEN" "https://api.gitcode.com/api/v5/repos/mindspore/mindformers"
# 无 commit status API（均 404）
curl ".../api/v5/repos/mindspore/mindformers/statuses/<sha>"      # 404
curl ".../api/v5/repos/mindspore/mindformers/commits/<sha>/status" # 404
# v8 Actions 存在（mindformers 为空）
curl ".../api/v8/repos/mindspore/mindformers/actions/runs"  # {"total_count":0,...}
```

主要文档入口：
- v2 文档（端点全，参数表需浏览器）：https://docs.gitcode.com/docs/apis/
- v1 文档（静态、参数表全）：https://docs.gitcode.com/v1-docs/en/docs/
- webhook 帮助（事件/payload/签名）：https://docs.gitcode.com/docs/help/home/org_project/webhook/web-hook/
- PAT 帮助：https://docs.gitcode.com/docs/help/home/user_center/security_management/user_pat/
