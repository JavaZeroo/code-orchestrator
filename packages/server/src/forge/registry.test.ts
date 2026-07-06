import { describe, expect, it } from 'vitest';
import { isForgeKind, parseForgeUrl } from './registry';

describe('parseForgeUrl', () => {
  it('识别 github PR', () => {
    expect(parseForgeUrl('https://github.com/JavaZeroo/code-orchestrator/pull/34')).toEqual({
      forge: 'github',
      repo: 'JavaZeroo/code-orchestrator',
      number: 34,
      kind: 'pr',
    });
  });

  it('识别 github issue', () => {
    expect(parseForgeUrl('https://github.com/cli/cli/issues/13785')).toMatchObject({ forge: 'github', kind: 'issue', number: 13785 });
  });

  it('识别 gitcode merge_requests 与 issues', () => {
    expect(parseForgeUrl('https://gitcode.com/mindspore/mindformers/merge_requests/8377')).toMatchObject({ forge: 'gitcode', kind: 'pr', number: 8377 });
    expect(parseForgeUrl('https://gitcode.com/a/b/issues/9')).toMatchObject({ forge: 'gitcode', kind: 'issue', number: 9 });
  });

  it('非 forge URL 返回 null', () => {
    expect(parseForgeUrl('https://example.com/foo/bar')).toBeNull();
    expect(parseForgeUrl('not a url')).toBeNull();
  });
});

describe('isForgeKind', () => {
  it('只认 github/gitcode', () => {
    expect(isForgeKind('github')).toBe(true);
    expect(isForgeKind('gitcode')).toBe(true);
    expect(isForgeKind('gitlab')).toBe(false);
  });
});
