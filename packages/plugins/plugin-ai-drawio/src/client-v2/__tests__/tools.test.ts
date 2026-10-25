/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { createMockClient } from '@nocobase/client-v2';
import { describe, expect, it } from 'vitest';
import { displayDiagramTool } from '../tools/displayDiagram';
import { appendDiagramTool } from '../tools/appendDiagram';
import { editDiagramTool } from '../tools/editDiagram';
import { getDiagram } from '../diagramStore';

describe('Drawio V2 tool pipeline', () => {
  it('assembles the first truncated diagram, preserves its identity/title and applies later cell edits', async () => {
    const app = createMockClient();
    const partial = await displayDiagramTool[1].invoke(app, {
      xml: '<mxCell id="node-a" parent="1"',
      title: 'First diagram',
      diagramId: 'diagram-a',
    });
    expect(partial.status).toBe('error');
    const complete = await appendDiagramTool[1].invoke(app, { xml: ' vertex="1"/>' });
    expect(complete.status).toBe('success');
    expect(getDiagram()).toMatchObject({ id: 'diagram-a', title: 'First diagram' });
    const edited = await editDiagramTool[1].invoke(app, {
      operations: [
        {
          operation: 'update',
          cell_id: 'node-a',
          new_xml: '<mxCell id="node-a" parent="1" value="Updated" vertex="1"/>',
        },
      ],
    });
    expect(edited.status).toBe('success');
    expect(getDiagram().xml).toContain('value="Updated"');
  });
});
