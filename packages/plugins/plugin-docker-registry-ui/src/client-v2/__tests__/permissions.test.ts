import { createMockClient } from '@nocobase/client-v2';
import { describe, expect, it } from 'vitest';
import {
  DOCKER_REGISTRY_PERMISSION_ITEMS,
  DOCKER_REGISTRY_SNIPPETS,
  resolveDockerRegistryPermissions,
} from '../permissions';
import PluginDockerRegistryUiClientV2 from '../plugin';

describe('Docker Registry client permissions', () => {
  it('keeps read, transfer and delete permissions separate', () => {
    const permissions = resolveDockerRegistryPermissions((snippet) => snippet === 'pm.docker-registry-ui.read');
    expect(permissions).toEqual({
      canRead: true,
      canDelete: false,
      canDownload: false,
      canUpload: false,
      canConfigure: false,
      canManage: false,
    });
  });

  it('grants upload and download independently', () => {
    expect(resolveDockerRegistryPermissions((snippet) => snippet === 'pm.docker-registry-ui.download')).toMatchObject({
      canDownload: true,
      canUpload: false,
      canDelete: false,
    });
    expect(resolveDockerRegistryPermissions((snippet) => snippet === 'pm.docker-registry-ui.upload')).toMatchObject({
      canDownload: false,
      canUpload: true,
      canDelete: false,
    });
  });

  it('grants settings without implicitly granting image operations', () => {
    expect(resolveDockerRegistryPermissions((snippet) => snippet === DOCKER_REGISTRY_SNIPPETS.settings)).toEqual({
      canRead: false,
      canDelete: false,
      canDownload: false,
      canUpload: false,
      canConfigure: true,
      canManage: false,
    });
  });

  it('treats manage as the explicit superset', () => {
    const permissions = resolveDockerRegistryPermissions((snippet) => snippet === 'pm.docker-registry-ui.manage');
    expect(permissions).toEqual({
      canRead: true,
      canDelete: true,
      canDownload: true,
      canUpload: true,
      canConfigure: true,
      canManage: true,
    });
  });

  it('denies every capability when no snippet is granted', () => {
    expect(resolveDockerRegistryPermissions(() => false)).toEqual({
      canRead: false,
      canDelete: false,
      canDownload: false,
      canUpload: false,
      canConfigure: false,
      canManage: false,
    });
  });

  it('registers the Images settings tab and keeps operation-only ACL rows hidden', async () => {
    const app = createMockClient({ plugins: [PluginDockerRegistryUiClientV2] });

    await app.load();

    expect(app.pluginSettingsManager.get('docker-registry', false)).toMatchObject({
      aclSnippet: DOCKER_REGISTRY_SNIPPETS.access,
    });
    expect(app.pluginSettingsManager.get('docker-registry.index', false)).toMatchObject({
      aclSnippet: DOCKER_REGISTRY_SNIPPETS.settings,
    });
    expect(app.pluginSettingsManager.get('docker-registry.guide', false)).toMatchObject({
      aclSnippet: DOCKER_REGISTRY_SNIPPETS.read,
    });
    const imagesPage = app.pluginSettingsManager.get('docker-registry.images', false);
    expect(imagesPage).toMatchObject({
      aclSnippet: DOCKER_REGISTRY_SNIPPETS.read,
      sort: 10,
    });
    expect(imagesPage?.hidden).not.toBe(true);
    for (const permission of DOCKER_REGISTRY_PERMISSION_ITEMS) {
      expect(app.pluginSettingsManager.get(`docker-registry.${permission.key}`, false)).toMatchObject({
        aclSnippet: permission.aclSnippet,
        hidden: true,
      });
    }
  });
});
