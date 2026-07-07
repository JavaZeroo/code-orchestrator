import { Play } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { type WorkflowDefRow, api } from '../api';
import { Button } from './ui/button';
import { Input, Label } from './ui/primitives';
import { useProjectScope } from '../lib/project';

export function StartForm({ def, onStarted }: { def: WorkflowDefRow; onStarted: (runId: string) => void }) {
  const varKeys = Object.keys(def.graph.vars ?? {});
  const needsCwd = def.graph.nodes.some((n) => n.type === 'agent' && !n.cwd);
  const keys = needsCwd && !varKeys.includes('cwd') ? ['cwd', ...varKeys] : varKeys;
  const [vars, setVars] = useState<Record<string, string>>({ ...(def.graph.vars ?? {}) });
  const [busy, setBusy] = useState(false);
  const { projectId } = useProjectScope();

  const start = () => {
    setBusy(true);
    api.startRun(def.id, vars, projectId).then((d) => onStarted(d.runId)).catch((e) => toast.error(String(e))).finally(() => setBusy(false));
  };

  return (
    <div className="mt-3 flex flex-col gap-2.5 border-t border-line pt-3">
      {keys.map((k) => (
        <Label key={k}>
          {k}
          <Input
            value={vars[k] ?? ''}
            placeholder={k === 'cwd' ? '/path/to/repo（agent 节点工作目录）' : ''}
            onChange={(e) => setVars({ ...vars, [k]: e.target.value })}
          />
        </Label>
      ))}
      <Button variant="default" size="sm" className="self-start" disabled={busy} onClick={start}>
        <Play size={13} /> {busy ? '启动中…' : '启动'}
      </Button>
    </div>
  );
}
