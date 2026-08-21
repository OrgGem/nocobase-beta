import type { ToolsOptions } from '@nocobase/client-v2';
import { DrawioDiagramCard } from '../components/DrawioDiagramCard';
import { getDiagram, getDiagramState, setDiagram } from '../diagramStore';
import { wrapWithMxFile } from '../lib/xml-utils';
import type { ToolResult } from './types';

type DiagramShape = 'rect' | 'rounded' | 'ellipse' | 'diamond' | 'cylinder' | 'swimlane' | 'text';

type DiagramNode = {
  id: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  shape?: DiagramShape;
  parent?: string;
  style?: string;
};

type DiagramEdge = {
  id: string;
  source: string;
  target: string;
  label?: string;
  style?: string;
};

type DiagramModel = {
  title?: string;
  description?: string;
  diagramId?: string;
  containers?: DiagramNode[];
  nodes?: DiagramNode[];
  edges?: DiagramEdge[];
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function escapeXml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&')
    .replace(/</g, '<')
    .replace(/>/g, '>')
    .replace(/"/g, '"');
}

function normalizeStyle(style?: string) {
  if (!style) return '';
  return style.endsWith(';') ? style : `${style};`;
}

function shapeStyle(shape: DiagramShape | undefined, fallback: DiagramShape) {
  switch (shape || fallback) {
    case 'ellipse':
      return 'ellipse;whiteSpace=wrap;html=1;';
    case 'diamond':
      return 'rhombus;whiteSpace=wrap;html=1;';
    case 'cylinder':
      return 'shape=cylinder3d;whiteSpace=wrap;html=1;boundedLbl=1;backgroundOutline=1;size=15;';
    case 'swimlane':
      return 'swimlane;whiteSpace=wrap;html=1;startSize=28;';
    case 'text':
      return 'text;html=1;strokeColor=none;fillColor=none;align=center;verticalAlign=middle;whiteSpace=wrap;';
    case 'rect':
      return 'rounded=0;whiteSpace=wrap;html=1;';
    case 'rounded':
    default:
      return 'rounded=1;whiteSpace=wrap;html=1;';
  }
}

function nodeToMxCell(node: DiagramNode, fallbackShape: DiagramShape) {
  const parent = node.parent || '1';
  const style = `${shapeStyle(node.shape, fallbackShape)}${normalizeStyle(node.style)}`;
  return `<mxCell id="${escapeXml(node.id)}" value="${escapeXml(node.label)}" style="${escapeXml(
    style,
  )}" vertex="1" parent="${escapeXml(parent)}"><mxGeometry x="${Number(node.x) || 0}" y="${
    Number(node.y) || 0
  }" width="${Number(node.width) || 120}" height="${Number(node.height) || 60}" as="geometry"/></mxCell>`;
}

function edgeToMxCell(edge: DiagramEdge) {
  const style = `edgeStyle=orthogonalEdgeStyle;rounded=0;orthogonalLoop=1;jettySize=auto;html=1;endArrow=classic;${normalizeStyle(
    edge.style,
  )}`;
  return `<mxCell id="${escapeXml(edge.id)}" value="${escapeXml(edge.label || '')}" style="${escapeXml(
    style,
  )}" edge="1" parent="1" source="${escapeXml(edge.source)}" target="${escapeXml(
    edge.target,
  )}"><mxGeometry relative="1" as="geometry"/></mxCell>`;
}

function modelToMxCells(model: DiagramModel) {
  return [
    ...(model.containers || []).map((node) => nodeToMxCell(node, 'swimlane')),
    ...(model.nodes || []).map((node) => nodeToMxCell(node, 'rounded')),
    ...(model.edges || []).map(edgeToMxCell),
  ].join('\n');
}

async function invoke(
  app: Parameters<NonNullable<ToolsOptions['invoke']>>[0],
  rawParams: unknown,
): Promise<ToolResult> {
  const params = rawParams as DiagramModel;
  if (!params.nodes?.length) {
    return { status: 'error', content: 'display_model_diagram called without nodes.' };
  }

  const fullXml = wrapWithMxFile(modelToMxCells(params));

  try {
    const current = getDiagram();
    const diagramId = params.diagramId || current?.id || `diagram-${Date.now().toString(36)}`;
    const title = params.title || current?.title || 'Drawio Diagram';
    setDiagram(diagramId, title, fullXml);

    return {
      status: 'success',
      content: `Successfully displayed the diagram${params.title ? ` "${params.title}"` : ''}. ${
        getDiagramState().drawerOpen ? '' : 'Click "Open Diagram" to view it.'
      }`,
    };
  } catch (error: unknown) {
    return { status: 'error', content: `Failed to display diagram: ${errorMessage(error)}` };
  }
}

export const displayModelDiagramTool: [string, ToolsOptions] = [
  'drawio-display_model_diagram',
  {
    invoke,
    ui: {
      card: DrawioDiagramCard,
    },
  },
];
