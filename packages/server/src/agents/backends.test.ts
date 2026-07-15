import { describe, expect, it } from 'vitest';
import { getAgentBackend } from './backends';

describe('server AgentBackend registry', () => {
  it('publishes the same capability contract used by runners', () => {
    expect(getAgentBackend('claude')).toMatchObject({
      name: 'claude',
      capabilities: { designerTools: true, taskIntakeTools: true, resume: true, fork: true },
    });
    expect(getAgentBackend('codex')).toMatchObject({
      name: 'codex',
      capabilities: { designerTools: false, taskIntakeTools: false, resume: true, fork: true },
    });
  });
});
