import { Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api } from './api';
import { Button } from './components/ui/button';
import { Input, Label, Textarea } from './components/ui/primitives';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './components/ui/select';
import { useMachines } from './lib/queries';

export function NewSession({ onCreated }: { onCreated: (sessionId: string) => void }) {
  const { data: machines = [] } = useMachines();
  const [machineId, setMachineId] = useState('');
  const [cwd, setCwd] = useState('/root');
  const [model, setModel] = useState('claude');
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (machines.length > 0 && !machineId) {
      setMachineId(machines[0]!.id);
    }
  }, [machines, machineId]);

  const submit = () => {
    if (!machineId || !cwd) {
      return;
    }
    setBusy(true);
    api
      .spawn({ machineId, cwd, model, prompt: prompt.trim() || undefined })
      .then((d) => onCreated(d.sessionId))
      .catch((e) => toast.error(`创建失败：${e}`))
      .finally(() => setBusy(false));
  };

  return (
    <div className="mx-auto mt-12 flex w-full max-w-lg flex-col gap-4 px-4">
      <h2 className="text-lg font-semibold">新建会话</h2>
      <Label>
        机器
        <Select value={machineId} onValueChange={setMachineId}>
          <SelectTrigger>
            <SelectValue placeholder="选择机器" />
          </SelectTrigger>
          <SelectContent>
            {machines.map((m) => (
              <SelectItem key={m.id} value={m.id}>
                {m.name} {m.labels.length > 0 ? `[${m.labels.join(',')}]` : ''}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Label>
      <Label>
        工作目录
        <Input value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="/path/to/repo" />
      </Label>
      <Label>
        模型
        <Select value={model} onValueChange={setModel}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="claude">claude（默认）</SelectItem>
            <SelectItem value="deepseek">deepseek（Anthropic 兼容端点）</SelectItem>
            <SelectItem value="glm">glm（Anthropic 兼容端点）</SelectItem>
          </SelectContent>
        </Select>
      </Label>
      <Label>
        首条消息（可选）
        <Textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={4} placeholder="要做什么？" className="resize-none" />
      </Label>
      <Button variant="default" disabled={busy || !machineId} onClick={submit}>
        <Plus size={14} /> {busy ? '创建中…' : '创建会话'}
      </Button>
      {machines.length === 0 && <p className="text-xs text-dim">没有在线机器——先在目标机器上启动 runner。</p>}
    </div>
  );
}
