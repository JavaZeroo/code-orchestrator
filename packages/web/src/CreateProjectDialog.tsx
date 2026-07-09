/**
 * 新建项目弹窗（#70）：从项目切换器下拉底部「＋ 新建项目」触发。
 * 表单体从 ProjectsPage.tsx 的 CreateProject 搬迁。
 */

import { useState } from 'react';
import { toast } from 'sonner';
import { type ForgeKind } from './api';
import { api } from './api';
import { Button } from './components/ui/button';
import { Card, Input, Label } from './components/ui/primitives';
import { Dialog, DialogContent, DialogTitle } from './components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './components/ui/select';
import { invalidate } from './lib/queries';

export function CreateProjectDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState('');
  const [forge, setForge] = useState<ForgeKind>('github');
  const [repo, setRepo] = useState('');
  const [baseImage, setBaseImage] = useState('');
  const [busy, setBusy] = useState(false);

  const create = () => {
    setBusy(true);
    api
      .createProject({ name: name.trim(), forge, repo: repo.trim(), autonomy: 'manual', baseImage: baseImage.trim() || null })
      .then(() => {
        toast.success('项目已创建（自治=手动，可随时拨开关）');
        setName('');
        setRepo('');
        setBaseImage('');
        onClose();
        invalidate('projects');
        onDone();
      })
      .catch((e) => toast.error(String(e instanceof Error ? e.message : e)))
      .finally(() => setBusy(false));
  };

  const resetAndClose = () => {
    setName('');
    setRepo('');
    setBaseImage('');
    setBusy(false);
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && resetAndClose()}>
      <DialogContent>
        <DialogTitle>新建项目</DialogTitle>
        <Card className="flex flex-col gap-3 p-4">
          <div className="grid grid-cols-2 gap-3">
            <Label>
              名称
              <Input value={name} placeholder="mindformers" onChange={(e) => setName(e.target.value)} />
            </Label>
            <Label>
              代码托管
              <Select value={forge} onValueChange={(v) => setForge(v as ForgeKind)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="github">GitHub</SelectItem>
                  <SelectItem value="gitcode">GitCode</SelectItem>
                </SelectContent>
              </Select>
            </Label>
          </div>
          <Label>
            仓库（owner/repo）
            <Input value={repo} placeholder="owner/repo" onChange={(e) => setRepo(e.target.value)} />
          </Label>
          <Label>
            容器镜像（可选 · design-v2）
            <Input value={baseImage} placeholder="留空=非容器化；如 mindformers:ms2.7.2_..." onChange={(e) => setBaseImage(e.target.value)} />
          </Label>
          <p className="text-[11px] text-faint">配了镜像即容器化项目，可「启动容器会话」；默认「手动」——建好后按需拨自治开关。</p>
          <div className="flex gap-2">
            <Button variant="default" disabled={busy || !name.trim() || !repo.trim()} onClick={create}>
              {busy ? '创建中…' : '创建'}
            </Button>
            <Button variant="ghost" onClick={resetAndClose}>
              取消
            </Button>
          </div>
        </Card>
      </DialogContent>
    </Dialog>
  );
}
