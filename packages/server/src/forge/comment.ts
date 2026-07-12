import { eq } from 'drizzle-orm';
import { getDb, schema } from '../db/index';
import { getForge } from './registry';
import { userForgeToken } from './tokens';
import type { ForgeKind } from './types';

type ForgeRef = Pick<typeof schema.forgeRefs.$inferSelect, 'id' | 'forge' | 'kind' | 'repo' | 'number' | 'active'>;

export interface ForgeCommentResult {
  ok: true;
  commentId: number;
}

export interface ForgeCommentDependencies {
  findRef(id: string): Promise<ForgeRef | undefined>;
  requesterToken(userId: string, forge: ForgeKind): Promise<string | undefined>;
  postComment(ref: ForgeRef, body: string, token: string): Promise<{ id: number }>;
}

export class ForgeCommentError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
  }
}

const defaultDependencies: ForgeCommentDependencies = {
  async findRef(id) {
    const rows = await getDb().select().from(schema.forgeRefs).where(eq(schema.forgeRefs.id, id)).limit(1);
    return rows[0];
  },
  requesterToken: userForgeToken,
  postComment: (ref, body, token) => getForge(ref.forge).createPullComment(ref.repo, ref.number, body, token),
};

/** Posts one comment to an active tracked PR using only the requester's forge identity. */
export class ForgeCommentService {
  private readonly inFlight = new Map<string, Promise<ForgeCommentResult>>();

  constructor(private readonly deps: ForgeCommentDependencies = defaultDependencies) {}

  request(refId: string, body: string, userId?: string): Promise<ForgeCommentResult> {
    const comment = body.trim();
    const key = `${userId ?? 'anonymous'}:${refId}:${comment}`;
    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const request = this.perform(refId, comment, userId);
    this.inFlight.set(key, request);
    const clear = () => {
      if (this.inFlight.get(key) === request) this.inFlight.delete(key);
    };
    void request.then(clear, clear);
    return request;
  }

  private async perform(refId: string, body: string, userId?: string): Promise<ForgeCommentResult> {
    if (!userId) throw new ForgeCommentError(401, '登录后才能发布 PR 评论');
    if (!body) throw new ForgeCommentError(400, '评论不能为空');

    const ref = await this.deps.findRef(refId);
    if (!ref) throw new ForgeCommentError(404, `forge ref not found: ${refId}`);
    if (ref.active !== 'yes') throw new ForgeCommentError(409, '该 forge ref 已停止跟踪');
    if (ref.kind !== 'pr') throw new ForgeCommentError(400, '只有 PR ref 可以发布评论');

    const token = await this.deps.requesterToken(userId, ref.forge);
    if (!token) throw new ForgeCommentError(403, `当前用户未绑定 ${ref.forge === 'github' ? 'GitHub' : 'GitCode'} token`);

    try {
      const result = await this.deps.postComment(ref, body, token);
      return { ok: true, commentId: result.id };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new ForgeCommentError(502, `${ref.forge === 'github' ? 'GitHub' : 'GitCode'} PR 评论发布失败：${detail}`);
    }
  }
}

export const forgeCommentService = new ForgeCommentService();
