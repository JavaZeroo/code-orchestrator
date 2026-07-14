/** Project 一等配置容器的 CRUD（grill-me 共识 Q7）。trigger 归属 project、继承其策略。 */

import type { FastifyInstance } from 'fastify';
import { createId } from '@paralleldrive/cuid2';
import { and, desc, eq } from 'drizzle-orm';
import * as z from 'zod';
import { getDb, schema } from '../db/index';
import { EngineError, startRun } from '../engine/engine';
import { publish } from '../events';
import { getForge, isForgeKind } from '../forge/registry';
import { anyForgeToken, userForgeToken } from '../forge/tokens';
import { provisionWorkspace } from '../forge/workspace';

const bodySchema = z.object({
  name: z.string().min(1),
  forge: z.enum(['gitcode', 'github']),
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, '格式: owner/repo'),
  autonomy: z.enum(['manual', 'agent', 'auto']).default('manual'),
  guardrails: z.array(z.string()).default([]),
  defaultDefId: z.string().nullable().optional(),
  /** 默认流程定义（任务受理器预选此模板） */
  defaultWorkflow: z.string().nullable().optional(),
  models: z.record(z.string(), z.string()).default({}),
  vars: z.record(z.string(), z.string()).default({}),
  // design-v2：容器化执行配置
  baseImage: z.string().nullable().optional(),
  accel: z.object({ kind: z.string() }).nullable().optional(),
  components: z.record(z.string(), z.string()).optional(),
  memoryRepo: z.string().nullable().optional(),
});

