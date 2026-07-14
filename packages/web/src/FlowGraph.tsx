import { useMemo } from 'react';
import dagre from '@dagrejs/dagre';
import { Background, ReactFlow, type Edge, type Node } from '@xyflow/react';
import type { WorkflowDef } from './api';
import '@xyflow/react/dist/style.css';

const NODE_W = 190;
const NODE_H = 54;

const STATUS_COLOR: Record<string, string> = {
  pending: 'var(--color-line-2)',
  running: 'var(--color-run)',
  waiting_human: 'var(--color-human)',
  done: 'var(--color-ok)',
  failed: 'var(--color-danger)',
  skipped: 'var(--color-faint)',
};

const TYPE_ICON: Record<string, string> = {
  agent: '🤖',
  gate: '🚧',
  meeting: '🗳',
  fanout: '⑃',
  condition: '?',
  check: '✓',
};

interface Props {
  def: WorkflowDef;
  statuses?: Record<string, string>;
  onNodeClick?: (nodeId: string) => void;
}

export function FlowGraph({ def, statuses, onNodeClick }: Props) {
  const { nodes, edges } = useMemo(() => {
    const g = new dagre.graphlib.Graph();
    g.setGraph({ rankdir: 'TB', nodesep: 50, ranksep: 70 });
    g.setDefaultEdgeLabel(() => ({}));
    for (const n of def.nodes) {
      g.setNode(n.id, { width: NODE_W, height: NODE_H });
    }
    for (const [from, to] of def.edges) {
      g.setEdge(from, to);
    }
    dagre.layout(g);

    const nodes: Node[] = def.nodes.map((n) => {
      const pos = g.node(n.id);
      const status = statuses?.[n.id] ?? 'pending';
      const border = STATUS_COLOR[status] ?? STATUS_COLOR.pending!;
      return {
        id: n.id,
        position: { x: pos.x - NODE_W / 2, y: pos.y - NODE_H / 2 },
        data: {
          label: `${TYPE_ICON[n.type] ?? ''} ${n.title ?? n.id}${n.type === 'agent' && n.model ? ` · ${n.model}` : ''}`,
        },
        style: {
          width: NODE_W,
          background: 'var(--color-panel-2)',
          color: 'var(--color-ink)',
          border: `1.5px solid ${border}`,
          borderRadius: 10,
          fontSize: 13,
          fontWeight: 500,
          boxShadow:
            status === 'running'
              ? `0 0 0 3px color-mix(in oklch, ${border} 22%, transparent), var(--shadow-panel)`
              : 'var(--shadow-panel)',
        },
      };
    });
    const edges: Edge[] = def.edges.map(([from, to]) => {
      const source = def.nodes.find((node) => node.id === from);
      const branch = source?.type === 'condition'
        ? source.onTrue.includes(to) ? '是' : source.onFalse.includes(to) ? '否' : undefined
        : undefined;
      return {
        id: `${from}->${to}`,
        source: from,
        target: to,
        label: branch,
        labelStyle: branch ? { fill: 'var(--color-dim)', fontSize: 11, fontWeight: 600 } : undefined,
        labelBgStyle: branch ? { fill: 'var(--color-panel)', fillOpacity: 0.9 } : undefined,
        labelBgPadding: branch ? [4, 2] : undefined,
        animated: (statuses?.[to] ?? '') === 'running',
        style: { stroke: 'var(--color-line-2)', strokeWidth: 1.5 },
      };
    });
    return { nodes, edges };
  }, [def, statuses]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      fitView
      colorMode="dark"
      nodesDraggable={false}
      nodesConnectable={false}
      proOptions={{ hideAttribution: true }}
      onNodeClick={(_, node) => onNodeClick?.(node.id)}
    >
      <Background gap={22} color="var(--color-line)" />
    </ReactFlow>
  );
}
