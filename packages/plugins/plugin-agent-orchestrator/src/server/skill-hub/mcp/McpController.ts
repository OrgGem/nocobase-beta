import type PluginSkillHubServer from '../plugin';
import { parseJsonText } from '../utils/json-fields';

export class McpController {
  constructor(private plugin: PluginSkillHubServer) {}

  /**
   * List all enabled skills in standard MCP format.
   * Route: GET /api/skillHub:mcpListTools
   */
  async listTools(ctx: any, next: any) {
    const skills = await this.plugin.db.getRepository('skillDefinitions').find({
      filter: { enabled: true },
    });

    const tools = await Promise.all(skills.map(async (skill: any) => ({
        name: skill.get('name').toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_'),
        description: typeof this.plugin.getSkillDescriptionForAI === 'function'
          ? await this.plugin.getSkillDescriptionForAI(skill)
          : skill.get('description'),
        inputSchema: parseJsonText(skill.get('inputSchema'), null),
      })));

    ctx.body = {
      tools,
    };

    await next();
  }

  /**
   * Execute a skill in standard MCP format.
   * Route: POST /api/skillHub:mcpCallTool
   */
  async callTool(ctx: any, next: any) {
    const { name, arguments: args } = ctx.request.body || {};

    if (!name) {
      ctx.throw(400, 'Missing tool name');
    }

    // Try finding the exact skill
    const skills = await this.plugin.db.getRepository('skillDefinitions').find({
      filter: { enabled: true },
    });

    const skill = skills.find((s: any) => 
      s.get('name').toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_') === name
    );

    if (!skill) {
      ctx.throw(404, `Tool ${name} not found`);
    }

    try {
      const result = await this.plugin.executeSkill(skill, args || {}, ctx);
      
      let textContent = `Executed successfully.`;
      if (result.stdout) textContent += `\nOutput:\n${result.stdout}`;
      if (result.stderr) textContent += `\nErrors:\n${result.stderr}`;
      
      if (result.files?.length) {
        textContent += `\nFiles generated:\n` + result.files.map((f: any) => {
          return `- [${f.name}](${f.downloadUrl})`;
        }).join('\n');
      }

      ctx.body = {
        content: [
          {
            type: 'text',
            text: textContent,
          }
        ],
        isError: result.status !== 'succeeded',
      };
    } catch (err: any) {
      ctx.body = {
        content: [{ type: 'text', text: `Skill Execution Error: ${err.message}` }],
        isError: true,
      };
    }

    await next();
  }
}