export async function registerProjectRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/projects', async (req, reply) => {
    const body = bodySchema.parse(req.body);
    const id = createId();
    await getDb().insert(schema.projects).values({ id, ...body, defaultDefId: body.defaultDefId ?? null, createdBy: req.user?.id });
    void reply.code(201);
    return { id };
  });

  app.get('/api/projects', async () => {
    const rows = await getDb().select().from(schema.projects).orderBy(desc(schema.projects.createdAt)).limit(200);
    return { projects: rows };
  });

  /** 「走流水线」一键直达：真建 issue → 与 forge intake 同形状的 vars → startRun。
   *  手动/自动两条入口在 issue 语义上合一（grill 决议 2026-07-08）；
   *  若项目有命中同仓的启用触发器，标题自动补其字面前缀并写入去重表，防轮询二次触发。 */
  app.post<{ Params: { id: string } }>('/api/projects/:id/dispatch', async (req, reply) => {
    const body = z.object({ text: z.string().trim().min(1), defId: z.string().optional() }).parse(req.body);
    const db = getDb();
    const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, req.params.id)).limit(1);
    if (!project) {
      void reply.code(404);
      return { error: 'project not found' };
    }
    const defId = body.defId ?? project.defaultWorkflow;
    if (!defId) {
      void reply.code(400);
      return { error: '项目未设置默认流水线——去 项目设置→流水线 创建或设默认' };
    }
    const [def] = await db.select().from(schema.workflowDefs).where(eq(schema.workflowDefs.id, defId)).limit(1);
    if (!def || def.archived === 'yes') {
      void reply.code(400);
      return { error: `流水线不存在或已归档: ${defId}` };
    }
    if (!isForgeKind(project.forge)) {
      void reply.code(400);
      return { error: `未知 forge: ${project.forge}` };
    }
    const forgeKind = project.forge;
    const token = (req.user?.id ? await userForgeToken(req.user.id, forgeKind) : undefined) ?? (await anyForgeToken(forgeKind));
    if (!token) {
      void reply.code(400);
      return { error: `未绑定 ${forgeKind} 令牌——「走流水线」需要真实建 issue，请先在设置里绑定` };
    }

    // 标题=首行截断；命中同仓启用触发器时补其 ^\[xxx\] 字面前缀（保持仓面惯例 + 让 run 可被触发器语义归类）
    let title = (body.text.split('\n', 1)[0] ?? '').trim().slice(0, 80) || '未命名任务';
    const triggers = await db
      .select()
      .from(schema.requirementTriggers)
      .where(and(eq(schema.requirementTriggers.repo, project.repo), eq(schema.requirementTriggers.enabled, 'yes')));
    const trigger = triggers.find((t) => t.projectId === project.id) ?? triggers[0];
    const prefixMatch = trigger?.titlePattern?.match(/^\^\\\[([^\\\]]+)\\\]/);
    if (trigger?.titlePattern && prefixMatch) {
      try {
        if (!new RegExp(trigger.titlePattern, 'i').test(title)) {
          title = `[${prefixMatch[1]}] ${title}`;
        }
      } catch { /* 非法正则则不补前缀 */ }
    }

    const forge = getForge(forgeKind);
    const issue = await forge.createIssue(project.repo, { title, body: body.text }, token);

    // 触发器去重记账：轮询器靠 (trigger_id, issue_number) 唯一索引跳过我们已直接启动的 issue
    let intakeId: string | undefined;
    if (trigger) {
      const inserted = await db
        .insert(schema.requirementIntakes)
        .values({
          id: createId(),
          triggerId: trigger.id,
          projectId: project.id,
          forge: forgeKind,
          repo: project.repo,
          issueNumber: issue.number,
          title,
          author: req.user?.email ?? 'ui',
          issueUrl: issue.htmlUrl,
          status: 'started',
        })
        .onConflictDoNothing({ target: [schema.requirementIntakes.triggerId, schema.requirementIntakes.issueNumber] })
        .returning({ id: schema.requirementIntakes.id });
      intakeId = inserted[0]?.id;
    }

    const vars: Record<string, string> = {
      ...project.vars,
      ...(trigger?.vars ?? {}),
      forge: forgeKind,
      repo: project.repo,
      issue_number: String(issue.number),
      issue_title: title,
      issue_body: body.text,
      issue_url: issue.htmlUrl ?? '',
      issue_author: req.user?.email ?? 'ui',
    };
    const ws = await provisionWorkspace(forgeKind, project.repo, String(issue.number), vars.base ?? 'main');
    if (ws) {
      vars.cwd = ws.cwd;
      vars.branch = ws.branch;
    }

    try {
      const runId = await startRun(defId, vars, project.id, undefined, req.user?.id);
      if (intakeId) {
        await db.update(schema.requirementIntakes).set({ runId }).where(eq(schema.requirementIntakes.id, intakeId));
      }
      await publish({
        type: 'requirement.triggered',
        runId,
        payload: { projectId: project.id, project: project.name, forge: forgeKind, repo: project.repo, issue: issue.number, title, url: issue.htmlUrl, via: 'dispatch' },
      });
      void reply.code(201);
      return { runId, issueNumber: issue.number, issueUrl: issue.htmlUrl };
    } catch (err) {
      if (intakeId) {
        await db.update(schema.requirementIntakes).set({ status: 'failed' }).where(eq(schema.requirementIntakes.id, intakeId));
      }
      if (err instanceof EngineError) {
        void reply.code(err.statusCode);
        return { error: err.message };
      }
      throw err;
    }
  });

  app.get<{ Params: { id: string } }>('/api/projects/:id/materializations', async (req) => {
    const rows = await getDb()
      .select({
        machineId: schema.projectMaterializations.machineId,
        basePath: schema.projectMaterializations.basePath,
        status: schema.projectMaterializations.status,
      })
      .from(schema.projectMaterializations)
      .where(eq(schema.projectMaterializations.projectId, req.params.id));
    return { materializations: rows };
  });

  app.patch<{ Params: { id: string } }>('/api/projects/:id', async (req, reply) => {
    const patch = bodySchema.partial().parse(req.body ?? {});
    if (Object.keys(patch).length === 0) {
      void reply.code(400);
      return { error: '无更新字段' };
    }
    await getDb().update(schema.projects).set(patch).where(eq(schema.projects.id, req.params.id));
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>('/api/projects/:id', async (req) => {
    // 先解绑其 trigger 的 projectId，再删项目（避免 FK 阻塞）
    await getDb().update(schema.requirementTriggers).set({ projectId: null }).where(eq(schema.requirementTriggers.projectId, req.params.id));
    await getDb().delete(schema.projects).where(eq(schema.projects.id, req.params.id));
    return { ok: true };
  });
}
