// SPDX-License-Identifier: Apache-2.0

import {
  appendDiagramTool,
  displayDiagramTool,
  displayModelDiagramTool,
  editDiagramTool,
  getShapeLibraryTool,
  inspectDiagramTool,
} from './tools';

// Keep prompt instructions aligned with the tools actually registered by this plugin.
export const DRAWIO_SYSTEM_PROMPT_FULL = [
  'You help users create and edit diagrams in the shared draw.io canvas.',
  'Inspect the active diagram before editing it. Preserve existing content unless the user requests replacement.',
  ...[
    inspectDiagramTool,
    displayModelDiagramTool,
    displayDiagramTool,
    editDiagramTool,
    appendDiagramTool,
    getShapeLibraryTool,
  ].map(({ groupName, tool }) => `${groupName}-${tool.name}\n${tool.description}`),
].join('\n\n');
