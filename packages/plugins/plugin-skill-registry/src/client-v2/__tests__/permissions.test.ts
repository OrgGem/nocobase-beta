/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { createAclSnippetAllow, createMockClient } from '@nocobase/client-v2';

import {
  canUseSkillRegistryCapability,
  permissionsForRole,
  resolveSkillRegistryPermissions,
  SKILL_REGISTRY_SNIPPETS,
} from '../permissions';
import PluginSkillRegistryClientV2 from '../plugin';

describe('Skill Registry client ACL', () => {
  it('uses the snippet namespace registered by the server plugin', () => {
    expect(SKILL_REGISTRY_SNIPPETS).toEqual({
      read: 'pm.plugin-skill-registry.read',
      sync: 'pm.plugin-skill-registry.sync',
      publish: 'pm.plugin-skill-registry.publish',
      install: 'pm.plugin-skill-registry.install',
      markdown: 'pm.plugin-skill-registry.markdown',
      manage: 'pm.plugin-skill-registry.manage',
    });
  });

  it('keeps read and sync independent', () => {
    const allowSync = createAclSnippetAllow([SKILL_REGISTRY_SNIPPETS.sync]);

    expect(canUseSkillRegistryCapability(allowSync, 'sync')).toBe(true);
    expect(canUseSkillRegistryCapability(allowSync, 'read')).toBe(false);
    expect(canUseSkillRegistryCapability(allowSync, 'publish')).toBe(false);
    expect(canUseSkillRegistryCapability(allowSync, 'install')).toBe(false);
    expect(canUseSkillRegistryCapability(allowSync, 'markdown')).toBe(false);
  });

  it('treats manage as the server-defined capability superset', () => {
    const allowManage = createAclSnippetAllow([SKILL_REGISTRY_SNIPPETS.manage]);

    expect(canUseSkillRegistryCapability(allowManage, 'read')).toBe(true);
    expect(canUseSkillRegistryCapability(allowManage, 'sync')).toBe(true);
    expect(canUseSkillRegistryCapability(allowManage, 'publish')).toBe(true);
    expect(canUseSkillRegistryCapability(allowManage, 'install')).toBe(true);
    expect(canUseSkillRegistryCapability(allowManage, 'markdown')).toBe(true);
    expect(canUseSkillRegistryCapability(allowManage, 'manage')).toBe(true);
  });

  it('resolves all page permissions from one runtime-specific allow function', () => {
    const permissions = resolveSkillRegistryPermissions(createAclSnippetAllow(['pm.*']));

    expect(permissions).toEqual({
      canRead: true,
      canSync: true,
      canPublish: true,
      canInstall: true,
      canMarkdown: true,
      canManage: true,
    });
  });

  it('keeps the core plugin-manager grant separate from registry actions', () => {
    const permissions = resolveSkillRegistryPermissions(createAclSnippetAllow(['pm']));
    expect(Object.values(permissions)).not.toContain(true);
    const restricted = resolveSkillRegistryPermissions(
      createAclSnippetAllow(['pm.*', '!pm.plugin-skill-registry.manage', '!pm.plugin-skill-registry.publish']),
    );
    expect(restricted.canRead).toBe(true);
    expect(restricted.canManage).toBe(false);
    expect(restricted.canPublish).toBe(false);
  });

  it('honors an explicit rejection even before a wildcard grant', () => {
    const role = { snippets: ['!pm.plugin-skill-registry.manage', '!pm.plugin-skill-registry.publish', 'pm.*'] };
    expect(permissionsForRole(role)).toMatchObject({ canRead: true, canPublish: false, canManage: false });
  });

  it('uses read to gate every page that loads registry collection data', async () => {
    const app = createMockClient({ plugins: [PluginSkillRegistryClientV2] });

    await app.load();

    expect(app.pluginSettingsManager.get('skill-registry')).toMatchObject({
      aclSnippet: SKILL_REGISTRY_SNIPPETS.read,
    });
    for (const pageName of ['index', 'sources', 'runs', 'versions', 'settings']) {
      expect(app.pluginSettingsManager.get(`skill-registry.${pageName}`)).toMatchObject({
        aclSnippet: SKILL_REGISTRY_SNIPPETS.read,
      });
    }
    expect(app.pluginSettingsManager.get('skill-registry.markdown-skills')).toMatchObject({
      aclSnippet: SKILL_REGISTRY_SNIPPETS.markdown,
    });
  });
});
