import { Application, Plugin } from '@nocobase/client-v2';
import {
  DOCKER_REGISTRY_LEGACY_IMAGE_PATH,
  DOCKER_REGISTRY_LEGACY_MANAGER_PATH,
  DOCKER_REGISTRY_LEGACY_REPOSITORY_PATH,
} from '../shared/routes';
import { DOCKER_REGISTRY_PERMISSION_ITEMS, DOCKER_REGISTRY_SNIPPETS } from './permissions';

export class PluginDockerRegistryUiClientV2 extends Plugin<Record<string, never>, Application> {
  async load() {
    this.pluginSettingsManager.addMenuItem({
      key: 'docker-registry',
      title: this.t('Docker Registry') as unknown as string,
      icon: 'CloudServerOutlined',
      aclSnippet: DOCKER_REGISTRY_SNIPPETS.access,
    });
    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'docker-registry',
      key: 'images',
      title: this.t('Images') as unknown as string,
      aclSnippet: DOCKER_REGISTRY_SNIPPETS.read,
      sort: 10,
      componentLoader: () => import('./pages/RegistryManagerPage'),
    });
    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'docker-registry',
      key: 'index',
      title: this.t('Settings') as unknown as string,
      aclSnippet: DOCKER_REGISTRY_SNIPPETS.settings,
      sort: 20,
      componentLoader: () => import('./pages/RegistrySettingsPage'),
    });
    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'docker-registry',
      key: 'guide',
      title: this.t('Guide') as unknown as string,
      aclSnippet: DOCKER_REGISTRY_SNIPPETS.read,
      sort: 30,
      componentLoader: () => import('./pages/RegistryGuidePage'),
    });
    for (const [index, permission] of DOCKER_REGISTRY_PERMISSION_ITEMS.entries()) {
      this.pluginSettingsManager.addPageTabItem({
        menuKey: 'docker-registry',
        key: permission.key,
        title: this.t(permission.title) as unknown as string,
        aclSnippet: permission.aclSnippet,
        hidden: true,
        sort: 100 + index,
      });
    }
    this.router.add('admin.docker-registry', {
      path: DOCKER_REGISTRY_LEGACY_MANAGER_PATH,
      componentLoader: () => import('./pages/RegistryManagerPage'),
    });
    this.router.add('admin.docker-registry-repository', {
      path: DOCKER_REGISTRY_LEGACY_REPOSITORY_PATH,
      componentLoader: () => import('./pages/RepositoryPage'),
    });
    this.router.add('admin.docker-registry-image', {
      path: DOCKER_REGISTRY_LEGACY_IMAGE_PATH,
      componentLoader: () => import('./pages/ImageDetailsPage'),
    });
  }
}

export default PluginDockerRegistryUiClientV2;
