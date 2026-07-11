import { describe, expect, it, vi } from 'vitest';
import {
  ForgeRetestError,
  ForgeRetestService,
  type ForgeRetestDependencies,
} from './retest';

const activeGitCodePr = {
  id: 'ref-1',
  forge: 'gitcode' as const,
  kind: 'pr' as const,
  repo: 'mindspore/mindformers',
  number: 8377,
  active: 'yes' as const,
};

function dependencies(overrides: Partial<ForgeRetestDependencies> = {}) {
  return {
    findRef: vi.fn().mockResolvedValue(activeGitCodePr),
    requesterToken: vi.fn().mockResolvedValue('requester-token'),
    postComment: vi.fn().mockResolvedValue({ id: 91 }),
    ...overrides,
  } satisfies ForgeRetestDependencies;
}

describe('ForgeRetestService', () => {
  it('posts exactly one /retest with the requester token for concurrent calls', async () => {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const deps = dependencies({
      postComment: vi.fn().mockImplementation(async () => waiting),
    });
    const service = new ForgeRetestService(deps);

    const first = service.request(activeGitCodePr.id, 'operator-1');
    const second = service.request(activeGitCodePr.id, 'operator-1');

    expect(second).toBe(first);
    await vi.waitFor(() => expect(deps.postComment).toHaveBeenCalledTimes(1));
    expect(deps.requesterToken).toHaveBeenCalledWith('operator-1');
    expect(deps.postComment).toHaveBeenCalledWith(activeGitCodePr, '/retest', 'requester-token');

    release();
    await expect(Promise.all([first, second])).resolves.toEqual([
      { ok: true, confirmation: 'pending' },
      { ok: true, confirmation: 'pending' },
    ]);
  });

  it.each([
    ['missing ref', undefined, 404],
    ['inactive ref', { ...activeGitCodePr, active: 'no' as const }, 409],
    ['issue ref', { ...activeGitCodePr, kind: 'issue' as const }, 400],
    ['GitHub ref', { ...activeGitCodePr, forge: 'github' as const }, 400],
  ])('rejects a %s without resolving credentials or posting', async (_name, ref, statusCode) => {
    const deps = dependencies({ findRef: vi.fn().mockResolvedValue(ref) });
    const service = new ForgeRetestService(deps);

    await expect(service.request('ref-invalid', 'operator-1')).rejects.toMatchObject({ statusCode });
    expect(deps.requesterToken).not.toHaveBeenCalled();
    expect(deps.postComment).not.toHaveBeenCalled();
  });

  it('rejects an anonymous requester without looking up or posting to the ref', async () => {
    const deps = dependencies();
    const service = new ForgeRetestService(deps);

    await expect(service.request(activeGitCodePr.id)).rejects.toMatchObject({ statusCode: 401 });
    expect(deps.findRef).not.toHaveBeenCalled();
    expect(deps.postComment).not.toHaveBeenCalled();
  });

  it('rejects missing requester credentials without posting', async () => {
    const deps = dependencies({ requesterToken: vi.fn().mockResolvedValue(undefined) });
    const service = new ForgeRetestService(deps);

    await expect(service.request(activeGitCodePr.id, 'operator-1')).rejects.toMatchObject({ statusCode: 403 });
    expect(deps.postComment).not.toHaveBeenCalled();
  });

  it('reports an outbound GitCode failure without retrying the comment', async () => {
    const deps = dependencies({ postComment: vi.fn().mockRejectedValue(new Error('upstream unavailable')) });
    const service = new ForgeRetestService(deps);

    await expect(service.request(activeGitCodePr.id, 'operator-1')).rejects.toEqual(
      new ForgeRetestError(502, 'GitCode /retest 发布失败：upstream unavailable'),
    );
    expect(deps.postComment).toHaveBeenCalledTimes(1);
  });
});
