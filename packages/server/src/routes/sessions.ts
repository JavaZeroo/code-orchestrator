/**
 * 会话与审批的 REST 面（web 前端与 curl 共用）。
 * 会话创建委托 services/spawn；gate 审批分流到工作流引擎。
 */

import type { FastifyInstance } from 'fastify';
import { and, asc, desc, eq, gt, isNotNull, isNull, lt } from 'drizzle-orm';
import * as z from 'zod';
import { approvalDecisionSchema, MessageMetaSchema, sessionAgentSchema, sessionNoteMarkdownSchema } from '@co/protocol';
import { getDb, hasDb, schema } from '../db/index';
import { decideGate } from '../engine/engine';
import { publish } from '../events';
import { forkSession, ForkError } from '../services/fork';
import { resumeSession, ResumeError } from '../services/resume';
import { archiveSession, restoreSession, SessionArchiveError } from '../services/sessionArchive';
import { appendSessionNote, deleteSessionNote, reviseSessionNote, SessionNoteError } from '../services/sessionNote';
import { spawnSession, SpawnError } from '../services/spawn';
import { ContainerSpawnQueued, spawnContainerSession } from '../services/spawnContainer';
import { resolveAndSpawn } from '../services/spawnAuto';
import { callRunner } from '../ws/runnerHub';

class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

const spawnBodySchema = z.object({
  machineId: z.string().optional(),
  cwd: z.string().optional(),
  prompt: z.string().optional(),
  agent: sessionAgentSchema.default('claude'),
  model: z.string().optional(),
  role: z.string().optional(),
  meta: MessageMetaSchema.optional(),
  env: z.record(z.string(), z.string()).optional(),
  designer: z.boolean().optional(),
  taskIntake: z.boolean().optional(),
  title: z.string().optional(),
  projectId: z.string().optional(),
  effort: MessageMetaSchema.shape.effort,
  container: z.boolean().optional(),
});

const sendBodySchema = z.object({ text: z.string().min(1), meta: MessageMetaSchema.optional() });
const createSessionNoteSchema = z.object({ markdown: sessionNoteMarkdownSchema }).strict();
const noteIdSchema = z.coerce.number().int().positive();
const renameBodySchema = z.object({ title: z.string().trim().min(1).max(120) }).strict();
const listSessionsQuerySchema = z.object({ archived: z.enum(['true', 'false']).default('false') });
const decideBodySchema = z.object({ decision: approvalDecisionSchema, decidedBy: z.string().optional() });
const workspaceFileQuerySchema = z.object({ path: z.string().min(1) });
const EVENT_PAGE_SIZE = 2000;

function requireDb() {
  if (!hasDb()) {
    throw new HttpError(503, 'DATABASE_URL 未配置');
  }
  return getDb();
}

async function findSession(sessionId: string) {
  const db = requireDb();
  const rows = await db.select().from(schema.sessions).where(eq(schema.sessions.id, sessionId)).limit(1);
  const row = rows[0];
  if (!row) {
    throw new HttpError(404, `session not found: ${sessionId}`);
  }
  return row;
}

