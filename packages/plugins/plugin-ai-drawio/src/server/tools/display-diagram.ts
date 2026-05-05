import { z } from 'zod';
type ToolRegisterOptions = any;

const description = `Display a diagram on the active draw.io block. Pass ONLY the mxCell elements - wrapper tags and root cells are added automatically.

VALIDATION RULES (XML will be rejected if violated):
1. Generate ONLY mxCell elements - NO wrapper tags (<mxfile>, <mxGraphModel>, <root>)
2. Do NOT include root cells (id="0" or id="1") - they are added automatically
3. All mxCell elements must be siblings - never nested
4. Every mxCell needs a unique id (start from "2")
5. Every mxCell needs a valid parent attribute (use "1" for top-level)
6. Escape special chars in values: &lt; &gt; &amp; &quot;

Example (generate ONLY this - no wrapper tags):
<mxCell id="lane1" value="Frontend" style="swimlane;" vertex="1" parent="1">
  <mxGeometry x="40" y="40" width="200" height="200" as="geometry"/>
</mxCell>
<mxCell id="step1" value="Step 1" style="rounded=1;" vertex="1" parent="lane1">
  <mxGeometry x="20" y="60" width="160" height="40" as="geometry"/>
</mxCell>
<mxCell id="edge1" style="edgeStyle=orthogonalEdgeStyle;endArrow=classic;" edge="1" parent="1" source="step1" target="step2">
  <mxGeometry relative="1" as="geometry"/>
</mxCell>

Notes:
- For AWS diagrams, use **AWS 2025 icons**.
- For animated connectors, add "flowAnimation=1" to edge style.
`;

const displayDiagramTool: ToolRegisterOptions = {
  groupName: 'drawio',
  tool: {
    name: 'display_diagram',
    title: 'Display Diagram',
    description,
    execution: 'frontend',
    schema: z.object({
      xml: z.string().describe('XML string to be displayed on draw.io (mxCell elements only)'),
    }),
    invoke: async () => ({
      status: 'success',
      content: 'Diagram displayed on the active draw.io canvas.',
    }),
  },
};

export default displayDiagramTool;
