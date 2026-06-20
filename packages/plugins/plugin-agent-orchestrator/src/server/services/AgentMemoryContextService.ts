import { asObject, toPlain, trimText } from '../utils/ctx-utils';

type MemoryScope = 'public' | 'user' | 'agent_user';

type PolicySettings = {
  nativeObserverEnabled?: boolean;
  memoryInjectionEnabled?: boolean;
  memoryScopes?: string[];
  maxMemoryContextChars?: number;
  maxContextChars?: number;
  harnessTag?: string;
};

type ContextRecord = {
  scope?: string;
  userId?: string | number | null;
  aiEmployeeUsername?: string | null;
  contentMd?: string | null;
  graphMd?: string | null;
  enabled?: boolean;
};

type BuildContextOptions = {
  userId?: string | number;
  aiEmployeeUsername?: string;
  settings?: PolicySettings;
};

type ContextSection = {
  scope: string;
  title: string;
  body: string;
};

const DEFAULT_MEMORY_SCOPES: MemoryScope[] = ['public', 'user', 'agent_user'];
const DEFAULT_MAX_CONTEXT_CHARS = 6000;

function readModelValue(record: unknown, key: string) {
  const model = record as { get?: (name: string) => unknown; [key: string]: unknown };
  return typeof model?.get === 'function' ? model.get(key) : model?.[key];
}

function normalizeScopes(value: unknown): MemoryScope[] {
  if (!Array.isArray(value)) return DEFAULT_MEMORY_SCOPES;
  const scopes = value.filter(
    (item): item is MemoryScope => item === 'public' || item === 'user' || item === 'agent_user',
  );
  return scopes.length ? scopes : DEFAULT_MEMORY_SCOPES;
}

