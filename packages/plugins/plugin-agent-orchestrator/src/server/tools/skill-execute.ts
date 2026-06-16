import { parseJsonText } from '../skill-hub/utils/json-fields';
import type { ToolsRuntime } from '@nocobase/ai';

type ToolRuntimeInput = string | ToolsRuntime | undefined;

function normalizeRuntime(runtime: ToolRuntimeInput): ToolsRuntime | undefined {
  if (!runtime) return undefined;
  if (typeof runtime === 'string') {
    return { toolCallId: runtime, writer: () => {} };
  }
  return runtime;
}

export function createSkillExecuteTool(plugin: any) {
  return {
    scope: 'CUSTOM',
    execution: 'backend',
    // Intentionally fixed to ASK. This is the universal gateway: a single tool
    // whose `execute` action can run ANY enabled skill by name, so the
    // per-skill `autoCall` flag cannot be honored here — the harness decides
    // approval from `defaultPermission` before invoke, when the target skill is
    // not yet known. The per-skill dynamic tools (`skill_hub_<name>`) are the
    // fast path that respect `autoCall: true → ALLOW`. Keeping the generic
    // gateway on ASK is deliberate defense-in-depth, not an oversight.
    defaultPermission: 'ASK',

    introduction: {
      title: 'Skill Hub - Universal Skill Executor',
      about:
        'A universal gateway to execute predefined specialized skills (data processing, complex calculations, file generation, etc.) inside a secure Python/Node.js sandbox.',
    },

    definition: {
      name: 'skill_hub_execute',
      description: `A universal gateway to execute various predefined specialized skills (e.g., data transformation, calculations, document/presentation generation) in an isolated sandbox.
HOW TO USE THIS TOOL:
1. If you don't know the exact 'skillName' or its required 'input' schema, first call this tool with { "action": "list" } to discover all available skills.
2. For complex workflow skills, call { "action": "describe", "skillName": "<exact_skill_name>" } to load the full instructions before execution.
3. To run a skill, call this tool with { "action": "execute", "skillName": "<exact_skill_name>", "input": { <parameters> } }.
CRITICAL: Do NOT guess or hallucinate the 'input' object. You MUST strictly provide the parameters matching the JSON schema defined for that specific skill.
The skill's output may contain text results, structured JSON data, or download URLs for generated files.
IMPORTANT: If the skill returns file download URLs, you MUST format them as clickable Markdown links (e.g., [Download filename.ext](/api/attachments/...)) in your final response to the user.`,
      schema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'describe', 'execute'],
            description: '"list" to see available skills, "describe" to load full instructions, "execute" to run one',
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

    async invoke(ctx: any, args: Record<string, any>, runtime?: ToolRuntimeInput) {
      plugin.app.logger.info(`[skill-execute] Tool invoked with action: ${args.action}, skillName: ${args.skillName}`);

      // Action: list available skills
      if (args.action === 'list') {
        const skills = await plugin.db.getRepository('skillDefinitions').find({
          filter: { enabled: true },
          fields: ['name', 'title', 'description', 'language', 'inputSchema', 'instructions', 'storageType'],
        });

        const skillList = skills.map((s: any) => ({
          name: s.get('name'),
          title: s.get('title'),
          description: s.get('description'),
          language: s.get('language'),
          inputSchema: parseJsonText(s.get('inputSchema'), null),
          hasInstructions: !!s.get('instructions') || s.get('storageType') === 'plugin',
          storageType: s.get('storageType'),
        }));

        return {
          status: 'success',
          content: JSON.stringify({ skills: skillList }),
        };
      }

      // Action: describe one skill with full workflow instructions
      if (args.action === 'describe') {
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

        const instructions =
          typeof plugin.getSkillInstructions === 'function'
            ? await plugin.getSkillInstructions(skill)
            : skill.get('instructions');

        return {
          status: 'success',
          content: JSON.stringify({
            name: skill.get('name'),
            title: skill.get('title'),
            description: skill.get('description'),
            language: skill.get('language'),
            inputSchema: parseJsonText(skill.get('inputSchema'), null),
            packages: parseJsonText(skill.get('packages'), []),
            storageType: skill.get('storageType'),
            storageUrl: skill.get('storageUrl'),
            instructions,
          }),
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
          const normalizedRuntime = normalizeRuntime(runtime);
          const previousRuntime = ctx.runtime;
          if (normalizedRuntime) {
            ctx.runtime = normalizedRuntime;
          }
          let result;
          try {
            result = await plugin.executeSkill(skill, args.input || {}, ctx);
          } finally {
            if (normalizedRuntime) {
              if (previousRuntime === undefined) {
                delete ctx.runtime;
              } else {
                ctx.runtime = previousRuntime;
              }
            }
          }

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
              execId: result.execId,
              agentLoopRunId: result.agentLoopRunId,
              agentLoopStepId: result.agentLoopStepId,
              durationMs: result.durationMs,
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
        content: `Unknown action "${args.action}". Use "list", "describe", or "execute".`,
      };
    },
  };
}
