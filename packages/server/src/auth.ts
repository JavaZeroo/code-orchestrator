/**
 * better-auth 集成（决策 §12.2）：email/password + drizzle(pg)。
 * 挂载 /api/auth/*；requireUser() 供全局鉴权钩子使用。
 */

import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getDb, schema } from './db/index';
import { env } from './env';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
}

function createAuth() {
  if (!env.AUTH_SECRET) {
    throw new Error('AUTH_SECRET 未配置，无法启用认证');
  }
  return betterAuth({
    secret: env.AUTH_SECRET,
    baseURL: env.PUBLIC_URL,
    trustedOrigins: [env.PUBLIC_URL, 'http://localhost:5173', 'http://127.0.0.1:5173'],
    emailAndPassword: { enabled: true },
    database: drizzleAdapter(getDb(), {
      provider: 'pg',
      schema: {
        user: schema.authUser,
        session: schema.authSession,
        account: schema.authAccount,
        verification: schema.authVerification,
      },
    }),
  });
}

let _auth: ReturnType<typeof createAuth> | null = null;

export function getAuth() {
  if (!_auth) {
    _auth = createAuth();
  }
  return _auth;
}

function toWebHeaders(req: FastifyRequest): Headers {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === 'string') {
      headers.set(k, v);
    } else if (Array.isArray(v)) {
      headers.set(k, v.join(','));
    }
  }
  return headers;
}

function toWebRequest(req: FastifyRequest): Request {
  const proto = (req.headers['x-forwarded-proto'] as string) ?? 'http';
  const url = `${proto}://${req.headers.host}${req.url}`;
  const method = req.method.toUpperCase();
  const body = method === 'GET' || method === 'HEAD' ? undefined : JSON.stringify(req.body ?? {});
  return new Request(url, { method, headers: toWebHeaders(req), body });
}

/** 挂载 better-auth 的所有端点到 /api/auth/* */
export function mountAuthRoutes(app: FastifyInstance): void {
  app.route({
    method: ['GET', 'POST'],
    url: '/api/auth/*',
    handler: async (req, reply) => {
      const res = await getAuth().handler(toWebRequest(req));
      void reply.status(res.status);
      res.headers.forEach((value, key) => {
        void reply.header(key, value);
      });
      const buf = Buffer.from(await res.arrayBuffer());
      void reply.send(buf.length > 0 ? buf : undefined);
    },
  });
}

export async function sessionUser(req: FastifyRequest): Promise<AuthUser | null> {
  const session = await getAuth().api.getSession({ headers: toWebHeaders(req) });
  if (!session) {
    return null;
  }
  return { id: session.user.id, email: session.user.email, name: session.user.name };
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthUser;
  }
}

/** 全局鉴权钩子：/api/* 需登录（auth 自身端点与 /health、/ws 除外） */
export function installAuthGuard(app: FastifyInstance): void {
  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    const url = req.url;
    if (!url.startsWith('/api/') || url.startsWith('/api/auth/')) {
      return;
    }
    const user = await sessionUser(req);
    if (!user) {
      void reply.code(401).send({ error: 'unauthorized' });
      return reply;
    }
    req.user = user;
  });
}
