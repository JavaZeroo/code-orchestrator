import { workflowDefSchema } from '@co/protocol';
import { describe, expect, it } from 'vitest';
import { planWorkflowRevision, WorkflowRevisionError } from './workflowRevision';

const revisedGraph = workflowDefSchema.parse({
  name: 'Delivery pipeline',
  nodes: [{ id: 'implement', type: 'agent', prompt: 'Implement the change' }],
  edges: [],
});

describe('planWorkflowRevision', () => {
  it('plans the next version while preserving project ownership', () => {
    const plan = planWorkflowRevision(
      { id: 'workflow-v3', version: 3, projectId: 'project-1', archived: 'no' },
      revisedGraph,
      { id: 'workflow-v4', createdVia: 'chat', createdBy: 'operator-1' },
    );

    expect(plan).toEqual({
      previousId: 'workflow-v3',
      definition: {
        id: 'workflow-v4',
        name: 'Delivery pipeline',
        version: 4,
        graph: revisedGraph,
        createdVia: 'chat',
        projectId: 'project-1',
        createdBy: 'operator-1',
      },
    });
  });

  it('rejects attempts to branch from an archived version', () => {
    expect(() =>
      planWorkflowRevision(
        { id: 'workflow-v1', version: 1, projectId: null, archived: 'yes' },
        revisedGraph,
        { id: 'workflow-v2', createdVia: 'manual' },
      ),
    ).toThrowError(new WorkflowRevisionError(409, 'workflow version is archived: workflow-v1'));
  });
});
