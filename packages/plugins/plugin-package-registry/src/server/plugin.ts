import { Plugin } from '@nocobase/server';
import * as collections from './collections';

export class PluginPackageRegistryServer extends Plugin {
  async afterAdd() {
    // Register collections
    this.db.import(collections);
  }

  async beforeLoad() {}

  async load() {}

  async install() {}

  async afterEnable() {}

  async afterDisable() {}

  async remove() {}
}

export default PluginPackageRegistryServer;

