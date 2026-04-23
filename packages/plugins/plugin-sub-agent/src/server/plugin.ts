import { Plugin } from '@nocobase/server';
import { z } from 'zod';
import type PluginAIServer from '@nocobase/plugin-ai/dist/server';
import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import path from 'path';

export class PluginSubAgentServer extends Plugin {
  async afterAdd() {}

  async beforeLoad() {
    this.db.import({ directory: path.resolve(__dirname, 'collections') });
  }

  async load() {
    this.app.acl.registerSnippet({
      name: `pm.${this.name}`,
      actions: ['subAgents:*'],
    });

    // In NocoBase 2.x, the true system-wide ToolsManager is in app.aiManager (from @nocobase/ai), not the local one in plugin-ai
    const toolsManager = this.app.aiManager.toolsManager;

    toolsManager.registerDynamicTools(async (register) => {
      try {
        const subAgentsRepo = this.db.getRepository('subAgents');
        if (!subAgentsRepo) return;
        
        const subAgents = await subAgentsRepo.find({ filter: { enabled: true } });
        
        const tools = [];
        for (const agent of subAgents) {
          tools.push({
            scope: 'CUSTOM',
            execution: 'backend',
            defaultPermission: 'ALLOW',
            silence: false,
            introduction: {
              title: `[Sub-Agent] ${agent.name}`,
              about: agent.description || 'Delegate tasks to this sub-agent',
            },
            definition: {
              name: agent.name.replace(/[^a-zA-Z0-9_-]/g, '_'),
              description: `Sub-agent: ${agent.description || agent.name}. Delegate tasks to this sub-agent for processing.`,
              schema: z.object({
                task: z.string().describe('The task or query for the sub-agent to perform'),
                context: z.string().optional().describe('Any contextual information to help the sub-agent'),
              }),
            },
            invoke: async (ctx: any, args: any, id: string) => {
              let attempt = 0;
              let lastResult;
              const maxAttempts = agent.retryOnError ? (agent.retryCount || 3) : 1;

              while (attempt < maxAttempts) {
                attempt++;
                const res = await this.invokeSubAgent(agent, args, ctx, id);
                if (res.status === 'success') return res;
                lastResult = res;
                this.app.log.warn(`Sub-agent [${agent.name}] failed (attempt ${attempt}/${maxAttempts}). Error: ${res.content}`);
              }
              return lastResult;
            },
          });
        }
        
        if (tools.length > 0) {
          register.registerTools(tools);
        }
      } catch (e) {
        this.app.log.error('Failed to register dynamic tools for sub-agents', e);
      }
    });
  }

