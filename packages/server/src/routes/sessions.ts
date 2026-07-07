/**
 * 会话与审批的 REST 面（web 前端与 curl 共用）。
 * 会话创建委托 services/spawn；gate 审批分流到工作流引擎。
 */

import type { FastifyInstance } from 'fastify';
import { and, asc, desc, eq } from 'drizzle-orm';
import * as z from 'zod';
import { approvalDecisionSchema, MessageMetaSchema, sessionAgentSchema } from '@co/protocol';
import { getDb, hasDb, schema } from '../db/index';
import { decideGate } from '../engine/engine';
import { publish } from '../events';
import { spawnSession, SpawnError } from '../services/spawn';
import { ContainerSpawnQueued, spawnContainerSession } from '../services/spawnContainer';
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
  machineId: z.string(),
  cwd: z.string(),
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
});

const sendBodySchema = z.object({ text: z.string().min(1), meta: MessageMetaSchema.optional() });
const decideBodySchema = z.object({ decision: approvalDecisionSchema, decidedBy: z.string().optional() });

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
    if (err instanceof HttpError || err instanceof SpawnError) {
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

  app.post('/api/sessions', async (req) => {
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
    return spawnSession({ ...body, createdBy: req.user?.id });
  });

  // 容器化会话（design-v2 #37）：项目须配 baseImage；无空闲机 → 202 排队
  app.post('/api/container-sessions', async (req, reply) => {
    requireDb();
    const body = z
      .object({
        projectId: z.string(),
        prompt: z.string().optional(),
        model: z.string().optional(),
        machineId: z.string().optional(),
        key: z.string().optional(),
        base: z.string().optional(),
      })
      .parse(req.body);
    try {
      return await spawnContainerSession({ ...body, createdBy: req.user?.id });
    } catch (e) {
      if (e instanceof ContainerSpawnQueued) {
        void reply.code(202);
        return { queued: true, taskId: e.taskId };
      }
      throw e;
    }
  });

  app.get('/api/sessions', async () => {
    const db = requireDb();
    const rows = await db.select().from(schema.sessions).orderBy(desc(schema.sessions.createdAt)).limit(100);
    return { sessions: rows };
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

  app.get<{ Params: { id: string }; Querystring: { since?: string } }>(
    '/api/sessions/:id/events',
    async (req) => {
      const db = requireDb();
      const since = Number(req.query.since ?? 0);
      const rows = await db
        .select()
        .from(schema.events)
        .where(eq(schema.events.sessionId, req.params.id))
        .orderBy(asc(schema.events.seq))
        .limit(500);
      return { events: since > 0 ? rows.filter((r) => r.seq > since) : rows };
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
