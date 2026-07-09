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
