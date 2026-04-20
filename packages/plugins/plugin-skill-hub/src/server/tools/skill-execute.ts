export function createSkillExecuteTool(plugin: any) {
  return {
    scope: 'GENERAL',
    execution: 'backend',
    defaultPermission: 'ASK',

    introduction: {
      title: 'Skill Hub - Code Sandbox',
      about: 'Execute predefined skills (Python/Node.js) in sandbox on worker server. Can generate files for download.',
    },

    definition: {
      name: 'skill_hub.execute',
      description: `Execute a predefined skill in isolated sandbox environment on worker server.
Use action "list" to see available skills and their input schemas.
Use action "execute" with skillName and input to run a skill.
Skills can generate output files (Word, Excel, PDF, CSV, etc.) which will be returned as download URLs.`,
      schema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'execute'],
            description: '"list" to see available skills, "execute" to run one',
          },
          skillName: {
            type: 'string',
            description: 'Skill name (required for "execute" action)',
          },
          input: {
            type: 'object',
            description: 'Input parameters matching the skill inputSchema',
          },
        },
        required: ['action'],
      },
    },

    invoke: async (ctx: any, args: any) => {
      // Action: list available skills
      if (args.action === 'list') {
        const skills = await plugin.db.getRepository('skillDefinitions').find({
          filter: { enabled: true },
          fields: ['name', 'title', 'description', 'language', 'inputSchema'],
        });

        const skillList = skills.map((s: any) => ({
          name: s.get('name'),
          title: s.get('title'),
          description: s.get('description'),
          language: s.get('language'),
          inputSchema: s.get('inputSchema'),
        }));

        return {
          status: 'success',
          content: JSON.stringify({ skills: skillList }),
        };
      }

      // Action: execute skill
      if (args.action === 'execute') {
        if (!args.skillName) {
          return { status: 'error', content: 'Missing skillName parameter' };
        }

        const skill = await plugin.db.getRepository('skillDefinitions').findOne({
          filter: { name: args.skillName, enabled: true },
        });

        if (!skill) {
          return {
            status: 'error',
            content: `Skill "${args.skillName}" not found or disabled`,
          };
        }

        try {
          const result = await plugin.executeSkill(skill, args.input || {}, ctx);

          return {
            status: result.status === 'succeeded' ? 'success' : 'error',
            content: JSON.stringify({
              message:
                result.status === 'succeeded'
                  ? `Executed successfully. ${result.files?.length || 0} file(s) generated.`
                  : `Failed: ${result.stderr}`,
              stdout: result.stdout,
              stderr: result.stderr,
              files: result.files,
            }),
          };
        } catch (error) {
          return {
            status: 'error',
            content: `Execution error: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      }

      return {
        status: 'error',
        content: `Unknown action "${args.action}". Use "list" or "execute".`,
      };
    },
  };
}
