import { z } from 'zod';
import type { DrawioToolDefinition } from './types';

const description = `Display a NEW draw.io diagram from compact structured data.

Use this tool instead of display_diagram for normal flowcharts, architecture sketches, process maps, and simple diagrams. It keeps tool-call arguments small by sending nodes and edges as JSON; the browser converts them to draw.io XML.

Guidelines:
- The plugin keeps ONE shared draw.io canvas for the whole chat. The first display shows an "Open Diagram" button; once open, later calls update the SAME canvas in place. If the canvas is closed, the button appears again.
- Include title and description when creating a new diagram from a user request.
- Use stable unique ids, e.g. "frontend", "api", "db", "edge-api-db".
- Keep x/y/width/height within x=0-800 and y=0-600.
- Put large grouping boxes in containers, then set node.parent to the container id.
- For shape, use: rect, rounded, ellipse, diamond, cylinder, swimlane, text.
- Use style only for small draw.io style overrides such as fillColor=#dae8fc;strokeColor=#6c8ebf;.
`;

const diagramNodeSchema = z.object({
  id: z.string().describe('Unique id for the node/container.'),
  label: z.string().describe('Text shown inside the shape.'),
  x: z.number().describe('X coordinate.'),
  y: z.number().describe('Y coordinate.'),
  width: z.number().describe('Width in pixels.'),
  height: z.number().describe('Height in pixels.'),
  shape: z
    .enum(['rect', 'rounded', 'ellipse', 'diamond', 'cylinder', 'swimlane', 'text'])
    .optional()
    .describe('Shape kind. Defaults to rounded for nodes and swimlane for containers.'),
  parent: z.string().optional().describe('Parent container id. Omit for top-level shapes.'),
  style: z.string().optional().describe('Optional draw.io style suffix.'),
});

const displayModelDiagramTool: DrawioToolDefinition = {
  groupName: 'drawio',
  tool: {
    name: 'display_model_diagram',
    title: 'Display Model Diagram',
    description,
    execution: 'frontend',
    schema: z.object({
      title: z.string().optional().describe('Diagram title to use when a new draw.io diagram must be created.'),
      description: z.string().optional().describe('Diagram description to save with a newly created diagram.'),
      diagramId: z
        .string()
        .optional()
        .describe('Target ID returned by inspect_active_diagram when updating an open diagram.'),
      containers: z.array(diagramNodeSchema).optional().describe('Optional grouping containers.'),
      nodes: z.array(diagramNodeSchema).describe('Diagram nodes.'),
      edges: z
        .array(
          z.object({
            id: z.string().describe('Unique edge id.'),
            source: z.string().describe('Source node id.'),
            target: z.string().describe('Target node id.'),
            label: z.string().optional().describe('Optional edge label.'),
            style: z.string().optional().describe('Optional draw.io edge style suffix.'),
          }),
        )
        .optional()
        .describe('Connectors between nodes.'),
    }),
    invoke: async () => ({
      status: 'success',
      content: 'Diagram displayed on the draw.io canvas.',
    }),
  },
};

export default displayModelDiagramTool;
