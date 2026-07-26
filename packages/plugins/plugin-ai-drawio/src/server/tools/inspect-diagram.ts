import { z } from 'zod';
import type { DrawioToolDefinition } from './types';

const inspectDiagramTool: DrawioToolDefinition = {
  groupName: 'drawio',
  tool: {
    name: 'inspect_active_diagram',
    title: 'Inspect Active Diagram',
    description:
      'Read the XML and target ID of the open draw.io diagram in the user browser. Call this before edit_diagram so you use the current cell IDs. No manual chat context attachment is required.',
    execution: 'frontend',
    schema: z.object({
      diagramId: z.string().optional().describe('Optional open diagram ID to inspect.'),
    }),
    invoke: async () => ({
      status: 'success',
      content: 'The active draw.io diagram was inspected.',
    }),
  },
};

export default inspectDiagramTool;
