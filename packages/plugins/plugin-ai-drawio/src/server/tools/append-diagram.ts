import { z } from 'zod';
type ToolRegisterOptions = any;

const description = `Continue generating diagram XML when previous display_diagram output was truncated due to length limits.

WHEN TO USE: Only call this tool after display_diagram returned a truncation error.

CRITICAL INSTRUCTIONS:
1. Do NOT include any wrapper tags - just continue the mxCell elements
2. Continue from EXACTLY where your previous output stopped
3. Complete the remaining mxCell elements
4. If still truncated, call append_diagram again with the next fragment

Example: If previous output ended with '<mxCell id="x" style="rounded=1', continue with ';" vertex="1">...' and complete the remaining elements.`;

const appendDiagramTool: ToolRegisterOptions = {
  groupName: 'drawio',
  tool: {
    name: 'append_diagram',
    title: 'Append Diagram',
    description,
    execution: 'frontend',
    schema: z.object({
      xml: z.string().describe('Continuation XML fragment to append (NO wrapper tags)'),
    }),
    invoke: async () => ({
      status: 'success',
      content: 'Diagram fragment appended on the active draw.io canvas.',
    }),
  },
};

export default appendDiagramTool;
