import type { ToolsOptions } from '@nocobase/client-v2';
import { getDiagram, setDiagram } from '../diagramStore';
import { applyDiagramOperations, type DiagramOperation, wrapWithMxFile } from '../lib/xml-utils';
import type { ToolResult } from './types';

type EditDiagramParams = {
  diagramId?: string;
  operations?: DiagramOperation[];
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function invoke(
  app: Parameters<NonNullable<ToolsOptions['invoke']>>[0],
  rawParams: unknown,
): Promise<ToolResult> {
  const params = rawParams as EditDiagramParams;
  const operations = params.operations || [];
  if (!operations.length) {
    return { status: 'error', content: 'edit_diagram called without operations.' };
  }

  const current = getDiagram();

  if (!current) {
    return {
      status: 'error',
      content: 'No draw.io diagram exists. Use display_diagram to set the initial state first.',
    };
  }

  const currentXml = current.xml;
  if (!currentXml) {
    return {
      status: 'error',
      content: 'Active diagram has no XML to edit. Use display_diagram to set the initial state first.',
    };
  }

  let editedXml: string;
  let operationErrors: { type: string; cellId: string; message: string }[];
  try {
    const result = applyDiagramOperations(currentXml, operations);
    editedXml = result.result;
    operationErrors = result.errors;
  } catch (error: unknown) {
    return {
      status: 'error',
      content: `Edit failed: ${errorMessage(error)}\n\nCurrent diagram XML:\n\`\`\`xml\n${currentXml}\n\`\`\``,
    };
  }

  if (operationErrors.length) {
    const messages = operationErrors
      .map((error) => `- ${error.type} on cell_id="${error.cellId}": ${error.message}`)
      .join('\n');
    return {
      status: 'error',
      content:
        `Some operations failed:\n${messages}\n\n` +
        `Current diagram XML:\n\`\`\`xml\n${currentXml}\n\`\`\`\n\n` +
        'Please check the cell IDs and retry.',
    };
  }

  const fullXml = wrapWithMxFile(editedXml);
  try {
    setDiagram(current.id, current.title, fullXml);
  } catch (error: unknown) {
    return { status: 'error', content: `Failed to apply edits to canvas: ${errorMessage(error)}` };
  }

  return { status: 'success', content: `Successfully applied ${operations.length} operation(s) to the diagram.` };
}

export const editDiagramTool: [string, ToolsOptions] = ['drawio-edit_diagram', { invoke }];