function normalizeText(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function formatRecordSection(record: ContextRecord) {
  const content = normalizeText(record.contentMd);
  const graph = normalizeText(record.graphMd);
  return [content, graph ? `## Graph\n${graph}` : ''].filter(Boolean).join('\n\n').trim();
}

export class AgentMemoryContextService {
  constructor(private readonly plugin: { app: any; db: any }) {}

  async resolvePolicySettings(task?: {
    ctx?: unknown;
    employee?: unknown;
    skillSettings?: unknown;
  }): Promise<PolicySettings> {
    const directSettings = asObject(task?.skillSettings);
    const employeeSettings = asObject(readModelValue(task?.employee, 'skillSettings'));
    const values = asObject((task?.ctx as { action?: { params?: { values?: unknown } } })?.action?.params?.values);
    const tag =
      normalizeText(values.harnessTag) ||
      normalizeText(values.orchestratorHarnessTag) ||
      normalizeText(directSettings.harnessTag) ||
      normalizeText(directSettings.orchestratorHarnessTag) ||
      normalizeText(employeeSettings.harnessTag) ||
      normalizeText(employeeSettings.orchestratorHarnessTag) ||
      'default';

    const profile = await this.findHarnessProfile(tag);
    const fallbackProfile = profile || (tag === 'default' ? null : await this.findHarnessProfile('default'));
    const profileSettings = asObject(fallbackProfile ? readModelValue(fallbackProfile, 'settings') : {});

    return {
      ...profileSettings,
      harnessTag: tag,
    };
  }

  async buildContext(options: BuildContextOptions) {
    const { userId, aiEmployeeUsername } = options;
    const settings = options.settings || {};
    if (!userId || settings.memoryInjectionEnabled === false) {
      return {
        context: '',
        appliedScopes: [] as string[],
        chars: 0,
      };
    }

    const sections: ContextSection[] = [];
    const scopes = normalizeScopes(settings.memoryScopes);

    if (scopes.includes('public')) {
      sections.push(...(await this.loadStoredSections('public', userId, aiEmployeeUsername)));
    }

    if (scopes.includes('user')) {
      const userMemory = await this.loadUserMemory(userId);
      if (userMemory) {
        sections.push({
          scope: 'user-memory',
          title: 'User Memory',
          body: userMemory,
        });
      }

      sections.push(...(await this.loadStoredSections('user', userId, aiEmployeeUsername)));
    }

    if (scopes.includes('agent_user')) {
      sections.push(...(await this.loadStoredSections('agent_user', userId, aiEmployeeUsername)));
    }

    if (!sections.length) {
      return {
        context: '',
        appliedScopes: [] as string[],
        chars: 0,
      };
    }

    const body = sections
      .map((section) => `### ${section.title}\n${section.body}`)
      .join('\n\n')
      .trim();
    const maxChars = Number(settings.maxMemoryContextChars || settings.maxContextChars || DEFAULT_MAX_CONTEXT_CHARS);
    const context = `<agent_memory_context>\n${trimText(
      body,
      Number.isFinite(maxChars) ? maxChars : DEFAULT_MAX_CONTEXT_CHARS,
    )}\n</agent_memory_context>`;

    return {
      context,
      appliedScopes: Array.from(new Set(sections.map((section) => section.scope))),
      chars: context.length,
    };
  }

  private async findHarnessProfile(tag: string) {
    try {
      const repo = this.plugin.db.getRepository('agentHarnessProfiles');
      if (!repo) return null;
      return repo.findOne({
        filter: {
          tag,
          enabled: true,
        },
      });
    } catch (error) {
      this.plugin.app.logger?.warn?.('[AgentOrchestrator] Failed to load policy profile', error);
      return null;
    }
  }

  private async loadStoredSections(scope: MemoryScope, userId?: string | number, aiEmployeeUsername?: string) {
    try {
      const repo = this.plugin.db.getRepository('agentMemoryContexts');
      if (!repo) return [];

      const filter: Record<string, unknown> = {
        scope,
        enabled: true,
      };

      if (scope === 'public') {
        filter.userId = null;
      } else if (userId) {
        filter.userId = userId;
      }

      const records = await repo.find({
        filter,
        sort: ['scope', 'aiEmployeeUsername', 'updatedAt'],
      });

      return records
        .map((record: unknown) => toPlain(record) as ContextRecord)
        .filter((record) => {
          if (scope === 'agent_user') {
            return (
              String(record.userId || '') === String(userId || '') &&
              normalizeText(record.aiEmployeeUsername) === normalizeText(aiEmployeeUsername)
            );
          }
          const username = normalizeText(record.aiEmployeeUsername);
          return !username || username === normalizeText(aiEmployeeUsername);
        })
        .map((record) => ({
          scope,
          title: this.sectionTitle(scope, record.aiEmployeeUsername),
          body: formatRecordSection(record),
        }))
        .filter((section) => section.body);
    } catch (error) {
      this.plugin.app.logger?.warn?.(`[AgentOrchestrator] Failed to load ${scope} memory context`, error);
      return [];
    }
  }

  private async loadUserMemory(userId: string | number) {
    try {
      const pluginManager = this.plugin.app.pm;
      const candidates = ['plugin-user-memory', '@nocobase/plugin-user-memory', 'user-memory'];
      let userMemoryPlugin: {
        memoryInjector?: { getMemoryPromptSection?: (userId: number) => Promise<string> };
      } | null = null;

      for (const name of candidates) {
        try {
          const candidate = pluginManager?.get?.(name);
          if (candidate?.memoryInjector?.getMemoryPromptSection) {
            userMemoryPlugin = candidate;
            break;
          }
        } catch {
          // Missing plugin aliases are expected in installations without user memory.
        }
      }

      if (!userMemoryPlugin && typeof pluginManager?.getPlugins === 'function') {
        for (const [, candidate] of pluginManager.getPlugins()) {
          if (candidate?.memoryInjector?.getMemoryPromptSection) {
            userMemoryPlugin = candidate;
            break;
          }
        }
      }

      const injector = userMemoryPlugin?.memoryInjector;
      if (!injector?.getMemoryPromptSection) return '';
      return normalizeText(await injector.getMemoryPromptSection(Number(userId)));
    } catch (error) {
      this.plugin.app.logger?.warn?.('[AgentOrchestrator] Failed to read plugin-user-memory context', error);
      return '';
    }
  }

  private sectionTitle(scope: MemoryScope, aiEmployeeUsername?: string | null) {
    const suffix = aiEmployeeUsername ? ` (${aiEmployeeUsername})` : '';
    if (scope === 'public') return `Public Agent Knowledge${suffix}`;
    if (scope === 'user') return `User Context${suffix}`;
    return `Private Agent/User Context${suffix}`;
  }
}
