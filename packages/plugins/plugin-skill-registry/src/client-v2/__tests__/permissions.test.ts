import { createAclSnippetAllow, createMockClient } from '@nocobase/client-v2';

import { canUseSkillRegistryCapability, SKILL_REGISTRY_SNIPPETS } from '../permissions';
import PluginSkillRegistryClientV2 from '../plugin';

describe('Skill Registry client ACL', () => {
  it('keeps read and sync independent', () => {
    const allowSync = createAclSnippetAllow([SKILL_REGISTRY_SNIPPETS.sync]);

    expect(canUseSkillRegistryCapability(allowSync, 'sync')).toBe(true);
    expect(canUseSkillRegistryCapability(allowSync, 'read')).toBe(false);
    expect(canUseSkillRegistryCapability(allowSync, 'publish')).toBe(false);
    expect(canUseSkillRegistryCapability(allowSync, 'install')).toBe(false);
  });

  it('treats manage as the server-defined capability superset', () => {
    const allowManage = createAclSnippetAllow([SKILL_REGISTRY_SNIPPETS.manage]);

    expect(canUseSkillRegistryCapability(allowManage, 'read')).toBe(true);
    expect(canUseSkillRegistryCapability(allowManage, 'sync')).toBe(true);
    expect(canUseSkillRegistryCapability(allowManage, 'publish')).toBe(true);
    expect(canUseSkillRegistryCapability(allowManage, 'install')).toBe(true);
    expect(canUseSkillRegistryCapability(allowManage, 'manage')).toBe(true);
  });

  it('uses read to gate every page that loads registry collection data', async () => {
    const app = createMockClient({ plugins: [PluginSkillRegistryClientV2] });

    await app.load();

    expect(app.pluginSettingsManager.get('skill-registry')).toMatchObject({
      aclSnippet: SKILL_REGISTRY_SNIPPETS.read,
    });
    for (const pageName of ['index', 'sources', 'runs', 'versions']) {
      expect(app.pluginSettingsManager.get(`skill-registry.${pageName}`)).toMatchObject({
        aclSnippet: SKILL_REGISTRY_SNIPPETS.read,
      });
    }
  });
});
