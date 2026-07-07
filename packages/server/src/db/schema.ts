/**
 * 数据模型，对应 docs/design.md §6。
 * 认证相关表由 better-auth 的 drizzle adapter 生成后并入（决策 §12.2），
 * users 表仅存业务扩展字段。
 */

import {
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

// ---------- 认证（better-auth 标准表，字段名对齐其 drizzle adapter 约定） ----------

export const authUser = pgTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const authSession = pgTable('session', {
  id: text('id').primaryKey(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  token: text('token').notNull().unique(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  userId: text('user_id')
    .notNull()
    .references(() => authUser.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const authAccount = pgTable('account', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: text('user_id')
    .notNull()
    .references(() => authUser.id, { onDelete: 'cascade' }),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
  refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
  scope: text('scope'),
  password: text('password'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const authVerification = pgTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** 业务扩展：每用户的 gitcode token（AES-256-GCM 加密）与绑定身份。
 *  注：per-forge token 已泛化到 forge_tokens 表；此表 gitcode 字段保留兼容，新代码用 forgeTokens。 */
export const userSettings = pgTable('user_settings', {
  userId: text('user_id')
    .primaryKey()
    .references(() => authUser.id, { onDelete: 'cascade' }),
  gitcodeTokenEnc: text('gitcode_token_enc'),
  gitcodeLogin: text('gitcode_login'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** 每用户 × 每 forge 的 token（AES-256-GCM）与绑定身份。支持 gitcode/github/… 可插拔 */
export const forgeTokens = pgTable(
  'forge_tokens',
  {
    userId: text('user_id')
      .notNull()
      .references(() => authUser.id, { onDelete: 'cascade' }),
    forge: text('forge', { enum: ['gitcode', 'github'] }).notNull(),
    tokenEnc: text('token_enc').notNull(),
    login: text('login'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.forge] })],
);

/** 每用户 × 每 LLM provider 的 API key（AES-256-GCM）。spawn 解析模型别名时优先于 server env */
export const llmKeys = pgTable(
  'llm_keys',
  {
    userId: text('user_id')
      .notNull()
      .references(() => authUser.id, { onDelete: 'cascade' }),
    provider: text('provider', { enum: ['deepseek', 'glm'] }).notNull(),
    keyEnc: text('key_enc').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.provider] })],
);

/** 每用户的飞书/Lark 自定义机器人 webhook（AES-256-GCM 加密）。
 *  PK = user_id 一对一，形态参照 userSettings。 */
export const larkWebhooks = pgTable('lark_webhooks', {
  userId: text('user_id')
    .primaryKey()
    .references(() => authUser.id, { onDelete: 'cascade' }),
  urlEnc: text('url_enc').notNull(),
  enabled: text('enabled', { enum: ['yes', 'no'] }).notNull().default('yes'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Project = per-场景策略的一等容器（grill-me 共识 Q7）：一个项目一份策略包，
 *  让「管 code-orchestrator=全自动+TDD」与「管 mindformers=全手动」干净并存。
 *  trigger 归属某 project 并继承其配置（repo/forge/默认工作流/模型/vars/自治/护栏）。 */
export const projects = pgTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  forge: text('forge', { enum: ['gitcode', 'github'] }).notNull(),
  repo: text('repo').notNull(),
  /** 自治档位：manual=每 PR 人审 / agent=agent 判断是否需人介入 / auto=绿即自动合 */
  autonomy: text('autonomy', { enum: ['manual', 'agent', 'auto'] }).notNull().default('manual'),
  /** 强制人工的护栏：改动命中这些路径 glob 一律不自动合（auto/agent 档的安全底线，可空=无护栏） */
  guardrails: jsonb('guardrails').$type<string[]>().notNull().default([]),
  /** 默认预设工作流（需求进来起哪条流水线） */
  defaultDefId: text('default_def_id'),
  /** 默认流程定义（任务受理器预选此模板，任务中心③期手加，additive） */
  defaultWorkflow: text('default_workflow'),
  /** 模型花名册：{pm, dev, se} → 预设按角色取，同一预设换项目换模型 */
  models: jsonb('models').$type<Record<string, string>>().notNull().default({}),
  /** 项目级默认 vars（如 base 分支），与 issue 变量合并注入 run */
  vars: jsonb('vars').$type<Record<string, string>>().notNull().default({}),
  // ---- design-v2：项目升为一等工作区（以下均可空，兼容存量「forge+repo 策略容器」）----
  /** 薄 base 镜像（design-v2 Q7）：容器执行基底，只装 OS+python+git；重活交给 EnvComponent。空=无容器退化路径 */
  baseImage: text('base_image'),
  /** 加速器需求（design-v2 Q11）：{kind} 或 null。非空=该项目会话独占一台对应 kind 机器 */
  accel: jsonb('accel').$type<{ kind: string } | null>(),
  /** 组件默认版本（design-v2 Q7）：{组件名: 版本}，run 可覆盖。组件定义住项目仓 .co/ */
  components: jsonb('components').$type<Record<string, string>>().notNull().default({}),
  /** 中心 bare memory 仓路径（design-v2 Q5）：co-server 托管，容器物化/回写 agent 后端记忆 */
  memoryRepo: text('memory_repo'),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** 项目在某台机器的物化记录（design-v2 Q1/Q9）：黏性调度 + 冷/热判定。
 *  ready=已 clone+可复用；co 优先把新会话黏到 ready 且有空闲卡的机器，否则溢出到新机（付一次冷物化）。 */
export const projectMaterializations = pgTable(
  'project_materializations',
  {
    projectId: text('project_id').notNull(),
    machineId: text('machine_id').notNull(),
    /** <dataRoot>/co/base/<slug> 等的落地根 */
    basePath: text('base_path').notNull(),
    status: text('status', { enum: ['materializing', 'ready', 'failed'] }).notNull().default('materializing'),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.machineId] })],
);

/** 资源预留账本（design-v2 Q4/Q11）：v1 机器粒度——一台机同时至多一个 active 预留（一机一任务）。
 *  co-server 重启后按 runner 上报的存活容器对账重建。 */
export const resourceReservations = pgTable(
  'resource_reservations',
  {
    id: text('id').primaryKey(),
    machineId: text('machine_id').notNull(),
    sessionId: text('session_id'),
    kind: text('kind'),
    status: text('status', { enum: ['reserved', 'active', 'released'] }).notNull().default('reserved'),
    acquiredAt: timestamp('acquired_at', { withTimezone: true }).notNull().defaultNow(),
    releasedAt: timestamp('released_at', { withTimezone: true }),
  },
  (t) => [index('reservations_machine_idx').on(t.machineId), index('reservations_status_idx').on(t.status)],
);

/** 任务排队（design-v2 Q9）：需要加速器的任务在无空闲机时进 pending，机器释放后 reconciler 自动派（FIFO+priority）。 */
export const taskQueue = pgTable(
  'task_queue',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id'),
    kind: text('kind'),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    priority: integer('priority').notNull().default(0),
    status: text('status', { enum: ['pending', 'scheduled', 'running', 'done', 'failed'] }).notNull().default('pending'),
    enqueuedAt: timestamp('enqueued_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('task_queue_status_idx').on(t.status)],
);

/** Work-Item 控制平面：事件日志的物化投影（CQRS 读模型）。
 *  把散落的流程（requirement/run/node/pr/approval…）统一成带血缘(parentId)+生命周期的可查可管的树。
 *  由 workProjector 订阅事件总线维护，可从 events 表重放重建。key = 自然键，保证投影幂等。 */
export const workItems = pgTable(
  'work_items',
  {
    id: text('id').primaryKey(),
    /** 自然键（如 run:<runId> / pr:<forge>:<repo>#<n> / req:<trigger>:<issue>），投影幂等用 */
    key: text('key').notNull().unique(),
    type: text('type').notNull(), // goal|phase|requirement|run|node|pr|approval
    parentId: text('parent_id'),
    title: text('title'),
    status: text('status').notNull().default('active'), // pending|active|waiting_human|blocked|done|failed|cancelled
    owner: text('owner'), // pm|dev|se|human…
    /** 归属项目(任务中心按项目过滤,design-ui-ia ①):投影时从事件 payload 或 runs 表回填 */
    projectId: text('project_id'),
    refs: jsonb('refs').$type<Record<string, unknown>>().notNull().default({}),
    meta: jsonb('meta').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
  },
  (t) => [index('work_items_parent_idx').on(t.parentId), index('work_items_type_idx').on(t.type), index('work_items_project_idx').on(t.projectId)],
);

/** 用户可自定义的 LLM 端点注册表（会话/工作流选模型时按 label 命中） */
export const llmEndpoints = pgTable('llm_endpoints', {
  id: text('id').primaryKey(),
  label: text('label').notNull().unique(),
  model: text('model').notNull(),
  baseUrl: text('base_url').notNull(),
  apiKeyEnc: text('api_key_enc').notNull(),
  createdBy: text('created_by').references(() => authUser.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const machines = pgTable('machines', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  labels: jsonb('labels').$type<string[]>().notNull().default([]),
  info: jsonb('info').$type<Record<string, unknown>>(),
  status: text('status', { enum: ['online', 'offline'] }).notNull().default('offline'),
  /** 该机数据盘根（design-v2 Q6）：co 在 <dataRoot>/co/ 下铺物化目录。每机自报，如 /data1、/data2 */
  dataRoot: text('data_root'),
  /** 加速器清单（design-v2 Q4）：[{kind,index,model?}]。由 accelerator 适配器 detect 上报（M2），替代死字段 npu */
  resources: jsonb('resources').$type<Array<{ kind: string; index: number; model?: string }>>().notNull().default([]),
  lastActiveAt: timestamp('last_active_at', { withTimezone: true }),
});

export const sessions = pgTable('sessions', {
  id: text('id').primaryKey(),
  machineId: text('machine_id')
    .notNull()
    .references(() => machines.id),
  agent: text('agent').notNull(),
  model: text('model'),
  role: text('role'),
  cwd: text('cwd').notNull(),
  state: text('state').notNull().default('starting'),
  nativeSessionId: text('native_session_id'),
  runId: text('run_id'),
  nodeId: text('node_id'),
  // ---- design-v2：会话归属项目 + 容器化执行 ----
  /** 归属项目（可空兼容存量手动会话）：物化/memory/资源都从项目取 */
  projectId: text('project_id'),
  /** docker 容器 id（design-v2 Q3）：会话跑在此容器内；空=无容器退化路径 */
  containerId: text('container_id'),
  /** 资源预留 id（design-v2 Q4）：绑定该会话独占的机器/卡；容器销毁即释放 */
  reservationId: text('reservation_id'),
  createdBy: text('created_by'),
  /** 累计用量：{inputTokens, outputTokens, cacheReadTokens, costUsd, turns} */
  usage: jsonb('usage').$type<Record<string, number>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** append-only 事件日志：系统地基（design §2） */
export const events = pgTable(
  'events',
  {
    seq: bigserial('seq', { mode: 'number' }).primaryKey(),
    sessionId: text('session_id'),
    runId: text('run_id'),
    type: text('type').notNull(),
    payload: jsonb('payload').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('events_session_idx').on(t.sessionId), index('events_run_idx').on(t.runId)],
);

export const approvals = pgTable('approvals', {
  id: text('id').primaryKey(),
  kind: text('kind', { enum: ['tool', 'gate'] }).notNull(),
  sessionId: text('session_id'),
  runId: text('run_id'),
  nodeId: text('node_id'),
  title: text('title').notNull(),
  payload: jsonb('payload').notNull(),
  risk: text('risk'),
  status: text('status', { enum: ['pending', 'approved', 'denied', 'expired'] })
    .notNull()
    .default('pending'),
  decision: jsonb('decision'),
  decidedBy: text('decided_by'),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const workflowDefs = pgTable('workflow_defs', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  version: integer('version').notNull().default(1),
  graph: jsonb('graph').notNull(),
  createdVia: text('created_via', { enum: ['chat', 'manual'] }).notNull().default('manual'),
  /** 归属项目（design-v2 #36 scoping）：空=未归属（老数据/全局） */
  projectId: text('project_id'),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  /** 归档标记（任务中心③期手加，additive）：'yes' 隐藏于模板选择器；默认 'no' */
  archived: text('archived').notNull().default('no'),
});

export const workflowRuns = pgTable('workflow_runs', {
  id: text('id').primaryKey(),
  defId: text('def_id')
    .notNull()
    .references(() => workflowDefs.id),
  /** 归属项目（design-v2 #36 scoping）：从 trigger/def 继承 */
  projectId: text('project_id'),
  status: text('status', { enum: ['running', 'waiting_human', 'done', 'failed', 'cancelled'] })
    .notNull()
    .default('running'),
  context: jsonb('context').$type<Record<string, unknown>>().notNull().default({}),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp('ended_at', { withTimezone: true }),
});

export const nodeStates = pgTable(
  'node_states',
  {
    runId: text('run_id')
      .notNull()
      .references(() => workflowRuns.id),
    nodeId: text('node_id').notNull(),
    status: text('status', {
      enum: ['pending', 'running', 'waiting_human', 'done', 'failed', 'skipped'],
    })
      .notNull()
      .default('pending'),
    sessionId: text('session_id'),
    output: jsonb('output'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.runId, t.nodeId] })],
);

export const meetingRecords = pgTable('meeting_records', {
  id: text('id').primaryKey(),
  runId: text('run_id').notNull(),
  nodeId: text('node_id').notNull(),
  participants: jsonb('participants').notNull(),
  rounds: jsonb('rounds').notNull(),
  verdict: text('verdict'),
  minutesMd: text('minutes_md'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** forge PR/issue ↔ 工作流的映射、轮询快照与 nudge 记账 */
export const forgeRefs = pgTable('forge_refs', {
  id: text('id').primaryKey(),
  /** 代码托管后端；存量行默认 gitcode */
  forge: text('forge', { enum: ['gitcode', 'github'] }).notNull().default('gitcode'),
  kind: text('kind', { enum: ['pr', 'issue'] }).notNull(),
  repo: text('repo').notNull(),
  number: integer('number').notNull(),
  runId: text('run_id'),
  nodeId: text('node_id'),
  /** nudge 注入目标会话 */
  sessionId: text('session_id'),
  ciStatus: text('ci_status'),
  /** 上次轮询快照：labels[]、lastCommentId、mergeable 关键位 */
  snapshot: jsonb('snapshot').$type<Record<string, unknown>>(),
  /** 各原因的 nudge 次数（去重封顶用，AO reactions 语义） */
  nudgeCounts: jsonb('nudge_counts').$type<Record<string, number>>().notNull().default({}),
  active: text('active', { enum: ['yes', 'no'] }).notNull().default('yes'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** 需求录入触发器（task #22）：某 forge repo 的 issue 满足过滤条件 → 自动起工作流。
 *  最初愿景的入口：需求（issue）进来 → 分析 → 拆解 → 设计 → 实现 → PR → 门禁回流。 */
export const requirementTriggers = pgTable('requirement_triggers', {
  id: text('id').primaryKey(),
  /** 归属项目（可空兼容存量）：起 run 时继承项目的 vars/模型/自治等策略 */
  projectId: text('project_id').references(() => projects.id),
  forge: text('forge', { enum: ['gitcode', 'github'] }).notNull(),
  repo: text('repo').notNull(),
  defId: text('def_id')
    .notNull()
    .references(() => workflowDefs.id),
  /** 仅匹配含全部这些标签的 issue（空 = 不限） */
  labels: jsonb('labels').$type<string[]>().notNull().default([]),
  /** 标题正则/子串过滤（空 = 不限） */
  titlePattern: text('title_pattern'),
  /** 注入工作流的静态附加变量（如 cwd / base 分支）；与自动 issue 变量合并 */
  vars: jsonb('vars').$type<Record<string, string>>().notNull().default({}),
  /** 首次启用时是否对现存 open issue 也触发（默认 no：只建立基线，之后的新 issue 才触发） */
  backfill: text('backfill', { enum: ['yes', 'no'] }).notNull().default('no'),
  enabled: text('enabled', { enum: ['yes', 'no'] }).notNull().default('yes'),
  createdBy: text('created_by'),
  /** 上次轮询时刻（增量 since 水位 + 首轮基线判定） */
  lastPolledAt: timestamp('last_polled_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** 需求录入记录：命中触发器的 issue → run 追溯（同时是需求列表 + 去重水位）。
 *  唯一索引 (trigger_id, issue_number) 保证同一 issue 只触发一次（并发轮询下抢占插入）。 */
export const requirementIntakes = pgTable(
  'requirement_intakes',
  {
    id: text('id').primaryKey(),
    triggerId: text('trigger_id')
      .notNull()
      .references(() => requirementTriggers.id, { onDelete: 'cascade' }),
    /** 归属项目（design-v2 #36 scoping）：从 trigger 继承 */
    projectId: text('project_id'),
    forge: text('forge', { enum: ['gitcode', 'github'] }).notNull(),
    repo: text('repo').notNull(),
    issueNumber: text('issue_number').notNull(),
    title: text('title'),
    author: text('author'),
    issueUrl: text('issue_url'),
    runId: text('run_id'),
    /** seeded=基线仅记录未触发 started=已起工作流 failed=起工作流失败 */
    status: text('status', { enum: ['seeded', 'started', 'failed'] }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('req_intake_trigger_issue_uniq').on(t.triggerId, t.issueNumber)],
);
