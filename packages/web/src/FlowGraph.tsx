import { useMemo } from 'react';
import dagre from '@dagrejs/dagre';
import { Background, ReactFlow, type Edge, type Node } from '@xyflow/react';
import type { WorkflowDef } from './api';
import '@xyflow/react/dist/style.css';

const NODE_W = 190;
const NODE_H = 54;

const STATUS_COLOR: Record<string, string> = {
  pending: '#3a4048',
  running: '#4f8cff',
  waiting_human: '#d29922',
  done: '#3fb950',
  failed: '#f85149',
  skipped: '#555',
};

const TYPE_ICON: Record<string, string> = {
  agent: '🤖',
  gate: '🚧',
  meeting: '🗳',
  fanout: '⑃',
  condition: '?',
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
          background: '#171a21',
          color: '#d7dce4',
          border: `2px solid ${border}`,
          borderRadius: 8,
          fontSize: 13,
          ...(status === 'running' ? { boxShadow: `0 0 12px ${border}66` } : {}),
        },
      };
    });
    const edges: Edge[] = def.edges.map(([from, to]) => ({
      id: `${from}->${to}`,
      source: from,
      target: to,
      animated: (statuses?.[to] ?? '') === 'running',
      style: { stroke: '#3a4048' },
    }));
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
      <Background gap={20} color="#20242c" />
    </ReactFlow>
  );
}
