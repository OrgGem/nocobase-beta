import { Plugin } from '@nocobase/server';
import { resolve } from 'node:path';
import { DOCKER_REGISTRY_DESKTOP_ROUTE_SCHEMA_UID } from '../shared/routes';
import {
  deleteTag,
  deleteRepositoryContents,
  downloadImage,
  getDeleteImpact,
  getImageDetails,
  getRepositoryDeleteImpact,
  getPublicConfiguration,
  getSettings,
  listRepositories,
  listTags,
  testConnection,
  testConnectionDraft,
  updateSettings,
  uploadImage,
} from './resources/docker-registry';
import { createDockerRegistryRequestMethodPolicy } from './middlewares/request-method-policy';
import { DOCKER_REGISTRY_ACTIONS, DOCKER_REGISTRY_MANAGE_ACTIONS } from './permissions';

export class PluginDockerRegistryUiServer extends Plugin {
  async load() {
    await this.db.import({ directory: resolve(__dirname, 'collections') });
    this.app.resourceManager.use(createDockerRegistryRequestMethodPolicy());
    this.app.resourceManager.define({
      name: 'dockerRegistry',
      actions: {
        getSettings,
        getPublicConfiguration,
        updateSettings,
        testConnection,
        testConnectionDraft,
        listRepositories,
        listTags,
        getImageDetails,
        getDeleteImpact,
        deleteTag,
        getRepositoryDeleteImpact,
        deleteRepositoryContents,
        downloadImage,
        uploadImage,
      },
    });

    this.app.acl.registerSnippet({ name: `pm.${this.name}.access`, actions: [] });
    this.app.acl.registerSnippet({ name: `pm.${this.name}.read`, actions: [...DOCKER_REGISTRY_ACTIONS.read] });
    this.app.acl.registerSnippet({ name: `pm.${this.name}.delete`, actions: [...DOCKER_REGISTRY_ACTIONS.delete] });
    this.app.acl.registerSnippet({ name: `pm.${this.name}.download`, actions: [...DOCKER_REGISTRY_ACTIONS.download] });
    this.app.acl.registerSnippet({ name: `pm.${this.name}.upload`, actions: [...DOCKER_REGISTRY_ACTIONS.upload] });
    this.app.acl.registerSnippet({ name: `pm.${this.name}.settings`, actions: [...DOCKER_REGISTRY_ACTIONS.settings] });
    this.app.acl.registerSnippet({
      name: `pm.${this.name}`,
      actions: [...DOCKER_REGISTRY_MANAGE_ACTIONS],
    });
    this.app.acl.registerSnippet({
      name: `pm.${this.name}.manage`,
      actions: [...DOCKER_REGISTRY_MANAGE_ACTIONS],
    });
  }

  async remove() {
    await this.db
      .getRepository('desktopRoutes')
      .destroy({ filter: { schemaUid: DOCKER_REGISTRY_DESKTOP_ROUTE_SCHEMA_UID } });
  }
}

export default PluginDockerRegistryUiServer;
