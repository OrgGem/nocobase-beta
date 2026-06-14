import { SkillHubCard } from './SkillHubCard';
import { parseJsonText } from '../utils/jsonFields';

const sanitize = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');

const extractList = (data: any) => {
  const value = data?.data?.data ?? data?.data ?? data ?? [];
  return Array.isArray(value) ? value : [];
};

const getAuthToken = (app: any) => app?.apiClient?.auth?.getToken?.() || app?.apiClient?.auth?.token || '';

const registerSkillHubCard = (toolsManager: any, name: string) => {
  try {
    toolsManager.registerTools(name, { ui: { card: SkillHubCard } });
  } catch (err: unknown) {
    if (!(err instanceof Error) || !err.message.includes('override existing keys')) {
      throw err;
    }
  }
};

export async function registerSkillLoopCards(app: any) {
  const toolsManager = app.aiManager?.toolsManager;
  if (!toolsManager) return;
  registerSkillHubCard(toolsManager, 'skill_hub_execute');
  if (!getAuthToken(app)) return;

  try {
    const skillsResponse = await app.apiClient.request({
      url: 'skillDefinitions:list',
      skipNotify: true,
      params: {
        filter: { enabled: true },
        fields: ['id', 'name', 'autoCall', 'interactionSchema'],
        pageSize: 500,
      },
    });

    let loopSkillIds = new Set<string>();
    try {
      const loopConfigsResponse = await app.apiClient.request({
        url: 'skillLoopConfigs:list',
        skipNotify: true,
        params: {
          filter: { enabled: true },
          fields: ['skillId'],
          pageSize: 500,
        },
      });
      loopSkillIds = new Set(extractList(loopConfigsResponse.data).map((config: any) => String(config.skillId)));
    } catch {
      // Older deployments may not have the collection before migration/sync.
    }

    const skills = extractList(skillsResponse.data);
    for (const skill of skills) {
      const hasLoopConfig = loopSkillIds.has(String(skill.id));
      const hasLegacySchema = !skill.autoCall && !!parseJsonText(skill.interactionSchema, null);
      if (!hasLoopConfig && !hasLegacySchema) continue;
      registerSkillHubCard(toolsManager, `skill_hub_${sanitize(skill.name)}`);
    }
  } catch {
    // user without ACL or backend unavailable - skip silently
  }
}
