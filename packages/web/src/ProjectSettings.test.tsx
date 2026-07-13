import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { RequirementRow } from './api';
import {
  downloadWorkflowTemplate,
  importWorkflowTemplateFile,
  parseWorkflowTemplateJson,
  RequirementRowItem,
  WorkflowExportAction,
  WorkflowImportAction,
} from './ProjectSettings';

const requirement: RequirementRow = {
  id: 'intake-1',
  triggerId: 'trigger-1',
  projectId: 'project-1',
  forge: 'github',
  repo: 'acme/widgets',
  issueNumber: '42',
  title: 'Build a widget',
  author: 'alice',
  issueUrl: 'https://github.com/acme/widgets/issues/42',
  runId: null,
  status: 'seeded',
  runStatus: null,
  createdAt: '2026-07-11T00:00:00Z',
};

describe('RequirementRowItem', () => {
  it('offers start for seeded intakes and retry for failed intakes', () => {
    const seeded = renderToStaticMarkup(<RequirementRowItem r={requirement} onOpenRun={vi.fn()} />);
    const failed = renderToStaticMarkup(
      <RequirementRowItem r={{ ...requirement, status: 'failed' }} onOpenRun={vi.fn()} />,
    );

    expect(seeded).toContain('title="启动需求"');
    expect(seeded).toContain(' 启动</button>');
    expect(failed).toContain('title="重试需求"');
    expect(failed).toContain(' 重试</button>');
  });

  it('shows only the existing run action after an intake has started', () => {
    const started = renderToStaticMarkup(
      <RequirementRowItem
        r={{ ...requirement, status: 'started', runId: 'run-1', runStatus: 'running' }}
        onOpenRun={vi.fn()}
      />,
    );

    expect(started).not.toContain('title="启动需求"');
    expect(started).not.toContain('title="重试需求"');
    expect(started).toContain('title="查看运行"');
  });
});

describe('workflow template import', () => {
  const validDefinition = {
    name: 'Release pipeline',
    description: 'Build and review a release',
    nodes: [{ id: 'build', type: 'agent' as const, prompt: 'Build the release', cli: 'claude' as const }],
    edges: [],
  };

  it('imports a valid JSON file as a manual workflow in the selected project and refreshes the list', async () => {
    const createWorkflow = vi.fn().mockResolvedValue({ id: 'workflow-1' });
    const refreshWorkflows = vi.fn();
    const file = { text: vi.fn().mockResolvedValue(JSON.stringify(validDefinition)) };

    await expect(importWorkflowTemplateFile(
      'project-42',
      file,
      createWorkflow,
      refreshWorkflows,
    )).resolves.toEqual(validDefinition);

    expect(file.text).toHaveBeenCalledOnce();
    expect(createWorkflow).toHaveBeenCalledWith(validDefinition, 'manual', 'project-42');
    expect(refreshWorkflows).toHaveBeenCalledOnce();
  });

  it('rejects malformed or schema-invalid JSON before creating or refreshing a workflow', async () => {
    const createWorkflow = vi.fn();
    const refreshWorkflows = vi.fn();

    await expect(importWorkflowTemplateFile(
      'project-42',
      { text: async () => '{not json' },
      createWorkflow,
      refreshWorkflows,
    )).rejects.toThrow('有效的 JSON');
    await expect(importWorkflowTemplateFile(
      'project-42',
      { text: async () => JSON.stringify({ ...validDefinition, nodes: [] }) },
      createWorkflow,
      refreshWorkflows,
    )).rejects.toThrow('不符合流水线定义');

    expect(createWorkflow).not.toHaveBeenCalled();
    expect(refreshWorkflows).not.toHaveBeenCalled();
  });

  it('exposes a single JSON-file picker in the pipeline actions', () => {
    const markup = renderToStaticMarkup(
      <WorkflowImportAction importing={false} onFile={vi.fn()} />,
    );

    expect(markup).toContain('导入 JSON');
    expect(markup).toContain('type="file"');
    expect(markup).toContain('accept="application/json,.json"');
    expect(markup).not.toContain('multiple');
  });
});

describe('workflow template export', () => {
  const workflow = {
    name: 'Release / prod:night ..',
    graph: {
      name: 'Release pipeline',
      description: 'Build and review a release',
      nodes: [{ id: 'build', type: 'agent' as const, prompt: 'Build the release', cli: 'claude' as const }],
      edges: [],
    },
  };

  it('downloads importer-compatible pretty-printed JSON with a filename-safe workflow name', () => {
    const download = vi.fn();

    downloadWorkflowTemplate(workflow, download);

    expect(download).toHaveBeenCalledOnce();
    const [filename, contents] = download.mock.calls[0] as [string, string];
    expect(filename).toBe('Release-prod-night.json');
    expect(contents).toBe(`${JSON.stringify(workflow.graph, null, 2)}\n`);
    expect(contents).toContain('\n  "nodes": [\n');
    expect(parseWorkflowTemplateJson(contents)).toEqual(workflow.graph);
  });

  it('exposes an accessible JSON export action for an active workflow card', () => {
    const markup = renderToStaticMarkup(
      <WorkflowExportAction workflow={workflow} onExport={vi.fn()} />,
    );

    expect(markup).toContain('aria-label="导出 JSON"');
    expect(markup).toContain('title="导出 JSON"');
  });
});
