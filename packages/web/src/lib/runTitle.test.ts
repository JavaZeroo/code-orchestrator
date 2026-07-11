import { describe, expect, it } from 'vitest';
import {
  normalizeRunTitle,
  RUN_TITLE_MAX_LENGTH,
  runDisplayTitle,
  runMatchesSearch,
} from './runTitle';

const run = {
  id: 'run-release-42',
  title: 'Production rollout',
  defName: 'Release pipeline',
  defId: 'workflow-release-pipeline',
};

describe('workflow run titles', () => {
  it('accepts trimmed 1-120 character titles and rejects invalid values', () => {
    expect(normalizeRunTitle('  Production rollout  ')).toBe('Production rollout');
    expect(normalizeRunTitle('x'.repeat(RUN_TITLE_MAX_LENGTH))).toHaveLength(RUN_TITLE_MAX_LENGTH);
    expect(normalizeRunTitle('   ')).toBeNull();
    expect(normalizeRunTitle('x'.repeat(RUN_TITLE_MAX_LENGTH + 1))).toBeNull();
  });

  it('uses the run title before the workflow name and ID fallback', () => {
    expect(runDisplayTitle(run)).toBe('Production rollout');
    expect(runDisplayTitle({ ...run, title: null })).toBe('Release pipeline');
    expect(runDisplayTitle({ ...run, title: null, defName: null })).toBe('workflow');
  });

  it('finds runs by their persistent title while retaining workflow and ID search', () => {
    expect(runMatchesSearch(run, 'ROLLOUT')).toBe(true);
    expect(runMatchesSearch(run, 'release pipeline')).toBe(true);
    expect(runMatchesSearch(run, 'run-release-42')).toBe(true);
    expect(runMatchesSearch(run, 'incident review')).toBe(false);
  });
});
