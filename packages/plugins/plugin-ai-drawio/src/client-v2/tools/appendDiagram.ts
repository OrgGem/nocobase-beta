/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import type { ToolsOptions } from '@nocobase/client-v2';
import { getDiagram, getDiagramState, setDiagram } from '../diagramStore';
import { isMxCellXmlComplete, wrapWithMxFile } from '../runtime/xml-utils';
import { appendPartialXml, getPartialXml, getPartialDiagramInfo, resetPartialXml } from './sharedState';
import type { ToolResult } from './types';

type AppendDiagramParams = {
  xml?: string;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function invoke(
  app: Parameters<NonNullable<ToolsOptions['invoke']>>[0],
  rawParams: unknown,
): Promise<ToolResult> {
  const params = rawParams as AppendDiagramParams;
  const xml = params.xml || '';
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
        'ERROR: You started fresh with wrapper tags. Do NOT include wrapper tags or root cells (id="0", id="1").\n\n' +
        `Continue from EXACTLY where the partial ended:\n\`\`\`\n${getPartialXml().slice(-500)}\n\`\`\`\n\n` +
        'Start your continuation with the NEXT character after where it stopped.',
    };
  }

  appendPartialXml(xml);
  const accumulated = getPartialXml();
  if (!isMxCellXmlComplete(accumulated)) {
    return {
      status: 'error',
      content:
        'XML still incomplete (mxCell not closed). Call append_diagram again to continue.\n\n' +
        `Current ending:\n\`\`\`\n${accumulated.slice(-500)}\n\`\`\`\n\n` +
        'Continue from EXACTLY where you stopped.',
    };
  }

  const current = getDiagram();
  const partialInfo = getPartialDiagramInfo();
  resetPartialXml();
  const fullXml = wrapWithMxFile(accumulated);
  try {
    setDiagram(
      partialInfo.id || current?.id || `diagram-${Date.now().toString(36)}`,
      partialInfo.title || current?.title || 'Drawio Diagram',
      fullXml,
    );
    return { status: 'success', content: 'Diagram assembly complete and displayed successfully.' };
  } catch (error: unknown) {
    return { status: 'error', content: `Failed to render assembled diagram: ${errorMessage(error)}` };
  }
}

export const appendDiagramTool: [string, ToolsOptions] = ['drawio-append_diagram', { invoke }];
