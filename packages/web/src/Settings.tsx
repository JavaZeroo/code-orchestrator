/**
 * 全屏设置页（2026-07-09 分级管理决议）：三级分区——
 * 【个人】只影响当前账号（forge 令牌、通知）；
 * 【项目】随左上项目切换（基本信息、流水线、触发器与需求、物化状态）；
 * 【系统】实例级共享（机器、模型服务商、实例状态）。
 * 取代原 SettingsModal 与 ProjectSettings 两个弹窗。
 */

import { ArrowLeft, Bell, Boxes, Cpu, FolderGit2, GitBranch, HardDrive, KeyRound, Server, Workflow as WorkflowIcon, Zap } from 'lucide-react';
import { useEffect, useState } from 'react';
import { MachinesSection, NotifySection, ProvidersSection, TokensSection, type Me } from './Auth';
import { Designer } from './Designer';
import {
  ProjectAutomationSection,
  ProjectBasicSection,
  ProjectMaterialSection,
  ProjectPipelinesSection,
} from './ProjectSettings';
import { Button } from './components/ui/button';
import { Badge, StatusDot } from './components/ui/primitives';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './components/ui/select';
import { invalidate, useProjects, useResources } from './lib/queries';
import { useCurrentProject } from './lib/project';
import { cn } from './lib/utils';

export type SettingsSection =
  | 'me-tokens'
  | 'me-notify'
  | 'proj-basic'
  | 'proj-pipelines'
  | 'proj-automation'
  | 'proj-material'
  | 'sys-machines'
  | 'sys-providers'
  | 'sys-status';

interface NavItem {
  id: SettingsSection;
  label: string;
  icon: typeof KeyRound;
}

const NAV_GROUPS: { label: string; items: NavItem[] }[] = [
  {
    label: '个人',
    items: [
      { id: 'me-tokens', label: 'forge 令牌', icon: KeyRound },
      { id: 'me-notify', label: '通知', icon: Bell },
    ],
  },
  {
    label: '项目',
    items: [
      { id: 'proj-basic', label: '基本信息', icon: FolderGit2 },
      { id: 'proj-pipelines', label: '流水线', icon: WorkflowIcon },
      { id: 'proj-automation', label: '触发器与需求', icon: Zap },
      { id: 'proj-material', label: '物化状态', icon: HardDrive },
    ],
  },
  {
    label: '系统',
    items: [
      { id: 'sys-machines', label: '机器', icon: Server },
      { id: 'sys-providers', label: '模型服务商', icon: Boxes },
      { id: 'sys-status', label: '实例状态', icon: Cpu },
    ],
  },
];

const SECTION_TITLE: Record<SettingsSection, { title: string; hint: string }> = {
  'me-tokens': { title: 'forge 令牌', hint: '只影响你的账号——系统以你的身份在 forge 创建 PR、发评论' },
  'me-notify': { title: '通知', hint: '只影响你的账号——审批/完成事件推送到你的飞书' },
  'proj-basic': { title: '基本信息', hint: '项目级——仓库、容器镜像、自治开关' },
  'proj-pipelines': { title: '流水线', hint: '项目级——「走流水线」与触发器共用的流程定义' },
  'proj-automation': { title: '触发器与需求', hint: '项目级——issue/定时自动起流水线的入口配置' },
  'proj-material': { title: '物化状态', hint: '项目级——各机器上的检出与缓存状态' },
  'sys-machines': { title: '机器', hint: '实例级——所有用户共享的执行机群，接入/labels/凭证' },
  'sys-providers': { title: '模型服务商', hint: '实例级——所有用户共享的模型端点注册表' },
  'sys-status': { title: '实例状态', hint: '实例级——服务健康、资源占用、排队' },
};

function SystemStatusSection() {
  const [health, setHealth] = useState<{ ok: boolean; db: boolean; auth: boolean; uptime: number; version?: string } | null>(null);
  const { data: resources } = useResources();

  useEffect(() => {
    fetch('/health').then((r) => r.json()).then(setHealth).catch(() => setHealth(null));
  }, []);

  const fmtUptime = (s: number) => {
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    return d > 0 ? `${d}d ${h}h ${m}m` : h > 0 ? `${h}h ${m}m` : `${m}m`;
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-lg border border-line p-4">
        <h4 className="mb-3 text-sm font-medium">服务</h4>
        {health ? (
          <div className="mono-nums flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-dim">
            <span className="inline-flex items-center gap-1.5"><StatusDot tone={health.ok ? 'ok' : 'danger'} live={health.ok} /> server {health.version ?? ''}</span>
            <span>运行 {fmtUptime(health.uptime)}</span>
            <span className="inline-flex items-center gap-1">db <Badge tone={health.db ? 'ok' : 'danger'}>{health.db ? 'ok' : 'off'}</Badge></span>
            <span className="inline-flex items-center gap-1">auth <Badge tone={health.auth ? 'ok' : 'warn'}>{health.auth ? 'on' : 'off'}</Badge></span>
          </div>
        ) : (
          <p className="text-xs text-dim">健康检查不可达</p>
        )}
      </div>
      <div className="rounded-lg border border-line p-4">
        <h4 className="mb-3 text-sm font-medium">资源</h4>
        {resources ? (
          <div className="flex flex-col gap-2 text-xs text-dim">
            {resources.machines.map((m) => {
              const total = m.accels.reduce((n, a) => n + a.total, 0);
              const free = Math.max(0, total - m.used);
              return (
                <div key={m.id} className="mono-nums flex items-center gap-3">
                  <StatusDot tone="ok" live />
                  <span className="w-40 truncate text-ink-2">{m.id}</span>
                  <span>{m.labels.join(', ') || '-'}</span>
                  <span className="ml-auto">{total > 0 ? `加速器空闲 ${free}/${total}` : '无加速器'}</span>
                </div>
              );
            })}
            {resources.queued > 0 && <div className="text-warn">排队任务 {resources.queued}</div>}
          </div>
        ) : (
          <p className="text-xs text-dim">加载中…</p>
        )}
      </div>
    </div>
  );
}

