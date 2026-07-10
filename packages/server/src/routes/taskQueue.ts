/** 项目级排队容器会话：只暴露可识别的摘要，不把完整 spawn payload（createdBy 等）返回前端。 */

import type { FastifyInstance } from 'fastify';
import * as z from 'zod';
import { hasDb } from '../db/index';
import {
  cancelQueuedTask,
  listQueuedTasks,
  reprioritizeQueuedTask,
  retryFailedQueuedTask,
} from '../services/taskQueue';

interface ProjectParams {
  projectId: string;
}

interface QueuedSessionParams extends ProjectParams {
  taskId: string;
}

const priorityBodySchema = z.object({
  priority: z.number().int().min(-2_147_483_648).max(2_147_483_647),
});

export async function registerTaskQueueRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: ProjectParams }>('/api/projects/:projectId/queued-sessions', async (req, reply) => {
    if (!hasDb()) {
      return reply.code(503).send({ error: 'database not available' });
    }
    const tasks = await listQueuedTasks(req.params.projectId);
    return {
      tasks: tasks.map((task) => ({
        id: task.id,
        projectId: task.projectId,
        kind: task.kind,
        priority: task.priority,
        status: task.status,
        enqueuedAt: task.enqueuedAt,
        prompt: typeof task.payload.prompt === 'string' ? task.payload.prompt : null,
        agent: typeof task.payload.agent === 'string' ? task.payload.agent : null,
        model: typeof task.payload.model === 'string' ? task.payload.model : null,
      })),
    };
  });

  app.patch<{ Params: QueuedSessionParams }>(
    '/api/projects/:projectId/queued-sessions/:taskId',
    async (req, reply) => {
      if (!hasDb()) {
        return reply.code(503).send({ error: 'database not available' });
      }
      const { priority } = priorityBodySchema.parse(req.body ?? {});
      const result = await reprioritizeQueuedTask(req.params.projectId, req.params.taskId, priority);
      if (result.outcome === 'not-found') {
        return reply.code(404).send({ error: 'queued session not found' });
      }
      if (result.outcome === 'conflict') {
        return reply.code(409).send({ error: 'queued session is no longer pending', status: result.status });
      }
      return { ok: true, priority: result.priority };
    },
  );

  app.post<{ Params: QueuedSessionParams }>(
    '/api/projects/:projectId/queued-sessions/:taskId/retry',
    async (req, reply) => {
      if (!hasDb()) {
        return reply.code(503).send({ error: 'database not available' });
      }
      const result = await retryFailedQueuedTask(req.params.projectId, req.params.taskId);
      if (result.outcome === 'not-found') {
        return reply.code(404).send({ error: 'queued session not found' });
      }
      if (result.outcome === 'conflict') {
        return reply.code(409).send({ error: 'queued session is not failed', status: result.status });
      }
      return { ok: true };
    },
  );

  app.delete<{ Params: QueuedSessionParams }>(
    '/api/projects/:projectId/queued-sessions/:taskId',
    async (req, reply) => {
      if (!hasDb()) {
        return reply.code(503).send({ error: 'database not available' });
      }
      const result = await cancelQueuedTask(req.params.projectId, req.params.taskId);
      if (result.outcome === 'not-found') {
        return reply.code(404).send({ error: 'queued session not found' });
      }
      if (result.outcome === 'conflict') {
        return reply.code(409).send({ error: 'queued session is no longer pending', status: result.status });
      }
      return { ok: true };
    },
  );
}
