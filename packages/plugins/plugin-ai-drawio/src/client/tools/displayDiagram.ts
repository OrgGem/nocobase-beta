import type { ToolsOptions } from '@nocobase/client-v2';
import { getActiveHandle, getAllHandles, getHandleByDiagramId } from '../lib/activeRegistry';
import { isMxCellXmlComplete, wrapWithMxFile } from '../lib/xml-utils';
import { resetPartialXml, setPartialXml } from './sharedState';
import { DrawioDiagramCard } from '../components/DrawioDiagramCard';
import { setDiagramResult } from '../components/diagramResultStore';
import type { ToolResult } from './types';

type DisplayDiagramParams = {
  xml?: string;
  title?: string;
  description?: string;
  diagramId?: string;
};

function getMountedHandle(diagramId?: string) {
  if (diagramId) {
    return getHandleByDiagramId(diagramId);
  }
  return getActiveHandle() || getAllHandles()[0] || null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function invoke(
  app: Parameters<NonNullable<ToolsOptions['invoke']>>[0],
  rawParams: unknown,
): Promise<ToolResult> {
  const params = rawParams as DisplayDiagramParams;
  const xml = params.xml || '';
  if (!xml) {
    return { status: 'error', content: 'display_diagram called without xml.' };
  }

  if (!isMxCellXmlComplete(xml)) {
    setPartialXml(xml);
    const ending = xml.slice(-500);
    return {
      status: 'error',
      content:
        'Output was truncated due to length limits. Use the append_diagram tool to continue.\n\n' +
        `Your output ended with:\n\`\`\`\n${ending}\n\`\`\`\n\n` +
        'NEXT STEP: Call append_diagram with the continuation XML.\n' +
        '- Do NOT include wrapper tags or root cells (id="0", id="1")\n' +
        '- Start from EXACTLY where you stopped\n' +
        '- Complete all remaining mxCell elements',
    };
  }

  resetPartialXml();
  const fullXml = wrapWithMxFile(xml);

  try {
    const existingHandle = getMountedHandle(params.diagramId);

    if (existingHandle) {
      existingHandle.setXml(fullXml);
      await existingHandle.persist(fullXml);
      existingHandle.load(fullXml);

      setDiagramResult({
        diagramId: existingHandle.diagramId,
        title: existingHandle.diagramTitle || params.title || 'Drawio Diagram',
        appliedDirectly: true,
      });

      return { status: 'success', content: 'Successfully displayed the diagram.' };
    }

    if (params.diagramId) {
      return {
        status: 'error',
        content: `The requested diagram ${params.diagramId} is not open on this page. Open it before updating it.`,
      };
    }

    const apiClient = app.apiClient;
    if (!apiClient) {
      return { status: 'error', content: 'NocoBase API client is not available.' };
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

    await apiClient.request({
      url: `aiDiagrams:saveXml/${encodeURIComponent(diagramId)}`,
      method: 'post',
      data: { xml: fullXml },
    });

    setDiagramResult({ diagramId, title, appliedDirectly: false });
    return {
      status: 'success',
      content: 'Diagram created successfully. Click "Open Diagram" below to view it.',
    };
  } catch (error: unknown) {
    return { status: 'error', content: `Failed to display diagram: ${errorMessage(error)}` };
  }
}

export const displayDiagramTool: [string, ToolsOptions] = [
  'drawio-display_diagram',
  {
    invoke,
    ui: {
      card: DrawioDiagramCard,
    },
  },
];
