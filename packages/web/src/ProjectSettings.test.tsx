import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { RequirementRow } from './api';
import { RequirementRowItem } from './ProjectSettings';

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
