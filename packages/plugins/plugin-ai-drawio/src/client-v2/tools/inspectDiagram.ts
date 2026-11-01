/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import type { ToolsOptions } from '@nocobase/client-v2';
import { getDiagram } from '../diagramStore';
import type { ToolResult } from './types';

type InspectDiagramParams = {
  diagramId?: string;
};

async function invoke(
  app: Parameters<NonNullable<ToolsOptions['invoke']>>[0],
  rawParams: unknown,
): Promise<ToolResult> {
  const params = rawParams as InspectDiagramParams;
  const diagram = getDiagram();

  if (!diagram) {
    return {
      status: 'error',
      content: 'No draw.io diagram has been created yet. Use display_diagram or display_model_diagram first.',
    };
  }

  const titleLine = diagram.title ? `Title: ${diagram.title}\n` : '';
  return {
    status: 'success',
    content:
      `${titleLine}diagramId: ${diagram.id}\n` +
      'Use this diagramId in edit_diagram or display_diagram when changing this canvas.\n\n' +
      'Current diagram XML (authoritative):\n```xml\n' +
      (diagram.xml || '<empty diagram>') +
      '\n```',
  };
}

export const inspectDiagramTool: [string, ToolsOptions] = ['drawio-inspect_active_diagram', { invoke }];
