import type { ToolsOptions } from '@nocobase/client-v2';
import { getActiveHandle, getAllHandles, getHandleByDiagramId } from '../lib/activeRegistry';
import type { ToolResult } from './types';

type InspectDiagramParams = {
  diagramId?: string;
};

function getMountedHandle(diagramId?: string) {
  if (diagramId) {
    return getHandleByDiagramId(diagramId);
  }
  return getActiveHandle() || getAllHandles()[0] || null;
}

async function invoke(
  _app: Parameters<NonNullable<ToolsOptions['invoke']>>[0],
  rawParams: unknown,
): Promise<ToolResult> {
  const params = rawParams as InspectDiagramParams;
  const handle = getMountedHandle(params.diagramId);
  if (!handle) {
    return {
      status: 'error',
      content: 'No matching draw.io block is open. Open a diagram block, then ask me to inspect or edit it.',
    };
  }

  const title = handle.diagramTitle ? `Title: ${handle.diagramTitle}\n` : '';
  return {
    status: 'success',
    content:
      `${title}diagramId: ${handle.diagramId}\n` +
      'Use this diagramId in edit_diagram or display_diagram when changing this canvas.\n\n' +
      'Current diagram XML (authoritative):\n```xml\n' +
      (handle.getXml() || '<empty diagram>') +
      '\n```',
  };
}

export const inspectDiagramTool: [string, ToolsOptions] = ['drawio-inspect_active_diagram', { invoke }];
