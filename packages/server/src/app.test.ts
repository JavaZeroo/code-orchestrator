import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from './app';

let app: FastifyInstance | null = null;

async function testApp() {
  app = await createApp({ logger: false, serveWeb: false, startBackground: false });
  return app;
}

describe('createApp', () => {
  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it('serves health without a database', async () => {
    const res = await (await testApp()).inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, db: false, auth: false, version: '0.1.0' });
  });

  it('keeps read-only in-memory machine list available without a database', async () => {
    const res = await (await testApp()).inject({ method: 'GET', url: '/api/machines' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ machines: [] });
  });

  it('returns 503 for DB-backed machine mutations when DATABASE_URL is absent', async () => {
    const res = await (await testApp()).inject({
      method: 'POST',
      url: '/api/machines',
      payload: { name: 'dev', labels: ['dev'] },
    });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'database not available' });
  });
});
