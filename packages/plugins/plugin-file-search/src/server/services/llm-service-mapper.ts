import type { FileSearchSettings } from '../types';

function getOption(options: unknown, names: string[]): string | undefined {
  if (!options || typeof options !== 'object') return undefined;
  const record = options as Record<string, unknown>;
  for (const name of names) {
    const value = record[name];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

export class LlmServiceMapper {
  constructor(private readonly app: any) {}

  async resolveEnv(settings: FileSearchSettings): Promise<{ ok: boolean; message: string; env: NodeJS.ProcessEnv }> {
    if (!settings.llmService || !settings.indexModel) {
      return { ok: true, message: 'LLM service is not configured; runner will use environment defaults.', env: {} };
    }

    const aiPlugin = this.app.pm?.get?.('@nocobase/plugin-ai') || this.app.pm?.get?.('ai');
    if (!aiPlugin?.aiManager?.getLLMService) {
      return { ok: false, message: 'plugin-ai is not available.', env: {} };
    }

    try {
      const { service } = await aiPlugin.aiManager.getLLMService({
        llmService: settings.llmService,
        model: settings.indexModel,
      });
      const provider = String(service.get?.('provider') || service.provider || '');
      const options = service.get?.('options') || service.options || {};
      const apiKey = getOption(options, ['apiKey', 'api_key', 'key']);
      const baseURL = getOption(options, ['baseURL', 'baseUrl', 'apiBaseUrl', 'endpoint']);
      const env: NodeJS.ProcessEnv = {};

      if (apiKey) env.OPENAI_API_KEY = apiKey;
      if (baseURL) env.OPENAI_API_BASE = baseURL;

      if (!apiKey && provider !== 'ollama') {
        return { ok: false, message: `LLM service "${settings.llmService}" has no API key available.`, env };
      }

      if (!['openai', 'openai-completions', 'custom', 'custom-llm', 'ollama'].includes(provider)) {
        return {
          ok: false,
          message: `Provider "${provider}" is not mapped to LiteLLM for PageIndex yet.`,
          env,
        };
      }

      return { ok: true, message: `LLM service "${settings.llmService}" is usable by PageIndex.`, env };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error), env: {} };
    }
  }
}
