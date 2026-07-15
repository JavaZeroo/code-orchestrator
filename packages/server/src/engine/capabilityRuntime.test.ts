import { describe, expect, it, vi } from 'vitest';
import { deliverCapabilityFeedback } from './capabilityRuntime';

describe('Capability runtime feedback delivery', () => {
  it('treats an explicit Runner rejection as delivery failure so the engine can respawn', async () => {
    const send = vi.fn(async () => ({ ok: false, error: 'session not running: dead-session' }));

    await expect(deliverCapabilityFeedback(send, {
      sessionId: 'dead-session',
      text: 'Fix the failing test.',
      idempotencyKey: 'run-1:node-1:attempt-1:feedback',
    })).rejects.toThrow('session not running');
  });

  it('accepts an idempotent successful delivery', async () => {
    await expect(deliverCapabilityFeedback(async () => ({ ok: true }), {
      sessionId: 'session-1',
      text: 'Fix the failing test.',
      idempotencyKey: 'run-1:node-1:attempt-1:feedback',
    })).resolves.toBeUndefined();
  });
});
