import type { ToolsOptions } from '@nocobase/client';
import { createAndOpenDiagram } from '../autoOpenDiagram';
import { getActiveHandle, getAllHandles } from '../lib/activeRegistry';
import { wrapWithMxFile } from '../lib/xml-utils';
import { DrawioDiagramCard } from '../components/DrawioDiagramCard';
import { setDiagramResult } from '../components/diagramResultStore';
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
  containers?: DiagramNode[];
  nodes?: DiagramNode[];
  edges?: DiagramEdge[];
};

function getMountedHandle() {
  return getActiveHandle() || getAllHandles()[0] || null;
}

function escapeXml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function normalizeStyle(style?: string) {
  if (!style) return '';
  return style.endsWith(';') ? style : `${style};`;
}

function shapeStyle(shape: DiagramShape | undefined, fallback: DiagramShape) {
  const kind = shape || fallback;
  switch (kind) {
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
  const containers = model.containers || [];
  const nodes = model.nodes || [];
  const edges = model.edges || [];
  return [
    ...containers.map((node) => nodeToMxCell(node, 'swimlane')),
    ...nodes.map((node) => nodeToMxCell(node, 'rounded')),
    ...edges.map(edgeToMxCell),
  ].join('\n');
}

async function invoke(app: any, params: DiagramModel): Promise<ToolResult> {
  const nodes = params?.nodes || [];
  if (!nodes.length) {
    return { status: 'error', content: 'display_model_diagram called without nodes.' };
  }

  const fullXml = wrapWithMxFile(modelToMxCells(params));
  try {
    const existingHandle = getMountedHandle();

    if (existingHandle) {
      // Drawio block is already open on the page — apply directly
      existingHandle.setXml(fullXml);
      await existingHandle.persist(fullXml);
      existingHandle.bridge.load(fullXml);

      const title = existingHandle.diagramTitle || params.title || 'Drawio Diagram';
      setDiagramResult({
        diagramId: existingHandle.diagramId,
        title,
        appliedDirectly: true,
      });
      (params as any)._diagramId = existingHandle.diagramId;
      (params as any)._appliedDirectly = true;

      return { status: 'success', content: 'Successfully displayed the diagram.' };
    }

    // No drawio block is open — create the diagram record and save XML.
    // The UI card will give the user a button to open it.
    const apiClient = app?.apiClient;
    if (!apiClient) {
      // Fallback: auto-open via Drawer as before
      const handle = await createAndOpenDiagram(app, {
        title: params.title,
        description: params.description || 'Created from AI Employee draw.io tool.',
      });
      handle.setXml(fullXml);
      await handle.persist(fullXml);
      handle.bridge.load(fullXml);

      const title = handle.diagramTitle || params.title || 'Drawio Diagram';
      setDiagramResult({
        diagramId: handle.diagramId,
        title,
        appliedDirectly: true,
      });
      (params as any)._diagramId = handle.diagramId;
      (params as any)._appliedDirectly = true;

      return { status: 'success', content: 'Successfully displayed the diagram.' };
    }

    const title = params.title || `AI diagram ${new Date().toLocaleString()}`;
    const response = await apiClient.resource('aiDiagrams').create({
      values: {
        title,
        description: params.description || 'Created from AI Employee draw.io tool.',
        mode: 'editable',
      },
    });
    const diagramId = response?.data?.data?.id || response?.data?.id;
    if (!diagramId) {
      throw new Error('Failed to create draw.io diagram.');
    }

    // Save the XML content to the newly created diagram
    await apiClient.request({
      url: `aiDiagrams:saveXml/${encodeURIComponent(diagramId)}`,
      method: 'post',
      data: { xml: fullXml },
    });

    setDiagramResult({
      diagramId,
      title,
      appliedDirectly: false,
    });
    (params as any)._diagramId = diagramId;
    (params as any)._appliedDirectly = false;

    return {
      status: 'success',
      content: `Diagram created successfully. Click "Open Diagram" below to view it.`,
    };
  } catch (err: any) {
    return {
      status: 'error',
      content: `Failed to display diagram: ${err?.message || String(err)}`,
    };
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
