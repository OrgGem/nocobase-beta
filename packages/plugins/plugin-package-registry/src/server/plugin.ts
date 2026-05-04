import { Plugin } from '@nocobase/server';
import path from 'path';
import { createPackageRegistryActions, createPackageRegistryRouter } from './registry-router';

export class PluginPackageRegistryServer extends Plugin {
  async afterAdd() {}

  async beforeLoad() {
    await this.db.import({
      directory: path.resolve(__dirname, 'collections'),
    });
  }

  async load() {
    this.app.use(createPackageRegistryRouter(this), { before: 'resourcer' });
    this.app.resourceManager.define({
      name: 'packageRegistry',
      actions: createPackageRegistryActions(this),
    });
    this.app.acl.registerSnippet({
      name: `pm.${this.name}`,
      actions: ['packageRegistry:*', 'packageRegistries:*', 'packages:*', 'packageVersions:*', 'packageAssets:*'],
    });
  }

  async install() {}

  async afterEnable() {}

  async afterDisable() {}

  async remove() {}
}

export default PluginPackageRegistryServer;