  async invokeSubAgent(agent: any, args: any, ctx: any, id: string) {
    try {
      this.app.log.info(`Invoking sub-agent: ${agent.name} with task: ${args.task}`);
      const aiPlugin = this.app.pm.get('ai') as PluginAIServer;
      
      // 1. Get the LLM model
      // We fall back to a default known service if the agent didn't configure one explicitly.
      // To get the actual model safely, we let the provider fallback or use the specified service
      let providerInstance;
      try {
        const llmConfig = typeof agent.model === 'object' 
          ? agent.model 
          : { llmService: agent.model || undefined, model: null }; // Fallback to let LLM service infer defaults
        
        const service = await aiPlugin.aiManager.getLLMService(llmConfig);
        providerInstance = service.provider;
      } catch (e) {
        this.app.log.warn(`Failed to init configured LLM for sub-agent ${agent.name}, falling back to defaults. Error: ${e.message}`);
        throw new Error(`LLM Service Unavailable for Sub-Agent: ${e.message}`);
      }

      const chatModel = providerInstance.createModel();

      // 2. Resolve tools (skills) mapped to this agent
      const toolManager = aiPlugin.aiManager.toolManager;
      const allTools = await toolManager.listTools();
      
      const findTool = (skill: string): any => {
        for (const g of allTools as any[]) {
          // Some versions return groups, some return flat. Handle both.
          const toolsArray = g.tools || [g];
          const t = toolsArray.find(
            (t: any) => t.definition?.name === skill || t.definition?.name.endsWith(`.${skill}`)
          );
          if (t) return t;
        }
        return null;
      };
      
      const agentSkills = agent.skills || [];
      const langchainTools = agentSkills.map((skillName: string) => {
        const pTool = findTool(skillName);
        if (!pTool) return null;
        
        return new DynamicStructuredTool({
          name: pTool.definition.name.replace(/[^a-zA-Z0-9_-]/g, '_'), // ensure valid Langchain name
          description: pTool.definition.description,
          schema: pTool.definition.schema,
          func: async (toolArgs) => {
            const mappedName = pTool.definition.name.replace(/[^a-zA-Z0-9_-]/g, '_');
            this.app.log.info(`[SubAgent Tool] Executing ${skillName} (LangGraph name: ${mappedName})`);
            const res = await pTool.invoke(ctx, toolArgs, `sub-${id}`);
            if (res?.status === 'error') {
              throw new Error(`Tool <${skillName}> execution failed: ${res.content}`);
            }
            return typeof res?.content === 'string' ? res.content : JSON.stringify(res);
          }
        });
      }).filter(Boolean);

      // 3. Initialize Agent Executor
      const executor = createReactAgent({
        llm: chatModel,
        tools: langchainTools as any,
      });

      // 4. Construct System Prompt & User Context
      const systemMessage = new SystemMessage(
        agent.systemPrompt || `You are an AI Sub-Agent named ${agent.name}.\n${agent.description}`
      );
      
      const combinedTask = args.context 
        ? `Task: ${args.task}\n\nContext Provided:\n${args.context}`
        : `Task: ${args.task}`;
        
      const humanMessage = new HumanMessage(combinedTask);

      // 5. Invoke the chain!
      const stream = await executor.stream(
        { messages: [systemMessage, humanMessage] },
        { recursionLimit: agent.maxIterations || 10, streamMode: 'messages' }
      );

      let finalStateMsg;
      let aiContentCache = '';

      for await (const chunk of stream) {
        const [message, dict] = chunk;
        if (message.getType() === 'ai') {
           finalStateMsg = message;
           if (message.content) {
             aiContentCache += message.content.toString();
           }
        }

        if (ctx.runtime?.writer) {
          try {
             let step = message.getType(); // e.g. 'ai', 'tool', 'human'
             let emitContent = message.content?.toString() || '';
             let partial = true;
             
             if (step === 'ai') {
               if ((message as any).tool_calls?.length) {
                 step = 'tool_calling';
                 emitContent = `Calling tools: ${(message as any).tool_calls.map((tc: any) => tc.name).join(', ')}`;
                 partial = false;
               } else {
                 step = 'reasoning';
               }
             } else if (step === 'tool') {
               step = 'tool_result';
               partial = false;
               // omit logging full tool content back to UI unless needed
               emitContent = `Finished tool execution.`;
             }
             
             // Emit if there's actual content or if it's explicitly a step transition
             if (emitContent || step === 'tool_calling' || step === 'tool_result') {
                ctx.runtime.writer({
                   action: 'subAgentProgress',
                   body: { step, content: emitContent, partial }
                });
             }
          } catch(e) {}
        }
      }

      const resultText = aiContentCache || finalStateMsg?.content || 'Task completed without clear output.';

      return { 
        status: 'success' as const, 
        content: resultText
      };
    } catch (e) {
      this.app.log.error(`Failed to invoke sub-agent ${agent.name}`, e);
      return {
        status: 'error' as const,
        content: e.message || 'Unknown error occurred invoking sub-agent',
      };
    }
  }

  async install() {}

  async afterEnable() {}

  async afterDisable() {}

  async remove() {}
}

export default PluginSubAgentServer;
