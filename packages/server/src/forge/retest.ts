import { eq } from 'drizzle-orm';
import { getDb, schema } from '../db/index';
import { getForge } from './registry';
import { userForgeToken } from './tokens';

const RETEST_COMMENT = '/retest';

type ForgeRef = Pick<
  typeof schema.forgeRefs.$inferSelect,
  'id' | 'forge' | 'kind' | 'repo' | 'number' | 'active'
>;

export interface ForgeRetestResult {
  ok: true;
  confirmation: 'pending';
}

export interface ForgeRetestDependencies {
  findRef(id: string): Promise<ForgeRef | undefined>;
  requesterToken(userId: string): Promise<string | undefined>;
  postComment(ref: ForgeRef, body: string, token: string): Promise<unknown>;
}

export class ForgeRetestError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

const defaultDependencies: ForgeRetestDependencies = {
  async findRef(id) {
    const rows = await getDb().select().from(schema.forgeRefs).where(eq(schema.forgeRefs.id, id)).limit(1);
    return rows[0];
  },
  requesterToken: (userId) => userForgeToken(userId, 'gitcode'),
  postComment: (ref, body, token) => getForge('gitcode').createPullComment(ref.repo, ref.number, body, token),
};

/**
 * Posts the GitCode retest command for one tracked PR. Concurrent requests from
 * the same user for the same ref share one promise, so only one comment is sent.
 */
export class ForgeRetestService {
  private readonly inFlight = new Map<string, Promise<ForgeRetestResult>>();

  constructor(private readonly deps: ForgeRetestDependencies = defaultDependencies) {}

  request(refId: string, userId?: string): Promise<ForgeRetestResult> {
    const key = `${userId ?? 'anonymous'}:${refId}`;
    const existing = this.inFlight.get(key);
    if (existing) {
      return existing;
    }

    const request = this.perform(refId, userId);
    this.inFlight.set(key, request);
    const clear = () => {
      if (this.inFlight.get(key) === request) {
        this.inFlight.delete(key);
      }
    };
    void request.then(clear, clear);
    return request;
  }

  private async perform(refId: string, userId?: string): Promise<ForgeRetestResult> {
    if (!userId) {
      throw new ForgeRetestError(401, '登录后才能触发 GitCode CI 重跑');
    }

    const ref = await this.deps.findRef(refId);
    if (!ref) {
      throw new ForgeRetestError(404, `forge ref not found: ${refId}`);
    }
    if (ref.active !== 'yes') {
      throw new ForgeRetestError(409, '该 forge ref 已停止跟踪');
    }
    if (ref.kind !== 'pr') {
      throw new ForgeRetestError(400, '只有 PR ref 可以触发 CI 重跑');
    }
    if (ref.forge !== 'gitcode') {
      throw new ForgeRetestError(400, 'CI 重跑目前仅支持 GitCode PR');
    }

    const token = await this.deps.requesterToken(userId);
    if (!token) {
      throw new ForgeRetestError(403, '当前用户未绑定 GitCode token');
    }

    try {
      await this.deps.postComment(ref, RETEST_COMMENT, token);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new ForgeRetestError(502, `GitCode /retest 发布失败：${detail}`);
    }

    return { ok: true, confirmation: 'pending' };
  }
}

export const forgeRetestService = new ForgeRetestService();
