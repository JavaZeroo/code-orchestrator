import { describe, expect, it, vi } from 'vitest';
import { ForgeCommentError, ForgeCommentService, type ForgeCommentDependencies } from './comment';

const activePr = { id: 'ref-1', forge: 'github' as const, kind: 'pr' as const, repo: 'acme/widgets', number: 42, active: 'yes' as const };

function dependencies(overrides: Partial<ForgeCommentDependencies> = {}) {
  return {
    findRef: vi.fn().mockResolvedValue(activePr),
    requesterToken: vi.fn().mockResolvedValue('requester-token'),
    postComment: vi.fn().mockResolvedValue({ id: 91 }),
    ...overrides,
  } satisfies ForgeCommentDependencies;
}

describe('ForgeCommentService', () => {
  it('posts one trimmed comment through the ref adapter with the requester token', async () => {
    const deps = dependencies();
    const service = new ForgeCommentService(deps);

    await expect(service.request('ref-1', '  Please rerun the checks.  ', 'operator-1')).resolves.toEqual({ ok: true, commentId: 91 });
    expect(deps.requesterToken).toHaveBeenCalledWith('operator-1', 'github');
    expect(deps.postComment).toHaveBeenCalledWith(activePr, 'Please rerun the checks.', 'requester-token');
  });

  it('coalesces concurrent duplicate submissions into one outbound comment', async () => {
    let release!: (value: { id: number }) => void;
    const waiting = new Promise<{ id: number }>((resolve) => { release = resolve; });
    const deps = dependencies({ postComment: vi.fn().mockReturnValue(waiting) });
    const service = new ForgeCommentService(deps);
    const first = service.request('ref-1', 'Ship it', 'operator-1');
    const second = service.request('ref-1', 'Ship it', 'operator-1');

    expect(second).toBe(first);
    await vi.waitFor(() => expect(deps.postComment).toHaveBeenCalledTimes(1));
    release({ id: 92 });
    await expect(Promise.all([first, second])).resolves.toEqual([{ ok: true, commentId: 92 }, { ok: true, commentId: 92 }]);
  });

  it.each([
    ['missing ref', undefined, 404],
    ['inactive ref', { ...activePr, active: 'no' as const }, 409],
    ['issue ref', { ...activePr, kind: 'issue' as const }, 400],
  ])('rejects a %s without resolving credentials or posting', async (_name, ref, statusCode) => {
    const deps = dependencies({ findRef: vi.fn().mockResolvedValue(ref) });
    await expect(new ForgeCommentService(deps).request('bad-ref', 'Comment', 'operator-1')).rejects.toMatchObject({ statusCode });
    expect(deps.requesterToken).not.toHaveBeenCalled();
    expect(deps.postComment).not.toHaveBeenCalled();
  });

  it('rejects anonymous, empty, and credential-less requests without posting', async () => {
    const deps = dependencies({ requesterToken: vi.fn().mockResolvedValue(undefined) });
    const service = new ForgeCommentService(deps);
    await expect(service.request('ref-1', 'Comment')).rejects.toMatchObject({ statusCode: 401 });
    await expect(service.request('ref-1', '   ', 'operator-1')).rejects.toMatchObject({ statusCode: 400 });
    await expect(service.request('ref-1', 'Comment', 'operator-1')).rejects.toMatchObject({ statusCode: 403 });
    expect(deps.postComment).not.toHaveBeenCalled();
  });

  it('reports adapter failures without retrying', async () => {
    const deps = dependencies({ postComment: vi.fn().mockRejectedValue(new Error('upstream unavailable')) });
    await expect(new ForgeCommentService(deps).request('ref-1', 'Comment', 'operator-1')).rejects.toEqual(
      new ForgeCommentError(502, 'GitHub PR 评论发布失败：upstream unavailable'),
    );
    expect(deps.postComment).toHaveBeenCalledTimes(1);
  });
});
