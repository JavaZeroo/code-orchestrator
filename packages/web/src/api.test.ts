import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';

function mockFetch(response: Response) {
  const fetch = vi.fn().mockResolvedValue(response);
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

describe('api client', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('unwraps list endpoints', async () => {
    const fetch = mockFetch(Response.json({ machines: [{ id: 'm1', name: 'dev', labels: ['dev'] }] }));

    await expect(api.machines()).resolves.toEqual([{ id: 'm1', name: 'dev', labels: ['dev'] }]);
    expect(fetch).toHaveBeenCalledWith('/api/machines');
  });

  it('adds since only for incremental event polling', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ events: [] }))
      .mockResolvedValueOnce(Response.json({ events: [] }));
    vi.stubGlobal('fetch', fetch);

    await api.events('s1');
    await api.events('s1', 12);

    expect(fetch).toHaveBeenNthCalledWith(1, '/api/sessions/s1/events');
    expect(fetch).toHaveBeenNthCalledWith(2, '/api/sessions/s1/events?since=12');
  });

  it('posts JSON bodies for session spawn', async () => {
    const fetch = mockFetch(Response.json({ sessionId: 's1' }));

    await expect(api.spawn({ prompt: 'hello', agent: 'claude' })).resolves.toEqual({ sessionId: 's1' });
    expect(fetch).toHaveBeenCalledWith('/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'hello', agent: 'claude' }),
    });
  });

  it('persists machine scheduling pause through the machine API', async () => {
    const fetch = mockFetch(Response.json({ ok: true }));

    await expect(api.patchMachine('m1', { schedulingPaused: true })).resolves.toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledWith('/api/machines/m1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ schedulingPaused: true }),
    });
  });

  it('lists, reprioritizes, retries, and cancels project queued sessions', async () => {
    const task = {
      id: 'task/1',
      projectId: 'project/1',
      prompt: 'train',
      status: 'failed',
      enqueuedAt: '2026-07-11T00:00:00Z',
    };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ tasks: [task] }))
      .mockResolvedValueOnce(Response.json({ ok: true, priority: 7 }))
      .mockResolvedValueOnce(Response.json({ ok: true }))
      .mockResolvedValueOnce(Response.json({ ok: true }));
    vi.stubGlobal('fetch', fetch);

    await expect(api.queuedSessions('project/1')).resolves.toEqual([task]);
    await expect(api.reprioritizeQueuedSession('project/1', 'task/1', 7)).resolves.toEqual({ ok: true, priority: 7 });
    await expect(api.retryQueuedSession('project/1', 'task/1')).resolves.toEqual({ ok: true });
    await expect(api.cancelQueuedSession('project/1', 'task/1')).resolves.toEqual({ ok: true });

    expect(fetch).toHaveBeenNthCalledWith(1, '/api/projects/project%2F1/queued-sessions');
    expect(fetch).toHaveBeenNthCalledWith(2, '/api/projects/project%2F1/queued-sessions/task%2F1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ priority: 7 }),
    });
    expect(fetch).toHaveBeenNthCalledWith(3, '/api/projects/project%2F1/queued-sessions/task%2F1/retry', {
      method: 'POST',
    });
    expect(fetch).toHaveBeenNthCalledWith(4, '/api/projects/project%2F1/queued-sessions/task%2F1', { method: 'DELETE' });
  });

  it('dispatches unauthorized events on 401', async () => {
    const dispatchEvent = vi.fn();
    vi.stubGlobal('window', { dispatchEvent });
    mockFetch(new Response('nope', { status: 401 }));

    await expect(api.sessions()).rejects.toThrow('未登录或会话已过期');
    expect(dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'co:unauthorized' }));
  });

  it('includes status and response text for failed requests', async () => {
    mockFetch(new Response('server exploded', { status: 500 }));

    await expect(api.sessions()).rejects.toThrow('500: server exploded');
  });
});
