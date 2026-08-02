import { Application } from '@nocobase/client';
import { describe, expect, it } from 'vitest';

import { DOCKER_REGISTRY_PERMISSION_ITEMS, DOCKER_REGISTRY_SNIPPETS } from '../../client-v2/permissions';
import {
  DOCKER_REGISTRY_LEGACY_IMAGE_PATH,
  DOCKER_REGISTRY_LEGACY_MANAGER_PATH,
  DOCKER_REGISTRY_LEGACY_REPOSITORY_PATH,
} from '../../shared/routes';
import PluginDockerRegistryUiClient from '../plugin';

describe('PluginDockerRegistryUiClient', () => {
  it('registers the same settings pages and browser routes as client-v2', async () => {
    const app = new Application({
      plugins: [
        [
          PluginDockerRegistryUiClient,
          { name: 'docker-registry-ui', packageName: 'plugin-docker-registry-ui' },
        ],
      ],
    });

    await app.load();

    expect(app.pluginSettingsManager.get('docker-registry')).toMatchObject({
      title: 'Docker Registry',
      aclSnippet: DOCKER_REGISTRY_SNIPPETS.access,
    });
    expect(app.pluginSettingsManager.get('docker-registry.index')).toMatchObject({
      title: 'Settings',
      aclSnippet: DOCKER_REGISTRY_SNIPPETS.settings,
    });
    expect(app.pluginSettingsManager.get('docker-registry.guide')).toMatchObject({
      title: 'Guide',
      aclSnippet: DOCKER_REGISTRY_SNIPPETS.read,
    });
    expect(app.pluginSettingsManager.get('docker-registry.images')).toMatchObject({
      title: 'Images',
      aclSnippet: DOCKER_REGISTRY_SNIPPETS.read,
      sort: 10,
    });
    for (const permission of DOCKER_REGISTRY_PERMISSION_ITEMS) {
      expect(app.pluginSettingsManager.get(`docker-registry.${permission.key}`, false)).toMatchObject({
        title: permission.title,
        aclSnippet: permission.aclSnippet,
        hidden: true,
        isTopLevel: false,
      });
    }
    expect(app.pluginSettingsManager.get('docker-registry.index')?.Component.displayName).toBe(
      'LegacyDockerRegistryPage(RegistrySettingsPage)',
    );
    expect(app.pluginSettingsManager.get('docker-registry.images')?.Component.displayName).toBe(
      'LegacyDockerRegistryPage(RegistryManagerPage)',
    );
    expect(app.router.get('admin.docker-registry')).toMatchObject({ path: DOCKER_REGISTRY_LEGACY_MANAGER_PATH });
    expect(app.router.get('admin.docker-registry-repository')).toMatchObject({
      path: DOCKER_REGISTRY_LEGACY_REPOSITORY_PATH,
    });
    expect(app.router.get('admin.docker-registry-image')).toMatchObject({ path: DOCKER_REGISTRY_LEGACY_IMAGE_PATH });
  });
});
