import { Plugin } from '@nocobase/client';
import ImageDetailsPage from '../client-v2/pages/ImageDetailsPage';
import RegistryGuidePage from '../client-v2/pages/RegistryGuidePage';
import RegistryManagerPage from '../client-v2/pages/RegistryManagerPage';
import RegistrySettingsPage from '../client-v2/pages/RegistrySettingsPage';
import RepositoryPage from '../client-v2/pages/RepositoryPage';
import { DOCKER_REGISTRY_PERMISSION_ITEMS, DOCKER_REGISTRY_SNIPPETS } from '../client-v2/permissions';
import {
  DOCKER_REGISTRY_LEGACY_IMAGE_PATH,
  DOCKER_REGISTRY_LEGACY_MANAGER_PATH,
  DOCKER_REGISTRY_LEGACY_REPOSITORY_PATH,
} from '../shared/routes';
import { withLegacyDockerRegistryPermissions } from './LegacyDockerRegistryPage';
import models from './models';

const SETTINGS_KEY = 'docker-registry';
const SETTINGS_PAGES = [
  {
    key: 'images',
    title: 'Images',
    aclSnippet: DOCKER_REGISTRY_SNIPPETS.read,
    Component: withLegacyDockerRegistryPermissions(RegistryManagerPage),
    sort: 10,
  },
  {
    key: 'index',
    title: 'Settings',
    aclSnippet: DOCKER_REGISTRY_SNIPPETS.settings,
    Component: withLegacyDockerRegistryPermissions(RegistrySettingsPage),
    sort: 20,
  },
  {
    key: 'guide',
    title: 'Guide',
    aclSnippet: DOCKER_REGISTRY_SNIPPETS.read,
    Component: withLegacyDockerRegistryPermissions(RegistryGuidePage),
    sort: 30,
  },
] as const;

const ROUTES = [
  {
    key: 'admin.docker-registry',
    path: DOCKER_REGISTRY_LEGACY_MANAGER_PATH,
    Component: withLegacyDockerRegistryPermissions(RegistryManagerPage),
  },
  {
    key: 'admin.docker-registry-repository',
    path: DOCKER_REGISTRY_LEGACY_REPOSITORY_PATH,
    Component: withLegacyDockerRegistryPermissions(RepositoryPage),
  },
  {
    key: 'admin.docker-registry-image',
    path: DOCKER_REGISTRY_LEGACY_IMAGE_PATH,
    Component: withLegacyDockerRegistryPermissions(ImageDetailsPage),
  },
] as const;

export class PluginDockerRegistryUiClient extends Plugin {
  async load() {
    this.flowEngine.registerModels(models);

    this.app.pluginSettingsManager.add(SETTINGS_KEY, {
      title: this.t('Docker Registry'),
      icon: 'CloudServerOutlined',
      aclSnippet: DOCKER_REGISTRY_SNIPPETS.access,
    });
    for (const page of SETTINGS_PAGES) {
      this.app.pluginSettingsManager.add(`${SETTINGS_KEY}.${page.key}`, {
        title: this.t(page.title),
        Component: page.Component,
        aclSnippet: page.aclSnippet,
        sort: page.sort,
      });
    }
    for (const [index, permission] of DOCKER_REGISTRY_PERMISSION_ITEMS.entries()) {
      this.app.pluginSettingsManager.add(`${SETTINGS_KEY}.${permission.key}`, {
        title: this.t(permission.title),
        aclSnippet: permission.aclSnippet,
        hidden: true,
        isTopLevel: false,
        sort: 100 + index,
      });
    }
    for (const route of ROUTES) {
      this.app.router.add(route.key, {
        path: route.path,
        Component: route.Component,
      });
    }
  }

  async remove() {
    for (const permission of DOCKER_REGISTRY_PERMISSION_ITEMS) {
      this.app.pluginSettingsManager.remove(`${SETTINGS_KEY}.${permission.key}`);
    }
    for (const page of SETTINGS_PAGES) {
      this.app.pluginSettingsManager.remove(`${SETTINGS_KEY}.${page.key}`);
    }
    this.app.pluginSettingsManager.remove(SETTINGS_KEY);
    for (const route of ROUTES) {
      this.app.router.remove(route.key);
    }
  }
}

export default PluginDockerRegistryUiClient;
