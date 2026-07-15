import {
  builtinAgentBackendDescriptors,
  type AgentBackendCapability,
  type AgentBackendDescriptor,
  type RunnerParams,
  type SessionAgent,
} from '@co/protocol';
import { ClaudeSession, forkClaudeNativeSession } from './claude/driver';
import { CodexSession } from './codex/driver';
import type { DriverEmit } from './driverTypes';
import type { RunnerSession } from './sessions';

export interface ForkedRunnerSession {
  session: RunnerSession;
  nativeSessionId: string;
}

/**
 * Backend 的深 Adapter：调用方只描述会话生命周期，不接触 Claude/Codex 构造器、
 * fork 顺序或能力组合差异。
 */
export interface RunnerBackendAdapter {
  descriptor: AgentBackendDescriptor;
  validateSpawn(params: RunnerParams<'session.spawn'>): string | null;
  createSession(
    params: RunnerParams<'session.spawn'>,
    emit: DriverEmit,
    resumeNativeSessionId?: string,
  ): RunnerSession;
  forkSession(
    params: RunnerParams<'session.fork'>,
    emit: DriverEmit,
  ): Promise<ForkedRunnerSession>;
}

export function backendCapabilityError(
  descriptor: AgentBackendDescriptor,
  capability: AgentBackendCapability,
): string | null {
  return descriptor.capabilities[capability]
    ? null
    : `agent "${descriptor.name}" does not support ${capability}`;
}

function validateSpawn(
  descriptor: AgentBackendDescriptor,
  params: RunnerParams<'session.spawn'>,
): string | null {
  const environment = params.container ? 'containerSession' : 'hostSession';
  const environmentError = backendCapabilityError(
    descriptor,
    environment,
  );
  if (environmentError) return environmentError;
  if (params.designer) {
    const error = backendCapabilityError(descriptor, 'designerTools');
    if (error) return error;
  }
  if (params.taskIntake) {
    const error = backendCapabilityError(descriptor, 'taskIntakeTools');
    if (error) return error;
  }
  const requested = new Set<AgentBackendCapability>([
    environment,
    ...(params.designer ? ['designerTools' as const] : []),
    ...(params.taskIntake ? ['taskIntakeTools' as const] : []),
  ]);
  const constraint = descriptor.constraints.find((item) => item.allOf.every((capability) => requested.has(capability)));
  if (constraint) return constraint.reason;
  return null;
}

const claude: RunnerBackendAdapter = {
  descriptor: builtinAgentBackendDescriptors.claude,
  validateSpawn(params) {
    return validateSpawn(this.descriptor, params);
  },
  createSession(params, emit, resumeNativeSessionId) {
    return new ClaudeSession(params, emit, resumeNativeSessionId);
  },
  async forkSession(params, emit) {
    const nativeSessionId = await forkClaudeNativeSession(params.nativeSessionId, params.cwd);
    const session = new ClaudeSession(params, emit, nativeSessionId);
    session.start();
    return { session, nativeSessionId };
  },
};

const codex: RunnerBackendAdapter = {
  descriptor: builtinAgentBackendDescriptors.codex,
  validateSpawn(params) {
    return validateSpawn(this.descriptor, params);
  },
  createSession(params, emit, resumeNativeSessionId) {
    return new CodexSession(params, emit, resumeNativeSessionId);
  },
  async forkSession(params, emit) {
    const session = new CodexSession(params, emit, undefined, params.nativeSessionId);
    session.start();
    const nativeSessionId = await session.waitUntilReady();
    return { session, nativeSessionId };
  },
};

const registry: Partial<Record<SessionAgent, RunnerBackendAdapter>> = {
  claude,
  codex,
};

export function getRunnerBackendAdapter(agent: SessionAgent): RunnerBackendAdapter | null {
  return registry[agent] ?? null;
}
