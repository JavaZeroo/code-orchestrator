/** Work-Item 控制平面读接口：血缘树（roots→children）+ 单项。management 动作后续在此扩展。 */

import type { FastifyInstance } from 'fastify';
import { desc, eq } from 'drizzle-orm';
import { getDb, schema } from '../db/index';

type Row = typeof schema.workItems.$inferSelect;
interface Node extends Row {
  children: Node[];
}

function buildTree(rows: Row[]): Node[] {
  const byId = new Map<string, Node>();
  for (const r of rows) {
    byId.set(r.id, { ...r, children: [] });
  }
  const roots: Node[] = [];
  for (const n of byId.values()) {
    const parent = n.parentId ? byId.get(n.parentId) : undefined;
    if (parent) {
      parent.children.push(n);
    } else {
      roots.push(n);
    }
  }
  // 子节点按创建时间升序，roots 按更新时间降序（最近活跃在前）
  for (const n of byId.values()) {
    n.children.sort((a, b) => +new Date(a.createdAt) - +new Date(b.createdAt));
  }
  roots.sort((a, b) => +new Date(b.updatedAt) - +new Date(a.updatedAt));
  return roots;
}

export async function registerWorkRoutes(app: FastifyInstance): Promise<void> {
  /** 血缘树：最近 N 个 work item 组装成 roots→children */
  app.get<{ Querystring: { limit?: string; type?: string } }>('/api/work', async (req) => {
    const db = getDb();
    const limit = Math.min(Number(req.query.limit ?? 500), 2000);
    const rows = await db.select().from(schema.workItems).orderBy(desc(schema.workItems.updatedAt)).limit(limit);
    return { tree: buildTree(rows), count: rows.length };
  });

  /** 单个 work item + 直接子项 */
  app.get<{ Params: { id: string } }>('/api/work/:id', async (req, reply) => {
    const db = getDb();
    const item = (await db.select().from(schema.workItems).where(eq(schema.workItems.id, req.params.id)).limit(1))[0];
    if (!item) {
      void reply.code(404);
      return { error: 'work item not found' };
    }
    const children = await db.select().from(schema.workItems).where(eq(schema.workItems.parentId, item.id)).orderBy(schema.workItems.createdAt);
    return { item, children };
  });
}
