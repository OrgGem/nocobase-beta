import { z } from 'zod';
import type { ToolRegisterOptions } from '@nocobase/plugin-ai/dist/server/manager/tool-manager';
import { loadShapeLibrary, SHAPE_LIBRARY_NAMES } from '../shape-libraries';

const description = `Get draw.io shape/icon library documentation with style syntax and shape names.

Available libraries:
- Cloud: aws4, azure2, gcp2, alibaba_cloud, openstack, salesforce
- Networking: cisco19, network, kubernetes, vvd, rack
- Business: bpmn, lean_mapping
- General: flowchart, basic, arrows2, infographic, sitemap
- UI/Mockups: android
- Enterprise: citrix, sap, mscae, atlassian
- Engineering: fluidpower, electrical, pid, cabinets, floorplan
- Icons: webicons

Call this tool to get shape names and usage syntax for a specific library.`;

const getShapeLibraryTool: ToolRegisterOptions = {
  groupName: 'drawio',
  tool: {
    name: 'get_shape_library',
    title: 'Get Shape Library',
    description,
    execution: 'backend',
    schema: z.object({
      library: z.string().describe("Library name (e.g., 'aws4', 'kubernetes', 'flowchart')"),
    }),
    invoke: async (_ctx, args: { library?: string }) => {
      const requested = (args?.library || '').trim();
      if (!requested) {
        return { status: 'error', content: 'library parameter is required.' };
      }
      const sanitized = requested.toLowerCase().replace(/[^a-z0-9_-]/g, '');
      if (sanitized !== requested.toLowerCase()) {
        return {
          status: 'error',
          content: `Invalid library name "${requested}". Use only letters, numbers, underscores, and hyphens.`,
        };
      }
      const content = await loadShapeLibrary(sanitized);
      if (!content) {
        return {
          status: 'error',
          content: `Library "${requested}" not found. Available: ${SHAPE_LIBRARY_NAMES.join(', ')}`,
        };
      }
      return { status: 'success', content };
    },
  },
};

export default getShapeLibraryTool;
