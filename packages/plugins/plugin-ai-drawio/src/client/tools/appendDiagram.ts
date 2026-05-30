import type { ToolsOptions } from '@nocobase/client';
import { getActiveHandle, getAllHandles } from '../lib/activeRegistry';
import { isMxCellXmlComplete, wrapWithMxFile } from '../lib/xml-utils';
import { appendPartialXml, getPartialXml, resetPartialXml } from './sharedState';
import type { ToolResult } from './types';

function getMountedHandle() {
  return getActiveHandle() || getAllHandles()[0] || null;
}

async function invoke(_app: any, params: { xml?: string }): Promise<ToolResult> {
  const xml = params?.xml || '';
  if (!xml) {
    return { status: 'error', content: 'append_diagram called without xml.' };
  }

  const trimmed = xml.trim();
  const isFreshStart =
    trimmed.startsWith('<mxGraphModel') ||
    trimmed.startsWith('<root') ||
    trimmed.startsWith('<mxfile') ||
    trimmed.startsWith('<mxCell id="0"') ||
    trimmed.startsWith('<mxCell id="1"');

  if (isFreshStart) {
    return {
      status: 'error',
      content:
        `ERROR: You started fresh with wrapper tags. Do NOT include wrapper tags or root cells (id="0", id="1").\n\n` +
        `Continue from EXACTLY where the partial ended:\n\`\`\`\n${getPartialXml().slice(-500)}\n\`\`\`\n\n` +
        `Start your continuation with the NEXT character after where it stopped.`,
    };
  }

  appendPartialXml(xml);
  const accumulated = getPartialXml();

  if (!isMxCellXmlComplete(accumulated)) {
    return {
      status: 'error',
      content:
        `XML still incomplete (mxCell not closed). Call append_diagram again to continue.\n\n` +
        `Current ending:\n\`\`\`\n${accumulated.slice(-500)}\n\`\`\`\n\n` +
        `Continue from EXACTLY where you stopped.`,
    };
  }

  const handle = getMountedHandle();
  if (!handle) {
    resetPartialXml();
    return {
      status: 'error',
      content: 'No active draw.io block found. Cannot finalize the assembled diagram.',
    };
  }

  const finalXml = accumulated;
  resetPartialXml();
  const fullXml = wrapWithMxFile(finalXml);

  try {
    handle.setXml(fullXml);
    await handle.persist(fullXml);
    handle.bridge.load(fullXml);
    return { status: 'success', content: 'Diagram assembly complete and displayed successfully.' };
  } catch (err: any) {
    return { status: 'error', content: `Failed to render assembled diagram: ${err?.message || String(err)}` };
  }
}

export const appendDiagramTool: [string, ToolsOptions] = ['drawio-append_diagram', { invoke }];
