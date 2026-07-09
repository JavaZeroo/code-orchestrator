/**
 * 组件源登记与下发（design-machines-env B1）：
 * 版本→URL 登记表；下发 = 目标机 runner 后台 wget+sha256 校验+原子落
 * <dataRoot>/co/cache/<组件>/<版本>/，完成与否由心跳扫描回报（机器行可见）。
 */

import type { FastifyInstance } from 'fastify';
import { createId } from '@paralleldrive/cuid2';
import { desc, eq } from 'drizzle-orm';
import * as z from 'zod';
import { getDb, schema } from '../db/index';
import { callRunner, listMachines } from '../ws/runnerHub';

const createSchema = z.object({
  component: z.string().trim().min(1).max(40).regex(/^[a-z0-9-]+$/, '小写字母数字连字符'),
  version: z.string().trim().min(1).max(80).regex(/^[\w.+-]+$/),
  url: z.string().url(),
  sha256: z.string().trim().regex(/^[a-f0-9]{64}$/i).optional(),
});

export async function registerComponentRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/component-sources', async () => {
    const rows = await getDb().select().from(schema.componentSources).orderBy(desc(schema.componentSources.createdAt));
    return { sources: rows };
  });

  app.post('/api/component-sources', async (req, reply) => {
    const body = createSchema.parse(req.body);
    const id = createId();
    try {
      await getDb().insert(schema.componentSources).values({ ...body, id, createdBy: req.user?.id });
    } catch {
      void reply.code(409);
      return { error: `已存在: ${body.component} ${body.version}` };
    }
    void reply.code(201);
    return { id };
  });

  app.delete<{ Params: { id: string } }>('/api/component-sources/:id', async (req) => {
    await getDb().delete(schema.componentSources).where(eq(schema.componentSources.id, req.params.id));
    return { ok: true };
  });

  /** 下发到指定机器：后台执行，完成后由 runner 心跳扫描回报（UI 轮询机器行即可见） */
  app.post<{ Params: { id: string } }>('/api/component-sources/:id/dispatch', async (req, reply) => {
    const body = z.object({ machineId: z.string() }).parse(req.body);
    const [src] = await getDb().select().from(schema.componentSources).where(eq(schema.componentSources.id, req.params.id)).limit(1);
    if (!src) {
      void reply.code(404);
      return { error: 'source not found' };
    }
    const machine = listMachines().find((m) => m.id === body.machineId);
    if (!machine) {
      void reply.code(409);
      return { error: '机器不在线' };
    }
    if (!machine.dataRoot) {
      void reply.code(400);
      return { error: '该机器未配置 DATA_ROOT，无处安放缓存' };
    }
    // 原子语义：下载到 .fetch-*.tmp，校验通过才 mv 成正式版本目录（扫描只认非隐藏目录）
    const root = `${machine.dataRoot}/co/cache`;
    const tmp = `${root}/.fetch-${src.component}-${src.version}.tmp`;
    const log = `${root}/.fetch-${src.component}-${src.version}.log`;
    const dest = `${root}/${src.component}/${src.version}`;
    const shaCheck = src.sha256
      ? `FILE=$(ls); echo "${src.sha256}  $FILE" | sha256sum -c -`
      : `true`;
    const script = `rm -rf ${tmp} && mkdir -p ${tmp} && cd ${tmp} && ` +
      `curl -fSLO --retry 3 ${JSON.stringify(src.url)} && ${shaCheck} && ` +
      `mkdir -p ${JSON.stringify(`${root}/${src.component}`)} && rm -rf ${JSON.stringify(dest)} && mv ${tmp} ${JSON.stringify(dest)}`;
    // 日志重定向的目录必须在 nohup 拉起前就位（否则后台任务因打不开日志静默夭折）
    const result = await callRunner(body.machineId, 'machine.exec', {
      cmd: `mkdir -p ${root} && { nohup sh -c ${JSON.stringify(script)} > ${JSON.stringify(log)} 2>&1 & } && echo started`,
      timeoutMs: 15_000,
    });
    if (result.exitCode !== 0) {
      void reply.code(502);
      return { error: result.stderr.slice(0, 300) || 'dispatch failed' };
    }
    return { ok: true, note: '后台下载中，完成后机器组件缓存自动更新（日志在 cache/.fetch-*.log）' };
  });
}
