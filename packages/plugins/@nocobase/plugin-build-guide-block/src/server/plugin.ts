import { InstallOptions, Plugin } from '@nocobase/server';
import path from 'path';
import { build } from './actions/build';
import { getHtml } from './actions/getHtml';

export class PluginBuildGuideBlockServer extends Plugin {
  afterAdd() {}

  beforeLoad() {}

  async load() {
    this.app.resourceManager.registerActionHandlers({
      'aiBuildGuideSpaces:build': build,
      'aiBuildGuideSpaces:getHtml': getHtml,
    });

    this.app.acl.allow('aiBuildGuideSpaces', 'getHtml', 'loggedIn');
    this.app.acl.registerSnippet({
      name: 'pm.ai-build-guide',
      actions: [
        'aiBuildGuideSpaces:create',
        'aiBuildGuideSpaces:update',
        'aiBuildGuideSpaces:destroy',
        'aiBuildGuideSpaces:list',
        'aiBuildGuideSpaces:get',
        'aiBuildGuideSpaces:build',
      ],
    });
  }

  async install(options?: InstallOptions) {
    const collection = this.db.getCollection('aiBuildGuideSpaces');
    if (collection) {
      await collection.model.sync();
    }
    const repo = this.db.getRepository<any>('collections');
    if (repo) {
      await repo.db2cm('aiBuildGuideSpaces');
    }
  }

  async upgrade() {
    const collection = this.db.getCollection('aiBuildGuideSpaces');
    if (collection) {
      await collection.model.sync();
    }
    const repo = this.db.getRepository<any>('collections');
    if (repo) {
      await repo.db2cm('aiBuildGuideSpaces');
    }
  }

  async afterEnable() {}

  async afterDisable() {}

  async remove() {}
}

export default PluginBuildGuideBlockServer;
