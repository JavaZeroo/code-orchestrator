import { createId } from '@paralleldrive/cuid2';
import { workflowDefSchema, type WorkflowDef } from '@co/protocol';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '../db/index';

export class WorkflowRevisionError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

interface RevisionSource {
  id: string;
  version: number;
  projectId: string | null;
  archived: 'yes' | 'no';
}

interface RevisionOptions {
  id: string;
  createdVia: 'chat' | 'manual';
  createdBy?: string;
}

export function planWorkflowRevision(source: RevisionSource, graph: WorkflowDef, options: RevisionOptions) {
  if (source.archived === 'yes') {
    throw new WorkflowRevisionError(409, `workflow version is archived: ${source.id}`);
  }
  return {
    previousId: source.id,
    definition: {
      id: options.id,
      name: graph.name,
      version: source.version + 1,
      graph,
      createdVia: options.createdVia,
      projectId: source.projectId,
      createdBy: options.createdBy,
    },
  };
}

export async function reviseWorkflowDefinition(
  sourceId: string,
  graphInput: unknown,
  options: { createdVia: 'chat' | 'manual'; createdBy?: string },
) {
  // Validate before opening the transaction so malformed graphs cannot mutate any reference.
  const graph = workflowDefSchema.parse(graphInput);
  const id = createId();

  return getDb().transaction(async (tx) => {
    const [source] = await tx
      .select()
      .from(schema.workflowDefs)
      .where(eq(schema.workflowDefs.id, sourceId))
      .limit(1)
      .for('update');
    if (!source) {
      throw new WorkflowRevisionError(404, `workflow not found: ${sourceId}`);
    }

    const plan = planWorkflowRevision(source, graph, {
      id,
      createdVia: options.createdVia,
      createdBy: options.createdBy,
    });

    await tx.insert(schema.workflowDefs).values(plan.definition);
    await tx
      .update(schema.projects)
      .set({ defaultWorkflow: id })
      .where(eq(schema.projects.defaultWorkflow, sourceId));
    await tx
      .update(schema.projects)
      .set({ defaultDefId: id })
      .where(eq(schema.projects.defaultDefId, sourceId));
    await tx
      .update(schema.requirementTriggers)
      .set({ defId: id })
      .where(eq(schema.requirementTriggers.defId, sourceId));
    await tx
      .update(schema.workflowDefs)
      .set({ archived: 'yes' })
      .where(eq(schema.workflowDefs.id, sourceId));

    return {
      id,
      name: plan.definition.name,
      version: plan.definition.version,
      previousId: plan.previousId,
    };
  });
}
