import type { ToolsOptions } from '@nocobase/client-v2';
import { DrawioDiagramCard } from '../components/DrawioDiagramCard';
import { getDiagram, getDiagramState, setDiagram } from '../diagramStore';
import { isMxCellXmlComplete, wrapWithMxFile } from '../lib/xml-utils';
import { resetPartialXml, setPartialXml } from './sharedState';
import type { ToolResult } from './types';

type DisplayDiagramParams = {
  xml?: string;
  title?: string;
  description?: string;
  diagramId?: string;
};

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

export const displayDiagramTool: [string, ToolsOptions] = [
  'drawio-display_diagram',
  {
    invoke,
    ui: {
      card: DrawioDiagramCard,
    },
  },
];