export function SettingsPage({
  me,
  section,
  onSectionChange,
  onBack,
  onChanged,
  onOpenRun,
  onOpenSession,
}: {
  me: Me;
  section: SettingsSection;
  onSectionChange: (s: SettingsSection) => void;
  onBack: () => void;
  onChanged: () => void;
  onOpenRun: (runId: string) => void;
  onOpenSession: (id: string) => void;
}) {
  const { data: projects = [] } = useProjects();
  const { projectId, setProjectId } = useCurrentProject();
  const project = projects.find((p) => p.id === projectId);
  const [designerOpen, setDesignerOpen] = useState(false);

  const isProjectSection = section.startsWith('proj-');
  const meta = SECTION_TITLE[section];

  // 编排全屏子视图（占满内容区，高度充裕）
  if (designerOpen) {
    return (
      <div className="flex flex-1 flex-col overflow-hidden">
        <Designer
          onBack={() => setDesignerOpen(false)}
          onSaved={() => {
            invalidate('workflows');
            setDesignerOpen(false);
          }}
        />
      </div>
    );
  }

  const renderContent = () => {
    if (isProjectSection && !project) {
      return <p className="p-6 text-sm text-dim">请先在上方选择项目。</p>;
    }
    switch (section) {
      case 'me-tokens':
        return <TokensSection me={me} onChanged={onChanged} />;
      case 'me-notify':
        return <NotifySection me={me} onChanged={onChanged} />;
      case 'proj-basic':
        return <ProjectBasicSection project={project!} onOpenSession={onOpenSession} />;
      case 'proj-pipelines':
        return <ProjectPipelinesSection project={project!} onOpenDesigner={() => setDesignerOpen(true)} />;
      case 'proj-automation':
        return <ProjectAutomationSection me={me} project={project!} onOpenRun={onOpenRun} />;
      case 'proj-material':
        return <ProjectMaterialSection projectId={project!.id} />;
      case 'sys-machines':
        return <MachinesSection />;
      case 'sys-providers':
        return <ProvidersSection me={me} onChanged={onChanged} />;
      case 'sys-status':
        return <SystemStatusSection />;
    }
  };

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <header className="flex h-13 shrink-0 items-center gap-3 border-b border-line bg-bg-2/40 px-4 py-2.5 backdrop-blur-sm">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft size={14} /> 返回
        </Button>
        <h1 className="font-display text-[15px] font-semibold tracking-tight text-ink">设置</h1>
        <span className="hidden text-xs text-faint sm:inline">— 个人 · 项目 · 系统 三级管理</span>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* 分级导航 */}
        <aside className="flex w-52 shrink-0 flex-col gap-1 overflow-y-auto border-r border-line bg-bg-2/40 p-3">
          {NAV_GROUPS.map((g) => (
            <div key={g.label} className="mb-2">
              <div className="flex items-center gap-2 px-2 pb-1.5 text-[10px] font-semibold tracking-widest text-faint uppercase">
                {g.label}
                {g.label === '项目' && <GitBranch size={10} className="text-faint" />}
              </div>
              {g.label === '项目' && (
                <div className="mb-1.5 px-1">
                  <Select value={projectId ?? ''} onValueChange={setProjectId}>
                    <SelectTrigger className="h-7 w-full !text-[12px]">
                      <SelectValue placeholder="选择项目" />
                    </SelectTrigger>
                    <SelectContent>
                      {projects.map((p) => (
                        <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              {g.items.map((it) => {
                const active = section === it.id;
                return (
                  <button
                    key={it.id}
                    onClick={() => onSectionChange(it.id)}
                    className={cn(
                      'group relative flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] transition-all',
                      active ? 'bg-panel-2 text-ink shadow-[var(--shadow-panel)]' : 'text-dim hover:bg-panel/60 hover:text-ink-2',
                    )}
                  >
                    {active && <span className="absolute top-1.5 bottom-1.5 left-0 w-[2.5px] rounded-full bg-accent" />}
                    <it.icon size={14} className={cn('shrink-0', active ? 'text-accent' : 'text-faint group-hover:text-dim')} />
                    {it.label}
                  </button>
                );
              })}
            </div>
          ))}
        </aside>

        {/* 内容区 */}
        <main className="flex-1 overflow-y-auto">
          <div className="mx-auto flex max-w-3xl flex-col gap-4 p-6">
            <div>
              <h2 className="text-[15px] font-semibold text-ink">
                {meta.title}
                {isProjectSection && project && <span className="ml-2 text-xs font-normal text-faint">@ {project.name}</span>}
              </h2>
              <p className="mt-0.5 text-xs text-faint">{meta.hint}</p>
            </div>
            {renderContent()}
          </div>
        </main>
      </div>
    </div>
  );
}
