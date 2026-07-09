import { describe, expect, it } from 'vitest';
import type { ProjectRow, RunRow, SessionRow } from '../api';
import {
  crossProjectWaiting,
  isWaitingRun,
  isWaitingSession,
  threadProjectId,
  waitingCountByProject,
} from './attention';

function session(partial: Partial<SessionRow> & Pick<SessionRow, 'id' | 'state'>): SessionRow {
  const { id, state, ...rest } = partial;
  return {
    id,
    machineId: 'm1',
    agent: 'claude',
    model: null,
    cwd: '/repo/worktree',
    title: null,
    state,
    nativeSessionId: null,
    runId: null,
    nodeId: null,
    projectId: null,
    usage: null,
    createdAt: '2026-07-09T00:00:00Z',
    ...rest,
  };
}

function run(partial: Partial<RunRow> & Pick<RunRow, 'id' | 'status'>): RunRow {
  const { id, status, ...rest } = partial;
  return {
    id,
    defId: 'workflow-definition',
    projectId: null,
    status,
    context: { vars: {}, outputs: {} },
    startedAt: '2026-07-09T00:00:00Z',
    endedAt: null,
    ...rest,
  };
}

function project(id: string, name: string): ProjectRow {
  return {
    id,
    name,
    forge: 'github',
    repo: 'owner/repo',
    autonomy: 'manual',
    guardrails: [],
    defaultDefId: null,
    defaultWorkflow: null,
    models: {},
    vars: {},
    baseImage: null,
    accel: null,
    components: {},
    memoryRepo: null,
    createdAt: '2026-07-09T00:00:00Z',
  };
}

describe('attention selectors', () => {
  it('classifies only human-waiting sessions and runs as attention items', () => {
    expect(isWaitingSession(session({ id: 's-approval', state: 'waiting_approval' }))).toBe(true);
    expect(isWaitingSession(session({ id: 's-input', state: 'waiting_input' }))).toBe(true);
    expect(isWaitingSession(session({ id: 's-idle', state: 'idle' }))).toBe(false);
    expect(isWaitingRun(run({ id: 'r-human', status: 'waiting_human' }))).toBe(true);
    expect(isWaitingRun(run({ id: 'r-running', status: 'running' }))).toBe(false);
  });

  it('resolves a session project directly before falling back to its run', () => {
    const runMap = new Map([
      ['r1', run({ id: 'r1', status: 'waiting_human', projectId: 'p-from-run' })],
    ]);

    expect(threadProjectId(session({ id: 's-direct', state: 'waiting_input', projectId: 'p-direct', runId: 'r1' }), runMap)).toBe('p-direct');
    expect(threadProjectId(session({ id: 's-run', state: 'waiting_input', runId: 'r1' }), runMap)).toBe('p-from-run');
    expect(threadProjectId(session({ id: 's-none', state: 'waiting_input' }), runMap)).toBeNull();
  });

  it('counts waiting sessions and runs by project without counting non-waiting work', () => {
    const counts = waitingCountByProject(
      [
        session({ id: 's1', state: 'waiting_approval', projectId: 'p1' }),
        session({ id: 's2', state: 'waiting_input', runId: 'r2' }),
        session({ id: 's3', state: 'idle', projectId: 'p1' }),
      ],
      [
        run({ id: 'r1', status: 'waiting_human', projectId: 'p1' }),
        run({ id: 'r2', status: 'running', projectId: 'p2' }),
        run({ id: 'r3', status: 'waiting_human', projectId: 'p2' }),
      ],
    );

    expect(counts.get('p1')).toBe(2);
    expect(counts.get('p2')).toBe(2);
    expect(counts.size).toBe(2);
  });

  it('builds cross-project waiting items with project names and stable fallback titles', () => {
    const items = crossProjectWaiting(
      [
        session({ id: 's1', state: 'waiting_approval', projectId: 'p1', title: 'Review diff' }),
        session({ id: 's2', state: 'waiting_input', runId: 'r2', cwd: '/tmp/repo-b' }),
      ],
      [
        run({ id: 'r1', status: 'waiting_human', projectId: 'p1', defName: 'Gate check' }),
        run({ id: 'r2', status: 'running', projectId: 'p2' }),
        run({ id: 'r3', status: 'waiting_human', projectId: 'p-missing', defId: 'abcdef123456' }),
      ],
      [project('p1', 'Core'), project('p2', 'Edge')],
    );

    expect(items).toEqual([
      {
        kind: 'session',
        id: 's1',
        projectId: 'p1',
        projectName: 'Core',
        title: 'Review diff',
        subtitle: '等待处理',
      },
      {
        kind: 'session',
        id: 's2',
        projectId: 'p2',
        projectName: 'Edge',
        title: 'repo-b',
        subtitle: '等待处理',
      },
      {
        kind: 'run',
        id: 'r1',
        projectId: 'p1',
        projectName: 'Core',
        title: 'Gate check',
        subtitle: '流水线等待审批',
      },
      {
        kind: 'run',
        id: 'r3',
        projectId: 'p-missing',
        projectName: 'p-missing',
        title: 'abcdef12',
        subtitle: '流水线等待审批',
      },
    ]);
  });
});
