import type { ToolsOptions } from '@nocobase/client-v2';
import { displayModelDiagramTool } from './displayModelDiagram';
import { displayDiagramTool } from './displayDiagram';
import { editDiagramTool } from './editDiagram';
import { appendDiagramTool } from './appendDiagram';
import { inspectDiagramTool } from './inspectDiagram';

export const drawioClientTools: Array<[string, ToolsOptions]> = [
  inspectDiagramTool,
  displayModelDiagramTool,
  displayDiagramTool,
  editDiagramTool,
  appendDiagramTool,
];

export { inspectDiagramTool, displayModelDiagramTool, displayDiagramTool, editDiagramTool, appendDiagramTool };
