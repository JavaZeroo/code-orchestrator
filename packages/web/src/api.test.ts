import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, decodeWorkspaceTextPreview, WORKSPACE_TEXT_PREVIEW_MAX_BYTES, type WorkflowDef } from './api';

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

  it('constructs initial, forward, and backward session event cursors', async () => {
    const initialPage = { events: [], page: { hasEarlier: true, before: 8 } };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json(initialPage))
      .mockResolvedValueOnce(Response.json({ events: [], page: { hasEarlier: false, before: null } }))
      .mockResolvedValueOnce(Response.json({ events: [], page: { hasEarlier: false, before: null } }));
    vi.stubGlobal('fetch', fetch);

    await expect(api.events('s1')).resolves.toEqual(initialPage);
    await api.events('s1', { since: 12 });
    await api.events('s1', { before: 8 });

    expect(fetch).toHaveBeenNthCalledWith(1, '/api/sessions/s1/events');
    expect(fetch).toHaveBeenNthCalledWith(2, '/api/sessions/s1/events?since=12');
    expect(fetch).toHaveBeenNthCalledWith(3, '/api/sessions/s1/events?before=8');
  });

  it('constructs initial, forward, and backward run thread cursors', async () => {
    const initialPage = { events: [], page: { hasEarlier: true, before: 8 } };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json(initialPage))
      .mockResolvedValueOnce(Response.json({ events: [], page: { hasEarlier: false, before: null } }))
      .mockResolvedValueOnce(Response.json({ events: [], page: { hasEarlier: false, before: null } }));
    vi.stubGlobal('fetch', fetch);

    await expect(api.runThread('run-1')).resolves.toEqual(initialPage);
    await api.runThread('run-1', { since: 12 });
    await api.runThread('run-1', { before: 8 });

    expect(fetch).toHaveBeenNthCalledWith(1, '/api/runs/run-1/thread');
    expect(fetch).toHaveBeenNthCalledWith(2, '/api/runs/run-1/thread?since=12');
    expect(fetch).toHaveBeenNthCalledWith(3, '/api/runs/run-1/thread?before=8');
  });

  it('fetches one session by its encoded ID', async () => {
    const fetch = mockFetch(Response.json({ session: { id: 'session/older', state: 'dead' } }));

    await expect(api.session('session/older')).resolves.toEqual({ id: 'session/older', state: 'dead' });
    expect(fetch).toHaveBeenCalledWith('/api/sessions/session%2Folder');
  });

  it('constructs an encoded workspace file request', async () => {
    const response = new Response('bytes');
    const fetch = mockFetch(response);
    await expect(api.workspaceFile('session/one', 'reports/final result.bin')).resolves.toBe(response);
    expect(fetch).toHaveBeenCalledWith('/api/sessions/session%2Fone/files?path=reports%2Ffinal%20result.bin');
  });

  it('loads an encoded workspace file as an inline UTF-8 preview', async () => {
    const fetch = mockFetch(new Response('# Report\nAll checks passed.'));
    await expect(api.workspaceTextPreview('session/one', 'reports/final report.md')).resolves.toEqual({
      kind: 'text',
      text: '# Report\nAll checks passed.',
    });
    expect(fetch).toHaveBeenCalledWith('/api/sessions/session%2Fone/files?path=reports%2Ffinal%20report.md');
  });

  it('rejects binary and oversized responses instead of rendering them as text', async () => {
    await expect(decodeWorkspaceTextPreview(new Response(new Uint8Array([0xff, 0xfe, 0x00])))).resolves.toEqual({ kind: 'binary' });
    await expect(decodeWorkspaceTextPreview(new Response('small', {
      headers: { 'content-length': String(WORKSPACE_TEXT_PREVIEW_MAX_BYTES + 1) },
    }))).resolves.toEqual({ kind: 'oversized' });
  });

  it('surfaces preview request errors', async () => {
    mockFetch(new Response('workspace file unavailable', { status: 400 }));
    await expect(api.workspaceTextPreview('session-1', 'missing.txt')).rejects.toThrow('400: workspace file unavailable');
  });

  it('requests an encoded workspace directory listing', async () => {
    const listing = { path: 'reports/final', entries: [], truncated: false };
    const fetch = mockFetch(Response.json(listing));
    await expect(api.workspaceFiles('session/one', 'reports/final')).resolves.toEqual(listing);
    expect(fetch).toHaveBeenCalledWith('/api/sessions/session%2Fone/files/list?path=reports%2Ffinal');
  });

  it('uploads exact file bytes to an encoded workspace destination', async () => {
    const fetch = mockFetch(Response.json({ ok: true, path: 'reports/raw.bin', size: 4 }));
    const file = new Blob([new Uint8Array([0, 1, 128, 255])]);
    await expect(api.uploadWorkspaceFile('session/one', 'reports/raw.bin', file)).resolves.toEqual({
      ok: true, path: 'reports/raw.bin', size: 4,
    });
    expect(fetch).toHaveBeenCalledWith('/api/sessions/session%2Fone/files?path=reports%2Fraw.bin', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: file,
    });
  });

  it('deletes an encoded workspace file path', async () => {
    const fetch = mockFetch(Response.json({ ok: true, path: 'reports/old result.bin' }));
    await expect(api.deleteWorkspaceFile('session/one', 'reports/old result.bin')).resolves.toEqual({
      ok: true, path: 'reports/old result.bin',
    });
    expect(fetch).toHaveBeenCalledWith('/api/sessions/session%2Fone/files?path=reports%2Fold%20result.bin', {
      method: 'DELETE',
    });
  });

  it('creates an encoded workspace directory path', async () => {
    const fetch = mockFetch(Response.json({ ok: true, path: 'reports/daily results' }));
    await expect(api.createWorkspaceDirectory('session/one', 'reports/daily results')).resolves.toEqual({
      ok: true, path: 'reports/daily results',
    });
    expect(fetch).toHaveBeenCalledWith(
      '/api/sessions/session%2Fone/files/directories?path=reports%2Fdaily%20results',
      { method: 'POST' },
    );
  });

  it('renames an encoded workspace entry with a JSON name', async () => {
    const fetch = mockFetch(Response.json({ ok: true, path: 'reports/final result.txt' }));
    await expect(api.renameWorkspaceEntry('session/one', 'reports/draft.txt', 'final result.txt')).resolves.toEqual({
      ok: true, path: 'reports/final result.txt',
    });
    expect(fetch).toHaveBeenCalledWith('/api/sessions/session%2Fone/files?path=reports%2Fdraft.txt', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'final result.txt' }),
    });
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

  it('posts session resume to the existing session resource', async () => {
    const fetch = mockFetch(Response.json({ ok: true, sessionId: 's1' }));

    await expect(api.resume('s1')).resolves.toEqual({ ok: true, sessionId: 's1' });
    expect(fetch).toHaveBeenCalledWith('/api/sessions/s1/resume', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
  });

  it('posts workflow pause and resume to the run resource', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ ok: true, run: { id: 'run-1', status: 'paused' } }))
      .mockResolvedValueOnce(Response.json({ ok: true, run: { id: 'run-1', status: 'running' } }));
    vi.stubGlobal('fetch', fetch);

    await expect(api.pauseRun('run-1')).resolves.toEqual({ ok: true, run: { id: 'run-1', status: 'paused' } });
    await expect(api.resumeRun('run-1')).resolves.toEqual({ ok: true, run: { id: 'run-1', status: 'running' } });
    expect(fetch).toHaveBeenNthCalledWith(1, '/api/runs/run-1/pause', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(fetch).toHaveBeenNthCalledWith(2, '/api/runs/run-1/resume', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
  });

  it('posts session fork and returns the independent target ID', async () => {
    const fetch = mockFetch(Response.json({ ok: true, sessionId: 'fork-1' }));

    await expect(api.fork('source-1')).resolves.toEqual({ ok: true, sessionId: 'fork-1' });
    expect(fetch).toHaveBeenCalledWith('/api/sessions/source-1/fork', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
  });

  it('renames a session through its existing resource', async () => {
    const fetch = mockFetch(Response.json({ ok: true, session: { id: 's1', title: 'Release follow-up' } }));

    await expect(api.renameSession('s1', 'Release follow-up')).resolves.toEqual({
      ok: true,
      session: { id: 's1', title: 'Release follow-up' },
    });
    expect(fetch).toHaveBeenCalledWith('/api/sessions/s1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Release follow-up' }),
    });
  });

  it('renames a workflow run through its existing resource', async () => {
    const fetch = mockFetch(Response.json({ ok: true, run: { id: 'run-1', title: 'Production rollout' } }));

    await expect(api.renameRun('run-1', 'Production rollout')).resolves.toEqual({
      ok: true,
      run: { id: 'run-1', title: 'Production rollout' },
    });
    expect(fetch).toHaveBeenCalledWith('/api/runs/run-1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Production rollout' }),
    });
  });

  it('appends Markdown notes to an encoded workflow run resource', async () => {
    const note = {
      seq: 42,
      type: 'run.note',
      runId: 'run/1',
      payload: { markdown: '**Hold** deployment.', author: 'operator@example.com' },
    };
    const fetch = mockFetch(Response.json({ note }, { status: 201 }));

    await expect(api.addRunNote('run/1', '**Hold** deployment.')).resolves.toEqual({ note });
    expect(fetch).toHaveBeenCalledWith('/api/runs/run%2F1/notes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ markdown: '**Hold** deployment.' }),
    });
  });

  it('appends Markdown notes to an encoded standalone session resource', async () => {
    const note = {
      seq: 18,
      type: 'session.note',
      sessionId: 'session/1',
      payload: { markdown: '**Handoff** context.', author: 'operator@example.com' },
    };
    const fetch = mockFetch(Response.json({ note }, { status: 201 }));

    await expect(api.addSessionNote('session/1', '**Handoff** context.')).resolves.toEqual({ note });
    expect(fetch).toHaveBeenCalledWith('/api/sessions/session%2F1/notes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ markdown: '**Handoff** context.' }),
    });
  });

  it('edits session and run notes through their creation event identifiers', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ note: { seq: 19, type: 'session.note.updated' } }))
      .mockResolvedValueOnce(Response.json({ note: { seq: 43, type: 'run.note.updated' } }));
    vi.stubGlobal('fetch', fetch);

    await api.editSessionNote('session/1', 18, 'Corrected handoff.');
    await api.editRunNote('run/1', 42, 'Proceed with deployment.');

    expect(fetch).toHaveBeenNthCalledWith(1, '/api/sessions/session%2F1/notes/18', {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ markdown: 'Corrected handoff.' }),
    });
    expect(fetch).toHaveBeenNthCalledWith(2, '/api/runs/run%2F1/notes/42', {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ markdown: 'Proceed with deployment.' }),
    });
  });

  it('deletes session and run notes through their creation event identifiers', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ note: { seq: 20, type: 'session.note.deleted', payload: { noteId: 18 } } }))
      .mockResolvedValueOnce(Response.json({ note: { seq: 44, type: 'run.note.deleted', payload: { noteId: 42 } } }));
    vi.stubGlobal('fetch', fetch);

    await api.deleteSessionNote('session/1', 18);
    await api.deleteRunNote('run/1', 42);

    expect(fetch).toHaveBeenNthCalledWith(1, '/api/sessions/session%2F1/notes/18', { method: 'DELETE' });
    expect(fetch).toHaveBeenNthCalledWith(2, '/api/runs/run%2F1/notes/42', { method: 'DELETE' });
  });

  it('lists archived sessions separately and posts archive state changes', async () => {
    const archivedAt = '2026-07-11T04:00:00.000Z';
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ sessions: [{ id: 's1', archivedAt }] }))
      .mockResolvedValueOnce(Response.json({ ok: true, session: { id: 's1', archivedAt } }))
      .mockResolvedValueOnce(Response.json({ ok: true, session: { id: 's1', archivedAt: null } }));
    vi.stubGlobal('fetch', fetch);

    await expect(api.archivedSessions()).resolves.toEqual([{ id: 's1', archivedAt }]);
    await expect(api.archiveSession('s1')).resolves.toEqual({ ok: true, session: { id: 's1', archivedAt } });
    await expect(api.restoreSession('s1')).resolves.toEqual({ ok: true, session: { id: 's1', archivedAt: null } });

    expect(fetch).toHaveBeenNthCalledWith(1, '/api/sessions?archived=true');
    expect(fetch).toHaveBeenNthCalledWith(2, '/api/sessions/s1/archive', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(fetch).toHaveBeenNthCalledWith(3, '/api/sessions/s1/restore', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
  });

  it('lists archived runs and posts retry and archive state changes', async () => {
    const archivedAt = '2026-07-11T05:00:00.000Z';
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ runs: [{ id: 'run-1', archivedAt }] }))
      .mockResolvedValueOnce(Response.json({
        ok: true,
        run: { id: 'run-1', status: 'running', endedAt: null },
        retriedNodeIds: ['deploy'],
      }))
      .mockResolvedValueOnce(Response.json({ ok: true, run: { id: 'run-1', archivedAt } }))
      .mockResolvedValueOnce(Response.json({ ok: true, run: { id: 'run-1', archivedAt: null } }));
    vi.stubGlobal('fetch', fetch);

    await expect(api.archivedRuns()).resolves.toEqual([{ id: 'run-1', archivedAt }]);
    await expect(api.retryRun('run-1')).resolves.toEqual({
      ok: true,
      run: { id: 'run-1', status: 'running', endedAt: null },
      retriedNodeIds: ['deploy'],
    });
    await expect(api.archiveRun('run-1')).resolves.toEqual({ ok: true, run: { id: 'run-1', archivedAt } });
    await expect(api.restoreRun('run-1')).resolves.toEqual({ ok: true, run: { id: 'run-1', archivedAt: null } });

    expect(fetch).toHaveBeenNthCalledWith(1, '/api/runs?archived=true');
    expect(fetch).toHaveBeenNthCalledWith(2, '/api/runs/run-1/retry', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(fetch).toHaveBeenNthCalledWith(3, '/api/runs/run-1/archive', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(fetch).toHaveBeenNthCalledWith(4, '/api/runs/run-1/restore', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
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

  it('publishes a workflow revision through the versioned endpoint', async () => {
    const fetch = mockFetch(Response.json({ id: 'workflow-v2', name: 'Pipeline', version: 2, previousId: 'workflow-v1' }));
    const graph: WorkflowDef = {
      name: 'Pipeline',
      nodes: [{ id: 'implement', type: 'agent', cli: 'claude', prompt: 'Implement it' }],
      edges: [],
    };

    await expect(api.reviseWorkflow('workflow-v1', graph, 'chat')).resolves.toEqual({
      id: 'workflow-v2',
      name: 'Pipeline',
      version: 2,
      previousId: 'workflow-v1',
    });
    expect(fetch).toHaveBeenCalledWith('/api/workflows/workflow-v1/revisions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ graph, createdVia: 'chat' }),
    });
  });

  it('submits Codex interactive answers through the approval endpoint', async () => {
    const fetch = mockFetch(Response.json({ ok: true, status: 'approved' }));
    const answers = { scope: { answers: ['Runner'] } };

    await expect(api.answer('input-1', answers)).resolves.toEqual({ ok: true, status: 'approved' });
    expect(fetch).toHaveBeenCalledWith('/api/approvals/input-1/decide', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: { behavior: 'allow', updatedInput: { answers } } }),
    });
  });

  it('submits approval rejection feedback through the approval endpoint', async () => {
    const fetch = mockFetch(Response.json({ ok: true, status: 'denied' }));

    await api.decide('approval-1', 'deny', 'Change the deployment target.');

    expect(fetch).toHaveBeenCalledWith('/api/approvals/approval-1/decide', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: { behavior: 'deny', message: 'Change the deployment target.' } }),
    });
  });

  it('requests a GitCode CI retest for the encoded tracked ref', async () => {
    const fetch = mockFetch(Response.json({ ok: true, confirmation: 'pending' }));

    await expect(api.retestForgeRef('ref/1')).resolves.toEqual({ ok: true, confirmation: 'pending' });
    expect(fetch).toHaveBeenCalledWith('/api/forge/refs/ref%2F1/retest', { method: 'POST' });
  });

  it('posts a comment to the encoded tracked PR ref', async () => {
    const fetch = mockFetch(Response.json({ ok: true, commentId: 73 }));

    await expect(api.commentForgeRef('ref/1', 'Please rerun the checks.')).resolves.toEqual({ ok: true, commentId: 73 });
    expect(fetch).toHaveBeenCalledWith('/api/forge/refs/ref%2F1/comments', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'Please rerun the checks.' }),
    });
  });

  it('starts a recorded requirement through its encoded intake resource', async () => {
    const fetch = mockFetch(Response.json({ runId: 'run-1' }, { status: 201 }));

    await expect(api.startRequirement('intake/1')).resolves.toEqual({ runId: 'run-1' });
    expect(fetch).toHaveBeenCalledWith('/api/requirements/intake%2F1/start', { method: 'POST' });
  });

  it('surfaces a rejected retest request to the run action', async () => {
    mockFetch(new Response('{"error":"该 forge ref 已停止跟踪"}', { status: 409 }));

    await expect(api.retestForgeRef('ref-1')).rejects.toThrow('409: {"error":"该 forge ref 已停止跟踪"}');
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
