import type { ToolsOptions } from '@nocobase/client';
import { getActiveHandle } from '../lib/activeRegistry';
import { applyDiagramOperations, DiagramOperation, wrapWithMxFile } from '../lib/xml-utils';
import type { ToolResult } from './types';

async function invoke(_app: any, params: { operations?: DiagramOperation[] }): Promise<ToolResult> {
  const operations = params?.operations || [];
  if (!operations.length) {
    return { status: 'error', content: 'edit_diagram called without operations.' };
  }

  const handle = getActiveHandle();
  if (!handle) {
    return {
      status: 'error',
      content:
        'No active draw.io block found. Open a Drawio Diagram block on the page before calling edit_diagram.',
    };
  }

  const currentXml = handle.getXml();
  if (!currentXml) {
    return {
      status: 'error',
      content: 'Active diagram has no XML to edit. Use display_diagram to set the initial state first.',
    };
  }

  let editedXml: string;
  let opErrors: { type: string; cellId: string; message: string }[];
  try {
    const r = applyDiagramOperations(currentXml, operations);
    editedXml = r.result;
    opErrors = r.errors;
  } catch (err: any) {
    return {
      status: 'error',
      content: `Edit failed: ${err?.message || String(err)}\n\nCurrent diagram XML:\n\`\`\`xml\n${currentXml}\n\`\`\``,
    };
  }

  if (opErrors.length) {
    const messages = opErrors.map((e) => `- ${e.type} on cell_id="${e.cellId}": ${e.message}`).join('\n');
    return {
      status: 'error',
      content:
        `Some operations failed:\n${messages}\n\n` +
        `Current diagram XML:\n\`\`\`xml\n${currentXml}\n\`\`\`\n\n` +
        `Please check the cell IDs and retry.`,
    };
  }

  const fullXml = wrapWithMxFile(editedXml);
  try {
    handle.setXml(fullXml);
    await handle.persist(fullXml);
    handle.bridge.load(fullXml);
  } catch (err: any) {
    return { status: 'error', content: `Failed to apply edits to canvas: ${err?.message || String(err)}` };
  }

  return {
    status: 'success',
    content: `Successfully applied ${operations.length} operation(s) to the diagram.`,
  };
}

export const editDiagramTool: [string, ToolsOptions] = [
  'drawio-edit_diagram',
  { invoke },
];
