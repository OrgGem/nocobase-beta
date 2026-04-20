import React, { useRef, useState, useCallback, useMemo, useEffect } from 'react';
import { Tooltip } from 'antd';
import {
  ZoomInOutlined,
  ZoomOutOutlined,
  ExpandOutlined,
  ClockCircleOutlined,
  CodeOutlined,
  EditOutlined,
  BranchesOutlined,
  FunctionOutlined,
  ThunderboltOutlined,
  ApiOutlined,
} from '@ant-design/icons';
import { useT } from '../locale';

// ── Types ────────────────────────────────────────────

interface N8nNode {
  id: string;
  name: string;
  type: string;
  typeVersion?: number;
  position: [number, number];
  parameters?: any;
}

interface N8nConnection {
  node: string;
  type: string;
  index: number;
}

interface N8nWorkflowData {
  nodes?: N8nNode[];
  connections?: Record<string, { main?: N8nConnection[][] }>;
}

interface Edge {
  from: string; // node name
  to: string; // node name
  fromIndex: number;
  toIndex: number;
}

// ── Constants ────────────────────────────────────────

const NODE_W = 160;
const NODE_H = 48;
const SCALE_MIN = 0.2;
const SCALE_MAX = 3;
const SCALE_STEP = 0.15;

// ── Node type icon + color mapping ──────────────────

function getNodeMeta(type: string): { icon: React.ReactNode; color: string; bg: string } {
  const t = type.toLowerCase();
  if (t.includes('trigger') || t.includes('webhook'))
    return { icon: <ThunderboltOutlined />, color: '#fa541c', bg: '#fff2e8' };
  if (t.includes('code') || t.includes('function'))
    return { icon: <CodeOutlined />, color: '#1890ff', bg: '#e6f7ff' };
  if (t.includes('set') || t.includes('edit'))
    return { icon: <EditOutlined />, color: '#52c41a', bg: '#f6ffed' };
  if (t.includes('switch') || t.includes('if') || t.includes('filter'))
    return { icon: <BranchesOutlined />, color: '#722ed1', bg: '#f9f0ff' };
  if (t.includes('aggregate') || t.includes('merge') || t.includes('split'))
    return { icon: <FunctionOutlined />, color: '#eb2f96', bg: '#fff0f6' };
  if (t.includes('http') || t.includes('api') || t.includes('request'))
    return { icon: <ApiOutlined />, color: '#13c2c2', bg: '#e6fffb' };
  if (t.includes('schedule') || t.includes('cron') || t.includes('interval'))
    return { icon: <ClockCircleOutlined />, color: '#faad14', bg: '#fffbe6' };
  return { icon: <ApiOutlined />, color: '#8c8c8c', bg: '#fafafa' };
}

function shortType(type: string): string {
  return type.replace(/^n8n-nodes-base\./, '').replace(/^@[^.]+\./, '');
}

// ── Edge path (bezier) ──────────────────────────────

function edgePath(x1: number, y1: number, x2: number, y2: number): string {
  const dx = Math.abs(x2 - x1) * 0.5;
  return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
}

// ── Component ────────────────────────────────────────

