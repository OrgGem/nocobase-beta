import type { ToolsOptions } from '@nocobase/client';
import { displayDiagramTool } from './displayDiagram';
import { editDiagramTool } from './editDiagram';
import { appendDiagramTool } from './appendDiagram';

export const drawioClientTools: Array<[string, ToolsOptions]> = [
  displayDiagramTool,
  editDiagramTool,
  appendDiagramTool,
];

export { displayDiagramTool, editDiagramTool, appendDiagramTool };
