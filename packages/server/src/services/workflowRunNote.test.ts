import { describe, expect, it, vi } from 'vitest';
import {
  appendWorkflowRunNoteWithDependencies,
  deleteWorkflowRunNoteWithDependencies,
  reviseWorkflowRunNoteWithDependencies,
  WorkflowRunNoteError,
  type WorkflowRunNoteDependencies,
} from './workflowRunNote';

function dependencies(runExists = true): WorkflowRunNoteDependencies {
  return {
    runExists: vi.fn().mockResolvedValue(runExists),
    noteExists: vi.fn().mockResolvedValue(runExists),
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

  it('appends a scoped revision event for an existing run note', async () => {
    const deps = dependencies();
    await expect(reviseWorkflowRunNoteWithDependencies('run-1', {
      noteId: 11, markdown: 'Deployment may proceed.',
    }, deps)).resolves.toEqual({
      seq: 41,
      type: 'run.note.updated',
      runId: 'run-1',
      payload: { noteId: 11, markdown: 'Deployment may proceed.' },
    });
    expect(deps.noteExists).toHaveBeenCalledWith('run-1', 11);
    expect(deps.publishEvent).toHaveBeenCalledWith({
      type: 'run.note.updated', runId: 'run-1', payload: { noteId: 11, markdown: 'Deployment may proceed.' },
    });
  });

  it('rejects an unknown or mismatched run note without publishing', async () => {
    const deps = dependencies(false);
    await expect(reviseWorkflowRunNoteWithDependencies('run-1', {
      noteId: 99, markdown: 'Do not save.',
    }, deps)).rejects.toEqual(new WorkflowRunNoteError(404, 'run note not found'));
    expect(deps.publishEvent).not.toHaveBeenCalled();
  });

  it('appends a scoped deletion tombstone for an existing run note', async () => {
    const deps = dependencies();
    await expect(deleteWorkflowRunNoteWithDependencies('run-1', { noteId: 11 }, deps)).resolves.toEqual({
      seq: 41, type: 'run.note.deleted', runId: 'run-1', payload: { noteId: 11 },
    });
    expect(deps.noteExists).toHaveBeenCalledWith('run-1', 11);
    expect(deps.publishEvent).toHaveBeenCalledWith({
      type: 'run.note.deleted', runId: 'run-1', payload: { noteId: 11 },
    });
  });

  it('rejects deletion of an unknown or cross-run note', async () => {
    const deps = dependencies(false);
    await expect(deleteWorkflowRunNoteWithDependencies('run-1', { noteId: 99 }, deps))
      .rejects.toEqual(new WorkflowRunNoteError(404, 'run note not found'));
    expect(deps.publishEvent).not.toHaveBeenCalled();
  });
});
