import type { FastifyInstance } from 'fastify';
import { listAgentBackends } from '../agents/backends';

export async function registerAgentBackendRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/agent-backends', async () => ({
    backends: listAgentBackends().map(({ name, capabilities, constraints }) => ({
      name,
      capabilities,
      constraints,
      rejectionReasons: Object.fromEntries(
        Object.entries(capabilities)
          .filter(([, supported]) => !supported)
          .map(([capability]) => [capability, `agent "${name}" does not support ${capability}`]),
      ),
    })),
  }));
}
