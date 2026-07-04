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

/** 业务扩展：每用户的 gitcode token（AES-256-GCM 加密）与绑定身份 */
export const userSettings = pgTable('user_settings', {
  userId: text('user_id')
    .primaryKey()
    .references(() => authUser.id, { onDelete: 'cascade' }),
  gitcodeTokenEnc: text('gitcode_token_enc'),
  gitcodeLogin: text('gitcode_login'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const machines = pgTable('machines', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  labels: jsonb('labels').$type<string[]>().notNull().default([]),
  info: jsonb('info').$type<Record<string, unknown>>(),
  status: text('status', { enum: ['online', 'offline'] }).notNull().default('offline'),
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
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const workflowRuns = pgTable('workflow_runs', {
  id: text('id').primaryKey(),
  defId: text('def_id')
    .notNull()
    .references(() => workflowDefs.id),
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

/** gitcode PR/issue ↔ 工作流的映射、轮询快照与 nudge 记账 */
export const forgeRefs = pgTable('forge_refs', {
  id: text('id').primaryKey(),
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