export async function registerSessionRoutes(app: FastifyInstance): Promise<void> {
  app.setErrorHandler((err, _req, reply) => {
    if (
      err instanceof HttpError ||
      err instanceof SpawnError ||
      err instanceof ResumeError ||
      err instanceof ForkError ||
      err instanceof SessionArchiveError ||
      err instanceof SessionNoteError
    ) {
      void reply.code(err.statusCode).send({ error: err.message });
      return;
    }
    if (err instanceof z.ZodError) {
      void reply.code(400).send({ error: 'invalid request', issues: err.issues });
      return;
    }
    app.log.error(err);
    void reply.code(500).send({ error: err instanceof Error ? err.message : 'internal error' });
  });

  app.post('/api/sessions', async (req, reply) => {
    const db = requireDb();
    const body = spawnBodySchema.parse(req.body);
    // 任务受理会话：注入当前项目可用模板清单 + forge/repo 上下文
    if (body.taskIntake && body.projectId) {
      const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, body.projectId)).limit(1);
      if (project) {
        const defs = await db
          .select()
          .from(schema.workflowDefs)
          .where(and(eq(schema.workflowDefs.projectId, body.projectId), eq(schema.workflowDefs.archived, 'no')))
          .limit(50);
        const contextParts = [`项目: ${project.name} (forge=${project.forge}, repo=${project.repo})`, '', '可用模板:'];
        for (const d of defs) {
          const g = d.graph as Record<string, unknown>;
          const nodes = (g.nodes as Array<Record<string, unknown>>) ?? [];
          const varKeys = Object.keys((g.vars as Record<string, string>) ?? {});
          const needsCwd = nodes.some((n) => n.type === 'agent' && !n.cwd);
          contextParts.push(`  - id="${d.id}" name="${d.name}" vars=[${varKeys.join(',')}] needsCwd=${needsCwd}`);
        }
        body.meta = { ...body.meta, appendSystemPrompt: contextParts.join('\n') };
      }
    }
    try {
      return await resolveAndSpawn({ ...body, createdBy: req.user?.id });
    } catch (e) {
      if (e instanceof ContainerSpawnQueued) {
        void reply.code(202);
        return { queued: true, taskId: e.taskId };
      }
      throw e;
    }
  });

  // 容器化会话（design-v2 #37）：项目须配 baseImage；无空闲机 → 202 排队
  app.post('/api/container-sessions', async (req, reply) => {
    requireDb();
    const body = z
      .object({
        projectId: z.string(),
        prompt: z.string().optional(),
        agent: sessionAgentSchema.default('claude'),
        model: z.string().optional(),
        machineId: z.string().optional(),
        key: z.string().optional(),
        base: z.string().optional(),
        effort: MessageMetaSchema.shape.effort,
      })
      .parse(req.body);
    try {
      const { effort, ...rest } = body;
      return await spawnContainerSession({
        ...rest,
        meta: effort ? { effort } : undefined,
        createdBy: req.user?.id,
      });
    } catch (e) {
      if (e instanceof ContainerSpawnQueued) {
        void reply.code(202);
        return { queued: true, taskId: e.taskId };
      }
      throw e;
    }
  });

  app.get<{ Querystring: { archived?: string } }>('/api/sessions', async (req) => {
    const db = requireDb();
    const { archived } = listSessionsQuerySchema.parse(req.query);
    const rows = await db
      .select()
      .from(schema.sessions)
      .where(archived === 'true' ? isNotNull(schema.sessions.archivedAt) : isNull(schema.sessions.archivedAt))
      .orderBy(desc(archived === 'true' ? schema.sessions.archivedAt : schema.sessions.createdAt))
      .limit(100);
    return { sessions: rows };
  });

  app.get<{ Params: { id: string } }>('/api/sessions/:id', async (req) => {
    const session = await findSession(req.params.id);
    return { session };
  });

  app.patch<{ Params: { id: string } }>('/api/sessions/:id', async (req) => {
    const db = requireDb();
    const body = renameBodySchema.parse(req.body);
    const [session] = await db
      .update(schema.sessions)
      .set({ title: body.title })
      .where(eq(schema.sessions.id, req.params.id))
      .returning({ id: schema.sessions.id, title: schema.sessions.title });
    if (!session) {
      throw new HttpError(404, `session not found: ${req.params.id}`);
    }
    return { ok: true, session };
  });

  app.post<{ Params: { id: string } }>('/api/sessions/:id/resume', async (req) => {
    requireDb();
    const result = await resumeSession(req.params.id);
    return { ok: true, ...result };
  });

  app.post<{ Params: { id: string } }>('/api/sessions/:id/fork', async (req) => {
    requireDb();
    const result = await forkSession(req.params.id, req.user?.id);
    return { ok: true, ...result };
  });

  app.post<{ Params: { id: string } }>('/api/sessions/:id/archive', async (req) => {
    requireDb();
    const session = await archiveSession(req.params.id);
    return { ok: true, session: { id: session.id, archivedAt: session.archivedAt } };
  });

  app.post<{ Params: { id: string } }>('/api/sessions/:id/restore', async (req) => {
    requireDb();
    const session = await restoreSession(req.params.id);
    return { ok: true, session: { id: session.id, archivedAt: session.archivedAt } };
  });

  app.post<{ Params: { id: string } }>('/api/sessions/:id/send', async (req) => {
    const body = sendBodySchema.parse(req.body);
    const session = await findSession(req.params.id);
    const result = await callRunner(session.machineId, 'session.send', {
      sessionId: session.id,
      text: body.text,
      meta: body.meta,
    });
    if (!result.ok) {
      throw new HttpError(502, result.error ?? 'send failed');
    }
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/sessions/:id/notes', async (req, reply) => {
    requireDb();
    const body = createSessionNoteSchema.parse(req.body);
    const note = await appendSessionNote(req.params.id, {
      markdown: body.markdown,
      author: req.user?.email ?? 'ui',
    });
    void reply.code(201);
    return { note };
  });

  app.patch<{ Params: { id: string; noteId: string } }>('/api/sessions/:id/notes/:noteId', async (req) => {
    requireDb();
    const body = createSessionNoteSchema.parse(req.body);
    const note = await reviseSessionNote(req.params.id, {
      noteId: noteIdSchema.parse(req.params.noteId),
      markdown: body.markdown,
    });
    return { note };
  });

  app.delete<{ Params: { id: string; noteId: string } }>('/api/sessions/:id/notes/:noteId', async (req) => {
    requireDb();
    const note = await deleteSessionNote(req.params.id, {
      noteId: noteIdSchema.parse(req.params.noteId),
    });
    return { note };
  });

  app.post<{ Params: { id: string } }>('/api/sessions/:id/kill', async (req) => {
    const session = await findSession(req.params.id);
    await callRunner(session.machineId, 'session.kill', { sessionId: session.id });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/sessions/:id/interrupt', async (req) => {
    const session = await findSession(req.params.id);
    const result = await callRunner(session.machineId, 'session.interrupt', { sessionId: session.id });
    if (!result.ok) {
      throw new HttpError(409, result.error ?? 'interrupt failed');
    }
    return { ok: true };
  });

  /** 会话工作目录的 git 变更（web diff 面板用） */
  app.get<{ Params: { id: string } }>('/api/sessions/:id/diff', async (req) => {
    const session = await findSession(req.params.id);
    const result = await callRunner(session.machineId, 'machine.exec', {
      cmd: `git -C ${JSON.stringify(session.cwd)} diff HEAD --stat && echo '---DIFF---' && git -C ${JSON.stringify(session.cwd)} diff HEAD`,
      timeoutMs: 20_000,
    });
    if (result.exitCode !== 0) {
      return { ok: false, error: result.stderr.slice(0, 500) || '不是 git 仓库或无法读取变更' };
    }
    const [stat = '', diff = ''] = result.stdout.split("---DIFF---\n");
    return { ok: true, stat: stat.trim(), diff: diff.slice(0, 200_000) };
  });

  /** Download one bounded regular file from the host or container session workspace. */
  app.get<{ Params: { id: string }; Querystring: { path?: string } }>('/api/sessions/:id/files', async (req, reply) => {
    const session = await findSession(req.params.id);
    const { path } = workspaceFileQuerySchema.parse(req.query);
    const result = await callRunner(session.machineId, 'workspace.read', {
      root: session.cwd,
      path,
      containerId: session.containerId ?? undefined,
    });
    if (!result.ok || result.data === undefined || result.basename === undefined || result.size === undefined) {
      throw new HttpError(400, result.error ?? 'workspace file unavailable');
    }
    const data = Buffer.from(result.data, 'base64');
    if (data.length !== result.size) throw new HttpError(502, 'runner returned an invalid workspace file');
    const fallback = result.basename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'artifact';
    void reply
      .header('content-type', 'application/octet-stream')
      .header('content-length', String(data.length))
      .header('content-disposition', `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(result.basename)}`)
      .send(data);
  });

  app.get<{ Params: { id: string }; Querystring: { before?: string; since?: string } }>(
    '/api/sessions/:id/events',
    async (req) => {
      const db = requireDb();
      const since = Number(req.query.since ?? 0);
      const before = Number(req.query.before ?? 0);
      if (since > 0 && before > 0) {
        throw new HttpError(400, 'since and before cursors cannot be combined');
      }
      // 首次加载返回最新 2000 条（desc+limit+reverse，长会话不能截断尾部——
      // 否则 approval.decided / tool-call-end 永远到不了前端）；since>0 增量拉取。
      // before>0 从当前最早事件向前翻页，额外取一条用于判断是否已到开头。
      if (since > 0) {
        const rows = await db
          .select()
          .from(schema.events)
          .where(and(eq(schema.events.sessionId, req.params.id), gt(schema.events.seq, since)))
          .orderBy(asc(schema.events.seq))
          .limit(EVENT_PAGE_SIZE);
        return { events: rows, page: { hasEarlier: false, before: null } };
      }
      const latest = await db
        .select()
        .from(schema.events)
        .where(
          before > 0
            ? and(eq(schema.events.sessionId, req.params.id), lt(schema.events.seq, before))
            : eq(schema.events.sessionId, req.params.id),
        )
        .orderBy(desc(schema.events.seq))
        .limit(EVENT_PAGE_SIZE + 1);
      const hasEarlier = latest.length > EVENT_PAGE_SIZE;
      const events = latest.slice(0, EVENT_PAGE_SIZE).reverse();
      return {
        events,
        page: {
          hasEarlier,
          before: hasEarlier ? (events[0]?.seq ?? null) : null,
        },
      };
    },
  );

  app.get<{ Querystring: { status?: string } }>('/api/approvals', async (req) => {
    const db = requireDb();
    const status = (req.query.status ?? 'pending') as 'pending' | 'approved' | 'denied' | 'expired';
    const rows = await db
      .select()
      .from(schema.approvals)
      .where(eq(schema.approvals.status, status))
      .orderBy(asc(schema.approvals.createdAt))
      .limit(100);
    return { approvals: rows };
  });

  app.post<{ Params: { id: string } }>('/api/approvals/:id/decide', async (req) => {
    const body = decideBodySchema.parse(req.body);
    // 审计身份以登录用户为准，body 里的 decidedBy 仅作无鉴权模式的回退
    body.decidedBy = req.user?.email ?? body.decidedBy;
    const db = requireDb();
    const rows = await db.select().from(schema.approvals).where(eq(schema.approvals.id, req.params.id)).limit(1);
    const approval = rows[0];
    if (!approval) {
      throw new HttpError(404, `approval not found: ${req.params.id}`);
    }
    if (approval.status !== 'pending') {
      throw new HttpError(409, `approval already ${approval.status}`);
    }

    // gate 审批归引擎管
    if (approval.kind === 'gate') {
      await decideGate(approval, body.decision, body.decidedBy);
      return { ok: true, status: body.decision.behavior === 'allow' ? 'approved' : 'denied' };
    }

    // tool 审批转发给持有会话的 runner
    if (!approval.sessionId) {
      throw new HttpError(400, 'tool approval missing sessionId');
    }
    const session = await findSession(approval.sessionId);
    if (session.state === 'dead') {
      await db
        .update(schema.approvals)
        .set({ status: 'expired', decidedBy: body.decidedBy, decidedAt: new Date() })
        .where(eq(schema.approvals.id, approval.id));
      await publish({
        type: 'approval.decided',
        sessionId: approval.sessionId ?? undefined,
        runId: approval.runId ?? undefined,
        payload: { approvalId: approval.id, status: 'expired', decidedBy: body.decidedBy },
      });
      return { ok: true, status: 'expired' };
    }
    const result = await callRunner(session.machineId, 'approval.decide', {
      approvalId: approval.id,
      sessionId: session.id,
      decision: body.decision,
    });
    if (!result.ok) {
      // runner 已不认识该会话（重启丢失）：惰性回收——会话判死、审批过期
      if (result.error?.includes('session not found')) {
        await db.update(schema.sessions).set({ state: 'dead' }).where(eq(schema.sessions.id, session.id));
        await db
          .update(schema.approvals)
          .set({ status: 'expired', decidedBy: body.decidedBy, decidedAt: new Date() })
          .where(eq(schema.approvals.id, approval.id));
        await publish({
          type: 'approval.decided',
          sessionId: approval.sessionId ?? undefined,
          runId: approval.runId ?? undefined,
          payload: { approvalId: approval.id, status: 'expired', decidedBy: body.decidedBy },
        });
        return { ok: true, status: 'expired' };
      }
      throw new HttpError(502, result.error ?? 'decide failed');
    }
    const status = body.decision.behavior === 'allow' ? 'approved' : 'denied';
    await db
      .update(schema.approvals)
      .set({ status, decision: body.decision, decidedBy: body.decidedBy, decidedAt: new Date() })
      .where(eq(schema.approvals.id, approval.id));
    await publish({
      type: 'approval.decided',
      sessionId: session.id,
      payload: { approvalId: approval.id, status, decidedBy: body.decidedBy },
    });
    return { ok: true, status };
  });
}
