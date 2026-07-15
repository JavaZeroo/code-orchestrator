import {
  contextPackSchema,
  type CapabilityLoopState,
  type ContextPack,
  type RepositoryCheckpoint,
  type RepositoryInstructionRef,
} from '@co/protocol';

export type { ContextPack, RepositoryCheckpoint, RepositoryInstructionRef } from '@co/protocol';

export function buildContextPack(
  state: CapabilityLoopState,
  cwd: string,
  instructions: RepositoryInstructionRef[],
  checkpoint: RepositoryCheckpoint,
  createdAt: string,
): ContextPack {
  return contextPackSchema.parse({
    version: 1,
    createdAt,
    task: {
      objective: state.contract.objective,
      acceptanceCriteria: state.contract.acceptanceCriteria.map(({ id, description }) => ({ id, description })),
      constraints: state.contract.constraints,
    },
    attempt: {
      number: state.attempts.length + 1,
      maxAttempts: state.contract.budget.maxAttempts,
    },
    repository: { cwd, instructions, checkpoint },
    priorAttempts: state.attempts.map((attempt) => ({
      number: attempt.number,
      status: attempt.status,
      summary: attempt.summary,
      findings: attempt.evaluations
        .filter((evaluation) => evaluation.status !== 'passed')
        .map(({ criterionId, status, detail }) => ({ criterionId, status, detail })),
    })),
  });
}

export function renderContextPack(pack: ContextPack): string {
  const criteria = pack.task.acceptanceCriteria
    .map((criterion) => `- [${criterion.id}] ${criterion.description}`)
    .join('\n');
  const constraints = pack.task.constraints.length > 0
    ? pack.task.constraints.map((constraint) => `- ${constraint}`).join('\n')
    : '- 无额外约束';
  const instructions = pack.repository.instructions.length > 0
    ? pack.repository.instructions
      .map((instruction) => `- ${instruction.path} (sha256=${instruction.sha256}, ${instruction.size} bytes)`)
      .join('\n')
    : '- 未发现根级指令文件；仍须遵循 Backend 自动加载的目录级指令。';
  const history = pack.priorAttempts.map((attempt) => {
    const findings = attempt.findings.length > 0
      ? attempt.findings.map((finding) => `  - [${finding.criterionId}] ${finding.detail}`).join('\n')
      : '  - 无失败 finding';
    return [
      `- Attempt ${attempt.number} (${attempt.status})${attempt.summary ? `：${attempt.summary}` : ''}`,
      findings,
    ].join('\n');
  }).join('\n');
  const checkpoint = pack.repository.checkpoint.gitHead
    ? `${pack.repository.checkpoint.gitHead} (${pack.repository.checkpoint.dirty ? 'dirty' : 'clean'})`
    : `unversioned (${pack.repository.checkpoint.dirty ? 'dirty' : 'clean'})`;
  return [
    `===== Context Pack v${pack.version} · Attempt ${pack.attempt.number}/${pack.attempt.maxAttempts} =====`,
    pack.task.objective ? `目标：${pack.task.objective}` : undefined,
    `Worktree：${pack.repository.cwd}`,
    `Checkpoint：${checkpoint}`,
    '验收标准：',
    criteria,
    '约束：',
    constraints,
    '仓库指令版本：',
    instructions,
    '此前 Attempt：',
    history || '- 无',
  ].filter((line): line is string => Boolean(line)).join('\n');
}
