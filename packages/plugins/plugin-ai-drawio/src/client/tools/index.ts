import type { ToolsOptions } from '@nocobase/client';
import { displayModelDiagramTool } from './displayModelDiagram';
import { displayDiagramTool } from './displayDiagram';
import { editDiagramTool } from './editDiagram';
import { appendDiagramTool } from './appendDiagram';

export const drawioClientTools: Array<[string, ToolsOptions]> = [
  displayModelDiagramTool,
  displayDiagramTool,
  editDiagramTool,
  appendDiagramTool,
];

export { displayModelDiagramTool, displayDiagramTool, editDiagramTool, appendDiagramTool };
