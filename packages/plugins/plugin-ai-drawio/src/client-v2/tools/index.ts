/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

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
