import type { ToolsOptions } from '@nocobase/client';
import { createAndOpenDiagram } from '../autoOpenDiagram';
import { getActiveHandle, getAllHandles } from '../lib/activeRegistry';
import { isMxCellXmlComplete, wrapWithMxFile } from '../lib/xml-utils';
import { resetPartialXml, setPartialXml } from './sharedState';
import { DrawioDiagramCard } from '../components/DrawioDiagramCard';
import { setDiagramResult } from '../components/diagramResultStore';
import type { ToolResult } from './types';

function getMountedHandle() {
  return getActiveHandle() || getAllHandles()[0] || null;
}

async function invoke(app: any, params: { xml?: string; title?: string; description?: string }): Promise<ToolResult> {
  const xml = params?.xml || '';
  if (!xml) {
    return { status: 'error', content: 'display_diagram called without xml.' };
  }

  if (!isMxCellXmlComplete(xml)) {
    setPartialXml(xml);
    const ending = xml.slice(-500);
    return {
      status: 'error',
      content:
        `Output was truncated due to length limits. Use the append_diagram tool to continue.\n\n` +
        `Your output ended with:\n\`\`\`\n${ending}\n\`\`\`\n\n` +
        `NEXT STEP: Call append_diagram with the continuation XML.\n` +
        `- Do NOT include wrapper tags or root cells (id="0", id="1")\n` +
        `- Start from EXACTLY where you stopped\n` +
        `- Complete all remaining mxCell elements`,
    };
  }

  resetPartialXml();
  const fullXml = wrapWithMxFile(xml);

  try {
    const existingHandle = getMountedHandle();

    if (existingHandle) {
      // Drawio block is already open on the page — apply directly
      existingHandle.setXml(fullXml);
      await existingHandle.persist(fullXml);
      existingHandle.bridge.load(fullXml);

      const title = existingHandle.diagramTitle || params.title || 'Drawio Diagram';
      // Store result for the card component
      setDiagramResult({
        diagramId: existingHandle.diagramId,
        title,
        appliedDirectly: true,
      });
      // Also mutate params so the card can read it from args
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

    // Store result for the card component
    setDiagramResult({
      diagramId,
      title,
      appliedDirectly: false,
    });
    // Mutate params so the card can read it from args
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

export const displayDiagramTool: [string, ToolsOptions] = [
  'drawio-display_diagram',
  {
    invoke,
    ui: {
      card: DrawioDiagramCard,
    },
  },
];
