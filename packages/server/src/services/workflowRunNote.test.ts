import { describe, expect, it, vi } from 'vitest';
import {
  appendWorkflowRunNoteWithDependencies,
  WorkflowRunNoteError,
  type WorkflowRunNoteDependencies,
} from './workflowRunNote';

function dependencies(runExists = true): WorkflowRunNoteDependencies {
  return {
    runExists: vi.fn().mockResolvedValue(runExists),
    publishEvent: vi.fn().mockResolvedValue(41),
  };
}

describe('workflow run notes', () => {
  it('publishes exactly one run-scoped append-only event', async () => {
    const deps = dependencies();
    const payload = { markdown: '**Pause** deployment.', author: 'operator@example.com' };

    await expect(appendWorkflowRunNoteWithDependencies('run-1', payload, deps)).resolves.toEqual({
      seq: 41,
      type: 'run.note',
      runId: 'run-1',
      payload,
    });
    expect(deps.runExists).toHaveBeenCalledOnce();
    expect(deps.publishEvent).toHaveBeenCalledOnce();
    expect(deps.publishEvent).toHaveBeenCalledWith({ type: 'run.note', runId: 'run-1', payload });
  });

  it('rejects an unknown run without publishing an event', async () => {
    const deps = dependencies(false);

    await expect(appendWorkflowRunNoteWithDependencies('missing', {
      markdown: 'This must not be saved.',
      author: 'operator@example.com',
    }, deps)).rejects.toEqual(new WorkflowRunNoteError(404, 'run not found'));
    expect(deps.publishEvent).not.toHaveBeenCalled();
  });
});
