import type { CapabilityLoopState } from '@co/protocol';
import { Badge, type BadgeTone } from './ui/primitives';

export type CapabilityLoopViewState = CapabilityLoopState;

const PHASE_META: Record<CapabilityLoopViewState['phase'], { label: string; tone: BadgeTone }> = {
  attempt_running: { label: 'Agent 执行中', tone: 'run' },
  evaluating: { label: '独立验收中', tone: 'run' },
  feedback_ready: { label: '等待修正', tone: 'warn' },
  achieved: { label: '验收通过', tone: 'ok' },
  blocked: { label: '验证受阻', tone: 'danger' },
  exhausted: { label: '预算耗尽', tone: 'danger' },
};

const EVALUATION_META = {
  passed: { label: '通过', tone: 'ok' as BadgeTone },
  failed: { label: '未通过', tone: 'danger' as BadgeTone },
  error: { label: '验证器错误', tone: 'warn' as BadgeTone },
};

export function CapabilityOutcomePanel({ state }: { state: CapabilityLoopViewState }) {
  const phase = PHASE_META[state.phase];
  return (
    <section aria-label="Agent 能力验证" className="space-y-2 rounded-lg border border-line bg-panel-2 p-3 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="font-medium text-ink">能力验证</h4>
        <Badge tone={phase.tone}>{phase.label}</Badge>
        <span className="mono-nums ml-auto text-dim">
          Attempt {state.attempts.length} / {state.contract.budget.maxAttempts}
        </span>
      </div>

      <div className="space-y-2">
        {state.attempts.map((attempt) => (
          <div key={attempt.number} className="rounded-md border border-line/70 bg-bg/40 p-2">
            <div className="mb-1 flex items-center gap-2">
              <span className="font-medium text-ink-2">Attempt {attempt.number}</span>
              <span className="text-dim">{attempt.status}</span>
            </div>
            {attempt.evaluations.map((evaluation) => {
              const meta = EVALUATION_META[evaluation.status];
              return (
                <div key={evaluation.criterionId} className="mt-1 border-l-2 border-line pl-2">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <code className="font-mono text-[11px] text-ink">{evaluation.criterionId}</code>
                    <Badge tone={meta.tone}>{meta.label}</Badge>
                    <span className="mono-nums text-[10px] text-faint">{evaluation.evidence.durationMs} ms</span>
                  </div>
                  <p className="mt-1 whitespace-pre-wrap text-dim">{evaluation.detail}</p>
                </div>
              );
            })}
          </div>
        ))}
      </div>

      {state.outcome?.summary && (
        <div className="border-t border-line/70 pt-2 text-ink-2">
          <span className="font-medium">Outcome：</span>{state.outcome.summary}
        </div>
      )}
    </section>
  );
}
