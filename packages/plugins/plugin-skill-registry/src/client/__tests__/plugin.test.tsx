import { Application } from '@nocobase/client';
import { describe, expect, it } from 'vitest';

import { SKILL_REGISTRY_SNIPPETS } from '../../client-v2/permissions';
import PluginSkillRegistryClient from '../plugin';

describe('PluginSkillRegistryClient', () => {
  it('registers the legacy settings menu with all client-v2 feature pages', async () => {
    const app = new Application({
      plugins: [[PluginSkillRegistryClient, { name: 'skill-registry', packageName: 'plugin-skill-registry' }]],
    });

    await app.load();

    expect(app.pluginSettingsManager.get('skill-registry')).toMatchObject({
      title: 'Skill Registry',
      aclSnippet: SKILL_REGISTRY_SNIPPETS.read,
    });
    expect(app.pluginSettingsManager.get('skill-registry.index')).toMatchObject({
      title: 'Catalog',
      aclSnippet: SKILL_REGISTRY_SNIPPETS.read,
    });
    expect(app.pluginSettingsManager.get('skill-registry.sources')).toMatchObject({ title: 'Sources' });
    expect(app.pluginSettingsManager.get('skill-registry.runs')).toMatchObject({ title: 'Sync runs' });
    expect(app.pluginSettingsManager.get('skill-registry.versions')).toMatchObject({ title: 'Versions' });
    expect(app.pluginSettingsManager.get('skill-registry.guide')).toMatchObject({ title: 'Guide' });
    expect(app.pluginSettingsManager.get('skill-registry.sources')?.Component.displayName).toBe(
      'LegacySkillRegistryPage(SourcesPage)',
    );
  });
});
