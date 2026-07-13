import { describe, expect, it } from 'vitest';
import { sessionPatchFilename } from './sessions';

describe('sessionPatchFilename', () => {
  it('uses a safe session title and preserves Unicode in attachment filenames', () => {
    expect(sessionPatchFilename({ id: 'session-1', title: ' 修复登录/重试.patch ' }))
      .toBe('修复登录_重试.patch');
  });

  it('falls back to the session id when no title is available', () => {
    expect(sessionPatchFilename({ id: 'session-1', title: null })).toBe('session-1.patch');
  });
});
