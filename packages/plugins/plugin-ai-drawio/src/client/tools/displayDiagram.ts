import type { ToolsOptions } from '@nocobase/client';
import { getActiveHandle } from '../lib/activeRegistry';
import { isMxCellXmlComplete, wrapWithMxFile } from '../lib/xml-utils';
import { resetPartialXml, setPartialXml } from './sharedState';
import type { ToolResult } from './types';

async function invoke(_app: any, params: { xml?: string }): Promise<ToolResult> {
  const xml = params?.xml || '';
  if (!xml) {
    return { status: 'error', content: 'display_diagram called without xml.' };
  }

  const handle = getActiveHandle();
  if (!handle) {
    return {
      status: 'error',
      content:
        'No active draw.io block found. Open a Drawio Diagram block on the page before calling display_diagram.',
    };
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
    handle.setXml(fullXml);
    await handle.persist(fullXml);
    handle.bridge.load(fullXml);
    return { status: 'success', content: 'Successfully displayed the diagram.' };
  } catch (err: any) {
    return {
      status: 'error',
      content: `Failed to display diagram: ${err?.message || String(err)}`,
    };
  }
}

export const displayDiagramTool: [string, ToolsOptions] = [
  'drawio-display_diagram',
  { invoke },
];