export const WorkflowCanvas: React.FC<{ workflow: any }> = ({ workflow }) => {
  const t = useT();
  const containerRef = useRef<HTMLDivElement>(null);

  // Pan/zoom state
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef({ x: 0, y: 0, ox: 0, oy: 0 });

  // Parse workflow data
  const wfData: N8nWorkflowData = useMemo(() => {
    if (!workflow) return { nodes: [], connections: {} };
    // Handle nested data structure
    const d = workflow.data || workflow;
    return {
      nodes: d.activeVersion?.nodes || d.nodes || [],
      connections: d.activeVersion?.connections || d.connections || {},
    };
  }, [workflow]);

  const { nodes, connections } = wfData;

  // Build edges
  const edges: Edge[] = useMemo(() => {
    const result: Edge[] = [];
    if (!connections) return result;
    for (const [fromName, conn] of Object.entries(connections)) {
      const outputs = conn.main || [];
      outputs.forEach((targets, fromIndex) => {
        targets?.forEach((target, toIndex) => {
          result.push({ from: fromName, to: target.node, fromIndex, toIndex });
        });
      });
    }
    return result;
  }, [connections]);

  // Node position lookup
  const nodeMap = useMemo(() => {
    const map = new Map<string, N8nNode>();
    nodes?.forEach((n) => map.set(n.name, n));
    return map;
  }, [nodes]);

  // Fit to view on first load
  useEffect(() => {
    if (!nodes?.length || !containerRef.current) return;
    fitToView();
  }, [nodes]);

  const fitToView = useCallback(() => {
    if (!nodes?.length || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const xs = nodes.map((n) => n.position[0]);
    const ys = nodes.map((n) => n.position[1]);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs) + NODE_W;
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys) + NODE_H;
    const contentW = maxX - minX + 80;
    const contentH = maxY - minY + 80;
    const s = Math.min(rect.width / contentW, rect.height / contentH, 1.5);
    setScale(Math.max(SCALE_MIN, Math.min(s, SCALE_MAX)));
    setOffset({
      x: (rect.width - contentW * s) / 2 - minX * s + 40 * s,
      y: (rect.height - contentH * s) / 2 - minY * s + 40 * s,
    });
  }, [nodes]);

  // Zoom
  const zoom = useCallback(
    (delta: number) => {
      setScale((prev) => Math.max(SCALE_MIN, Math.min(prev + delta, SCALE_MAX)));
    },
    [],
  );

  // Mouse wheel zoom
  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? -SCALE_STEP : SCALE_STEP;
      zoom(delta);
    },
    [zoom],
  );

  // Pan handlers
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      setDragging(true);
      dragStart.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y };
    },
    [offset],
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!dragging) return;
      setOffset({
        x: dragStart.current.ox + (e.clientX - dragStart.current.x),
        y: dragStart.current.oy + (e.clientY - dragStart.current.y),
      });
    },
    [dragging],
  );

  const handleMouseUp = useCallback(() => setDragging(false), []);

  if (!nodes?.length) {
    return <div style={{ padding: 24, color: '#999' }}>{t('No nodes found')}</div>;
  }

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', minHeight: 400 }}>
      {/* Toolbar */}
      <div
        style={{
          position: 'absolute',
          top: 8,
          right: 8,
          zIndex: 10,
          display: 'flex',
          gap: 4,
          background: '#fff',
          borderRadius: 6,
          boxShadow: '0 1px 4px rgba(0,0,0,0.12)',
          padding: '4px 6px',
        }}
      >
        <Tooltip title={t('Zoom In')}>
          <ZoomInOutlined
            style={{ fontSize: 18, cursor: 'pointer', padding: 4 }}
            onClick={() => zoom(SCALE_STEP)}
          />
        </Tooltip>
        <Tooltip title={t('Zoom Out')}>
          <ZoomOutOutlined
            style={{ fontSize: 18, cursor: 'pointer', padding: 4 }}
            onClick={() => zoom(-SCALE_STEP)}
          />
        </Tooltip>
        <Tooltip title={t('Fit to View')}>
          <ExpandOutlined
            style={{ fontSize: 18, cursor: 'pointer', padding: 4 }}
            onClick={fitToView}
          />
        </Tooltip>
        <span style={{ fontSize: 11, color: '#999', lineHeight: '26px', marginLeft: 4 }}>
          {Math.round(scale * 100)}%
        </span>
      </div>

      {/* Canvas */}
      <div
        ref={containerRef}
        style={{
          width: '100%',
          height: '100%',
          minHeight: 400,
          overflow: 'hidden',
          cursor: dragging ? 'grabbing' : 'grab',
          background: '#fafafa',
          backgroundImage:
            'radial-gradient(circle, #ddd 1px, transparent 1px)',
          backgroundSize: `${20 * scale}px ${20 * scale}px`,
          backgroundPosition: `${offset.x}px ${offset.y}px`,
          borderRadius: 8,
        }}
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
      >
        <div
          style={{
            transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
            transformOrigin: '0 0',
            position: 'relative',
          }}
        >
          {/* SVG Edges */}
          <svg
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              height: '100%',
              overflow: 'visible',
              pointerEvents: 'none',
            }}
          >
            <defs>
              <marker
                id="arrowhead"
                markerWidth="8"
                markerHeight="6"
                refX="8"
                refY="3"
                orient="auto"
              >
                <polygon points="0 0, 8 3, 0 6" fill="#b0b0b0" />
              </marker>
            </defs>
            {edges.map((edge, i) => {
              const fromNode = nodeMap.get(edge.from);
              const toNode = nodeMap.get(edge.to);
              if (!fromNode || !toNode) return null;

              const x1 = fromNode.position[0] + NODE_W;
              const y1 = fromNode.position[1] + NODE_H / 2;
              const x2 = toNode.position[0];
              const y2 = toNode.position[1] + NODE_H / 2;

              return (
                <path
                  key={`${edge.from}-${edge.to}-${i}`}
                  d={edgePath(x1, y1, x2, y2)}
                  fill="none"
                  stroke="#b0b0b0"
                  strokeWidth={2}
                  markerEnd="url(#arrowhead)"
                />
              );
            })}
          </svg>

          {/* Nodes */}
          {nodes.map((node) => {
            const meta = getNodeMeta(node.type);
            return (
              <Tooltip
                key={node.id}
                title={
                  <div>
                    <div style={{ fontWeight: 600 }}>{node.name}</div>
                    <div style={{ fontSize: 11, opacity: 0.8 }}>{shortType(node.type)}</div>
                    {node.typeVersion && (
                      <div style={{ fontSize: 11, opacity: 0.6 }}>v{node.typeVersion}</div>
                    )}
                  </div>
                }
              >
                <div
                  style={{
                    position: 'absolute',
                    left: node.position[0],
                    top: node.position[1],
                    width: NODE_W,
                    height: NODE_H,
                    background: meta.bg,
                    border: `2px solid ${meta.color}`,
                    borderRadius: 8,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '0 10px',
                    cursor: 'default',
                    userSelect: 'none',
                    boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
                    transition: 'box-shadow 0.15s',
                  }}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLDivElement).style.boxShadow = `0 2px 8px ${meta.color}40`;
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLDivElement).style.boxShadow = '0 1px 3px rgba(0,0,0,0.08)';
                  }}
                  onMouseDown={(e) => e.stopPropagation()}
                >
                  <span style={{ fontSize: 18, color: meta.color, flexShrink: 0 }}>{meta.icon}</span>
                  <span
                    style={{
                      fontSize: 12,
                      fontWeight: 500,
                      color: '#333',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {node.name}
                  </span>
                </div>
              </Tooltip>
            );
          })}
        </div>
      </div>
    </div>
  );
};
